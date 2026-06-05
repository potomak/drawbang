import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  MemoryDrawingStore,
  type DrawingRow,
} from "../ingest/drawing-store.js";
import { MemoryUserStore, type UserRecord } from "../ingest/user-store.js";
import { MemoryUserStatsStore } from "../ingest/user-stats-store.js";
import {
  renderStreakPageHandler,
  type RenderHandlersConfig,
} from "../ingest/render-handlers.js";

function row(over: Partial<DrawingRow> = {}): DrawingRow {
  const ms = over.created_at_ms ?? Date.parse("2026-05-01T12:00:00.000Z");
  return {
    drawing_id: over.drawing_id ?? "a".repeat(64),
    size: over.size ?? 16,
    created_at: over.created_at ?? new Date(ms).toISOString(),
    created_at_ms: ms,
    user_id: over.user_id ?? "u".repeat(64),
    username: over.username ?? "alice",
    parent_id: over.parent_id ?? null,
    frames: over.frames ?? 1,
    gif_size_bytes: over.gif_size_bytes ?? 1234,
    like_count: over.like_count,
  };
}

function rec(over: Partial<UserRecord> = {}): UserRecord {
  return {
    email: over.email ?? "alice@example.com",
    user_id: over.user_id ?? "u".repeat(64),
    username: over.username ?? "alice",
    password_hash: "scrypt$x$y",
    token_version: 0,
    created_at: "2026-04-01T00:00:00.000Z",
    ...over,
  };
}

function makeCfg(opts: { now?: Date; withUserStore?: boolean } = {}): {
  cfg: RenderHandlersConfig;
  drawingStore: MemoryDrawingStore;
  userStore: MemoryUserStore;
  userStatsStore: MemoryUserStatsStore;
} {
  const drawingStore = new MemoryDrawingStore();
  const userStore = new MemoryUserStore();
  const userStatsStore = new MemoryUserStatsStore();
  const cfg: RenderHandlersConfig = {
    drawingStore,
    publicBaseUrl: "https://draw.example",
    repoUrl: "https://github.com/test/test",
    userStatsStore,
    ...(opts.withUserStore === false ? {} : { userStore }),
    ...(opts.now ? { now: () => opts.now! } : {}),
  };
  return { cfg, drawingStore, userStore, userStatsStore };
}

describe("renderStreakPageHandler", () => {
  test("malformed username → 404", async () => {
    const { cfg } = makeCfg();
    const res = await renderStreakPageHandler(cfg, "BAD!user");
    assert.equal(res.status, 404);
  });

  test("unknown account with no drawings → 404", async () => {
    const { cfg } = makeCfg();
    const res = await renderStreakPageHandler(cfg, "ghost");
    assert.equal(res.status, 404);
  });

  test("known account with no drawings → 200 empty-state", async () => {
    const { cfg, userStore } = makeCfg();
    await userStore.register(rec());
    const res = await renderStreakPageHandler(cfg, "alice");
    assert.equal(res.status, 200);
    assert.match(res.body, /hasn't published any drawings yet/);
    assert.doesNotMatch(res.body, /class="st-month"/);
  });

  test("drawings across two UTC months render newest month first; earliest of the day wins", async () => {
    const { cfg, drawingStore, userStore } = makeCfg({
      now: new Date("2026-05-15T12:00:00.000Z"),
    });
    await userStore.register(rec());
    const aprMorningId = "1".repeat(64);
    const aprEveningId = "2".repeat(64);
    const mayId = "3".repeat(64);
    await drawingStore.put(
      row({
        drawing_id: aprMorningId,
        created_at_ms: Date.parse("2026-04-28T03:00:00.000Z"),
      }),
    );
    await drawingStore.put(
      row({
        drawing_id: aprEveningId,
        created_at_ms: Date.parse("2026-04-28T22:00:00.000Z"),
      }),
    );
    await drawingStore.put(
      row({
        drawing_id: mayId,
        created_at_ms: Date.parse("2026-05-01T10:00:00.000Z"),
      }),
    );

    const res = await renderStreakPageHandler(cfg, "alice");
    assert.equal(res.status, 200);

    const may = res.body.indexOf("May 2026");
    const apr = res.body.indexOf("April 2026");
    assert.ok(may > -1 && apr > -1, "both month labels must render");
    assert.ok(may < apr, "May 2026 must appear before April 2026");

    // May 1 → mayId.
    assert.match(res.body, new RegExp(`href="/d/${mayId}"`));
    // April 28 picks the EARLIER drawing (the 03:00 one).
    assert.match(res.body, new RegExp(`href="/d/${aprMorningId}"`));
    assert.doesNotMatch(res.body, new RegExp(`href="/d/${aprEveningId}"`));

    // April 29 and 30 should be empty (no drawing, in-month).
    const apr29Empty = />29</.test(res.body) && /st-day-empty/.test(res.body);
    assert.ok(apr29Empty, "expected at least one empty in-range cell");

    // Every day of April (1..27 too) must render with a day number now —
    // the calendar shows the full month even when a single day has a
    // drawing in it.
    for (const day of [1, 14, 27]) {
      assert.match(
        res.body,
        new RegExp(`<span class="st-day-num">${day}</span>`),
        `expected day ${day} to render as an empty in-month cell`,
      );
    }

    // The only out-of-range cells should be leading Monday-padding (no
    // day number on those).
    assert.match(res.body, /class="st-day st-day-out"/);

    // Counts: 3 drawings across 2 days.
    assert.match(res.body, /2 days with drawings/);
  });

  test("UTC midnight boundary: a drawing at 00:00:00 UTC maps to that day's cell", async () => {
    const { cfg, drawingStore, userStore } = makeCfg({
      now: new Date("2026-05-15T12:00:00.000Z"),
    });
    await userStore.register(rec());
    const midnightId = "4".repeat(64);
    await drawingStore.put(
      row({
        drawing_id: midnightId,
        created_at_ms: Date.parse("2026-05-01T00:00:00.000Z"),
      }),
    );
    const res = await renderStreakPageHandler(cfg, "alice");
    assert.equal(res.status, 200);
    // The thumb must be inside the May 2026 block, not April 2026.
    const may = res.body.indexOf("May 2026");
    const apr = res.body.indexOf("April 2026");
    const thumb = res.body.indexOf(`href="/d/${midnightId}"`);
    assert.ok(may > -1 && thumb > may);
    if (apr > -1) {
      assert.ok(thumb < apr, "midnight-boundary thumb belongs to May, not April");
    }
  });

  test("stats counters from userStatsStore land in the summary line", async () => {
    const { cfg, drawingStore, userStore, userStatsStore } = makeCfg({
      now: new Date("2026-05-15T12:00:00.000Z"),
    });
    await userStore.register(rec());
    await drawingStore.put(
      row({ created_at_ms: Date.parse("2026-05-10T10:00:00.000Z") }),
    );
    await userStatsStore.recordDailyDrawing({
      user_id: "u".repeat(64),
      date_utc: "2026-05-10",
      now_iso: "2026-05-10T10:00:00.000Z",
    });
    const res = await renderStreakPageHandler(cfg, "alice");
    assert.equal(res.status, 200);
    assert.match(res.body, /1-day streak/);
  });
});
