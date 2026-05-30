import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MemoryDrawingStore, type DrawingRow } from "../ingest/drawing-store.js";
import {
  AlreadyLikedError,
  DrawingNotFoundError,
  MemoryLikesStore,
  NotLikedError,
} from "../ingest/likes-store.js";

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
    like_count: overrides.like_count,
  };
}

describe("MemoryLikesStore", () => {
  test("like bumps like_count on the drawing row from 0 to 1", async () => {
    const drawingStore = new MemoryDrawingStore();
    const drawing_id = "a".repeat(64);
    const liker = "b".repeat(64);
    await drawingStore.put(row({ drawing_id }));
    const likes = new MemoryLikesStore(drawingStore);

    await likes.like({ drawing_id, user_id: liker, created_at_ms: 1 });

    const after = await drawingStore.get(drawing_id);
    assert.equal(after?.like_count, 1);
  });

  test("a second like by the same user is rejected (AlreadyLikedError)", async () => {
    const drawingStore = new MemoryDrawingStore();
    const drawing_id = "a".repeat(64);
    const liker = "b".repeat(64);
    await drawingStore.put(row({ drawing_id }));
    const likes = new MemoryLikesStore(drawingStore);

    await likes.like({ drawing_id, user_id: liker, created_at_ms: 1 });
    await assert.rejects(
      likes.like({ drawing_id, user_id: liker, created_at_ms: 2 }),
      AlreadyLikedError,
    );
    const after = await drawingStore.get(drawing_id);
    assert.equal(after?.like_count, 1, "double-like did not bump the counter");
  });

  test("like on a missing drawing rejects with DrawingNotFoundError", async () => {
    const likes = new MemoryLikesStore(new MemoryDrawingStore());
    await assert.rejects(
      likes.like({ drawing_id: "a".repeat(64), user_id: "b".repeat(64), created_at_ms: 1 }),
      DrawingNotFoundError,
    );
  });

  test("unlike decrements the count and forgets the row", async () => {
    const drawingStore = new MemoryDrawingStore();
    const drawing_id = "a".repeat(64);
    const liker = "b".repeat(64);
    await drawingStore.put(row({ drawing_id }));
    const likes = new MemoryLikesStore(drawingStore);

    await likes.like({ drawing_id, user_id: liker, created_at_ms: 1 });
    await likes.unlike({ drawing_id, user_id: liker });

    const after = await drawingStore.get(drawing_id);
    assert.equal(after?.like_count, 0);
    const liked = await likes.listLikedDrawingIds(liker, [drawing_id]);
    assert.deepEqual(liked, []);
  });

  test("unlike without a prior like rejects with NotLikedError", async () => {
    const drawingStore = new MemoryDrawingStore();
    const drawing_id = "a".repeat(64);
    await drawingStore.put(row({ drawing_id }));
    const likes = new MemoryLikesStore(drawingStore);

    await assert.rejects(
      likes.unlike({ drawing_id, user_id: "b".repeat(64) }),
      NotLikedError,
    );
  });

  test("listLikedDrawingIds returns only the subset the user liked", async () => {
    const drawingStore = new MemoryDrawingStore();
    const idA = "a".repeat(64);
    const idB = "b".repeat(64);
    const idC = "c".repeat(64);
    await drawingStore.put(row({ drawing_id: idA }));
    await drawingStore.put(row({ drawing_id: idB }));
    await drawingStore.put(row({ drawing_id: idC }));
    const liker = "u".repeat(64);
    const other = "v".repeat(64);
    const likes = new MemoryLikesStore(drawingStore);

    await likes.like({ drawing_id: idA, user_id: liker, created_at_ms: 1 });
    await likes.like({ drawing_id: idC, user_id: liker, created_at_ms: 2 });
    await likes.like({ drawing_id: idB, user_id: other, created_at_ms: 3 });

    const liked = await likes.listLikedDrawingIds(liker, [idA, idB, idC]);
    assert.deepEqual(liked.sort(), [idA, idC].sort());
  });

  test("listLikedDrawingIds on an empty id list short-circuits to []", async () => {
    const likes = new MemoryLikesStore(new MemoryDrawingStore());
    const liked = await likes.listLikedDrawingIds("u".repeat(64), []);
    assert.deepEqual(liked, []);
  });

  test("listLikeCounts mirrors like_count from the drawing rows", async () => {
    const drawingStore = new MemoryDrawingStore();
    const idA = "a".repeat(64);
    const idB = "b".repeat(64);
    await drawingStore.put(row({ drawing_id: idA }));
    await drawingStore.put(row({ drawing_id: idB }));
    const likes = new MemoryLikesStore(drawingStore);
    await likes.like({ drawing_id: idA, user_id: "u".repeat(64), created_at_ms: 1 });
    await likes.like({ drawing_id: idA, user_id: "v".repeat(64), created_at_ms: 2 });
    await likes.like({ drawing_id: idB, user_id: "u".repeat(64), created_at_ms: 3 });

    const counts = await likes.listLikeCounts([idA, idB]);
    assert.equal(counts[idA], 2);
    assert.equal(counts[idB], 1);
  });

  test("listLikeCounts on missing drawings reports 0", async () => {
    const likes = new MemoryLikesStore(new MemoryDrawingStore());
    const counts = await likes.listLikeCounts(["a".repeat(64)]);
    assert.deepEqual(counts, { ["a".repeat(64)]: 0 });
  });
});
