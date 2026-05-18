import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  MemoryUserStatsStore,
  isImmediatelyConsecutiveCanvas,
  nextCanvasState,
  nextDailyState,
  previousDayUtc,
} from "../ingest/user-stats-store.js";

// Pure reducers — no DDB, no I/O. The MemoryUserStatsStore tests below
// exercise the full read-modify-write flow against the same reducers.

describe("previousDayUtc", () => {
  test("rolls back one day across the month boundary", () => {
    assert.equal(previousDayUtc("2026-03-01"), "2026-02-28");
    assert.equal(previousDayUtc("2026-01-01"), "2025-12-31");
  });

  test("rolls back inside a month", () => {
    assert.equal(previousDayUtc("2026-05-18"), "2026-05-17");
  });

  test("throws on a malformed date", () => {
    assert.throws(() => previousDayUtc("not-a-date"));
  });
});

describe("isImmediatelyConsecutiveCanvas", () => {
  test("week N closes exactly when week N+1 opens", () => {
    assert.equal(isImmediatelyConsecutiveCanvas("canvas-2026-W20", "canvas-2026-W21"), true);
  });

  test("skipped week is not consecutive", () => {
    assert.equal(isImmediatelyConsecutiveCanvas("canvas-2026-W20", "canvas-2026-W22"), false);
  });

  test("same canvas is not consecutive", () => {
    assert.equal(isImmediatelyConsecutiveCanvas("canvas-2026-W20", "canvas-2026-W20"), false);
  });

  test("invalid canvas id is not consecutive", () => {
    assert.equal(isImmediatelyConsecutiveCanvas("garbage", "canvas-2026-W21"), false);
  });

  test("spans the ISO-year boundary (W52 → W01 of next year)", () => {
    // ISO 2025 has 52 weeks; week 52 closes 2025-12-29 + 7 days = 2026-01-05,
    // and canvas-2026-W01 opens on the Monday of ISO week 1 = 2025-12-29.
    // The two canvases are NOT consecutive on the calendar — they overlap.
    // Use a clean year-boundary case: 2024 has 52 weeks ending exactly when
    // 2025-W01 opens (2024-12-30).
    const ok = isImmediatelyConsecutiveCanvas("canvas-2024-W52", "canvas-2025-W01");
    assert.equal(ok, true);
  });
});

describe("nextDailyState", () => {
  test("first publish ever: total=1, streak=1", () => {
    const r = nextDailyState(null, "2026-05-18");
    assert.deepEqual(r, {
      daily_total: 1,
      daily_streak_current: 1,
      daily_streak_longest: 1,
      daily_last_date: "2026-05-18",
    });
  });

  test("same-day re-publish: total++, streak unchanged", () => {
    const prior = {
      pubkey: "p",
      daily_total: 3,
      daily_streak_current: 2,
      daily_streak_longest: 5,
      daily_last_date: "2026-05-18",
      canvas_total: 0,
      canvas_streak_current: 0,
      canvas_streak_longest: 0,
      canvas_last_id: null,
      updated_at: "",
    };
    const r = nextDailyState(prior, "2026-05-18");
    assert.equal(r.daily_total, 4);
    assert.equal(r.daily_streak_current, 2); // unchanged
    assert.equal(r.daily_streak_longest, 5); // unchanged
  });

  test("consecutive day extends the streak", () => {
    const prior = {
      pubkey: "p",
      daily_total: 1,
      daily_streak_current: 1,
      daily_streak_longest: 1,
      daily_last_date: "2026-05-17",
      canvas_total: 0,
      canvas_streak_current: 0,
      canvas_streak_longest: 0,
      canvas_last_id: null,
      updated_at: "",
    };
    const r = nextDailyState(prior, "2026-05-18");
    assert.equal(r.daily_streak_current, 2);
    assert.equal(r.daily_streak_longest, 2);
    assert.equal(r.daily_total, 2);
  });

  test("non-consecutive day resets streak to 1, longest preserved", () => {
    const prior = {
      pubkey: "p",
      daily_total: 10,
      daily_streak_current: 7,
      daily_streak_longest: 9,
      daily_last_date: "2026-05-10",
      canvas_total: 0,
      canvas_streak_current: 0,
      canvas_streak_longest: 0,
      canvas_last_id: null,
      updated_at: "",
    };
    const r = nextDailyState(prior, "2026-05-18");
    assert.equal(r.daily_streak_current, 1);
    assert.equal(r.daily_streak_longest, 9);
    assert.equal(r.daily_total, 11);
  });

  test("longest grows when current surpasses it", () => {
    const prior = {
      pubkey: "p",
      daily_total: 5,
      daily_streak_current: 5,
      daily_streak_longest: 5,
      daily_last_date: "2026-05-17",
      canvas_total: 0,
      canvas_streak_current: 0,
      canvas_streak_longest: 0,
      canvas_last_id: null,
      updated_at: "",
    };
    const r = nextDailyState(prior, "2026-05-18");
    assert.equal(r.daily_streak_current, 6);
    assert.equal(r.daily_streak_longest, 6);
  });
});

