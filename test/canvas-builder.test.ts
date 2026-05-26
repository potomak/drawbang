import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import { contentHash, hashHex } from "../src/proof-of-work.js";
import { FsStorage } from "../ingest/storage.js";
import { build } from "../builder/build.js";

function makeTile(marker: number): Uint8Array {
  const frame = new Bitmap();
  for (let i = 0; i < 16; i++) frame.set(i, (i + marker) % 16, (marker % 15) + 1);
  return encodeGif({ frames: [frame], activePalette: DEFAULT_ACTIVE_PALETTE });
}

function pngSize(bytes: Uint8Array): { w: number; h: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

function gifSize(bytes: Uint8Array): { w: number; h: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
}

function isGif(bytes: Uint8Array): boolean {
  return bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46; // "GIF"
}

test("builder sweeps a canvas inbox record → /c/<id>.html + composite, removes the record", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-cb-"));
  const storage = new FsStorage(root);

  const g0 = makeTile(1);
  const g1 = makeTile(2);
  const t0 = hashHex(await contentHash(g0));
  const t1 = hashHex(await contentHash(g1));
  await storage.put(`public/tiles/${t0}.gif`, g0, "image/gif");
  await storage.put(`public/tiles/${t1}.gif`, g1, "image/gif");

  const canvasId = "c".repeat(64);
  const rec = {
    canvas_id: canvasId,
    cols: 2,
    rows: 1,
    tiles: [t0, t1],
    user_id: "a".repeat(64),
    username: "alice",
    parent: null,
    created_at: "2026-05-24T10:00:00.000Z",
  };
  await storage.put(
    `inbox/2026-05-24/${canvasId}.canvas.json`,
    new TextEncoder().encode(JSON.stringify(rec)),
    "application/json",
  );

  await build({ storage, publicBaseUrl: "https://example.test", today: "2026-05-25" });

  const html = await fs.readFile(path.join(root, `public/c/${canvasId}.html`), "utf8");
  assert.match(html, /Canvas cccccccc/);
  assert.match(html, new RegExp(`/tiles/${t0}.gif`));
  assert.match(html, new RegExp(`/tiles/${t1}.gif`));
  assert.match(html, /<a href="\/u\/alice">alice<\/a>/);
  assert.match(html, /2×1 tiles/);

  // Multi-tile gallery thumb is an animated 32×16 composite GIF; no static .png.
  const gif = await storage.getBytes(`public/c/${canvasId}.gif`);
  assert.ok(gif, "composite gif written by builder");
  assert.ok(isGif(gif), "thumb is a GIF");
  assert.deepEqual(gifSize(gif), { w: 32, h: 16 });
  assert.equal(await storage.exists(`public/c/${canvasId}.png`), false);
  // OG -large.png is upscaled ~960.
  const large = await storage.getBytes(`public/c/${canvasId}-large.png`);
  assert.ok(large, "OG -large.png written");
  assert.ok(pngSize(large).w >= 480, `OG width upscaled, got ${pngSize(large).w}`);
  assert.match(html, new RegExp(`og:image" content="https://example.test/c/${canvasId}-large.png`));

  // Tiles are addressable at /t/<id> and the canvas links them.
  assert.match(html, new RegExp(`<a href="/t/${t0}">`));
  const tilePage = await fs.readFile(path.join(root, `public/t/${t0}.html`), "utf8");
  assert.match(tilePage, /Tile ID [0-9a-f]{8}/);
  assert.match(tilePage, new RegExp(`/tiles/${t0}.gif`));

  // Inbox record consumed.
  const inboxLeft = await storage
    .listPrefix("inbox/2026-05-24")
    .then((ks) => ks.filter((k) => k.endsWith(".canvas.json")));
  assert.equal(inboxLeft.length, 0);

  // Discoverability: the canvas is listed on the author's profile, the
  // landing gallery, and the RSS feed (linking /c/<id>).
  const profile = await fs.readFile(path.join(root, "public/u/alice.html"), "utf8");
  assert.match(profile, new RegExp(`href="/c/${canvasId}"`));
  assert.match(profile, new RegExp(`/c/${canvasId}.gif`)); // animated composite thumb
  const gallery = await fs.readFile(path.join(root, "public/gallery.html"), "utf8");
  assert.match(gallery, new RegExp(`href="/c/${canvasId}"`));
  const feed = await fs.readFile(path.join(root, "public/feed.rss"), "utf8");
  assert.match(feed, new RegExp(`/c/${canvasId}`));
  // Day archive (created_at = 2026-05-24) lists the canvas too.
  const dayPage = await fs.readFile(path.join(root, "public/days/2026-05-24/p/1.html"), "utf8");
  assert.match(dayPage, new RegExp(`href="/c/${canvasId}"`));
});

test("a 1×1 canvas uses the tile gif as its preview (no composite png)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-cb-"));
  const storage = new FsStorage(root);
  const g = makeTile(5);
  const t = hashHex(await contentHash(g));
  await storage.put(`public/tiles/${t}.gif`, g, "image/gif");
  const canvasId = "d".repeat(64);
  await storage.put(
    `inbox/2026-05-24/${canvasId}.canvas.json`,
    new TextEncoder().encode(
      JSON.stringify({
        canvas_id: canvasId,
        cols: 1,
        rows: 1,
        tiles: [t],
        user_id: "a".repeat(64),
        username: "bob",
        parent: null,
        created_at: "2026-05-24T10:00:00.000Z",
      }),
    ),
    "application/json",
  );

  await build({ storage, publicBaseUrl: "https://example.test", today: "2026-05-25" });

  const html = await fs.readFile(path.join(root, `public/c/${canvasId}.html`), "utf8");
  // 1×1: no small composite (gallery thumb uses the tile gif), but an upscaled
  // -large.png drives the OG image.
  assert.equal(await storage.exists(`public/c/${canvasId}.png`), false);
  assert.equal(await storage.exists(`public/c/${canvasId}-large.png`), true);
  assert.match(html, new RegExp(`og:image" content="https://example.test/c/${canvasId}-large.png`));
});
