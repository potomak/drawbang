import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import {
  handleCanvasClaim,
  handleCanvasState,
  type CanvasClaimRequest,
  type CanvasStateResponseBody,
} from "../ingest/canvas-handler.js";
import { MemoryCanvasStore } from "../ingest/canvas-store.js";
import { FsStorage } from "../ingest/storage.js";
import {
  generateIdentity,
  pubKeyHex,
  signCanvasClaim,
} from "../src/identity.js";
import { solveClaim } from "../src/pow.js";
import {
  canvasIdForDate,
  canvasOpensAt,
} from "../config/canvases.js";

async function tmpStorage(): Promise<{ storage: FsStorage; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-canvas-"));
  return { storage: new FsStorage(root), root };
}

// Pick a canvas that's "active" for the chosen `now` — opens last Monday.
function liveCanvasFor(now: Date): { canvasId: string; opens: Date } {
  const id = canvasIdForDate(now);
  return { canvasId: id, opens: canvasOpensAt(id) };
}

async function buildClaim(opts: {
  canvasId: string;
  x: number;
  y: number;
  baseline: string;
  bits: number;
}): Promise<{ req: CanvasClaimRequest; pubkey: string }> {
  const id = await generateIdentity();
  const pubkey = await pubKeyHex(id);
  const signature = await signCanvasClaim(id, opts.canvasId, opts.x, opts.y);
  const solved = await solveClaim(
    { canvasId: opts.canvasId, x: opts.x, y: opts.y, pubkey },
    opts.baseline,
    opts.bits,
  );
  return {
    pubkey,
    req: {
      canvas_id: opts.canvasId,
      x: opts.x,
      y: opts.y,
      pubkey,
      signature,
      baseline: opts.baseline,
      nonce: solved.nonce,
    },
  };
}

