// One-shot migration: pull drawings from the old R2 bucket via the
// Cloudflare REST API, re-ID each with the new content-addressed scheme
// (issue #55), and upload to the new S3 bucket.
//
// The old builder consumed the inbox/*.json sidecars on sweep, so the only
// surviving provenance is in public/days/<d>/index.jsonl. The old `id`
// happens to equal the PoW hash — we preserve it as `pow` in the new
// metadata. nonce/baseline are unrecoverable, so we tag them "migrated".
//
// We bypass the builder's inbox sweep (which would reject entries whose
// PoW we can't re-verify) by writing directly under public/:
//   public/drawings/<newId>.gif
//   public/days/<d>/index.jsonl   (one line per drawing, re-built with newIds)
//   public/days/<d>/manifest.json ({count, pages})
// Then the next builder run with DRAWBANG_FORCE_RERENDER=1 renders all the
// HTML pages.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_DEFAULT_REGION=us-east-1 \
//   npx tsx scripts/migrate-r2-to-s3.ts [--dry-run]

import { PER_PAGE } from "../config/constants.js";
import { S3Storage } from "../ingest/s3-storage.js";
import { contentHash, hashHex } from "../src/pow.js";
import { validateGif } from "../ingest/gif-validate.js";

interface IndexRowIn {
  id: string;
  created_at: string;
  required_bits: number;
  solve_ms: number | null;
  bench_hps: number | null;
  parent: string | null;
}

// Must match builder/build.ts DrawingMetadata — the builder reads this back.
interface IndexRowOut {
  id: string;
  pow: string;
  created_at: string;
  required_bits: number;
  solve_ms: number | null;
  bench_hps: number | null;
  parent: string | null;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

const cfToken = required("CLOUDFLARE_API_TOKEN");
const cfAccount = required("CLOUDFLARE_ACCOUNT_ID");
const r2Bucket = process.env.R2_BUCKET ?? "drawbang";
const s3Bucket = process.env.S3_BUCKET ?? "drawbang-assets";
const dryRun = process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");

const cfR2Base = `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/r2/buckets/${r2Bucket}`;

async function cfFetch(path: string): Promise<Response> {
  const res = await fetch(`${cfR2Base}${path}`, {
    headers: { Authorization: `Bearer ${cfToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CF API ${res.status} ${res.statusText} on ${path}: ${text}`);
  }
  return res;
}

async function r2List(): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({ per_page: "1000" });
    if (cursor) qs.set("cursor", cursor);
    const res = await cfFetch(`/objects?${qs}`);
    const body = (await res.json()) as {
      result: { key: string }[];
      result_info?: { cursor?: string; is_truncated?: boolean };
    };
    for (const obj of body.result) keys.push(obj.key);
    cursor = body.result_info?.is_truncated ? body.result_info.cursor : undefined;
  } while (cursor);
  return keys;
}

