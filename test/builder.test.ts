import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import { contentHash, hashHex, powHash, solve } from "../src/pow.js";
import { FsStorage } from "../ingest/storage.js";
import { build } from "../builder/build.js";

interface SeedOpts {
  pubkey?: string;
  signature?: string;
}

async function seedDrawing(
  root: string,
  day: string,
  marker: number,
  seedOpts: SeedOpts = {},
): Promise<string> {
  const frame = new Bitmap();
  // Unique pixel per caller so each gif hashes to a different ID (otherwise
  // content-addressing would collapse them into a single drawing).
  frame.set(marker % 16, Math.floor(marker / 16) % 16, ((marker % 15) + 1));
  const gif = encodeGif({ frames: [frame], activePalette: DEFAULT_ACTIVE_PALETTE });
  const baseline = "1970-01-01T00:00:00.000Z";
  const sol = await solve(gif, baseline, 12); // cheap for tests
  const id = hashHex(await contentHash(gif));
  const pow = hashHex(await powHash(gif, baseline, sol.nonce));

  const gifPath = path.join(root, "inbox", day, `${id}.gif`);
  const jsonPath = path.join(root, "inbox", day, `${id}.json`);
  await fs.mkdir(path.dirname(gifPath), { recursive: true });
  await fs.writeFile(gifPath, gif);
  // Sidecar shape mirrors what ingest/handler.ts writes. When seedOpts has
  // pubkey/signature, include them; otherwise leave them out to model legacy
  // pre-feature inbox JSONs.
  const sidecar: Record<string, unknown> = {
    id,
    pow,
    nonce: sol.nonce,
    baseline,
    solve_ms: sol.solveMs,
    bench_hps: 12345,
    required_bits: 12,
    created_at: `${day}T10:00:00.000Z`,
    parent: null,
  };
  if (seedOpts.pubkey !== undefined) sidecar.pubkey = seedOpts.pubkey;
  if (seedOpts.signature !== undefined) sidecar.signature = seedOpts.signature;
  await fs.writeFile(jsonPath, JSON.stringify(sidecar));
  return id;
}

test("builder sweeps inbox, renders per-day pages, is incremental", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage = new FsStorage(root);

  // Seed three drawings on 2026-04-17.
  const ids = await Promise.all([
    seedDrawing(root, "2026-04-17", 1),
    seedDrawing(root, "2026-04-17", 2),
    seedDrawing(root, "2026-04-17", 3),
  ]);

  const first = await build({ storage, publicBaseUrl: "https://example.test", today: "2026-04-18" });
  assert.equal(first.sweptDrawings, 3);
  assert.ok(first.touchedDays.includes("2026-04-17"));

  for (const id of ids) {
    assert.ok(
      await fs.stat(path.join(root, `public/drawings/${id}.gif`)),
      `published gif for ${id}`,
    );
    assert.ok(await fs.stat(path.join(root, `public/d/${id}.html`)));
  }
  const dayPage = await fs.readFile(path.join(root, "public/days/2026-04-17/p/1.html"), "utf8");
  assert.ok(dayPage.includes("Draw!"));
  const indexHtml = await fs.readFile(path.join(root, "public/gallery.html"), "utf8");
  assert.ok(indexHtml.includes("2026-04-17"));

  // Capture mtimes before running again.
  const snapshot = new Map<string, number>();
  for (const rel of [
    "public/days/2026-04-17/p/1.html",
    "public/days/2026-04-17/manifest.json",
    "public/days/2026-04-17/index.jsonl",
    "public/gallery.html",
    "public/feed.rss",
  ]) {
    const stat = await fs.stat(path.join(root, rel));
    snapshot.set(rel, stat.mtimeMs);
  }
  // A small delay so any file we *do* rewrite gets a newer mtime.
  await new Promise((r) => setTimeout(r, 25));

  // Run again with an empty inbox.
  const second = await build({ storage, publicBaseUrl: "https://example.test", today: "2026-04-18" });
  assert.equal(second.sweptDrawings, 0);

  for (const rel of ["public/days/2026-04-17/p/1.html", "public/days/2026-04-17/index.jsonl", "public/days/2026-04-17/manifest.json"]) {
    const stat = await fs.stat(path.join(root, rel));
    assert.equal(stat.mtimeMs, snapshot.get(rel), `${rel} must not be rewritten`);
  }
  const indexStat = await fs.stat(path.join(root, "public/gallery.html"));
  assert.ok(indexStat.mtimeMs >= snapshot.get("public/gallery.html")!, "index.html is rolling");
});

interface IndexLine {
  id: string;
  pubkey: string | null;
  signature: string | null;
}

