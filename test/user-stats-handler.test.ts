import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { handleUserStats } from "../ingest/user-stats-handler.js";
import { MemoryUserStatsStore } from "../ingest/user-stats-store.js";

describe("handleUserStats GET /users/{user_id}/stats", () => {
  test("returns 400 on malformed user_id", async () => {
    const userStatsStore = new MemoryUserStatsStore();
    const r = await handleUserStats("not-hex", { userStatsStore });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "invalid user_id" });
  });

  test("returns 400 on wrong-length hex", async () => {
    const userStatsStore = new MemoryUserStatsStore();
    const r = await handleUserStats("abcdef", { userStatsStore });
    assert.equal(r.status, 400);
  });

  test("returns 200 + zeros for a user_id with no row", async () => {
    const userStatsStore = new MemoryUserStatsStore();
    const user_id = "a".repeat(64);
    const r = await handleUserStats(user_id, { userStatsStore });
    assert.equal(r.status, 200);
    if (r.status !== 200) return;
    const b = r.body as Extract<typeof r.body, { user_id: string }>;
    assert.equal(b.user_id, user_id);
    assert.equal(b.daily_total, 0);
    assert.equal(b.daily_streak_current, 0);
    assert.equal(b.daily_streak_longest, 0);
    assert.equal(b.canvas_total, 0);
    assert.equal(b.daily_last_date, null);
    assert.equal(b.canvas_last_id, null);
    assert.deepEqual(b.daily_badges, []);
    assert.deepEqual(b.canvas_badges, []);
  });

  test("returns 200 + counters + earned badges for a populated row", async () => {
    const userStatsStore = new MemoryUserStatsStore();
    const user_id = "a".repeat(64);
    // Synthesize a state with daily_total=7 (unlocks daily-7) and
    // canvas_total=10 (unlocks canvas-10) by recording the right number
    // of events. Use distinct dates so daily-streak math doesn't reset
    // mid-loop. We want 7 consecutive days of activity.
    for (let i = 0; i < 7; i++) {
      const day = `2026-05-${String(11 + i).padStart(2, "0")}`;
      await userStatsStore.recordDailyDrawing({
        user_id,
        date_utc: day,
        now_iso: `${day}T12:00:00Z`,
      });
    }
    // Synthesize canvas_total=10 by participating in 10 distinct (not
    // necessarily consecutive) canvas IDs. Use a small spread of ISO weeks.
    const canvasIds = [
      "canvas-2026-W10", "canvas-2026-W11", "canvas-2026-W12", "canvas-2026-W13",
      "canvas-2026-W14", "canvas-2026-W15", "canvas-2026-W16", "canvas-2026-W17",
      "canvas-2026-W18", "canvas-2026-W19",
    ];
    for (const cid of canvasIds) {
      await userStatsStore.recordCanvasParticipation({
        user_id,
        canvas_id: cid,
        now_iso: "2026-05-18T12:00:00Z",
      });
    }

    const r = await handleUserStats(user_id, { userStatsStore });
    assert.equal(r.status, 200);
    if (r.status !== 200) return;
    const b = r.body as Extract<typeof r.body, { user_id: string }>;
    assert.equal(b.daily_total, 7);
    assert.equal(b.daily_streak_current, 7);
    assert.equal(b.canvas_total, 10);
    assert.equal(b.canvas_streak_current, 10);
    assert.deepEqual(b.daily_badges.map((bg) => bg.id), ["daily-7"]);
    assert.deepEqual(b.canvas_badges.map((bg) => bg.id), ["canvas-10"]);
  });

  test("sets a short cache-control on success and json content-type", async () => {
    const userStatsStore = new MemoryUserStatsStore();
    const user_id = "a".repeat(64);
    const r = await handleUserStats(user_id, { userStatsStore });
    assert.equal(r.headers["Content-Type"], "application/json");
    assert.match(r.headers["Cache-Control"], /max-age=\d+/);
  });
});
