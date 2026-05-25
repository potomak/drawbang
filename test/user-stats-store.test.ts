import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  MemoryUserStatsStore,
  isImmediatelyConsecutiveMural,
  nextMuralState,
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

describe("isImmediatelyConsecutiveMural", () => {
  test("week N closes exactly when week N+1 opens", () => {
    assert.equal(isImmediatelyConsecutiveMural("mural-2026-W20", "mural-2026-W21"), true);
  });

  test("skipped week is not consecutive", () => {
    assert.equal(isImmediatelyConsecutiveMural("mural-2026-W20", "mural-2026-W22"), false);
  });

  test("same mural is not consecutive", () => {
    assert.equal(isImmediatelyConsecutiveMural("mural-2026-W20", "mural-2026-W20"), false);
  });

  test("invalid mural id is not consecutive", () => {
    assert.equal(isImmediatelyConsecutiveMural("garbage", "mural-2026-W21"), false);
  });

  test("spans the ISO-year boundary (W52 → W01 of next year)", () => {
    // ISO 2025 has 52 weeks; week 52 closes 2025-12-29 + 7 days = 2026-01-05,
    // and mural-2026-W01 opens on the Monday of ISO week 1 = 2025-12-29.
    // The two murals are NOT consecutive on the calendar — they overlap.
    // Use a clean year-boundary case: 2024 has 52 weeks ending exactly when
    // 2025-W01 opens (2024-12-30).
    const ok = isImmediatelyConsecutiveMural("mural-2024-W52", "mural-2025-W01");
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
      user_id: "p",
      daily_total: 3,
      daily_streak_current: 2,
      daily_streak_longest: 5,
      daily_last_date: "2026-05-18",
      mural_total: 0,
      mural_streak_current: 0,
      mural_streak_longest: 0,
      mural_last_id: null,
      updated_at: "",
    };
    const r = nextDailyState(prior, "2026-05-18");
    assert.equal(r.daily_total, 4);
    assert.equal(r.daily_streak_current, 2); // unchanged
    assert.equal(r.daily_streak_longest, 5); // unchanged
  });

  test("consecutive day extends the streak", () => {
    const prior = {
      user_id: "p",
      daily_total: 1,
      daily_streak_current: 1,
      daily_streak_longest: 1,
      daily_last_date: "2026-05-17",
      mural_total: 0,
      mural_streak_current: 0,
      mural_streak_longest: 0,
      mural_last_id: null,
      updated_at: "",
    };
    const r = nextDailyState(prior, "2026-05-18");
    assert.equal(r.daily_streak_current, 2);
    assert.equal(r.daily_streak_longest, 2);
    assert.equal(r.daily_total, 2);
  });

  test("non-consecutive day resets streak to 1, longest preserved", () => {
    const prior = {
      user_id: "p",
      daily_total: 10,
      daily_streak_current: 7,
      daily_streak_longest: 9,
      daily_last_date: "2026-05-10",
      mural_total: 0,
      mural_streak_current: 0,
      mural_streak_longest: 0,
      mural_last_id: null,
      updated_at: "",
    };
    const r = nextDailyState(prior, "2026-05-18");
    assert.equal(r.daily_streak_current, 1);
    assert.equal(r.daily_streak_longest, 9);
    assert.equal(r.daily_total, 11);
  });

  test("longest grows when current surpasses it", () => {
    const prior = {
      user_id: "p",
      daily_total: 5,
      daily_streak_current: 5,
      daily_streak_longest: 5,
      daily_last_date: "2026-05-17",
      mural_total: 0,
      mural_streak_current: 0,
      mural_streak_longest: 0,
      mural_last_id: null,
      updated_at: "",
    };
    const r = nextDailyState(prior, "2026-05-18");
    assert.equal(r.daily_streak_current, 6);
    assert.equal(r.daily_streak_longest, 6);
  });
});

