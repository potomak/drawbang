import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MemoryDrawingStore, type DrawingRow } from "../ingest/drawing-store.js";
import { MemoryBookmarksStore } from "../ingest/bookmarks-store.js";
import {
  handleBookmark,
  handleUnbookmark,
  type BookmarksHandlerConfig,
} from "../ingest/bookmarks-handler.js";

const DRAWING_ID = "a".repeat(64);
const AUTH = { user_id: "u".repeat(64), username: "alice" };

function row(overrides: Partial<DrawingRow> = {}): DrawingRow {
  const ms = overrides.created_at_ms ?? Date.parse("2026-05-01T12:00:00.000Z");
  return {
    drawing_id: overrides.drawing_id ?? DRAWING_ID,
    size: 16,
    created_at: new Date(ms).toISOString(),
    created_at_ms: ms,
    user_id: "x".repeat(64),
    username: "bob",
    parent_id: null,
    frames: 1,
    gif_size_bytes: 1234,
  };
}

function makeConfig(): {
  cfg: BookmarksHandlerConfig;
  drawingStore: MemoryDrawingStore;
} {
  const drawingStore = new MemoryDrawingStore();
  const bookmarksStore = new MemoryBookmarksStore(drawingStore);
  return { cfg: { bookmarksStore, now: () => new Date(1000) }, drawingStore };
}

describe("handleBookmark", () => {
  test("happy path: 200 and the bookmark is visible to listBookmarkedDrawingIds", async () => {
    const { cfg, drawingStore } = makeConfig();
    await drawingStore.put(row());

    const res = await handleBookmark(DRAWING_ID, AUTH, cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    const mine = await cfg.bookmarksStore.listBookmarkedDrawingIds(AUTH.user_id, [DRAWING_ID]);
    assert.deepEqual(mine, [DRAWING_ID]);
  });

  test("a double-bookmark returns 409", async () => {
    const { cfg, drawingStore } = makeConfig();
    await drawingStore.put(row());

    await handleBookmark(DRAWING_ID, AUTH, cfg);
    const res = await handleBookmark(DRAWING_ID, AUTH, cfg);
    assert.equal(res.status, 409);
  });

  test("bookmarking a missing drawing returns 404", async () => {
    const { cfg } = makeConfig();
    const res = await handleBookmark(DRAWING_ID, AUTH, cfg);
    assert.equal(res.status, 404);
  });

  test("invalid drawing_id returns 400", async () => {
    const { cfg } = makeConfig();
    const res = await handleBookmark("nope", AUTH, cfg);
    assert.equal(res.status, 400);
  });
});

describe("handleUnbookmark", () => {
  test("happy path: 200 and the bookmark is gone", async () => {
    const { cfg, drawingStore } = makeConfig();
    await drawingStore.put(row());
    await handleBookmark(DRAWING_ID, AUTH, cfg);

    const res = await handleUnbookmark(DRAWING_ID, AUTH, cfg);
    assert.equal(res.status, 200);
    const mine = await cfg.bookmarksStore.listBookmarkedDrawingIds(AUTH.user_id, [DRAWING_ID]);
    assert.deepEqual(mine, []);
  });

  test("unbookmark without a prior bookmark returns 409", async () => {
    const { cfg, drawingStore } = makeConfig();
    await drawingStore.put(row());

    const res = await handleUnbookmark(DRAWING_ID, AUTH, cfg);
    assert.equal(res.status, 409);
  });

  test("invalid drawing_id returns 400", async () => {
    const { cfg } = makeConfig();
    const res = await handleUnbookmark("nope", AUTH, cfg);
    assert.equal(res.status, 400);
  });
});

// Read-side hydration (handleMyBookmarks) moved to hydrate-handler.ts.
// See test/hydrate-handler.test.ts.
