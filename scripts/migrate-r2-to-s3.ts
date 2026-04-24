// One-shot migration: download everything from the old R2 bucket, re-ID
// each drawing with the new content-addressed scheme (issue #55), and
// upload to the new S3 bucket. Only drawings + metadata are migrated —
// the builder will regenerate all HTML afterwards.
//
// Usage:
//   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
//   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_DEFAULT_REGION=... \
//   npx tsx scripts/migrate-r2-to-s3.ts
//
// Env:
//   R2_*                Cloudflare R2 S3-compatible credentials (read-only ok)
//   R2_BUCKET           Default: drawbang
//   AWS_*               AWS credentials for the new S3 bucket
//   S3_BUCKET           Default: drawbang-assets
//   DRY_RUN             If "1", print what would be uploaded without writing

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { S3Storage } from "../ingest/s3-storage.js";
import { contentHash, hashHex, leadingZeroBits, powHash } from "../src/pow.js";
import { validateGif } from "../ingest/gif-validate.js";

interface OldMetadata {
  id: string; // old id = pow hash
  nonce: string;
  baseline: string;
  solve_ms: number | null;
  bench_hps: number | null;
  required_bits: number;
  created_at: string;
  parent: string | null;
}

interface NewMetadata {
  id: string;
  pow: string;
  nonce: string;
  baseline: string;
  solve_ms: number | null;
  bench_hps: number | null;
  required_bits: number;
  created_at: string;
  parent: string | null;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

const r2AccountId = required("R2_ACCOUNT_ID");
const r2Bucket = process.env.R2_BUCKET ?? "drawbang";
const s3Bucket = process.env.S3_BUCKET ?? "drawbang-assets";
const dryRun = process.env.DRY_RUN === "1";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  },
});
const r2Storage = new S3Storage({ bucket: r2Bucket, client: r2 });
const s3Storage = new S3Storage({ bucket: s3Bucket });

// Build parent remap table so we can translate old-id references to new ids.
const oldToNew = new Map<string, string>();

