import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MemoryDrawingStore, type DrawingRow } from "../ingest/drawing-store.js";
import { MemoryBookmarksStore } from "../ingest/bookmarks-store.js";
import {
  renderBookmarksPageHandler,
  renderMyBookmarksFeedHandler,
  type RenderHandlersConfig,
} from "../ingest/render-handlers.js";

function row(overrides: Partial<DrawingRow> = {}): DrawingRow {
  const ms = overrides.created_at_ms ?? Date.parse("2026-05-01T12:00:00.000Z");
  return {
    drawing_id: overrides.drawing_id ?? "a".repeat(64),
    size: 16,
    created_at: new Date(ms).toISOString(),
    created_at_ms: ms,
    user_id: overrides.user_id ?? "u".repeat(64),
    username: overrides.username ?? "bob",
    parent_id: null,
    frames: 1,
    gif_size_bytes: 1234,
  };
}

function makeConfig(): {
  cfg: RenderHandlersConfig;
  drawingStore: MemoryDrawingStore;
  bookmarksStore: MemoryBookmarksStore;
} {
  const drawingStore = new MemoryDrawingStore();
  const bookmarksStore = new MemoryBookmarksStore(drawingStore);
  return {
    drawingStore,
    bookmarksStore,
    cfg: {
      drawingStore,
      bookmarksStore,
      publicBaseUrl: "https://draw.example",
      repoUrl: "https://github.com/test/test",
      perPage: 10,
    },
  };
}

describe("renderBookmarksPageHandler", () => {
  test("renders an uncached shell with no per-user data", async () => {
    const { cfg } = makeConfig();
    const res = await renderBookmarksPageHandler(cfg, "alice");
    assert.equal(res.status, 200);
    assert.match(res.cacheControl, /no-store/);
    assert.match(res.cacheControl, /private/);
    assert.match(res.body, /Your bookmarks/);
    assert.match(res.body, /data-bookmarks-list/);
    // The inline boot script must be there to wire up the auth+fetch dance.
    assert.match(res.body, /drawbang:jwt/);
    assert.match(res.body, /\/me\/bookmarks\/feed/);
  });

  test("the SSR'd page is byte-identical for two different usernames except for the data attribute", async () => {
    const { cfg } = makeConfig();
    const a = (await renderBookmarksPageHandler(cfg, "alice")).body;
    const b = (await renderBookmarksPageHandler(cfg, "bobby")).body;
    // The page leaks nothing past the URL's username, which the inline
    // script uses to verify ownership client-side.
    assert.equal(
      a.replace(/alice/g, "bobby"),
      b,
      "the only difference between two users' shells must be the bare username string",
    );
  });

  test("invalid username gets a 404", async () => {
    const { cfg } = makeConfig();
    const res = await renderBookmarksPageHandler(cfg, "BAD!user");
    assert.equal(res.status, 404);
  });

  test("the page ships the bookmark/share/like client scripts so cards stay interactive", async () => {
    const { cfg } = makeConfig();
    const res = await renderBookmarksPageHandler(cfg, "alice");
    assert.match(res.body, /<script src="\/bookmark\.js"><\/script>/);
    assert.match(res.body, /<script src="\/like\.js"><\/script>/);
    assert.match(res.body, /<script src="\/share\.js"><\/script>/);
  });
});

describe("renderMyBookmarksFeedHandler", () => {
  const ME = { user_id: "u".repeat(64), username: "alice" };

  test("returns the caller's bookmarked drawings as feed cards", async () => {
    const { cfg, drawingStore, bookmarksStore } = makeConfig();
    const drawing_id = "a".repeat(64);
    await drawingStore.put(row({ drawing_id }));
    await bookmarksStore.bookmark({ drawing_id, user_id: ME.user_id, created_at_ms: 1 });

    const res = await renderMyBookmarksFeedHandler(cfg, ME);
    assert.equal(res.status, 200);
    assert.match(res.cacheControl, /no-store/);
    assert.match(res.body, /<article class="feed-card">/);
    assert.ok(res.body.includes(drawing_id));
  });

  test("returns an empty body when the caller has no bookmarks", async () => {
    const { cfg } = makeConfig();
    const res = await renderMyBookmarksFeedHandler(cfg, ME);
    assert.equal(res.status, 200);
    assert.equal(res.body.trim(), "");
  });

  test("a bookmark of a since-deleted drawing is silently skipped", async () => {
    const { cfg, drawingStore, bookmarksStore } = makeConfig();
    const present = "a".repeat(64);
    const ghost = "b".repeat(64);
    await drawingStore.put(row({ drawing_id: present }));
    await drawingStore.put(row({ drawing_id: ghost }));
    await bookmarksStore.bookmark({ drawing_id: present, user_id: ME.user_id, created_at_ms: 1 });
    await bookmarksStore.bookmark({ drawing_id: ghost, user_id: ME.user_id, created_at_ms: 2 });
    // Simulate a deletion by reseating drawingStore with only `present`.
    const fresh = new MemoryDrawingStore();
    await fresh.put(row({ drawing_id: present }));
    const cfg2: RenderHandlersConfig = { ...cfg, drawingStore: fresh };

    const res = await renderMyBookmarksFeedHandler(cfg2, ME);
    assert.ok(res.body.includes(present));
    assert.ok(!res.body.includes(ghost));
  });

  test("config without a bookmarksStore returns an empty body", async () => {
    const drawingStore = new MemoryDrawingStore();
    const cfg: RenderHandlersConfig = {
      drawingStore,
      publicBaseUrl: "https://draw.example",
      repoUrl: "https://github.com/test/test",
    };
    const res = await renderMyBookmarksFeedHandler(cfg, ME);
    assert.equal(res.status, 200);
    assert.equal(res.body, "");
  });
});
