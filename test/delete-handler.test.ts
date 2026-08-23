import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { handleDeleteDrawing } from "../ingest/delete-handler.js";
import { MemoryDrawingStore, type DrawingRow } from "../ingest/drawing-store.js";
import { NoopInvalidator } from "../ingest/cache-invalidation.js";
import { FsStorage } from "../ingest/storage.js";
import { ANONYMOUS_USER_ID, ANONYMOUS_USERNAME } from "../config/constants.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ALICE = { user_id: "a".repeat(64), username: "alice" };
const BOB = { user_id: "b".repeat(64), username: "bob" };
const ADMIN = { user_id: "c".repeat(64), username: "root" };
const ID = "d".repeat(64);

function row(overrides: Partial<DrawingRow> = {}): DrawingRow {
  const ms = Date.parse("2026-05-01T12:00:00.000Z");
  return {
    drawing_id: ID,
    size: 16,
    created_at: new Date(ms).toISOString(),
    created_at_ms: ms,
    user_id: ALICE.user_id,
    username: ALICE.username,
    parent_id: null,
    frames: 1,
    gif_size_bytes: 100,
    ...overrides,
  };
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "drawbang-del-"));
  const storage = new FsStorage(dir);
  const drawingStore = new MemoryDrawingStore();
  const inv = new NoopInvalidator();
  return {
    dir,
    storage,
    drawingStore,
    inv,
    cfg: (isAdmin: (u: string) => boolean = (u) => u === ADMIN.username) => ({
      drawingStore,
      storage,
      cacheInvalidator: inv,
      isAdmin,
    }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function seed(h: Awaited<ReturnType<typeof harness>>, r: DrawingRow) {
  await h.drawingStore.put(r);
  await h.storage.put(`public/tiles/${r.drawing_id}.gif`, new Uint8Array([1]), "image/gif");
  await h.storage.put(`public/tiles/${r.drawing_id}-large.gif`, new Uint8Array([2]), "image/gif");
}

describe("handleDeleteDrawing — authorisation", () => {
  test("the author can delete their own drawing", async () => {
    const h = await harness();
    try {
      await seed(h, row());
      const res = await handleDeleteDrawing(ID, ALICE, h.cfg());
      assert.equal(res.status, 200);
      assert.equal(await h.drawingStore.get(ID), null);
    } finally {
      await h.cleanup();
    }
  });

  test("a different signed-in user cannot — 403, and nothing is removed", async () => {
    const h = await harness();
    try {
      await seed(h, row());
      const res = await handleDeleteDrawing(ID, BOB, h.cfg());
      assert.equal(res.status, 403);
      assert.ok(await h.drawingStore.get(ID), "row must survive a refused delete");
      assert.ok(await h.storage.exists(`public/tiles/${ID}.gif`), "gif must survive too");
      assert.deepEqual(h.inv.calls, [], "no cache churn on a refused delete");
    } finally {
      await h.cleanup();
    }
  });

  test("an operator on the allowlist can delete someone else's drawing", async () => {
    const h = await harness();
    try {
      await seed(h, row());
      const res = await handleDeleteDrawing(ID, ADMIN, h.cfg());
      assert.equal(res.status, 200);
      assert.equal(await h.drawingStore.get(ID), null);
    } finally {
      await h.cleanup();
    }
  });

  test("anonymous drawings are operator-only — no signed-in user 'owns' the sentinel", async () => {
    const h = await harness();
    try {
      await seed(h, row({ username: ANONYMOUS_USERNAME, user_id: ANONYMOUS_USER_ID }));
      // Even a caller who somehow held the sentinel handle is refused,
      // because ownership is never inferred for it.
      const asSentinel = { user_id: ANONYMOUS_USER_ID, username: ANONYMOUS_USERNAME };
      assert.equal((await handleDeleteDrawing(ID, asSentinel, h.cfg())).status, 403);
      assert.equal((await handleDeleteDrawing(ID, ALICE, h.cfg())).status, 403);
      assert.equal((await handleDeleteDrawing(ID, ADMIN, h.cfg())).status, 200);
    } finally {
      await h.cleanup();
    }
  });

  test("an empty allowlist grants nobody operator rights", async () => {
    const h = await harness();
    try {
      await seed(h, row());
      const res = await handleDeleteDrawing(
        ID,
        BOB,
        h.cfg(() => false)
      );
      assert.equal(res.status, 403);
    } finally {
      await h.cleanup();
    }
  });
});

describe("handleDeleteDrawing — effects", () => {
  test("clears the gif and every sidecar key", async () => {
    const h = await harness();
    try {
      await seed(h, row());
      await h.storage.put(`public/tiles/${ID}-large.mp4`, new Uint8Array([3]), "video/mp4");
      const res = await handleDeleteDrawing(ID, ALICE, h.cfg());
      assert.equal(res.status, 200);
      assert.deepEqual((res.body as { cleared_objects: string[] }).cleared_objects, [
        `public/tiles/${ID}-large.gif`,
        `public/tiles/${ID}-large.mp4`,
        `public/tiles/${ID}.gif`,
      ]);
      for (const suffix of [".gif", "-large.gif", "-large.mp4"]) {
        assert.equal(await h.storage.exists(`public/tiles/${ID}${suffix}`), false, suffix);
      }
    } finally {
      await h.cleanup();
    }
  });

  test("a missing sidecar doesn't fail the delete", async () => {
    const h = await harness();
    try {
      await seed(h, row()); // no -large.mp4 written
      const res = await handleDeleteDrawing(ID, ALICE, h.cfg());
      assert.equal(res.status, 200);
      assert.equal(await h.drawingStore.get(ID), null);
    } finally {
      await h.cleanup();
    }
  });

  test("invalidates the drawing page as well as the publish path set", async () => {
    const h = await harness();
    try {
      await seed(h, row());
      await handleDeleteDrawing(ID, ALICE, h.cfg());
      assert.deepEqual(h.inv.calls, [
        ["/", "/feed/items*", "/gallery*", "/u/alice*", "/feed.rss", `/d/${ID}*`],
      ]);
    } finally {
      await h.cleanup();
    }
  });

  test("an anonymous delete drops the /u/ path but still flushes /d/<id>", async () => {
    const h = await harness();
    try {
      await seed(h, row({ username: ANONYMOUS_USERNAME, user_id: ANONYMOUS_USER_ID }));
      await handleDeleteDrawing(ID, ADMIN, h.cfg());
      assert.deepEqual(h.inv.calls, [["/", "/feed/items*", "/gallery*", "/feed.rss", `/d/${ID}*`]]);
    } finally {
      await h.cleanup();
    }
  });

  test("unknown id is a 404, malformed id a 400", async () => {
    const h = await harness();
    try {
      assert.equal((await handleDeleteDrawing(ID, ADMIN, h.cfg())).status, 404);
      assert.equal((await handleDeleteDrawing("nope", ADMIN, h.cfg())).status, 400);
    } finally {
      await h.cleanup();
    }
  });

  test("deleting twice is a 404 the second time, not a crash", async () => {
    const h = await harness();
    try {
      await seed(h, row());
      assert.equal((await handleDeleteDrawing(ID, ALICE, h.cfg())).status, 200);
      assert.equal((await handleDeleteDrawing(ID, ALICE, h.cfg())).status, 404);
    } finally {
      await h.cleanup();
    }
  });
});
