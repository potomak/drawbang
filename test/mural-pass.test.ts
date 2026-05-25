import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { muralPass } from "../builder/mural-pass.js";
import { FsStorage } from "../ingest/storage.js";
import { MemoryMuralStore } from "../ingest/mural-store.js";
import { muralIdForDate } from "../config/murals.js";

async function tmpStorage(): Promise<{ storage: FsStorage; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-muralpass-"));
  return { storage: new FsStorage(root), root };
}

describe("mural pass", () => {
  test("first run creates current mural manifest + registry + state pointer", async () => {
    const { storage } = await tmpStorage();
    const now = new Date("2026-05-13T12:00:00Z");
    const expectedId = muralIdForDate(now);

    const r = await muralPass({ storage, now });
    assert.equal(r.current_mural, expectedId);
    assert.deepEqual(r.locked_murals, []);

    const manifest = await storage.getJSON<{ id: string; locked: boolean }>(
      `public/murals/${expectedId}/manifest.json`,
    );
    assert.ok(manifest);
    assert.equal(manifest.id, expectedId);
    assert.equal(manifest.locked, false);

    const state = await storage.getJSON<{ mural_id: string; tiles_total: number }>(
      "public/state/current-mural.json",
    );
    assert.equal(state?.mural_id, expectedId);
    assert.equal(state?.tiles_total, 256);
  });

  test("running twice on the same day is idempotent", async () => {
    const { storage } = await tmpStorage();
    const now = new Date("2026-05-13T12:00:00Z");
    await muralPass({ storage, now });
    const manifestBefore = await storage.getBytes(
      `public/murals/${muralIdForDate(now)}/manifest.json`,
    );
    const registryBefore = await storage.getBytes(
      "public/murals/index.jsonl",
    );

    await muralPass({ storage, now });
    const manifestAfter = await storage.getBytes(
      `public/murals/${muralIdForDate(now)}/manifest.json`,
    );
    const registryAfter = await storage.getBytes(
      "public/murals/index.jsonl",
    );

    assert.deepEqual(Array.from(manifestAfter!), Array.from(manifestBefore!));
    assert.deepEqual(Array.from(registryAfter!), Array.from(registryBefore!));
  });

  test("running after closes_at locks the previous mural + opens a new one", async () => {
    const { storage } = await tmpStorage();
    // First run on Wednesday of week 20.
    const t1 = new Date("2026-05-13T12:00:00Z");
    const w20 = muralIdForDate(t1);
    await muralPass({ storage, now: t1 });

    // Second run a week later — week 21 should open, week 20 should lock.
    const t2 = new Date("2026-05-20T12:00:00Z");
    const w21 = muralIdForDate(t2);
    assert.notEqual(w20, w21);

    const r2 = await muralPass({ storage, now: t2 });
    assert.equal(r2.current_mural, w21);
    assert.deepEqual(r2.locked_murals, [w20]);

    const oldManifest = await storage.getJSON<{ locked: boolean }>(
      `public/murals/${w20}/manifest.json`,
    );
    const newManifest = await storage.getJSON<{ locked: boolean }>(
      `public/murals/${w21}/manifest.json`,
    );
    assert.equal(oldManifest?.locked, true);
    assert.equal(newManifest?.locked, false);

    // Registry contains both.
    const registry = await storage.getBytes("public/murals/index.jsonl");
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
    await muralPass({ storage, now: t1 });
    await muralPass({ storage, now: t2 });
    const r3 = await muralPass({ storage, now: t2 });
    assert.deepEqual(r3.locked_murals, []); // already locked last pass
  });

  test("current-mural.json counts claimed vs published tiles via muralStore", async () => {
    const { storage } = await tmpStorage();
    const muralStore = new MemoryMuralStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const id = muralIdForDate(now);
    const nowEpoch = Math.floor(now.getTime() / 1000);

    await muralStore.claimTile({
      mural_id: id,
      tile_key: "0,0",
      user_id: "a".repeat(64),
      now_epoch: nowEpoch,
      ttl_s: 1800,
    });
    await muralStore.claimTile({
      mural_id: id,
      tile_key: "1,0",
      user_id: "b".repeat(64),
      now_epoch: nowEpoch,
      ttl_s: 1800,
    });
    await muralStore.publishTile({
      mural_id: id,
      tile_key: "1,0",
      user_id: "b".repeat(64),
      drawing_id: "ff",
      now_epoch: nowEpoch,
      cooldown_s: 900,
      cooldown_ttl_s: 7 * 86_400,
    });

    await muralPass({ storage, muralStore, now });
    const state = await storage.getJSON<{
      tiles_claimed: number;
      tiles_published: number;
    }>("public/state/current-mural.json");
    assert.equal(state?.tiles_claimed, 1);
    assert.equal(state?.tiles_published, 1);
  });

  test("re-renders already-locked murals from current DDB state when muralStore is wired", async () => {
    // Reproduces and pins the W20-wipe bug: an earlier muralPass ran without
    // muralStore and locked the prior mural with empty tiles + an immutable
    // cache-control. DDB still holds the publish; a subsequent pass with a
    // wired muralStore must re-render the locked HTML from DDB rather than
    // skipping it because it's already locked in the registry.
    const { storage } = await tmpStorage();
    const muralStore = new MemoryMuralStore();
    const t1 = new Date("2026-05-13T12:00:00Z");
    const t2 = new Date("2026-05-20T12:00:00Z");
    const w20 = muralIdForDate(t1);
    const drawingId = "d".repeat(64);
    const user_id = "a".repeat(64);
    const nowEpoch1 = Math.floor(t1.getTime() / 1000);

    await muralStore.claimTile({
      mural_id: w20,
      tile_key: "5,5",
      user_id,
      now_epoch: nowEpoch1,
      ttl_s: 1800,
    });
    await muralStore.publishTile({
      mural_id: w20,
      tile_key: "5,5",
      user_id,
      drawing_id: drawingId,
      now_epoch: nowEpoch1,
      cooldown_s: 900,
      cooldown_ttl_s: 7 * 86_400,
    });

    // First pass at t1: W20 is current, with the published tile.
    await muralPass({ storage, muralStore, now: t1 });

    // Second pass at t2 WITHOUT muralStore: W20 transitions to locked and
    // gets re-rendered with empty tiles — the bug.
    await muralPass({ storage, now: t2 });
    const broken = await storage.getBytes(`public/murals/${w20}.html`);
    assert.ok(broken, "expected locked mural HTML to exist");
    const brokenHtml = new TextDecoder().decode(broken);
    assert.ok(
      !brokenHtml.includes(`/tiles/${drawingId}.gif`),
      "precondition: the without-muralStore pass should have wiped the tile",
    );

    // Third pass at t2 WITH muralStore: re-renders every locked mural from
    // DDB. The published tile must come back.
    await muralPass({ storage, muralStore, now: t2 });
    const fixed = await storage.getBytes(`public/murals/${w20}.html`);
    assert.ok(fixed, "expected locked mural HTML to still exist");
    const fixedHtml = new TextDecoder().decode(fixed);
    assert.ok(
      fixedHtml.includes(`/tiles/${drawingId}.gif`),
      "expected the published tile to be re-rendered from DDB",
    );
  });
});
