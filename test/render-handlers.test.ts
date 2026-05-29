import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MemoryDrawingStore, type DrawingRow } from "../ingest/drawing-store.js";
import {
  renderDrawingPageHandler,
  renderFeedHandler,
  renderGalleryItemsHandler,
  renderGalleryPageHandler,
  renderProfileItemsHandler,
  renderProfilePageHandler,
  type RenderHandlersConfig,
} from "../ingest/render-handlers.js";

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

function makeConfig(perPage = 3): {
  store: MemoryDrawingStore;
  cfg: RenderHandlersConfig;
} {
  const store = new MemoryDrawingStore();
  return {
    store,
    cfg: {
      drawingStore: store,
      publicBaseUrl: "https://draw.example",
      repoUrl: "https://github.com/test/test",
      perPage,
    },
  };
}

describe("renderGalleryPageHandler", () => {
  test("empty gallery renders the empty-state copy", async () => {
    const { cfg } = makeConfig();
    const res = await renderGalleryPageHandler(cfg, null);
    assert.equal(res.status, 200);
    assert.match(res.body, /No drawings published yet/);
    assert.doesNotMatch(res.body, /data-gallery-sentinel/);
  });

  test("multiple drawings render newest-first with timestamps", async () => {
    const { store, cfg } = makeConfig();
    await store.put(row({ drawing_id: "1".repeat(64), username: "alice", created_at_ms: 100 }));
    await store.put(row({ drawing_id: "2".repeat(64), username: "bob",   created_at_ms: 200 }));
    const res = await renderGalleryPageHandler(cfg, null);
    assert.equal(res.status, 200);
    const i1 = res.body.indexOf("2".repeat(64));
    const i2 = res.body.indexOf("1".repeat(64));
    assert.ok(i1 > -1 && i2 > -1, "expected both drawings in the rendered HTML");
    assert.ok(i1 < i2, "expected newer drawing to be rendered first");
    // Per-item timestamps land in <time> elements.
    assert.match(res.body, /<time class="gal-item-time"/);
  });

  test("more items than perPage emits an infinite-scroll sentinel", async () => {
    const { store, cfg } = makeConfig(2);
    for (let i = 0; i < 4; i++) {
      await store.put(row({ drawing_id: String(i).padStart(64, "f"), created_at_ms: 1000 + i }));
    }
    const res = await renderGalleryPageHandler(cfg, null);
    assert.match(res.body, /data-gallery-sentinel/);
    assert.match(res.body, /data-next="\/gallery\/items\?cursor=/);
  });
});

describe("renderGalleryItemsHandler (fragment endpoint)", () => {
  test("returns just the li items + sentinel — no chrome", async () => {
    const { store, cfg } = makeConfig(2);
    for (let i = 0; i < 4; i++) {
      await store.put(row({ drawing_id: String(i).padStart(64, "f"), created_at_ms: 1000 + i }));
    }
    const res = await renderGalleryItemsHandler(cfg, null);
    assert.doesNotMatch(res.body, /<html/);
    assert.doesNotMatch(res.body, /class="hdr"/);
    assert.match(res.body, /<li>/);
    assert.match(res.body, /data-gallery-sentinel/);
  });

  test("last page omits the sentinel", async () => {
    const { store, cfg } = makeConfig(2);
    for (let i = 0; i < 3; i++) {
      await store.put(row({ drawing_id: String(i).padStart(64, "f"), created_at_ms: 1000 + i }));
    }
    // Page 1: items[1002, 1001], next_cursor present.
    const page1 = await renderGalleryItemsHandler(cfg, null);
    const next = page1.body.match(/data-next="([^"]+)"/);
    assert.ok(next, "expected next cursor in page 1");
    const cursor = new URL(next![1], "http://x").searchParams.get("cursor");
    // Page 2: items[1000], no next.
    const page2 = await renderGalleryItemsHandler(cfg, cursor);
    assert.doesNotMatch(page2.body, /data-gallery-sentinel/);
  });
});

