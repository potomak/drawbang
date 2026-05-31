import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MemoryDrawingStore, type DrawingRow } from "../ingest/drawing-store.js";
import {
  AlreadyBookmarkedError,
  BookmarkDrawingNotFoundError,
  MemoryBookmarksStore,
  NotBookmarkedError,
} from "../ingest/bookmarks-store.js";

function row(overrides: Partial<DrawingRow> = {}): DrawingRow {
  const ms = overrides.created_at_ms ?? Date.parse("2026-05-01T12:00:00.000Z");
  return {
    drawing_id: overrides.drawing_id ?? "a".repeat(64),
    size: overrides.size ?? 16,
    created_at: overrides.created_at ?? new Date(ms).toISOString(),
    created_at_ms: ms,
    user_id: overrides.user_id ?? "u".repeat(64),
    username: overrides.username ?? "alice",
    parent_id: overrides.parent_id ?? null,
    frames: overrides.frames ?? 1,
    gif_size_bytes: overrides.gif_size_bytes ?? 1234,
  };
}

describe("MemoryBookmarksStore", () => {
  test("bookmark adds a row visible via listByUser", async () => {
    const drawings = new MemoryDrawingStore();
    const drawing_id = "a".repeat(64);
    const user_id = "b".repeat(64);
    await drawings.put(row({ drawing_id }));
    const bookmarks = new MemoryBookmarksStore(drawings);

    await bookmarks.bookmark({ drawing_id, user_id, created_at_ms: 1 });

    const page = await bookmarks.listByUser(user_id, { limit: 10 });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].drawing_id, drawing_id);
  });

  test("a second bookmark by the same user is rejected (AlreadyBookmarkedError)", async () => {
    const drawings = new MemoryDrawingStore();
    const drawing_id = "a".repeat(64);
    const user_id = "b".repeat(64);
    await drawings.put(row({ drawing_id }));
    const bookmarks = new MemoryBookmarksStore(drawings);

    await bookmarks.bookmark({ drawing_id, user_id, created_at_ms: 1 });
    await assert.rejects(
      bookmarks.bookmark({ drawing_id, user_id, created_at_ms: 2 }),
      AlreadyBookmarkedError,
    );
    const page = await bookmarks.listByUser(user_id, { limit: 10 });
    assert.equal(page.items.length, 1, "double-bookmark must not duplicate the row");
  });

  test("bookmark on a missing drawing rejects with BookmarkDrawingNotFoundError", async () => {
    const bookmarks = new MemoryBookmarksStore(new MemoryDrawingStore());
    await assert.rejects(
      bookmarks.bookmark({
        drawing_id: "a".repeat(64),
        user_id: "b".repeat(64),
        created_at_ms: 1,
      }),
      BookmarkDrawingNotFoundError,
    );
  });

  test("unbookmark removes the row", async () => {
    const drawings = new MemoryDrawingStore();
    const drawing_id = "a".repeat(64);
    const user_id = "b".repeat(64);
    await drawings.put(row({ drawing_id }));
    const bookmarks = new MemoryBookmarksStore(drawings);

    await bookmarks.bookmark({ drawing_id, user_id, created_at_ms: 1 });
    await bookmarks.unbookmark({ drawing_id, user_id });

    const page = await bookmarks.listByUser(user_id, { limit: 10 });
    assert.deepEqual(page.items, []);
    const subset = await bookmarks.listBookmarkedDrawingIds(user_id, [drawing_id]);
    assert.deepEqual(subset, []);
  });

  test("unbookmark without a prior bookmark rejects with NotBookmarkedError", async () => {
    const drawings = new MemoryDrawingStore();
    const drawing_id = "a".repeat(64);
    await drawings.put(row({ drawing_id }));
    const bookmarks = new MemoryBookmarksStore(drawings);

    await assert.rejects(
      bookmarks.unbookmark({ drawing_id, user_id: "b".repeat(64) }),
      NotBookmarkedError,
    );
  });

  test("listBookmarkedDrawingIds returns only the subset the user bookmarked", async () => {
    const drawings = new MemoryDrawingStore();
    const idA = "a".repeat(64);
    const idB = "b".repeat(64);
    const idC = "c".repeat(64);
    await drawings.put(row({ drawing_id: idA }));
    await drawings.put(row({ drawing_id: idB }));
    await drawings.put(row({ drawing_id: idC }));
    const me = "u".repeat(64);
    const other = "v".repeat(64);
    const bookmarks = new MemoryBookmarksStore(drawings);

    await bookmarks.bookmark({ drawing_id: idA, user_id: me, created_at_ms: 1 });
    await bookmarks.bookmark({ drawing_id: idC, user_id: me, created_at_ms: 2 });
    await bookmarks.bookmark({ drawing_id: idB, user_id: other, created_at_ms: 3 });

    const mine = await bookmarks.listBookmarkedDrawingIds(me, [idA, idB, idC]);
    assert.deepEqual(mine.sort(), [idA, idC].sort());
  });

  test("listByUser is newest-first by created_at_ms", async () => {
    const drawings = new MemoryDrawingStore();
    const idA = "a".repeat(64);
    const idB = "b".repeat(64);
    await drawings.put(row({ drawing_id: idA }));
    await drawings.put(row({ drawing_id: idB }));
    const user_id = "u".repeat(64);
    const bookmarks = new MemoryBookmarksStore(drawings);
    await bookmarks.bookmark({ drawing_id: idA, user_id, created_at_ms: 10 });
    await bookmarks.bookmark({ drawing_id: idB, user_id, created_at_ms: 20 });

    const page = await bookmarks.listByUser(user_id, { limit: 10 });
    assert.equal(page.items[0].drawing_id, idB);
    assert.equal(page.items[1].drawing_id, idA);
  });
});