describe("nextMuralState", () => {
  test("first publish into any mural: total=1, streak=1", () => {
    const r = nextMuralState(null, "mural-2026-W21");
    assert.equal(r.mural_total, 1);
    assert.equal(r.mural_streak_current, 1);
    assert.equal(r.mural_streak_longest, 1);
    assert.equal(r.noOp, false);
  });

  test("same mural re-publish is a no-op (multiple tiles in one mural)", () => {
    const prior = {
      user_id: "p",
      daily_total: 0, daily_streak_current: 0, daily_streak_longest: 0, daily_last_date: null,
      mural_total: 1,
      mural_streak_current: 1,
      mural_streak_longest: 1,
      mural_last_id: "mural-2026-W21",
      updated_at: "",
    };
    const r = nextMuralState(prior, "mural-2026-W21");
    assert.equal(r.noOp, true);
    assert.equal(r.mural_total, 1);
  });

  test("consecutive week extends the streak", () => {
    const prior = {
      user_id: "p",
      daily_total: 0, daily_streak_current: 0, daily_streak_longest: 0, daily_last_date: null,
      mural_total: 1,
      mural_streak_current: 1,
      mural_streak_longest: 1,
      mural_last_id: "mural-2026-W20",
      updated_at: "",
    };
    const r = nextMuralState(prior, "mural-2026-W21");
    assert.equal(r.mural_total, 2);
    assert.equal(r.mural_streak_current, 2);
    assert.equal(r.mural_streak_longest, 2);
    assert.equal(r.noOp, false);
  });

  test("skipped week resets streak to 1, longest preserved", () => {
    const prior = {
      user_id: "p",
      daily_total: 0, daily_streak_current: 0, daily_streak_longest: 0, daily_last_date: null,
      mural_total: 3,
      mural_streak_current: 3,
      mural_streak_longest: 4,
      mural_last_id: "mural-2026-W18",
      updated_at: "",
    };
    const r = nextMuralState(prior, "mural-2026-W21");
    assert.equal(r.mural_total, 4);
    assert.equal(r.mural_streak_current, 1);
    assert.equal(r.mural_streak_longest, 4);
  });
});

describe("MemoryUserStatsStore", () => {
  test("records consecutive-day streak across two days", async () => {
    const store = new MemoryUserStatsStore();
    const user_id = "a".repeat(64);
    await store.recordDailyDrawing({ user_id, date_utc: "2026-05-17", now_iso: "2026-05-17T12:00:00Z" });
    const r = await store.recordDailyDrawing({ user_id, date_utc: "2026-05-18", now_iso: "2026-05-18T12:00:00Z" });
    assert.equal(r.daily_streak_current, 2);
    assert.equal(r.daily_streak_longest, 2);
    assert.equal(r.daily_total, 2);
  });

  test("mural no-op leaves prior state untouched", async () => {
    const store = new MemoryUserStatsStore();
    const user_id = "a".repeat(64);
    await store.recordMuralParticipation({
      user_id, mural_id: "mural-2026-W21", now_iso: "2026-05-18T12:00:00Z",
    });
    const r = await store.recordMuralParticipation({
      user_id, mural_id: "mural-2026-W21", now_iso: "2026-05-18T13:00:00Z",
    });
    assert.equal(r.mural_total, 1);
    assert.equal(r.mural_streak_current, 1);
  });

  test("daily and mural counters are independent", async () => {
    const store = new MemoryUserStatsStore();
    const user_id = "a".repeat(64);
    await store.recordDailyDrawing({ user_id, date_utc: "2026-05-18", now_iso: "2026-05-18T12:00:00Z" });
    const r = await store.recordMuralParticipation({
      user_id, mural_id: "mural-2026-W21", now_iso: "2026-05-18T12:00:01Z",
    });
    assert.equal(r.daily_total, 1);
    assert.equal(r.daily_streak_current, 1);
    assert.equal(r.mural_total, 1);
    assert.equal(r.mural_streak_current, 1);
  });
});

describe("earnedBadges integration via UserStatsRow shape", () => {
  test("daily_total 7 unlocks daily-7 only", async () => {
    const { earnedBadges } = await import("../config/badges.js");
    const e = earnedBadges({ daily_total: 7, mural_total: 0 });
    assert.deepEqual(e.daily.map((b) => b.id), ["daily-7"]);
    assert.deepEqual(e.mural, []);
  });

  test("daily_total 365 unlocks every daily tier", async () => {
    const { earnedBadges } = await import("../config/badges.js");
    const e = earnedBadges({ daily_total: 365, mural_total: 0 });
    assert.deepEqual(
      e.daily.map((b) => b.id),
      ["daily-7", "daily-30", "daily-90", "daily-180", "daily-365"],
    );
  });

  test("mural_total 26 unlocks mural-10 + mural-26", async () => {
    const { earnedBadges } = await import("../config/badges.js");
    const e = earnedBadges({ daily_total: 0, mural_total: 26 });
    assert.deepEqual(e.mural.map((b) => b.id), ["mural-10", "mural-26"]);
  });
});