describe("renderDrawingPageHandler", () => {
  test("404 for an unknown id", async () => {
    const { cfg } = makeConfig();
    const res = await renderDrawingPageHandler(cfg, "0".repeat(64));
    assert.equal(res.status, 404);
  });

  test("404 for a malformed id", async () => {
    const { cfg } = makeConfig();
    const res = await renderDrawingPageHandler(cfg, "not-hex");
    assert.equal(res.status, 404);
  });

  test("renders a drawing with author + parent + forks", async () => {
    const { store, cfg } = makeConfig();
    const parentId = "1".repeat(64);
    const childId = "2".repeat(64);
    const grandchildId = "3".repeat(64);
    await store.put(row({ drawing_id: parentId, username: "alice", created_at_ms: 100 }));
    await store.put(row({ drawing_id: childId, username: "bob", parent_id: parentId, created_at_ms: 200 }));
    await store.put(row({ drawing_id: grandchildId, username: "carol", parent_id: childId, created_at_ms: 300 }));

    const res = await renderDrawingPageHandler(cfg, childId);
    assert.equal(res.status, 200);
    // Author link to /u/<username>.
    assert.match(res.body, /href="\/u\/bob"/);
    // Parent shown.
    assert.match(res.body, new RegExp(`href="/t/${parentId}"`));
    // Forks section lists carol's drawing.
    assert.match(res.body, /<p class="panel-h">Forks · 1<\/p>/);
    assert.match(res.body, new RegExp(`/d/${grandchildId}`));
  });
});

describe("renderProfilePageHandler", () => {
  test("404 for a malformed username", async () => {
    const { cfg } = makeConfig();
    const res = await renderProfilePageHandler(cfg, "no_");
    assert.equal(res.status, 404);
  });

  test("404 for a username with no drawings", async () => {
    const { cfg } = makeConfig();
    const res = await renderProfilePageHandler(cfg, "ghost_user");
    assert.equal(res.status, 404);
  });

  test("renders the profile + infinite-scroll sentinel when paginated", async () => {
    const { store, cfg } = makeConfig(2);
    for (let i = 0; i < 4; i++) {
      await store.put(row({
        drawing_id: String(i).padStart(64, "a"),
        username: "alice",
        created_at_ms: 1000 + i,
      }));
    }
    const res = await renderProfilePageHandler(cfg, "alice");
    assert.equal(res.status, 200);
    assert.match(res.body, /Drawings by alice/);
    assert.match(res.body, /data-gallery-items/);
    assert.match(res.body, /data-gallery-sentinel/);
    assert.match(res.body, /data-next="\/u\/alice\/items\?cursor=/);
  });
});

describe("renderProfileItemsHandler", () => {
  test("returns a fragment with the next cursor", async () => {
    const { store, cfg } = makeConfig(2);
    for (let i = 0; i < 5; i++) {
      await store.put(row({
        drawing_id: String(i).padStart(64, "a"),
        username: "alice",
        created_at_ms: 1000 + i,
      }));
    }
    const res = await renderProfileItemsHandler(cfg, "alice", null);
    assert.doesNotMatch(res.body, /<html/);
    assert.match(res.body, /data-next="\/u\/alice\/items\?cursor=/);
  });
});

describe("renderFeedHandler", () => {
  test("emits RSS XML with the latest items first", async () => {
    const { store, cfg } = makeConfig();
    await store.put(row({ drawing_id: "1".repeat(64), created_at_ms: 100 }));
    await store.put(row({ drawing_id: "2".repeat(64), created_at_ms: 200 }));
    const res = await renderFeedHandler(cfg);
    assert.equal(res.contentType, "application/rss+xml; charset=utf-8");
    assert.match(res.body, /<rss version="2.0">/);
    const i1 = res.body.indexOf("2".repeat(64));
    const i2 = res.body.indexOf("1".repeat(64));
    assert.ok(i1 < i2, "expected newer item first in feed");
  });
});
