import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import {
  MemoryCanvasStore,
  TileLockedError,
  ClaimExpiredError,
  NotClaimerError,
  CooldownError,
  AlreadyPublishedError,
  type CanvasStore,
} from "../ingest/canvas-store.js";

const CANVAS = "canvas-2026-W20";
const TILE = "5,12";
const PUBKEY_A = "a".repeat(64);
const PUBKEY_B = "b".repeat(64);
const TTL = 1800;
const COOLDOWN = 900;
const COOLDOWN_TTL = 7 * 86_400;
const NOW = 1_700_000_000;

function makeStores(): Array<{ name: string; build: () => CanvasStore }> {
  return [{ name: "MemoryCanvasStore", build: () => new MemoryCanvasStore() }];
}

for (const { name, build } of makeStores()) {
  describe(name, () => {
    test("claim on a fresh tile succeeds", async () => {
      const s = build();
      const r = await s.claimTile({
        canvas_id: CANVAS,
        tile_key: TILE,
        user_id: PUBKEY_A,
        now_epoch: NOW,
        ttl_s: TTL,
      });
      assert.equal(r.claim_expires_at, NOW + TTL);
    });

    test("second user_id can't claim an active tile", async () => {
      const s = build();
      await s.claimTile({
        canvas_id: CANVAS,
        tile_key: TILE,
        user_id: PUBKEY_A,
        now_epoch: NOW,
        ttl_s: TTL,
      });
      await assert.rejects(
        () =>
          s.claimTile({
            canvas_id: CANVAS,
            tile_key: TILE,
            user_id: PUBKEY_B,
            now_epoch: NOW + 1,
            ttl_s: TTL,
          }),
        (err: unknown) => err instanceof TileLockedError,
      );
    });

    test("expired claim can be re-claimed by anyone", async () => {
      const s = build();
      await s.claimTile({
        canvas_id: CANVAS,
        tile_key: TILE,
        user_id: PUBKEY_A,
        now_epoch: NOW,
        ttl_s: TTL,
      });
      const r = await s.claimTile({
        canvas_id: CANVAS,
        tile_key: TILE,
        user_id: PUBKEY_B,
        now_epoch: NOW + TTL + 1,
        ttl_s: TTL,
      });
      assert.equal(r.claim_expires_at, NOW + TTL + 1 + TTL);
    });

    test("same user_id can refresh their own active claim", async () => {
      const s = build();
      await s.claimTile({
        canvas_id: CANVAS,
        tile_key: TILE,
        user_id: PUBKEY_A,
        now_epoch: NOW,
        ttl_s: TTL,
      });
      const r = await s.claimTile({
        canvas_id: CANVAS,
        tile_key: TILE,
        user_id: PUBKEY_A,
        now_epoch: NOW + 100,
        ttl_s: TTL,
      });
      assert.equal(r.claim_expires_at, NOW + 100 + TTL);
    });

    test("concurrent claim of same tile: exactly one wins", async () => {
      const s = build();
      const results = await Promise.allSettled([
        s.claimTile({
          canvas_id: CANVAS,
          tile_key: TILE,
          user_id: PUBKEY_A,
          now_epoch: NOW,
          ttl_s: TTL,
        }),
        s.claimTile({
          canvas_id: CANVAS,
          tile_key: TILE,
          user_id: PUBKEY_B,
          now_epoch: NOW,
          ttl_s: TTL,
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1, "exactly one claim should succeed");
      assert.equal(rejected.length, 1, "exactly one claim should fail");
      assert.ok(
        (rejected[0] as PromiseRejectedResult).reason instanceof TileLockedError,
      );
    });

    test("publish with valid claim succeeds, drawing_id stored", async () => {
      const s = build();
      await s.claimTile({
        canvas_id: CANVAS,
        tile_key: TILE,
        user_id: PUBKEY_A,
        now_epoch: NOW,
        ttl_s: TTL,
      });
      await s.publishTile({
        canvas_id: CANVAS,
        tile_key: TILE,
        user_id: PUBKEY_A,
        drawing_id: "deadbeef",
        now_epoch: NOW + 60,
        cooldown_s: COOLDOWN,
        cooldown_ttl_s: COOLDOWN_TTL,
      });
      const tiles = await s.getTiles(CANVAS);
      assert.equal(tiles.length, 1);
      assert.equal(tiles[0].drawing_id, "deadbeef");
      assert.equal(tiles[0].published_at, NOW + 60);
    });

    test("publish during cooldown is rejected with retry seconds", async () => {
      const s = build();
      // First publish: claim → publish.
      await s.claimTile({
        canvas_id: CANVAS,
        tile_key: "0,0",
        user_id: PUBKEY_A,
        now_epoch: NOW,
        ttl_s: TTL,
      });
      await s.publishTile({
        canvas_id: CANVAS,
        tile_key: "0,0",
        user_id: PUBKEY_A,
        drawing_id: "first",
        now_epoch: NOW,
        cooldown_s: COOLDOWN,
        cooldown_ttl_s: COOLDOWN_TTL,
      });
      // Second publish a moment later → cooldown.
      await s.claimTile({
        canvas_id: CANVAS,
        tile_key: "1,0",
        user_id: PUBKEY_A,
        now_epoch: NOW + 60,
        ttl_s: TTL,
      });
      await assert.rejects(
        () =>
          s.publishTile({
            canvas_id: CANVAS,
            tile_key: "1,0",
            user_id: PUBKEY_A,
            drawing_id: "second",
            now_epoch: NOW + 60,
            cooldown_s: COOLDOWN,
            cooldown_ttl_s: COOLDOWN_TTL,
          }),
        (err: unknown) => {
          if (!(err instanceof CooldownError)) return false;
          assert.equal(err.retry_after_s, COOLDOWN - 60);
          return true;
        },
      );
    });

    test("publish after cooldown elapses succeeds", async () => {
      const s = build();
      await s.claimTile({
        canvas_id: CANVAS,
        tile_key: "0,0",
        user_id: PUBKEY_A,
        now_epoch: NOW,
        ttl_s: TTL,
      });
      await s.publishTile({
        canvas_id: CANVAS,
        tile_key: "0,0",
        user_id: PUBKEY_A,
        drawing_id: "first",
        now_epoch: NOW,
        cooldown_s: COOLDOWN,
        cooldown_ttl_s: COOLDOWN_TTL,
      });
      await s.claimTile({
        canvas_id: CANVAS,
        tile_key: "1,0",
        user_id: PUBKEY_A,
        now_epoch: NOW + COOLDOWN,
        ttl_s: TTL,
      });
      await s.publishTile({
        canvas_id: CANVAS,
        tile_key: "1,0",
        user_id: PUBKEY_A,
        drawing_id: "second",
        now_epoch: NOW + COOLDOWN,
        cooldown_s: COOLDOWN,
        cooldown_ttl_s: COOLDOWN_TTL,
      });
    });

    test("publish with expired claim rejected", async () => {
      const s = build();
      await s.claimTile({
        canvas_id: CANVAS,
        tile_key: TILE,
        user_id: PUBKEY_A,
        now_epoch: NOW,
        ttl_s: TTL,
      });
      await assert.rejects(
        () =>
          s.publishTile({
            canvas_id: CANVAS,
            tile_key: TILE,
            user_id: PUBKEY_A,
            drawing_id: "x",
            now_epoch: NOW + TTL + 1,
            cooldown_s: COOLDOWN,
            cooldown_ttl_s: COOLDOWN_TTL,
          }),
        (err: unknown) => err instanceof ClaimExpiredError,
      );
    });

    test("publish from different user_id rejected", async () => {
      const s = build();
      await s.claimTile({
        canvas_id: CANVAS,
        tile_key: TILE,
        user_id: PUBKEY_A,
        now_epoch: NOW,
        ttl_s: TTL,
      });
      await assert.rejects(
        () =>
          s.publishTile({
            canvas_id: CANVAS,
            tile_key: TILE,
            user_id: PUBKEY_B,
            drawing_id: "x",
            now_epoch: NOW + 60,
            cooldown_s: COOLDOWN,
            cooldown_ttl_s: COOLDOWN_TTL,
          }),
        (err: unknown) => err instanceof NotClaimerError,
      );
    });

    test("claim on already-published tile rejected", async () => {
      const s = build();
      await s.claimTile({
        canvas_id: CANVAS,
        tile_key: TILE,
        user_id: PUBKEY_A,
        now_epoch: NOW,
        ttl_s: TTL,
      });
      await s.publishTile({
        canvas_id: CANVAS,
        tile_key: TILE,
        user_id: PUBKEY_A,
        drawing_id: "x",
        now_epoch: NOW + 60,
        cooldown_s: COOLDOWN,
        cooldown_ttl_s: COOLDOWN_TTL,
      });
      await assert.rejects(
        () =>
          s.claimTile({
            canvas_id: CANVAS,
            tile_key: TILE,
            user_id: PUBKEY_B,
            now_epoch: NOW + 10_000,
            ttl_s: TTL,
          }),
        (err: unknown) => err instanceof AlreadyPublishedError,
      );
    });

    test("getTiles returns rows with x,y coords populated", async () => {
      const s = build();
      await s.claimTile({
        canvas_id: CANVAS,
        tile_key: "7,11",
        user_id: PUBKEY_A,
        now_epoch: NOW,
        ttl_s: TTL,
      });
      const tiles = await s.getTiles(CANVAS);
      assert.equal(tiles.length, 1);
      assert.equal(tiles[0].x, 7);
      assert.equal(tiles[0].y, 11);
    });

    test("cooldownRemaining returns 0 with no prior publish", async () => {
      const s = build();
      assert.equal(
        await s.cooldownRemaining(PUBKEY_A, CANVAS, NOW, COOLDOWN),
        0,
      );
    });
  });
}
