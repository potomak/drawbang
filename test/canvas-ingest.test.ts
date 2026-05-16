import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import {
  INITIAL_STATE,
  contentHash,
  hashHex,
  requiredBits,
  solve,
  solveClaim,
} from "../src/pow.js";
import {
  type DrawbangIdentity,
  generateIdentity,
  pubKeyHex,
  signCanvasClaim,
  signDrawingId,
} from "../src/identity.js";
import type { Storage } from "../ingest/storage.js";
import { handleIngest, type IngestRequest } from "../ingest/handler.js";
import { handleCanvasClaim } from "../ingest/canvas-handler.js";
import { MemoryCanvasStore } from "../ingest/canvas-store.js";
import { canvasIdForDate, tileKey } from "../config/canvases.js";

class MemoryStorage implements Storage {
  private store = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async putIfAbsent(key: string, bytes: Buffer | Uint8Array, contentType: string): Promise<boolean> {
    if (this.store.has(key)) return false;
    await this.put(key, bytes, contentType);
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
    const out = new Set<string>();
    for (const key of this.store.keys()) {
      if (!key.startsWith(prefix + "/")) continue;
      const rest = key.slice(prefix.length + 1);
      const next = rest.split("/")[0];
      out.add(`${prefix}/${next}`);
    }
    return [...out];
  }
  async getBytes(key: string): Promise<Uint8Array | null> {
    return this.store.get(key)?.bytes ?? null;
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function makeGif(seed = 0): Uint8Array {
  const frame = new Bitmap();
  for (let i = 0; i < 16; i++) frame.set(i, (i + seed) % 16, 3);
  return encodeGif({ frames: [frame], activePalette: DEFAULT_ACTIVE_PALETTE });
}

async function publishBody(
  gif: Uint8Array,
  identity: DrawbangIdentity,
  baseline: string,
  extras: Partial<IngestRequest> = {},
): Promise<IngestRequest> {
  const id = hashHex(await contentHash(gif));
  const pubkey = await pubKeyHex(identity);
  const signature = await signDrawingId(identity, id);
  const bits = requiredBits(Number.POSITIVE_INFINITY);
  const sol = await solve(gif, baseline, bits);
  return {
    gif: Buffer.from(gif).toString("base64"),
    nonce: sol.nonce,
    baseline,
    solve_ms: sol.solveMs,
    bench_hps: 10_000,
    pubkey,
    signature,
    ...extras,
  };
}

async function claim(opts: {
  canvasStore: MemoryCanvasStore;
  storage: MemoryStorage;
  canvasId: string;
  x: number;
  y: number;
  identity: DrawbangIdentity;
  now: Date;
}): Promise<void> {
  const pubkey = await pubKeyHex(opts.identity);
  const signature = await signCanvasClaim(opts.identity, opts.canvasId, opts.x, opts.y);
  const baseline = INITIAL_STATE.last_publish_at;
  const bits = requiredBits(Number.POSITIVE_INFINITY);
  const solved = await solveClaim(
    { canvasId: opts.canvasId, x: opts.x, y: opts.y, pubkey },
    baseline,
    bits,
  );
  const r = await handleCanvasClaim(
    {
      canvas_id: opts.canvasId,
      x: opts.x,
      y: opts.y,
      pubkey,
      signature,
      baseline,
      nonce: solved.nonce,
    },
    {
      storage: opts.storage,
      canvasStore: opts.canvasStore,
      publicBaseUrl: "https://example.test",
      now: () => opts.now,
    },
  );
  assert.equal(r.status, 201, `claim failed: ${JSON.stringify(r.body)}`);
}

describe("ingest + canvas_claim", () => {
  test("publish with valid canvas_claim → 202 + tile published + membership recorded", async () => {
    const storage = new MemoryStorage();
    const canvasStore = new MemoryCanvasStore();
    const identity = await generateIdentity();
    const now = new Date("2026-05-13T12:00:00Z");
    const canvasId = canvasIdForDate(now);

    await claim({
      canvasStore,
      storage,
      canvasId,
      x: 5,
      y: 12,
      identity,
      now,
    });

    const gif = makeGif();
    const body = await publishBody(
      gif,
      identity,
      INITIAL_STATE.last_publish_at,
      {
        canvas_claim: { canvas_id: canvasId, x: 5, y: 12 },
      },
    );
    const r = await handleIngest(body, {
      storage,
      publicBaseUrl: "https://example.test",
      canvasStore,
      now: () => now,
    });
    assert.equal(r.status, 202);
    if (r.status !== 202) return;
    assert.equal(r.body.canvas?.canvas_id, canvasId);
    assert.equal(r.body.canvas?.x, 5);

    // Tile in store has drawing_id set.
    const tiles = await canvasStore.getTiles(canvasId);
    const tile = tiles.find((t) => t.x === 5 && t.y === 12);
    assert.equal(tile?.drawing_id, r.body.id);

    // Canvases file written.
    const memberFile = await storage.getJSON<{
      drawing_id: string;
      canvases: Array<{ id: string; x: number; y: number; claimed_by: string }>;
    }>(`public/drawings/${r.body.id}.canvases.json`);
    assert.equal(memberFile?.canvases.length, 1);
    assert.equal(memberFile?.canvases[0].id, canvasId);
    assert.equal(memberFile?.canvases[0].x, 5);

    // Drawing page contains the canvas section.
    const html = await storage.getBytes(`public/d/${r.body.id}.html`);
    assert.ok(html);
    const htmlStr = new TextDecoder().decode(html);
    assert.match(htmlStr, /Canvases/);
    assert.match(htmlStr, new RegExp(`/canvases/${canvasId}`));
  });

  test("publish with canvas_claim but no prior claim → 403", async () => {
    const storage = new MemoryStorage();
    const canvasStore = new MemoryCanvasStore();
    const identity = await generateIdentity();
    const now = new Date("2026-05-13T12:00:00Z");
    const canvasId = canvasIdForDate(now);

    const gif = makeGif();
    const body = await publishBody(
      gif,
      identity,
      INITIAL_STATE.last_publish_at,
      {
        canvas_claim: { canvas_id: canvasId, x: 5, y: 12 },
      },
    );
    const r = await handleIngest(body, {
      storage,
      publicBaseUrl: "https://example.test",
      canvasStore,
      now: () => now,
    });
    assert.equal(r.status, 403);
  });

  test("publish with canvas_claim on a locked canvas → 403", async () => {
    const storage = new MemoryStorage();
    const canvasStore = new MemoryCanvasStore();
    const identity = await generateIdentity();
    const now = new Date("2026-05-13T12:00:00Z");
    const lockedCanvas = "canvas-2026-W01";

    const gif = makeGif();
    const body = await publishBody(
      gif,
      identity,
      INITIAL_STATE.last_publish_at,
      {
        canvas_claim: { canvas_id: lockedCanvas, x: 5, y: 12 },
      },
    );
    const r = await handleIngest(body, {
      storage,
      publicBaseUrl: "https://example.test",
      canvasStore,
      now: () => now,
    });
    assert.equal(r.status, 403);
  });

  test("same gif into two different canvases → both succeed, sidecar has 2 entries", async () => {
    const storage = new MemoryStorage();
    const canvasStore = new MemoryCanvasStore();
    const identity = await generateIdentity();
    const gif = makeGif();

    // First canvas: current week
    const now1 = new Date("2026-05-13T12:00:00Z");
    const canvasA = canvasIdForDate(now1);
    await claim({ canvasStore, storage, canvasId: canvasA, x: 0, y: 0, identity, now: now1 });
    const body1 = await publishBody(gif, identity, INITIAL_STATE.last_publish_at, {
      canvas_claim: { canvas_id: canvasA, x: 0, y: 0 },
    });
    const r1 = await handleIngest(body1, {
      storage,
      publicBaseUrl: "https://example.test",
      canvasStore,
      now: () => now1,
    });
    assert.equal(r1.status, 202);
    if (r1.status !== 202) return;
    const drawingId = r1.body.id;

    // Second canvas: a week later, after cooldown elapses
    const now2 = new Date(now1.getTime() + 8 * 86_400_000);
    const canvasB = canvasIdForDate(now2);
    assert.notEqual(canvasA, canvasB);
    await claim({ canvasStore, storage, canvasId: canvasB, x: 1, y: 2, identity, now: now2 });
    const stateForBaseline = (await storage.getJSON<{ last_publish_at: string }>(
      "public/state/last-publish.json",
    ))!;
    const body2 = await publishBody(gif, identity, stateForBaseline.last_publish_at, {
      canvas_claim: { canvas_id: canvasB, x: 1, y: 2 },
    });
    const r2 = await handleIngest(body2, {
      storage,
      publicBaseUrl: "https://example.test",
      canvasStore,
      now: () => now2,
    });
    assert.equal(r2.status, 202);
    if (r2.status !== 202) return;
    assert.equal(r2.body.id, drawingId, "same gif yields same content-addressed id");

    // Sidecar shows membership in BOTH canvases.
    const memberFile = await storage.getJSON<{
      canvases: Array<{ id: string; x: number; y: number }>;
    }>(`public/drawings/${drawingId}.canvases.json`);
    assert.equal(memberFile?.canvases.length, 2);
    const ids = memberFile?.canvases.map((c) => c.id).sort();
    assert.deepEqual(ids, [canvasA, canvasB].sort());
  });

  test("publishTile on already-published tile rejects (covered by canvas-store unit)", async () => {
    // Once a tile has drawing_id set, publishTile must reject any further
    // publish attempt. This is exercised end-to-end in canvas-store.test.ts;
    // here we just confirm the handler surfaces a 4xx (claim-store can
    // return AlreadyPublishedError or NotClaimerError depending on whether
    // claim was attempted).
    const storage = new MemoryStorage();
    const canvasStore = new MemoryCanvasStore();
    const identityA = await generateIdentity();
    const identityB = await generateIdentity();
    const now = new Date("2026-05-13T12:00:00Z");
    const canvasId = canvasIdForDate(now);

    await claim({ canvasStore, storage, canvasId, x: 0, y: 0, identity: identityA, now });
    const gifA = makeGif(0);
    const bodyA = await publishBody(gifA, identityA, INITIAL_STATE.last_publish_at, {
      canvas_claim: { canvas_id: canvasId, x: 0, y: 0 },
    });
    const rA = await handleIngest(bodyA, {
      storage,
      publicBaseUrl: "https://example.test",
      canvasStore,
      now: () => now,
    });
    assert.equal(rA.status, 202);

    // B tries to publish onto the same tile without ever claiming it.
    // Wait 700s so global PoW drops back to the 14-bit bracket.
    const nowB = new Date(now.getTime() + 700_000);
    const baselineB = (await storage.getJSON<{ last_publish_at: string }>(
      "public/state/last-publish.json",
    ))!.last_publish_at;
    const gifB = makeGif(5);
    const bodyB = await publishBody(gifB, identityB, baselineB, {
      canvas_claim: { canvas_id: canvasId, x: 0, y: 0 },
    });
    const rB = await handleIngest(bodyB, {
      storage,
      publicBaseUrl: "https://example.test",
      canvasStore,
      now: () => nowB,
    });
    assert.ok(
      rB.status === 403 || rB.status === 409,
      `expected 403/409, got ${rB.status}: ${JSON.stringify(rB.body)}`,
    );
  });

  test("publish during cooldown → 429", async () => {
    const storage = new MemoryStorage();
    const canvasStore = new MemoryCanvasStore();
    const identity = await generateIdentity();
    const now = new Date("2026-05-13T12:00:00Z");
    const canvasId = canvasIdForDate(now);

    // First publish.
    await claim({ canvasStore, storage, canvasId, x: 0, y: 0, identity, now });
    const gif1 = makeGif(0);
    const body1 = await publishBody(gif1, identity, INITIAL_STATE.last_publish_at, {
      canvas_claim: { canvas_id: canvasId, x: 0, y: 0 },
    });
    const r1 = await handleIngest(body1, {
      storage,
      publicBaseUrl: "https://example.test",
      canvasStore,
      now: () => now,
    });
    assert.equal(r1.status, 202);

    // Second publish a minute later — within the 15-min cooldown.
    const now2 = new Date(now.getTime() + 60_000);
    // Need to also wait past the global publish-PoW bracket. requiredBits(60)=18
    // which would slow the test. Bump now2 past 600s so requiredBits drops to 14.
    const now3 = new Date(now.getTime() + 700_000);
    await claim({ canvasStore, storage, canvasId, x: 1, y: 0, identity, now: now3 });
    const baseline = (await storage.getJSON<{ last_publish_at: string }>(
      "public/state/last-publish.json",
    ))!.last_publish_at;
    const gif2 = makeGif(3);
    const body2 = await publishBody(gif2, identity, baseline, {
      canvas_claim: { canvas_id: canvasId, x: 1, y: 0 },
    });
    const r2 = await handleIngest(body2, {
      storage,
      publicBaseUrl: "https://example.test",
      canvasStore,
      now: () => now3,
    });
    assert.equal(r2.status, 429);
    if (r2.status === 429) {
      assert.ok((r2.body.retry_after_s ?? 0) > 0);
    }
    void now2;
    void tileKey;
  });
});
