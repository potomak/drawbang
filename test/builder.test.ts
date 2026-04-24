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

async function seedDrawing(root: string, day: string, marker: number): Promise<string> {
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
  await fs.writeFile(
    jsonPath,
    JSON.stringify({
      id,
      pow,
      nonce: sol.nonce,
      baseline,
      solve_ms: sol.solveMs,
      bench_hps: 12345,
      required_bits: 12,
      created_at: `${day}T10:00:00.000Z`,
      parent: null,
    }),
  );
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