async function listAll(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await r2.send(
      new ListObjectsV2Command({
        Bucket: r2Bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of page.Contents ?? []) if (obj.Key) keys.push(obj.Key);
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

interface Drawing {
  oldId: string;
  newId: string;
  day: string;
  gif: Uint8Array;
  meta: NewMetadata;
}

async function loadDrawing(gifKey: string): Promise<Drawing | null> {
  const m = gifKey.match(/^(?:inbox|public\/drawings)\/(?:(\d{4}-\d{2}-\d{2})\/)?([0-9a-f]+)\.gif$/);
  if (!m) {
    console.warn(`  skip: cannot parse key ${gifKey}`);
    return null;
  }
  const day = m[1] ?? "unknown";
  const oldId = m[2];

  const gif = await r2Storage.getBytes(gifKey);
  if (!gif) {
    console.warn(`  skip ${oldId}: gif missing`);
    return null;
  }
  try {
    validateGif(gif);
  } catch (err) {
    console.warn(`  skip ${oldId}: invalid gif: ${(err as Error).message}`);
    return null;
  }

  const newId = hashHex(await contentHash(gif));

  // Read old metadata if we can find it (only inbox/ has .json; public/drawings/
  // relies on index.jsonl). For a pre-launch migration we accept that some
  // entries will only have a gif — rebuild metadata from sensible defaults.
  let oldMeta: OldMetadata | null = null;
  const metaKeys = [
    gifKey.replace(/\.gif$/, ".json"),
    `inbox/${day}/${oldId}.json`,
  ];
  for (const mk of metaKeys) {
    const candidate = await r2Storage.getJSON<OldMetadata>(mk);
    if (candidate) {
      oldMeta = candidate;
      break;
    }
  }

  let meta: NewMetadata;
  if (oldMeta) {
    // Re-verify the PoW so we don't carry forward anything we wouldn't accept.
    const pow = await powHash(gif, oldMeta.baseline, oldMeta.nonce);
    if (leadingZeroBits(pow) < oldMeta.required_bits) {
      console.warn(`  skip ${oldId}: PoW re-verification failed`);
      return null;
    }
    meta = {
      id: newId,
      pow: hashHex(pow),
      nonce: oldMeta.nonce,
      baseline: oldMeta.baseline,
      solve_ms: oldMeta.solve_ms,
      bench_hps: oldMeta.bench_hps,
      required_bits: oldMeta.required_bits,
      created_at: oldMeta.created_at,
      parent: oldMeta.parent, // patched after the first pass
    };
  } else {
    console.warn(`  ${oldId}: no metadata — synthesizing minimal record`);
    const synth_created = day === "unknown" ? new Date().toISOString() : `${day}T00:00:00.000Z`;
    meta = {
      id: newId,
      pow: "migrated",
      nonce: "migrated",
      baseline: synth_created,
      solve_ms: null,
      bench_hps: null,
      required_bits: 16,
      created_at: synth_created,
      parent: null,
    };
  }

  oldToNew.set(oldId, newId);
  return { oldId, newId, day, gif, meta };
}

async function main(): Promise<void> {
  console.log(`r2://${r2Bucket} → s3://${s3Bucket}${dryRun ? " (DRY RUN)" : ""}`);

  console.log("listing source keys…");
  const gifKeys = [
    ...(await listAll("inbox/")).filter((k) => k.endsWith(".gif")),
    ...(await listAll("public/drawings/")).filter((k) => k.endsWith(".gif")),
  ];
  // De-dup: the same drawing often appears in both inbox/<d>/ and public/drawings/.
  const uniqueByOldId = new Map<string, string>();
  for (const k of gifKeys) {
    const m = k.match(/([0-9a-f]+)\.gif$/);
    if (!m) continue;
    if (!uniqueByOldId.has(m[1])) uniqueByOldId.set(m[1], k);
  }
  console.log(`found ${uniqueByOldId.size} unique gifs across ${gifKeys.length} keys`);

  // Pass 1: load every drawing, compute new id.
  const loaded: Drawing[] = [];
  for (const gifKey of uniqueByOldId.values()) {
    const d = await loadDrawing(gifKey);
    if (d) loaded.push(d);
  }
  console.log(`loaded ${loaded.length} valid drawings`);

  // Pass 2: patch parent references to use new ids.
  for (const d of loaded) {
    if (d.meta.parent && oldToNew.has(d.meta.parent)) {
      d.meta.parent = oldToNew.get(d.meta.parent)!;
    } else if (d.meta.parent) {
      console.warn(`  ${d.newId}: parent ${d.meta.parent} not found in migration; keeping as-is`);
    }
  }

  // Pass 3: group by day and write fresh inbox entries + rebuild index.jsonl.
  const byDay = new Map<string, Drawing[]>();
  for (const d of loaded) {
    const day = d.day === "unknown" ? d.meta.created_at.slice(0, 10) : d.day;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(d);
  }

  const enc = new TextEncoder();
  let written = 0;
  for (const [day, drawings] of [...byDay.entries()].sort()) {
    console.log(`writing ${drawings.length} drawings for ${day}…`);
    for (const d of drawings) {
      if (dryRun) continue;
      // Seed the inbox so the builder picks them up on its next run.
      await s3Storage.put(`inbox/${day}/${d.newId}.gif`, d.gif, "image/gif");
      await s3Storage.put(
        `inbox/${day}/${d.newId}.json`,
        enc.encode(JSON.stringify(d.meta)),
        "application/json",
      );
      written++;
    }
  }

  console.log(`done: wrote ${written} drawings (${loaded.length - written} skipped via DRY_RUN)`);
  console.log(
    `old→new id map:\n${[...oldToNew.entries()]
      .slice(0, 5)
      .map(([a, b]) => `  ${a.slice(0, 8)} → ${b.slice(0, 8)}`)
      .join("\n")}${oldToNew.size > 5 ? `\n  ... (${oldToNew.size - 5} more)` : ""}`,
  );
  console.log(`next: run 'npm run builder' against S3 to publish & render`);
}

await main();
