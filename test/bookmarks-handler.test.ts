import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MemoryDrawingStore, type DrawingRow } from "../ingest/drawing-store.js";
import { MemoryBookmarksStore } from "../ingest/bookmarks-store.js";
import {
  handleBookmark,
  handleMyBookmarks,
  handleUnbookmark,
  type BookmarksHandlerConfig,
} from "../ingest/bookmarks-handler.js";

const DRAWING_ID = "a".repeat(64);
const ALT_ID = "b".repeat(64);
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

describe("handleMyBookmarks", () => {
  test("returns only the ids the caller bookmarked", async () => {
    const { cfg, drawingStore } = makeConfig();
    await drawingStore.put(row({ drawing_id: DRAWING_ID }));
    await drawingStore.put(row({ drawing_id: ALT_ID }));
    await handleBookmark(DRAWING_ID, AUTH, cfg);

    const res = await handleMyBookmarks(`${DRAWING_ID},${ALT_ID}`, AUTH, cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { bookmarked: [DRAWING_ID] });
    assert.match(res.headers?.["Cache-Control"] ?? "", /no-store/);
  });

  test("empty ids list returns empty array", async () => {
    const { cfg } = makeConfig();
    const res = await handleMyBookmarks("", AUTH, cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { bookmarked: [] });
  });

  test("missing ids param returns empty array", async () => {
    const { cfg } = makeConfig();
    const res = await handleMyBookmarks(null, AUTH, cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { bookmarked: [] });
  });

  test("invalid id in csv returns 400", async () => {
    const { cfg } = makeConfig();
    const res = await handleMyBookmarks(`${DRAWING_ID},not-hex`, AUTH, cfg);
    assert.equal(res.status, 400);
  });

  test(">100 ids returns 400 (BatchGetItem cap)", async () => {
    const { cfg } = makeConfig();
    const ids = Array.from({ length: 101 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    const res = await handleMyBookmarks(ids.join(","), AUTH, cfg);
    assert.equal(res.status, 400);
  });
});