describe("nextCanvasState", () => {
  test("first publish into any canvas: total=1, streak=1", () => {
    const r = nextCanvasState(null, "canvas-2026-W21");
    assert.equal(r.canvas_total, 1);
    assert.equal(r.canvas_streak_current, 1);
    assert.equal(r.canvas_streak_longest, 1);
    assert.equal(r.noOp, false);
  });

  test("same canvas re-publish is a no-op (multiple tiles in one canvas)", () => {
    const prior = {
      pubkey: "p",
      daily_total: 0, daily_streak_current: 0, daily_streak_longest: 0, daily_last_date: null,
      canvas_total: 1,
      canvas_streak_current: 1,
      canvas_streak_longest: 1,
      canvas_last_id: "canvas-2026-W21",
      updated_at: "",
    };
    const r = nextCanvasState(prior, "canvas-2026-W21");
    assert.equal(r.noOp, true);
    assert.equal(r.canvas_total, 1);
  });

  test("consecutive week extends the streak", () => {
    const prior = {
      pubkey: "p",
      daily_total: 0, daily_streak_current: 0, daily_streak_longest: 0, daily_last_date: null,
      canvas_total: 1,
      canvas_streak_current: 1,
      canvas_streak_longest: 1,
      canvas_last_id: "canvas-2026-W20",
      updated_at: "",
    };
    const r = nextCanvasState(prior, "canvas-2026-W21");
    assert.equal(r.canvas_total, 2);
    assert.equal(r.canvas_streak_current, 2);
    assert.equal(r.canvas_streak_longest, 2);
    assert.equal(r.noOp, false);
  });

  test("skipped week resets streak to 1, longest preserved", () => {
    const prior = {
      pubkey: "p",
      daily_total: 0, daily_streak_current: 0, daily_streak_longest: 0, daily_last_date: null,
      canvas_total: 3,
      canvas_streak_current: 3,
      canvas_streak_longest: 4,
      canvas_last_id: "canvas-2026-W18",
      updated_at: "",
    };
    const r = nextCanvasState(prior, "canvas-2026-W21");
    assert.equal(r.canvas_total, 4);
    assert.equal(r.canvas_streak_current, 1);
    assert.equal(r.canvas_streak_longest, 4);
  });
});

describe("MemoryUserStatsStore", () => {
  test("records consecutive-day streak across two days", async () => {
    const store = new MemoryUserStatsStore();
    const pubkey = "a".repeat(64);
    await store.recordDailyDrawing({ pubkey, date_utc: "2026-05-17", now_iso: "2026-05-17T12:00:00Z" });
    const r = await store.recordDailyDrawing({ pubkey, date_utc: "2026-05-18", now_iso: "2026-05-18T12:00:00Z" });
    assert.equal(r.daily_streak_current, 2);
    assert.equal(r.daily_streak_longest, 2);
    assert.equal(r.daily_total, 2);
  });

  test("canvas no-op leaves prior state untouched", async () => {
    const store = new MemoryUserStatsStore();
    const pubkey = "a".repeat(64);
    await store.recordCanvasParticipation({
      pubkey, canvas_id: "canvas-2026-W21", now_iso: "2026-05-18T12:00:00Z",
    });
    const r = await store.recordCanvasParticipation({
      pubkey, canvas_id: "canvas-2026-W21", now_iso: "2026-05-18T13:00:00Z",
    });
    assert.equal(r.canvas_total, 1);
    assert.equal(r.canvas_streak_current, 1);
  });

  test("daily and canvas counters are independent", async () => {
    const store = new MemoryUserStatsStore();
    const pubkey = "a".repeat(64);
    await store.recordDailyDrawing({ pubkey, date_utc: "2026-05-18", now_iso: "2026-05-18T12:00:00Z" });
    const r = await store.recordCanvasParticipation({
      pubkey, canvas_id: "canvas-2026-W21", now_iso: "2026-05-18T12:00:01Z",
    });
    assert.equal(r.daily_total, 1);
    assert.equal(r.daily_streak_current, 1);
    assert.equal(r.canvas_total, 1);
    assert.equal(r.canvas_streak_current, 1);
  });
});

describe("earnedBadges integration via UserStatsRow shape", () => {
  test("daily_total 7 unlocks daily-7 only", async () => {
    const { earnedBadges } = await import("../config/badges.js");
    const e = earnedBadges({ daily_total: 7, canvas_total: 0 });
    assert.deepEqual(e.daily.map((b) => b.id), ["daily-7"]);
    assert.deepEqual(e.canvas, []);
  });

  test("daily_total 365 unlocks every daily tier", async () => {
    const { earnedBadges } = await import("../config/badges.js");
    const e = earnedBadges({ daily_total: 365, canvas_total: 0 });
    assert.deepEqual(
      e.daily.map((b) => b.id),
      ["daily-7", "daily-30", "daily-90", "daily-180", "daily-365"],
    );
  });

  test("canvas_total 26 unlocks canvas-10 + canvas-26", async () => {
    const { earnedBadges } = await import("../config/badges.js");
    const e = earnedBadges({ daily_total: 0, canvas_total: 26 });
    assert.deepEqual(e.canvas.map((b) => b.id), ["canvas-10", "canvas-26"]);
  });
});
