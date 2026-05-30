import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MemoryDrawingStore, type DrawingRow } from "../ingest/drawing-store.js";
import { MemoryLikesStore } from "../ingest/likes-store.js";
import {
  handleLike,
  handleLikeCounts,
  handleMyLikes,
  handleUnlike,
  type LikesHandlerConfig,
} from "../ingest/likes-handler.js";

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

function makeConfig(seed?: (s: MemoryDrawingStore) => Promise<void>): {
  cfg: LikesHandlerConfig;
  drawingStore: MemoryDrawingStore;
} {
  const drawingStore = new MemoryDrawingStore();
  const likesStore = new MemoryLikesStore(drawingStore);
  if (seed) {
    // Fire-and-forget — the seed is sync from the caller's POV in tests.
    seed(drawingStore);
  }
  return { cfg: { likesStore, now: () => new Date(1000) }, drawingStore };
}

describe("handleLike", () => {
  test("happy path: 200 + bumps like_count", async () => {
    const { cfg, drawingStore } = makeConfig();
    await drawingStore.put(row());

    const res = await handleLike(DRAWING_ID, AUTH, cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    const after = await drawingStore.get(DRAWING_ID);
    assert.equal(after?.like_count, 1);
  });

  test("a double-like returns 409", async () => {
    const { cfg, drawingStore } = makeConfig();
    await drawingStore.put(row());

    await handleLike(DRAWING_ID, AUTH, cfg);
    const res = await handleLike(DRAWING_ID, AUTH, cfg);
    assert.equal(res.status, 409);
  });

  test("liking a missing drawing returns 404", async () => {
    const { cfg } = makeConfig();
    const res = await handleLike(DRAWING_ID, AUTH, cfg);
    assert.equal(res.status, 404);
  });

  test("invalid drawing_id returns 400", async () => {
    const { cfg } = makeConfig();
    const res = await handleLike("nope", AUTH, cfg);
    assert.equal(res.status, 400);
  });
});

describe("handleUnlike", () => {
  test("happy path: 200 + drops like_count back to 0", async () => {
    const { cfg, drawingStore } = makeConfig();
    await drawingStore.put(row());
    await handleLike(DRAWING_ID, AUTH, cfg);

    const res = await handleUnlike(DRAWING_ID, AUTH, cfg);
    assert.equal(res.status, 200);
    const after = await drawingStore.get(DRAWING_ID);
    assert.equal(after?.like_count, 0);
  });

  test("unliking without a prior like returns 409", async () => {
    const { cfg, drawingStore } = makeConfig();
    await drawingStore.put(row());

    const res = await handleUnlike(DRAWING_ID, AUTH, cfg);
    assert.equal(res.status, 409);
  });

  test("invalid drawing_id returns 400", async () => {
    const { cfg } = makeConfig();
    const res = await handleUnlike("nope", AUTH, cfg);
    assert.equal(res.status, 400);
  });
});

describe("handleMyLikes", () => {
  test("returns only the ids the caller liked", async () => {
    const { cfg, drawingStore } = makeConfig();
    await drawingStore.put(row({ drawing_id: DRAWING_ID }));
    await drawingStore.put(row({ drawing_id: ALT_ID }));
    await handleLike(DRAWING_ID, AUTH, cfg);

    const res = await handleMyLikes(`${DRAWING_ID},${ALT_ID}`, AUTH, cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { liked: [DRAWING_ID] });
    assert.match(res.headers?.["Cache-Control"] ?? "", /no-store/);
  });

  test("empty ids list returns empty array", async () => {
    const { cfg } = makeConfig();
    const res = await handleMyLikes("", AUTH, cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { liked: [] });
  });

  test("missing ids param returns empty array", async () => {
    const { cfg } = makeConfig();
    const res = await handleMyLikes(null, AUTH, cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { liked: [] });
  });

  test("invalid id in csv returns 400", async () => {
    const { cfg } = makeConfig();
    const res = await handleMyLikes(`${DRAWING_ID},not-hex`, AUTH, cfg);
    assert.equal(res.status, 400);
  });

  test(">100 ids returns 400 (BatchGetItem cap)", async () => {
    const { cfg } = makeConfig();
    const ids = Array.from({ length: 101 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    const res = await handleMyLikes(ids.join(","), AUTH, cfg);
    assert.equal(res.status, 400);
  });
});

describe("handleLikeCounts (public, anonymous)", () => {
  test("returns fresh counts for the requested ids", async () => {
    const { cfg, drawingStore } = makeConfig();
    await drawingStore.put(row({ drawing_id: DRAWING_ID }));
    await drawingStore.put(row({ drawing_id: ALT_ID }));
    await handleLike(DRAWING_ID, AUTH, cfg);
    await handleLike(DRAWING_ID, { ...AUTH, user_id: "v".repeat(64) }, cfg);
    await handleLike(ALT_ID, AUTH, cfg);

    const res = await handleLikeCounts(`${DRAWING_ID},${ALT_ID}`, cfg);
    assert.equal(res.status, 200);
    const body = res.body as { counts: Record<string, number> };
    assert.equal(body.counts[DRAWING_ID], 2);
    assert.equal(body.counts[ALT_ID], 1);
    assert.match(res.headers?.["Cache-Control"] ?? "", /no-store/);
  });

  test("missing ids param returns an empty map", async () => {
    const { cfg } = makeConfig();
    const res = await handleLikeCounts(null, cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { counts: {} });
  });

  test("invalid id returns 400", async () => {
    const { cfg } = makeConfig();
    const res = await handleLikeCounts("not-hex", cfg);
    assert.equal(res.status, 400);
  });
});