describe("POST /canvas/claim", () => {
  test("happy path: returns 201 with claim_expires_at", async () => {
    const { storage } = await tmpStorage();
    const canvasStore = new MemoryCanvasStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const { canvasId } = liveCanvasFor(now);
    const baseline = "1970-01-01T00:00:00.000Z";
    const { req } = await buildClaim({ canvasId, x: 5, y: 12, baseline, bits: 14 });
    const r = await handleCanvasClaim(req, {
      storage,
      canvasStore,
      publicBaseUrl: "https://example.test",
      now: () => now,
    });
    assert.equal(r.status, 201);
    const body = r.body as { claim_expires_at: number; edit_url: string };
    assert.ok(body.claim_expires_at > Math.floor(now.getTime() / 1000));
    assert.equal(body.edit_url, `/?c=${canvasId}&x=5&y=12`);
  });

  test("missing pubkey → 400", async () => {
    const { storage } = await tmpStorage();
    const canvasStore = new MemoryCanvasStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const { canvasId } = liveCanvasFor(now);
    const r = await handleCanvasClaim(
      {
        canvas_id: canvasId,
        x: 0,
        y: 0,
        pubkey: "",
        signature: "0".repeat(128),
        baseline: "1970-01-01T00:00:00.000Z",
        nonce: "0",
      },
      { storage, canvasStore, publicBaseUrl: "https://example.test", now: () => now },
    );
    assert.equal(r.status, 400);
  });

  test("bad signature → 400", async () => {
    const { storage } = await tmpStorage();
    const canvasStore = new MemoryCanvasStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const { canvasId } = liveCanvasFor(now);
    const { req } = await buildClaim({
      canvasId,
      x: 0,
      y: 0,
      baseline: "1970-01-01T00:00:00.000Z",
      bits: 14,
    });
    req.signature = "0".repeat(128);
    const r = await handleCanvasClaim(req, {
      storage,
      canvasStore,
      publicBaseUrl: "https://example.test",
      now: () => now,
    });
    assert.equal(r.status, 400);
  });

  test("locked canvas → 403", async () => {
    const { storage } = await tmpStorage();
    const canvasStore = new MemoryCanvasStore();
    // Today = 2026-05-13. Pick a canvas that's already closed.
    const now = new Date("2026-05-13T12:00:00Z");
    const lockedCanvas = "canvas-2026-W01"; // closed Jan 5, 2026.
    const { req } = await buildClaim({
      canvasId: lockedCanvas,
      x: 0,
      y: 0,
      baseline: "1970-01-01T00:00:00.000Z",
      bits: 14,
    });
    const r = await handleCanvasClaim(req, {
      storage,
      canvasStore,
      publicBaseUrl: "https://example.test",
      now: () => now,
    });
    assert.equal(r.status, 403);
  });

  test("insufficient PoW → 400", async () => {
    const { storage } = await tmpStorage();
    const canvasStore = new MemoryCanvasStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const { canvasId } = liveCanvasFor(now);
    const id = await generateIdentity();
    const pubkey = await pubKeyHex(id);
    const signature = await signCanvasClaim(id, canvasId, 0, 0);
    // Trivial nonce won't satisfy 14 bits.
    const r = await handleCanvasClaim(
      {
        canvas_id: canvasId,
        x: 0,
        y: 0,
        pubkey,
        signature,
        baseline: "1970-01-01T00:00:00.000Z",
        nonce: "0",
      },
      { storage, canvasStore, publicBaseUrl: "https://example.test", now: () => now },
    );
    assert.equal(r.status, 400);
  });

  test("second pubkey on same tile → 409", async () => {
    const { storage } = await tmpStorage();
    const canvasStore = new MemoryCanvasStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const { canvasId } = liveCanvasFor(now);
    const baseline = "1970-01-01T00:00:00.000Z";

    const first = await buildClaim({ canvasId, x: 3, y: 4, baseline, bits: 14 });
    const r1 = await handleCanvasClaim(first.req, {
      storage,
      canvasStore,
      publicBaseUrl: "https://example.test",
      now: () => now,
    });
    assert.equal(r1.status, 201);

    // After the first claim, last_claim_at = nowISO and the difficulty
    // curve rises (20 bits at age < 10s). Wait until the bracket drops back
    // to 14 bits (>600s) so the second user's PoW is verifiable cheaply.
    const now2 = new Date(now.getTime() + 700_000);
    const second = await buildClaim({
      canvasId,
      x: 3,
      y: 4,
      baseline: now.toISOString(),
      bits: 14,
    });
    const r2 = await handleCanvasClaim(second.req, {
      storage,
      canvasStore,
      publicBaseUrl: "https://example.test",
      now: () => now2,
    });
    assert.equal(r2.status, 409);
  });
});

