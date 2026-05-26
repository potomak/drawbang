import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import { INITIAL_STATE, contentHash, hashHex, requiredBits, solve } from "../src/pow.js";
import { canonicalCanvasString, canvasIdFor, type CanvasManifest } from "../config/canvas.js";
import type { Storage } from "../ingest/storage.js";
import {
  handleCanvasPublish,
  type CanvasPublishConfig,
} from "../ingest/canvas-publish-handler.js";
import type { AuthedUser } from "../ingest/handler.js";

class MemoryStorage implements Storage {
  private store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async putIfAbsent(key: string, bytes: Buffer | Uint8Array, ct: string): Promise<boolean> {
    if (this.store.has(key)) return false;
    await this.put(key, bytes, ct);
    return true;
  }
  async put(key: string, bytes: Buffer | Uint8Array, contentType: string): Promise<void> {
    this.store.set(key, { bytes: new Uint8Array(bytes), contentType });
  }
  async getJSON<T>(key: string): Promise<T | null> {
    const v = this.store.get(key);
    return v ? (JSON.parse(new TextDecoder().decode(v.bytes)) as T) : null;
  }
  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }
  async listPrefix(prefix: string): Promise<string[]> {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
  async getBytes(key: string): Promise<Uint8Array | null> {
    return this.store.get(key)?.bytes ?? null;
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }
  keys(): string[] {
    return [...this.store.keys()];
  }
}

const ALICE: AuthedUser = { user_id: "a".repeat(64), username: "alice" };

function makeTile(marker: number): Uint8Array {
  const frame = new Bitmap();
  for (let i = 0; i < 16; i++) frame.set(i, (i + marker) % 16, (marker % 15) + 1);
  return encodeGif({ frames: [frame], activePalette: DEFAULT_ACTIVE_PALETTE });
}

const BASELINE = INITIAL_STATE.last_publish_at;
const BITS = requiredBits(Number.POSITIVE_INFINITY); // 14

async function buildReq(
  cells: { x: number; y: number; gif: Uint8Array }[],
  cols: number,
  rows: number,
) {
  const grid: (string | null)[] = Array(cols * rows).fill(null);
  for (const c of cells) grid[c.y * cols + c.x] = hashHex(await contentHash(c.gif));
  const manifest: CanvasManifest = { cols, rows, tiles: grid };
  const canonical = new TextEncoder().encode(canonicalCanvasString(manifest));
  const sol = await solve(canonical, BASELINE, BITS);
  return {
    manifest,
    req: {
      cols,
      rows,
      tiles: cells.map((c) => ({ x: c.x, y: c.y, gif: Buffer.from(c.gif).toString("base64") })),
      nonce: sol.nonce,
      baseline: BASELINE,
      solve_ms: sol.solveMs,
      bench_hps: 5000,
    },
  };
}

function cfg(storage: Storage, over: Partial<CanvasPublishConfig> = {}): CanvasPublishConfig {
  return {
    storage,
    publicBaseUrl: "https://example.test",
    auth: ALICE,
    now: () => new Date("2026-05-24T12:00:00.000Z"),
    ...over,
  };
}

