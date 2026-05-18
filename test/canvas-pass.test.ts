import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { canvasPass } from "../builder/canvas-pass.js";
import { FsStorage } from "../ingest/storage.js";
import { MemoryCanvasStore } from "../ingest/canvas-store.js";
import { canvasIdForDate } from "../config/canvases.js";

async function tmpStorage(): Promise<{ storage: FsStorage; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-canvaspass-"));
  return { storage: new FsStorage(root), root };
}

describe("canvas pass", () => {
  test("first run creates current canvas manifest + registry + state pointer", async () => {
    const { storage } = await tmpStorage();
    const now = new Date("2026-05-13T12:00:00Z");
    const expectedId = canvasIdForDate(now);

    const r = await canvasPass({ storage, now });
    assert.equal(r.current_canvas, expectedId);
    assert.deepEqual(r.locked_canvases, []);

    const manifest = await storage.getJSON<{ id: string; locked: boolean }>(
      `public/canvases/${expectedId}/manifest.json`,
    );
    assert.ok(manifest);
    assert.equal(manifest.id, expectedId);
    assert.equal(manifest.locked, false);

    const state = await storage.getJSON<{ canvas_id: string; tiles_total: number }>(
      "public/state/current-canvas.json",
    );
    assert.equal(state?.canvas_id, expectedId);
    assert.equal(state?.tiles_total, 256);
  });

  test("running twice on the same day is idempotent", async () => {
    const { storage } = await tmpStorage();
    const now = new Date("2026-05-13T12:00:00Z");
    await canvasPass({ storage, now });
    const manifestBefore = await storage.getBytes(
      `public/canvases/${canvasIdForDate(now)}/manifest.json`,
    );
    const registryBefore = await storage.getBytes(
      "public/canvases/index.jsonl",
    );

    await canvasPass({ storage, now });
    const manifestAfter = await storage.getBytes(
      `public/canvases/${canvasIdForDate(now)}/manifest.json`,
    );
    const registryAfter = await storage.getBytes(
      "public/canvases/index.jsonl",
    );

    assert.deepEqual(Array.from(manifestAfter!), Array.from(manifestBefore!));
    assert.deepEqual(Array.from(registryAfter!), Array.from(registryBefore!));
  });

  test("running after closes_at locks the previous canvas + opens a new one", async () => {
    const { storage } = await tmpStorage();
    // First run on Wednesday of week 20.
    const t1 = new Date("2026-05-13T12:00:00Z");
    const w20 = canvasIdForDate(t1);
    await canvasPass({ storage, now: t1 });

    // Second run a week later — week 21 should open, week 20 should lock.
    const t2 = new Date("2026-05-20T12:00:00Z");
    const w21 = canvasIdForDate(t2);
    assert.notEqual(w20, w21);

    const r2 = await canvasPass({ storage, now: t2 });
    assert.equal(r2.current_canvas, w21);
    assert.deepEqual(r2.locked_canvases, [w20]);

    const oldManifest = await storage.getJSON<{ locked: boolean }>(
      `public/canvases/${w20}/manifest.json`,
    );
    const newManifest = await storage.getJSON<{ locked: boolean }>(
      `public/canvases/${w21}/manifest.json`,
    );
    assert.equal(oldManifest?.locked, true);
    assert.equal(newManifest?.locked, false);

    // Registry contains both.
    const registry = await storage.getBytes("public/canvases/index.jsonl");
    const lines = new TextDecoder()
      .decode(registry!)
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id: string });
    const ids = lines.map((l) => l.id).sort();
    assert.deepEqual(ids, [w20, w21].sort());
  });

  test("running twice past lock boundary doesn't double-lock", async () => {
    const { storage } = await tmpStorage();
    const t1 = new Date("2026-05-13T12:00:00Z");
    const t2 = new Date("2026-05-20T12:00:00Z");
    await canvasPass({ storage, now: t1 });
    await canvasPass({ storage, now: t2 });
    const r3 = await canvasPass({ storage, now: t2 });
    assert.deepEqual(r3.locked_canvases, []); // already locked last pass
  });

  test("current-canvas.json counts claimed vs published tiles via canvasStore", async () => {
    const { storage } = await tmpStorage();
    const canvasStore = new MemoryCanvasStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const id = canvasIdForDate(now);
    const nowEpoch = Math.floor(now.getTime() / 1000);

    await canvasStore.claimTile({
      canvas_id: id,
      tile_key: "0,0",
      pubkey: "a".repeat(64),
      now_epoch: nowEpoch,
      ttl_s: 1800,
    });
    await canvasStore.claimTile({
      canvas_id: id,
      tile_key: "1,0",
      pubkey: "b".repeat(64),
      now_epoch: nowEpoch,
      ttl_s: 1800,
    });
    await canvasStore.publishTile({
      canvas_id: id,
      tile_key: "1,0",
      pubkey: "b".repeat(64),
      drawing_id: "ff",
      now_epoch: nowEpoch,
      cooldown_s: 900,
      cooldown_ttl_s: 7 * 86_400,
    });

    await canvasPass({ storage, canvasStore, now });
    const state = await storage.getJSON<{
      tiles_claimed: number;
      tiles_published: number;
    }>("public/state/current-canvas.json");
    assert.equal(state?.tiles_claimed, 1);
    assert.equal(state?.tiles_published, 1);
  });

  test("re-renders already-locked canvases from current DDB state when canvasStore is wired", async () => {
    // Reproduces and pins the W20-wipe bug: an earlier canvasPass ran without
    // canvasStore and locked the prior canvas with empty tiles + an immutable
    // cache-control. DDB still holds the publish; a subsequent pass with a
    // wired canvasStore must re-render the locked HTML from DDB rather than
    // skipping it because it's already locked in the registry.
    const { storage } = await tmpStorage();
    const canvasStore = new MemoryCanvasStore();
    const t1 = new Date("2026-05-13T12:00:00Z");
    const t2 = new Date("2026-05-20T12:00:00Z");
    const w20 = canvasIdForDate(t1);
    const drawingId = "d".repeat(64);
    const pubkey = "a".repeat(64);
    const nowEpoch1 = Math.floor(t1.getTime() / 1000);

    await canvasStore.claimTile({
      canvas_id: w20,
      tile_key: "5,5",
      pubkey,
      now_epoch: nowEpoch1,
      ttl_s: 1800,
    });
    await canvasStore.publishTile({
      canvas_id: w20,
      tile_key: "5,5",
      pubkey,
      drawing_id: drawingId,
      now_epoch: nowEpoch1,
      cooldown_s: 900,
      cooldown_ttl_s: 7 * 86_400,
    });

    // First pass at t1: W20 is current, with the published tile.
    await canvasPass({ storage, canvasStore, now: t1 });

    // Second pass at t2 WITHOUT canvasStore: W20 transitions to locked and
    // gets re-rendered with empty tiles — the bug.
    await canvasPass({ storage, now: t2 });
    const broken = await storage.getBytes(`public/canvases/${w20}.html`);
    assert.ok(broken, "expected locked canvas HTML to exist");
    const brokenHtml = new TextDecoder().decode(broken);
    assert.ok(
      !brokenHtml.includes(`/drawings/${drawingId}.gif`),
      "precondition: the without-canvasStore pass should have wiped the tile",
    );

    // Third pass at t2 WITH canvasStore: re-renders every locked canvas from
    // DDB. The published tile must come back.
    await canvasPass({ storage, canvasStore, now: t2 });
    const fixed = await storage.getBytes(`public/canvases/${w20}.html`);
    assert.ok(fixed, "expected locked canvas HTML to still exist");
    const fixedHtml = new TextDecoder().decode(fixed);
    assert.ok(
      fixedHtml.includes(`/drawings/${drawingId}.gif`),
      "expected the published tile to be re-rendered from DDB",
    );
  });
});