describe("GET /canvas/{id}/state", () => {
  test("unknown canvas id → 404", async () => {
    const { storage } = await tmpStorage();
    const canvasStore = new MemoryCanvasStore();
    const r = await handleCanvasState("bogus", {
      storage,
      canvasStore,
      publicBaseUrl: "https://example.test",
    });
    assert.equal(r.status, 404);
  });

  test("empty canvas → 200 with empty tiles", async () => {
    const { storage } = await tmpStorage();
    const canvasStore = new MemoryCanvasStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const { canvasId } = liveCanvasFor(now);
    const r = await handleCanvasState(canvasId, {
      storage,
      canvasStore,
      publicBaseUrl: "https://example.test",
      now: () => now,
    });
    assert.equal(r.status, 200);
    const body = r.body as CanvasStateResponseBody;
    assert.equal(body.canvas_id, canvasId);
    assert.equal(body.tiles.length, 0);
    assert.equal(body.locked, false);
    assert.match(r.headers?.["Cache-Control"] ?? "", /max-age=15/);
  });

  test("reflects an active claim and a published tile", async () => {
    const { storage } = await tmpStorage();
    const canvasStore = new MemoryCanvasStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const { canvasId } = liveCanvasFor(now);
    const baseline = "1970-01-01T00:00:00.000Z";

    // Active claim on (1,1).
    const claim1 = await buildClaim({ canvasId, x: 1, y: 1, baseline, bits: 14 });
    await handleCanvasClaim(claim1.req, {
      storage,
      canvasStore,
      publicBaseUrl: "https://example.test",
      now: () => now,
    });

    // Direct DDB-style write for the published tile (we don't need to
    // exercise the ingest path here — that's #180).
    await canvasStore.claimTile({
      canvas_id: canvasId,
      tile_key: "2,2",
      pubkey: "c".repeat(64),
      now_epoch: Math.floor(now.getTime() / 1000),
      ttl_s: 1800,
    });
    await canvasStore.publishTile({
      canvas_id: canvasId,
      tile_key: "2,2",
      pubkey: "c".repeat(64),
      drawing_id: "deadbeef",
      now_epoch: Math.floor(now.getTime() / 1000),
      cooldown_s: 900,
      cooldown_ttl_s: 7 * 86_400,
    });

    const r = await handleCanvasState(canvasId, {
      storage,
      canvasStore,
      publicBaseUrl: "https://example.test",
      now: () => now,
    });
    const body = r.body as CanvasStateResponseBody;
    assert.equal(body.tiles.length, 2);
    const claimed = body.tiles.find((t) => t.x === 1 && t.y === 1);
    const published = body.tiles.find((t) => t.x === 2 && t.y === 2);
    assert.ok(claimed?.claimed_by);
    assert.equal(published?.drawing_id, "deadbeef");
  });

  test("required_bits reflects current age of last_claim_at, not last claim's difficulty", async () => {
    const { storage } = await tmpStorage();
    const canvasStore = new MemoryCanvasStore();
    const t0 = new Date("2026-05-13T12:00:00Z");
    const { canvasId } = liveCanvasFor(t0);
    const baseline = "1970-01-01T00:00:00.000Z";

    // First-ever claim → server records last_difficulty_bits=14 (age=∞ bracket).
    const claim = await buildClaim({ canvasId, x: 3, y: 4, baseline, bits: 14 });
    const claimRes = await handleCanvasClaim(claim.req, {
      storage,
      canvasStore,
      publicBaseUrl: "https://example.test",
      now: () => t0,
    });
    assert.equal(claimRes.status, 201);

    // 300s later — age sits in the (60s, 600s] bracket → 16 bits.
    const r = await handleCanvasState(canvasId, {
      storage,
      canvasStore,
      publicBaseUrl: "https://example.test",
      now: () => new Date(t0.getTime() + 300_000),
    });
    const body = r.body as CanvasStateResponseBody;
    assert.equal(body.required_bits, 16);
    assert.equal(body.last_claim_at, t0.toISOString());
  });

  test("required_bits on a never-claimed canvas → easiest bracket", async () => {
    const { storage } = await tmpStorage();
    const canvasStore = new MemoryCanvasStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const { canvasId } = liveCanvasFor(now);
    const r = await handleCanvasState(canvasId, {
      storage,
      canvasStore,
      publicBaseUrl: "https://example.test",
      now: () => now,
    });
    const body = r.body as CanvasStateResponseBody;
    assert.equal(body.required_bits, 14);
  });

  test("locked canvas → immutable cache + locked:true", async () => {
    const { storage } = await tmpStorage();
    const canvasStore = new MemoryCanvasStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const lockedCanvas = "canvas-2026-W01";
    const r = await handleCanvasState(lockedCanvas, {
      storage,
      canvasStore,
      publicBaseUrl: "https://example.test",
      now: () => now,
    });
    assert.equal(r.status, 200);
    const body = r.body as CanvasStateResponseBody;
    assert.equal(body.locked, true);
    assert.match(r.headers?.["Cache-Control"] ?? "", /immutable/);
  });
});