test("builder propagates pubkey + signature from inbox to per-day index.jsonl, drawing page renders owner link", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage = new FsStorage(root);

  const pubkey = "a".repeat(64);
  const signature = "b".repeat(128);
  const id = await seedDrawing(root, "2026-04-19", 11, { pubkey, signature });

  await build({ storage, publicBaseUrl: "https://example.test", today: "2026-04-20" });

  const jsonl = await fs.readFile(
    path.join(root, "public/days/2026-04-19/index.jsonl"),
    "utf8",
  );
  const lines = jsonl.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]) as IndexLine;
  assert.equal(entry.id, id);
  assert.equal(entry.pubkey, pubkey);
  assert.equal(entry.signature, signature);

  // Per-drawing HTML carries an owner badge linking to /keys/<pubkey>.
  const drawingHtml = await fs.readFile(path.join(root, `public/d/${id}.html`), "utf8");
  assert.match(drawingHtml, new RegExp(`<a href="/keys/${pubkey}">`));
  assert.match(drawingHtml, /<dt>Owner<\/dt><dd><a href="\/keys\//);
  // No "anonymous" fallback when the owner is set.
  assert.equal(drawingHtml.includes("anonymous"), false);
});

test("builder per-owner sweep: maintains keys/<pk>/index.jsonl and renders keys/<pk>.html", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage = new FsStorage(root);
  const pubkey = "c".repeat(64);
  const sig = "d".repeat(128);

  // Two drawings on the same day, same owner.
  const id1 = await seedDrawing(root, "2026-04-19", 21, { pubkey, signature: sig });
  const id2 = await seedDrawing(root, "2026-04-19", 22, { pubkey, signature: sig });

  await build({ storage, publicBaseUrl: "https://example.test", today: "2026-04-20" });

  const ownerIndex = await fs.readFile(
    path.join(root, `public/keys/${pubkey}/index.jsonl`),
    "utf8",
  );
  const lines = ownerIndex.split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  const ids = lines.map((l) => (JSON.parse(l) as { id: string }).id).sort();
  assert.deepEqual(ids, [id1, id2].sort());

  const ownerHtml = await fs.readFile(path.join(root, `public/keys/${pubkey}.html`), "utf8");
  // Pubkey shown in full + abbreviated form.
  assert.match(ownerHtml, new RegExp(pubkey));
  assert.match(ownerHtml, /cccccccc/);
  // Both drawings linked by their share URL.
  assert.match(ownerHtml, new RegExp(`/d/${id1}`));
  assert.match(ownerHtml, new RegExp(`/d/${id2}`));
  // Owner page title surfaces the short pubkey.
  assert.match(ownerHtml, /Drawings by/);
});

test("builder per-owner sweep: separates two distinct owners on the same day", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage = new FsStorage(root);
  const alice = "a".repeat(64);
  const bob = "b".repeat(64);
  const sig = "d".repeat(128);

  const aliceId = await seedDrawing(root, "2026-04-19", 31, { pubkey: alice, signature: sig });
  const bobId = await seedDrawing(root, "2026-04-19", 32, { pubkey: bob, signature: sig });

  await build({ storage, publicBaseUrl: "https://example.test", today: "2026-04-20" });

  const aliceIdx = await fs.readFile(
    path.join(root, `public/keys/${alice}/index.jsonl`),
    "utf8",
  );
  const bobIdx = await fs.readFile(
    path.join(root, `public/keys/${bob}/index.jsonl`),
    "utf8",
  );
  assert.equal(aliceIdx.split("\n").filter(Boolean).length, 1);
  assert.equal(bobIdx.split("\n").filter(Boolean).length, 1);

  const aliceHtml = await fs.readFile(path.join(root, `public/keys/${alice}.html`), "utf8");
  const bobHtml = await fs.readFile(path.join(root, `public/keys/${bob}.html`), "utf8");
  // Each owner page links its own drawing only.
  assert.match(aliceHtml, new RegExp(`/d/${aliceId}`));
  assert.equal(aliceHtml.includes(bobId), false);
  assert.match(bobHtml, new RegExp(`/d/${bobId}`));
  assert.equal(bobHtml.includes(aliceId), false);
});

test("builder per-owner sweep: skips legacy/anonymous drawings (no /keys/ artifact)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage = new FsStorage(root);
  // Sidecar without owner fields -> anonymous.
  await seedDrawing(root, "2026-04-19", 41);

  await build({ storage, publicBaseUrl: "https://example.test", today: "2026-04-20" });

  // No keys/ directory should have been created at all.
  const keysExists = await fs.stat(path.join(root, "public/keys")).then(() => true, () => false);
  assert.equal(keysExists, false);
});

test("builder writes null pubkey + signature for legacy inbox sidecars (pre-feature), drawing page renders 'anonymous'", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage = new FsStorage(root);

  // No seedOpts -> sidecar omits the owner fields, like every drawing
  // submitted before #83 landed.
  const id = await seedDrawing(root, "2026-04-19", 12);

  await build({ storage, publicBaseUrl: "https://example.test", today: "2026-04-20" });

  const jsonl = await fs.readFile(
    path.join(root, "public/days/2026-04-19/index.jsonl"),
    "utf8",
  );
  const lines = jsonl.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]) as IndexLine;
  assert.equal(entry.id, id);
  assert.equal(entry.pubkey, null);
  assert.equal(entry.signature, null);

  // Legacy drawing renders the 'anonymous' fallback (no /keys/ link).
  const drawingHtml = await fs.readFile(path.join(root, `public/d/${id}.html`), "utf8");
  assert.match(drawingHtml, /<dt>Owner<\/dt><dd>anonymous<\/dd>/);
  assert.equal(/href="\/keys\//.test(drawingHtml), false);
});