function pngSize(bytes: Uint8Array): { w: number; h: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

describe("POST /canvas", () => {
  test("publishes a 2×2 canvas: stores 4 tiles + manifest + page + OG", async () => {
    const storage = new MemoryStorage();
    const cells = [
      { x: 0, y: 0, gif: makeTile(1) },
      { x: 1, y: 0, gif: makeTile(2) },
      { x: 0, y: 1, gif: makeTile(3) },
      { x: 1, y: 1, gif: makeTile(4) },
    ];
    const { manifest, req } = await buildReq(cells, 2, 2);
    const r = await handleCanvasPublish(req, cfg(storage));
    assert.equal(r.status, 202);
    const body = r.body as { canvas_id: string; tile_ids: string[] };
    assert.equal(body.canvas_id, await canvasIdFor(manifest));
    assert.equal(body.tile_ids.length, 4);

    for (const id of body.tile_ids) {
      assert.ok(await storage.exists(`public/tiles/${id}.gif`), `tile ${id} stored`);
    }
    const doc = await storage.getJSON<{ cols: number; rows: number; tiles: (string | null)[]; username: string }>(
      `public/c/${body.canvas_id}.json`,
    );
    assert.equal(doc?.cols, 2);
    assert.equal(doc?.username, "alice");
    assert.deepEqual(doc?.tiles, manifest.tiles);

    // The gallery thumbnail (animated /c/<id>.gif) is builder-only; the handler
    // sync-renders only the page + OG so a fresh canvas is shareable immediately.
    assert.equal(await storage.exists(`public/c/${body.canvas_id}.gif`), false);
    assert.equal(await storage.exists(`public/c/${body.canvas_id}.png`), false);

    // The page + OG image are sync-rendered at publish (live immediately, like /d/).
    const page = await storage.getBytes(`public/c/${body.canvas_id}.html`);
    assert.ok(page, "canvas page sync-rendered at publish");
    assert.match(new TextDecoder().decode(page), /Canvas [0-9a-f]{8}/);
    const large = await storage.getBytes(`public/c/${body.canvas_id}-large.png`);
    assert.ok(large, "OG -large.png written at publish");
    assert.ok(pngSize(large).w >= 480, "OG upscaled");

    // inbox record for the builder
    const inbox = await storage.listPrefix("inbox/2026-05-24/");
    assert.equal(inbox.some((k) => k.endsWith(`${body.canvas_id}.canvas.json`)), true);
  });

  test("a 1×1 canvas stores one tile and no composite png", async () => {
    const storage = new MemoryStorage();
    const { req } = await buildReq([{ x: 0, y: 0, gif: makeTile(7) }], 1, 1);
    const r = await handleCanvasPublish(req, cfg(storage));
    assert.equal(r.status, 202);
    const body = r.body as { canvas_id: string; tile_ids: string[] };
    assert.equal(body.tile_ids.length, 1);
    assert.equal(await storage.exists(`public/c/${body.canvas_id}.png`), false);
  });

  test("dedups identical tiles in different cells", async () => {
    const storage = new MemoryStorage();
    const same = makeTile(9);
    const { req } = await buildReq(
      [
        { x: 0, y: 0, gif: same },
        { x: 1, y: 0, gif: same },
      ],
      2,
      1,
    );
    const r = await handleCanvasPublish(req, cfg(storage));
    assert.equal(r.status, 202);
    const tileGifs = storage.keys().filter((k) => k.startsWith("public/tiles/"));
    assert.equal(tileGifs.length, 1, "identical tiles stored once");
  });

  test("idempotent: re-publishing the same canvas returns 200, same id", async () => {
    const storage = new MemoryStorage();
    const cells = [{ x: 0, y: 0, gif: makeTile(1) }, { x: 1, y: 0, gif: makeTile(2) }];
    const { req } = await buildReq(cells, 2, 1);
    const first = await handleCanvasPublish(req, cfg(storage));
    assert.equal(first.status, 202);
    // second publish needs a baseline that matches the advanced state.
    const { req: req2 } = await buildReq(cells, 2, 1);
    const second = await handleCanvasPublish(req2, cfg(storage, { now: () => new Date("2026-05-24T13:00:01.000Z") }));
    assert.equal(second.status, 200);
    assert.equal((first.body as { canvas_id: string }).canvas_id, (second.body as { canvas_id: string }).canvas_id);
  });

  test("rejects insufficient PoW", async () => {
    const storage = new MemoryStorage();
    const grid = [hashHex(await contentHash(makeTile(1)))];
    const manifest: CanvasManifest = { cols: 1, rows: 1, tiles: grid };
    const req = {
      cols: 1,
      rows: 1,
      tiles: [{ x: 0, y: 0, gif: Buffer.from(makeTile(1)).toString("base64") }],
      nonce: "0", // won't satisfy 14 bits
      baseline: BASELINE,
    };
    void manifest;
    const r = await handleCanvasPublish(req, cfg(storage));
    assert.equal(r.status, 400);
  });

  test("rejects an oversized shape", async () => {
    const storage = new MemoryStorage();
    const { req } = await buildReq([{ x: 0, y: 0, gif: makeTile(1) }], 5, 1);
    const r = await handleCanvasPublish(req, cfg(storage));
    assert.equal(r.status, 400);
  });
});