async function r2GetBytes(key: string): Promise<Uint8Array> {
  const res = await cfFetch(`/objects/${encodeURIComponent(key)}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function r2GetText(key: string): Promise<string> {
  const res = await cfFetch(`/objects/${encodeURIComponent(key)}`);
  return res.text();
}

const s3Storage = new S3Storage({ bucket: s3Bucket });
const oldToNew = new Map<string, string>();

interface Drawing {
  oldId: string;
  newId: string;
  day: string;
  gif: Uint8Array;
  out: IndexRowOut;
}

async function main(): Promise<void> {
  console.log(`r2://${r2Bucket} → s3://${s3Bucket}${dryRun ? " (DRY RUN)" : ""}`);

  console.log("listing R2 keys…");
  const allKeys = await r2List();
  const indexJsonlKeys = allKeys.filter((k) => /^public\/days\/\d{4}-\d{2}-\d{2}\/index\.jsonl$/.test(k));
  console.log(`  ${indexJsonlKeys.length} day index files, ${allKeys.length} total keys`);

  // Pass 1: load every drawing via the per-day indexes.
  const loaded: Drawing[] = [];
  for (const key of indexJsonlKeys.sort()) {
    const day = key.match(/\/days\/(\d{4}-\d{2}-\d{2})\//)![1];
    const text = await r2GetText(key);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as IndexRowIn;
      const oldId = row.id;
      let gif: Uint8Array;
      try {
        gif = await r2GetBytes(`public/drawings/${oldId}.gif`);
      } catch (err) {
        console.warn(`  skip ${oldId.slice(0, 8)}: ${(err as Error).message}`);
        continue;
      }
      try {
        validateGif(gif);
      } catch (err) {
        console.warn(`  skip ${oldId.slice(0, 8)}: invalid gif: ${(err as Error).message}`);
        continue;
      }
      const newId = hashHex(await contentHash(gif));
      oldToNew.set(oldId, newId);
      loaded.push({
        oldId,
        newId,
        day,
        gif,
        out: {
          id: newId,
          pow: oldId,
          created_at: row.created_at,
          required_bits: row.required_bits,
          solve_ms: row.solve_ms,
          bench_hps: row.bench_hps,
          parent: row.parent,
        },
      });
    }
  }
  console.log(`loaded ${loaded.length} drawings`);

  // Pass 2: remap parent references.
  for (const d of loaded) {
    if (d.out.parent && oldToNew.has(d.out.parent)) {
      d.out.parent = oldToNew.get(d.out.parent)!;
    } else if (d.out.parent) {
      console.warn(`  ${d.newId.slice(0, 8)}: parent ${d.out.parent.slice(0, 8)} not in migration`);
    }
  }

  // Pass 3: detect collisions (two different old gifs hashing to the same
  // content id — shouldn't happen, but worth knowing). Keep the earliest.
  const byNewId = new Map<string, Drawing>();
  for (const d of loaded) {
    const prior = byNewId.get(d.newId);
    if (prior && prior.oldId !== d.oldId) {
      if (d.out.created_at < prior.out.created_at) byNewId.set(d.newId, d);
      console.warn(
        `  content-id collision: ${prior.oldId.slice(0, 8)} vs ${d.oldId.slice(0, 8)} → ${d.newId.slice(0, 8)}`,
      );
    } else {
      byNewId.set(d.newId, d);
    }
  }
  const deduped = [...byNewId.values()];

  // Pass 4: write drawings + rebuild each day's index.jsonl + manifest.json.
  const enc = new TextEncoder();
  const byDay = new Map<string, Drawing[]>();
  for (const d of deduped) {
    if (!byDay.has(d.day)) byDay.set(d.day, []);
    byDay.get(d.day)!.push(d);
  }

  for (const [day, drawings] of [...byDay.entries()].sort()) {
    drawings.sort((a, b) => a.out.created_at.localeCompare(b.out.created_at));
    console.log(`writing ${drawings.length} drawings for ${day}…`);
    if (dryRun) continue;

    for (const d of drawings) {
      await s3Storage.put(`public/drawings/${d.newId}.gif`, d.gif, "image/gif");
    }
    const jsonl = drawings.map((d) => JSON.stringify(d.out)).join("\n") + "\n";
    await s3Storage.put(`public/days/${day}/index.jsonl`, enc.encode(jsonl), "application/jsonl");
    const pages = Math.max(1, Math.ceil(drawings.length / PER_PAGE));
    await s3Storage.put(
      `public/days/${day}/manifest.json`,
      enc.encode(JSON.stringify({ count: drawings.length, pages })),
      "application/json",
    );
  }

  console.log(`done: migrated ${deduped.length} drawings across ${byDay.size} days${dryRun ? " (dry run)" : ""}`);
  if (!dryRun) {
    console.log(`next: run the builder with DRAWBANG_FORCE_RERENDER=1 to regenerate all HTML`);
  }
}

await main();
