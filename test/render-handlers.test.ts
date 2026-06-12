import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MemoryDrawingStore, type DrawingRow } from "../ingest/drawing-store.js";
import {
  renderDrawingPageHandler,
  renderEmbedPageHandler,
  renderFeedHandler,
  renderFeedItemsHandler,
  renderHomePageHandler,
  renderProfileItemsHandler,
  renderProfilePageHandler,
  renderPromptItemsHandler,
  renderPromptPageHandler,
  renderPromptsArchiveHandler,
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
    prompt_id: overrides.prompt_id,
    frames: overrides.frames ?? 1,
    gif_size_bytes: overrides.gif_size_bytes ?? 1234,
    like_count: overrides.like_count,
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

describe("renderHomePageHandler", () => {
  test("empty feed renders the empty-state copy", async () => {
    const { cfg } = makeConfig();
    const res = await renderHomePageHandler(cfg, null);
    assert.equal(res.status, 200);
    assert.match(res.body, /No drawings yet/);
    assert.doesNotMatch(res.body, /data-infinite-sentinel/);
  });

  test("multiple drawings render newest-first as feed cards", async () => {
    const { store, cfg } = makeConfig();
    await store.put(row({ drawing_id: "1".repeat(64), username: "alice", created_at_ms: 100 }));
    await store.put(row({ drawing_id: "2".repeat(64), username: "bob",   created_at_ms: 200 }));
    const res = await renderHomePageHandler(cfg, null);
    assert.equal(res.status, 200);
    assert.match(res.body, /<article class="feed-card">/);
    const i1 = res.body.indexOf("2".repeat(64));
    const i2 = res.body.indexOf("1".repeat(64));
    assert.ok(i1 > -1 && i2 > -1, "expected both drawings in the rendered HTML");
    assert.ok(i1 < i2, "expected newer drawing to be rendered first");
  });

  test("more items than perPage emits an infinite-scroll sentinel pointing at /feed/items", async () => {
    const { store, cfg } = makeConfig(2);
    for (let i = 0; i < 4; i++) {
      await store.put(row({ drawing_id: String(i).padStart(64, "f"), created_at_ms: 1000 + i }));
    }
    const res = await renderHomePageHandler(cfg, null);
    assert.match(res.body, /data-infinite-sentinel/);
    assert.match(res.body, /data-next="\/feed\/items\?cursor=/);
  });

  test("'anonymous' rows render without a profile link", async () => {
    const { store, cfg } = makeConfig();
    await store.put(row({ drawing_id: "a".repeat(64), username: "anonymous" }));
    const res = await renderHomePageHandler(cfg, null);
    assert.match(res.body, /feed-card-author-anon[^"]*">anonymous/);
    assert.doesNotMatch(res.body, /href="\/u\/anonymous"/);
  });

  test("like_count from the row is surfaced as the SSR count", async () => {
    const { store, cfg } = makeConfig();
    const id = "a".repeat(64);
    await store.put(row({ drawing_id: id, like_count: 42 }));
    const res = await renderHomePageHandler(cfg, null);
    assert.match(res.body, new RegExp(`data-like-target="${id}"`));
    assert.match(res.body, /<span class="like-count" data-like-count>42<\/span>/);
  });

  test("rows without a like_count attribute default to 0 in the SSR markup", async () => {
    const { store, cfg } = makeConfig();
    await store.put(row({ drawing_id: "a".repeat(64) }));
    const res = await renderHomePageHandler(cfg, null);
    assert.match(res.body, /<span class="like-count" data-like-count>0<\/span>/);
  });

  test("renders today's daily-prompt banner with the /draw?prompt= CTA", async () => {
    const { store, cfg } = makeConfig();
    // 2026-06-01 ET is a dated OVERRIDES entry in config/prompts.ts →
    // deterministic "tiny-ghost" regardless of rotation arithmetic.
    cfg.now = () => new Date("2026-06-01T17:00:00.000Z");
    await store.put(row());
    const res = await renderHomePageHandler(cfg, null);
    assert.match(res.body, /class="prompt-banner"/);
    assert.match(res.body, /Tiny ghost/);
    assert.match(res.body, /href="\/draw\?prompt=tiny-ghost"/);
    assert.match(res.body, /gtag\("event","prompt_banner_view",\{slug:"tiny-ghost"\}\)/);
  });

  test("prompt banner: cursor pages omit it (same rule as the discover rail)", async () => {
    const { store, cfg } = makeConfig(2);
    for (let i = 0; i < 4; i++) {
      await store.put(row({ drawing_id: String(i).padStart(64, "f"), created_at_ms: 1000 + i }));
    }
    const first = await renderHomePageHandler(cfg, null);
    assert.match(first.body, /class="prompt-banner"/);
    const match = first.body.match(/data-next="\/feed\/items\?cursor=([^"]+)"/);
    assert.ok(match);
    const second = await renderHomePageHandler(cfg, match![1]);
    assert.doesNotMatch(second.body, /prompt-banner/);
  });

  test("discover rail: Most Liked module appears on the first page", async () => {
    const { store, cfg } = makeConfig();
    const now = Date.now();
    await store.put(row({ drawing_id: "a".repeat(64), username: "alice", like_count: 12, created_at_ms: now - 1000 }));
    await store.put(row({ drawing_id: "b".repeat(64), username: "bob", like_count: 5, created_at_ms: now - 2000 }));
    const res = await renderHomePageHandler(cfg, null);
    assert.match(res.body, /<aside class="rail-right"/);
    assert.match(res.body, /Most Liked · 30D/);
    // Highest like count appears first.
    const aliceIdx = res.body.indexOf("a".repeat(64));
    const bobIdx = res.body.indexOf("b".repeat(64));
    assert.ok(aliceIdx > -1 && bobIdx > -1 && aliceIdx < bobIdx);
  });

  test("discover rail: drawings older than 30 days are excluded", async () => {
    const { store, cfg } = makeConfig();
    const now = Date.now();
    const old = now - 40 * 24 * 60 * 60 * 1000;
    await store.put(row({ drawing_id: "a".repeat(64), username: "alice", like_count: 99, created_at_ms: old }));
    const res = await renderHomePageHandler(cfg, null);
    // The drawing still appears in the feed (no window there) but the
    // rail's Most Liked module skips it since it's outside the 30d
    // window — module body therefore has no liked items.
    assert.doesNotMatch(res.body, /Most Liked · 30D[\s\S]{0,400}♥ 99/);
  });

  test("discover rail: cursor pages omit the rail (avoid double-render)", async () => {
    const { store, cfg } = makeConfig(2);
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      await store.put(row({ drawing_id: String(i).padStart(64, "f"), username: "u" + i, like_count: 1, created_at_ms: now - i * 1000 }));
    }
    // Page 1 — discover should render
    const first = await renderHomePageHandler(cfg, null);
    assert.match(first.body, /<aside class="rail-right"[^>]*>[\s\S]*Most Liked/);
    // Pull the cursor from the sentinel and request page 2
    const match = first.body.match(/data-next="\/feed\/items\?cursor=([^"]+)"/);
    assert.ok(match);
    const second = await renderHomePageHandler(cfg, match![1]);
    // Page 2 still ships the rail wrapper (we'd need a separate URL to
    // skip the chrome entirely) but the discover module is absent —
    // saving the DDB read on every paginated request.
    assert.doesNotMatch(second.body, /Most Liked · 30D/);
  });

  test("sort toggle renders with Newest active by default", async () => {
    const { store, cfg } = makeConfig();
    await store.put(row());
    const res = await renderHomePageHandler(cfg, null);
    assert.match(res.body, /class="feed-sort"/);
    assert.match(res.body, /<a class="feed-sort-link" href="\/" aria-current="page">Newest<\/a>/);
    assert.match(res.body, /<a class="feed-sort-link" href="\/\?sort=top">Top today<\/a>/);
  });
});

describe("renderHomePageHandler ?sort=top", () => {
  test("orders the last 24h by like_count, not recency", async () => {
    const { store, cfg } = makeConfig();
    const now = Date.now();
    await store.put(row({ drawing_id: "1".repeat(64), like_count: 2, created_at_ms: now - 3000 }));
    await store.put(row({ drawing_id: "2".repeat(64), like_count: 9, created_at_ms: now - 2000 }));
    await store.put(row({ drawing_id: "3".repeat(64), like_count: 5, created_at_ms: now - 1000 }));
    const res = await renderHomePageHandler(cfg, null, "top");
    assert.equal(res.status, 200);
    // Bound to <main> — the discover rail after it also lists liked drawings.
    const feed = res.body.slice(res.body.indexOf("<main>"), res.body.indexOf("</main>"));
    const order = ["2", "3", "1"].map((c) => feed.indexOf(c.repeat(64)));
    assert.ok(order.every((i) => i > -1), "expected all three drawings in the feed");
    assert.deepEqual([...order].sort((a, b) => a - b), order, "expected like-count order");
  });

  test("drawings older than 24 hours are excluded", async () => {
    const { store, cfg } = makeConfig();
    const now = Date.now();
    await store.put(row({ drawing_id: "1".repeat(64), like_count: 99, created_at_ms: now - 25 * 60 * 60 * 1000 }));
    await store.put(row({ drawing_id: "2".repeat(64), like_count: 1, created_at_ms: now - 1000 }));
    const res = await renderHomePageHandler(cfg, null, "top");
    // Bound to <main> — the stale drawing legitimately appears in the
    // discover rail (30d window) rendered after it.
    const feed = res.body.slice(res.body.indexOf("<main>"), res.body.indexOf("</main>"));
    assert.ok(feed.indexOf("2".repeat(64)) > -1);
    assert.equal(feed.indexOf("1".repeat(64)), -1, "stale drawing must not appear in the feed");
  });

  test("caps at perPage with no infinite-scroll sentinel", async () => {
    const { store, cfg } = makeConfig(2);
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      await store.put(row({ drawing_id: String(i).padStart(64, "f"), like_count: i, created_at_ms: now - i * 1000 }));
    }
    const res = await renderHomePageHandler(cfg, null, "top");
    assert.doesNotMatch(res.body, /data-infinite-sentinel/);
    const cards = res.body.match(/<article class="feed-card">/g) ?? [];
    assert.equal(cards.length, 2);
  });

  test("empty day renders the top-specific fallback copy", async () => {
    const { store, cfg } = makeConfig();
    const now = Date.now();
    await store.put(row({ created_at_ms: now - 48 * 60 * 60 * 1000 }));
    const res = await renderHomePageHandler(cfg, null, "top");
    assert.match(res.body, /Nothing published in the last 24 hours/);
    assert.doesNotMatch(res.body, /No drawings yet/);
  });

  test("marks Top today active in the toggle and keeps banner + discover rail", async () => {
    const { store, cfg } = makeConfig();
    cfg.now = () => new Date("2026-06-01T17:00:00.000Z");
    await store.put(row({ like_count: 3, created_at_ms: Date.parse("2026-06-01T16:00:00.000Z") }));
    const res = await renderHomePageHandler(cfg, null, "top");
    assert.match(res.body, /<a class="feed-sort-link" href="\/\?sort=top" aria-current="page">Top today<\/a>/);
    assert.match(res.body, /class="prompt-banner"/);
    assert.match(res.body, /Most Liked · 30D/);
  });

  test("unknown sort values fall back to the chronological feed", async () => {
    const { store, cfg } = makeConfig();
    await store.put(row({ drawing_id: "1".repeat(64), created_at_ms: 100 }));
    await store.put(row({ drawing_id: "2".repeat(64), created_at_ms: 200 }));
    const res = await renderHomePageHandler(cfg, null, "garbage");
    const i1 = res.body.indexOf("2".repeat(64));
    const i2 = res.body.indexOf("1".repeat(64));
    assert.ok(i1 > -1 && i2 > -1 && i1 < i2, "expected newest-first order");
  });
});

describe("renderFeedItemsHandler (fragment endpoint)", () => {
  test("returns just the cards + sentinel — no chrome", async () => {
    const { store, cfg } = makeConfig(2);
    for (let i = 0; i < 4; i++) {
      await store.put(row({ drawing_id: String(i).padStart(64, "f"), created_at_ms: 1000 + i }));
    }
    const res = await renderFeedItemsHandler(cfg, null);
    assert.doesNotMatch(res.body, /<html/);
    assert.doesNotMatch(res.body, /class="hdr"/);
    assert.match(res.body, /<article class="feed-card">/);
    assert.match(res.body, /data-infinite-sentinel/);
  });

  test("never includes the daily-prompt banner", async () => {
    const { store, cfg } = makeConfig();
    await store.put(row());
    const res = await renderFeedItemsHandler(cfg, null);
    assert.doesNotMatch(res.body, /prompt-banner/);
    assert.doesNotMatch(res.body, /prompt_banner_view/);
  });

  test("last page omits the sentinel", async () => {
    const { store, cfg } = makeConfig(2);
    for (let i = 0; i < 3; i++) {
      await store.put(row({ drawing_id: String(i).padStart(64, "f"), created_at_ms: 1000 + i }));
    }
    const page1 = await renderFeedItemsHandler(cfg, null);
    const next = page1.body.match(/data-next="([^"]+)"/);
    assert.ok(next, "expected next cursor in page 1");
    const cursor = new URL(next![1], "http://x").searchParams.get("cursor");
    const page2 = await renderFeedItemsHandler(cfg, cursor);
    assert.doesNotMatch(page2.body, /data-infinite-sentinel/);
  });
});

describe("renderEmbedPageHandler", () => {
  test("renders the bare player: pixelated img, click-through, attribution", async () => {
    const { store, cfg } = makeConfig();
    const id = "a".repeat(64);
    await store.put(row({ drawing_id: id }));
    const res = await renderEmbedPageHandler(cfg, id);
    assert.equal(res.status, 200);
    assert.equal(res.cacheControl, "public, max-age=3600, s-maxage=86400");
    assert.match(res.body, /image-rendering: pixelated/);
    assert.match(res.body, new RegExp(`<img src="/tiles/${id}\\.gif"`));
    assert.match(res.body, new RegExp(`href="/d/${id}" target="_top"`));
    assert.match(res.body, /Made with Draw!/);
    // No chrome/shell — the page must stay iframe-sized.
    assert.doesNotMatch(res.body, /app-shell|rail-left|class="hdr"/);
  });

  test("404 for an unknown id is plain text, not the chrome'd not-found", async () => {
    const { cfg } = makeConfig();
    const res = await renderEmbedPageHandler(cfg, "b".repeat(64));
    assert.equal(res.status, 404);
    assert.match(res.contentType, /text\/plain/);
    assert.doesNotMatch(res.body, /<html/);
  });

  test("404 for a malformed id", async () => {
    const { cfg } = makeConfig();
    const res = await renderEmbedPageHandler(cfg, "not-an-id");
    assert.equal(res.status, 404);
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

  test("renders the like button with the row's like_count", async () => {
    const { store, cfg } = makeConfig();
    const id = "a".repeat(64);
    await store.put(row({ drawing_id: id, like_count: 9 }));
    const res = await renderDrawingPageHandler(cfg, id);
    assert.equal(res.status, 200);
    assert.match(res.body, new RegExp(`data-like-target="${id}"`));
    assert.match(res.body, /<span class="like-count" data-like-count>9<\/span>/);
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
    assert.match(res.body, /<dt>Remixed from<\/dt>/);
    assert.match(res.body, new RegExp(`href="/d/${parentId}"`));
    // Remixes section lists carol's drawing.
    assert.match(res.body, /<p class="panel-h">Remixes · 1<\/p>/);
    assert.match(res.body, new RegExp(`/d/${grandchildId}`));
  });

  test("Remix is the first action and carries .primary; merch loses it", async () => {
    const { store, cfg } = makeConfig();
    const id = "a".repeat(64);
    await store.put(row({ drawing_id: id }));
    const res = await renderDrawingPageHandler(cfg, id);
    assert.match(
      res.body,
      new RegExp(`<a class="btn primary" id="dr-fork" href="/draw\\?fork=${id}">Remix</a>`),
    );
    assert.match(res.body, /<a class="btn" id="dr-make-merch"/);
    const remixIdx = res.body.indexOf('id="dr-fork"');
    const likeIdx = res.body.indexOf("data-like-target");
    const merchIdx = res.body.indexOf('id="dr-make-merch"');
    assert.ok(remixIdx > -1 && likeIdx > -1 && merchIdx > -1);
    assert.ok(remixIdx < likeIdx && remixIdx < merchIdx, "expected Remix first in the action row");
    assert.doesNotMatch(res.body, /Fork &amp; edit/);
  });
});

describe("renderDrawingPageHandler remix chain", () => {
  // ids must be 64-hex; index-tagged so each is unique + addressable.
  function chainId(i: number): string {
    return String(i).padStart(64, "0");
  }

  async function seedChain(store: MemoryDrawingStore, depth: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 1; i <= depth; i++) {
      ids.push(chainId(i));
      await store.put(row({
        drawing_id: chainId(i),
        parent_id: i === 1 ? null : chainId(i - 1),
        created_at_ms: 1000 + i,
      }));
    }
    return ids;
  }

  function chainLinks(body: string): string[] {
    return [...body.matchAll(/class="dr-chain-link" href="\/d\/([0-9a-f]{64})"/g)].map((m) => m[1]);
  }

  test("3-deep chain renders 2 ancestor links, root-first, current as non-linked terminal", async () => {
    const { store, cfg } = makeConfig();
    const [rootId, childId, grandchildId] = await seedChain(store, 3);
    const res = await renderDrawingPageHandler(cfg, grandchildId);
    assert.equal(res.status, 200);
    assert.match(res.body, /<section class="dr-chain">/);
    assert.deepEqual(chainLinks(res.body), [rootId, childId]);
    // Current drawing is the terminal item: a plain thumb, no link.
    assert.match(
      res.body,
      new RegExp(`<li class="dr-chain-item dr-chain-current" aria-current="page"><img class="dr-chain-thumb" src="/tiles/${grandchildId}\\.gif"`),
    );
  });

  test("10-deep chain caps at 8 ancestors (nearest first dropped is the true root)", async () => {
    const { store, cfg } = makeConfig();
    const ids = await seedChain(store, 10);
    const res = await renderDrawingPageHandler(cfg, ids[9]);
    assert.equal(res.status, 200);
    const links = chainLinks(res.body);
    assert.equal(links.length, 8);
    // The 8 nearest ancestors are ids[1..8]; the true root falls off.
    assert.deepEqual(links, ids.slice(1, 9));
    assert.equal(res.body.indexOf(ids[0]), -1);
  });

  test("missing parent row renders without a chain and without erroring", async () => {
    const { store, cfg } = makeConfig();
    const id = "b".repeat(64);
    await store.put(row({ drawing_id: id, parent_id: "d".repeat(64) }));
    const res = await renderDrawingPageHandler(cfg, id);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.body, /dr-chain/);
  });

  test("parent missing mid-walk truncates the chain instead of erroring", async () => {
    const { store, cfg } = makeConfig();
    const ghost = "e".repeat(64);
    const parentId = "1".repeat(64);
    const childId = "2".repeat(64);
    await store.put(row({ drawing_id: parentId, parent_id: ghost, created_at_ms: 100 }));
    await store.put(row({ drawing_id: childId, parent_id: parentId, created_at_ms: 200 }));
    const res = await renderDrawingPageHandler(cfg, childId);
    assert.equal(res.status, 200);
    assert.deepEqual(chainLinks(res.body), [parentId]);
  });

  test("cyclic parent_id rows terminate the walk", async () => {
    const { store, cfg } = makeConfig();
    const a = "1".repeat(64);
    const b = "2".repeat(64);
    await store.put(row({ drawing_id: a, parent_id: b, created_at_ms: 100 }));
    await store.put(row({ drawing_id: b, parent_id: a, created_at_ms: 200 }));
    const res = await renderDrawingPageHandler(cfg, a);
    assert.equal(res.status, 200);
    assert.deepEqual(chainLinks(res.body), [b]);
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

// Fixed clocks for the /prompts surfaces. PROMPTS_EPOCH_ET is 2026-06-15;
// 16:00Z is always the same calendar day in ET (12:00 EDT), so day math
// is unambiguous. Rotation day 0 = slime-bounce, 1 = campfire, 2 = coin-spin.
const EPOCH_NOON = () => new Date("2026-06-15T16:00:00Z");
const EPOCH_PLUS_2 = () => new Date("2026-06-17T16:00:00Z");
const PRE_EPOCH = () => new Date("2026-06-12T16:00:00Z");

describe("renderPromptsArchiveHandler", () => {
  test("lists epoch through today newest-first and never leaks future days", async () => {
    const { cfg } = makeConfig();
    cfg.now = EPOCH_PLUS_2;
    const res = await renderPromptsArchiveHandler(cfg);
    assert.equal(res.status, 200);
    const iToday = res.body.indexOf("/prompts/coin-spin");
    const iYesterday = res.body.indexOf("/prompts/campfire");
    const iEpoch = res.body.indexOf("/prompts/slime-bounce");
    assert.ok(iToday > -1 && iYesterday > -1 && iEpoch > -1, "expected all three days listed");
    assert.ok(iToday < iYesterday && iYesterday < iEpoch, "expected newest-first order");
    assert.equal(res.body.match(/class="pm-row"/g)?.length, 3);
    assert.doesNotMatch(res.body, /2026-06-18/);
    assert.match(res.body, />Today</);
  });

  test("pre-epoch clock degrades to a single today-only entry", async () => {
    const { cfg } = makeConfig();
    cfg.now = PRE_EPOCH;
    const res = await renderPromptsArchiveHandler(cfg);
    assert.equal(res.body.match(/class="pm-row"/g)?.length, 1);
    assert.match(res.body, />Today</);
  });
});

describe("renderPromptPageHandler", () => {
  test("404s on a slug that names no prompt", async () => {
    const { cfg } = makeConfig();
    cfg.now = EPOCH_NOON;
    assert.equal((await renderPromptPageHandler(cfg, "not-a-real-prompt")).status, 404);
    assert.equal((await renderPromptPageHandler(cfg, "Bad!Slug")).status, 404);
  });

  test("lists only rows tagged with this prompt, newest-first", async () => {
    const { store, cfg } = makeConfig();
    cfg.now = EPOCH_NOON;
    await store.put(row({ drawing_id: "1".repeat(64), prompt_id: "slime-bounce", created_at_ms: 100 }));
    await store.put(row({ drawing_id: "2".repeat(64), prompt_id: "slime-bounce", created_at_ms: 200 }));
    await store.put(row({ drawing_id: "3".repeat(64), prompt_id: "campfire", created_at_ms: 300 }));
    await store.put(row({ drawing_id: "4".repeat(64), created_at_ms: 400 }));
    const res = await renderPromptPageHandler(cfg, "slime-bounce");
    assert.equal(res.status, 200);
    const i2 = res.body.indexOf("2".repeat(64));
    const i1 = res.body.indexOf("1".repeat(64));
    assert.ok(i2 > -1 && i1 > -1 && i2 < i1, "expected both tagged rows, newest first");
    assert.equal(res.body.indexOf("3".repeat(64)), -1);
    assert.equal(res.body.indexOf("4".repeat(64)), -1);
  });

  test("today's prompt carries the Draw-this CTA; a stale one points at the archive", async () => {
    const { cfg } = makeConfig();
    cfg.now = EPOCH_NOON; // today = slime-bounce
    const today = await renderPromptPageHandler(cfg, "slime-bounce");
    assert.match(today.body, /href="\/draw\?prompt=slime-bounce"/);
    const stale = await renderPromptPageHandler(cfg, "campfire");
    assert.doesNotMatch(stale.body, /href="\/draw\?prompt=/);
    assert.match(stale.body, /day has passed/);
  });

  test("og:image is the newest submission's -large.gif, falling back to the logo", async () => {
    const { store, cfg } = makeConfig();
    cfg.now = EPOCH_NOON;
    const empty = await renderPromptPageHandler(cfg, "slime-bounce");
    assert.match(empty.body, /og:image" content="https:\/\/draw\.example\/og-logo\.png"/);
    await store.put(row({ drawing_id: "1".repeat(64), prompt_id: "slime-bounce", created_at_ms: 100 }));
    await store.put(row({ drawing_id: "2".repeat(64), prompt_id: "slime-bounce", created_at_ms: 200 }));
    const filled = await renderPromptPageHandler(cfg, "slime-bounce");
    assert.match(
      filled.body,
      new RegExp(`og:image" content="https://draw\\.example/tiles/${"2".repeat(64)}-large\\.gif"`),
    );
  });

  test("more items than perPage emits a sentinel pointing at the items fragment", async () => {
    const { store, cfg } = makeConfig(2);
    cfg.now = EPOCH_NOON;
    for (let i = 0; i < 3; i++) {
      await store.put(row({
        drawing_id: String(i).padStart(64, "b"),
        prompt_id: "slime-bounce",
        created_at_ms: 1000 + i,
      }));
    }
    const res = await renderPromptPageHandler(cfg, "slime-bounce");
    assert.match(res.body, /data-next="\/prompts\/slime-bounce\/items\?cursor=/);
  });
});

describe("renderPromptItemsHandler", () => {
  test("404s on a slug that names no prompt", async () => {
    const { cfg } = makeConfig();
    assert.equal((await renderPromptItemsHandler(cfg, "not-a-real-prompt", null)).status, 404);
  });

  test("paginates as a bare fragment, following the cursor to the end", async () => {
    const { store, cfg } = makeConfig(2);
    cfg.now = EPOCH_NOON;
    for (let i = 0; i < 3; i++) {
      await store.put(row({
        drawing_id: String(i).padStart(64, "b"),
        prompt_id: "slime-bounce",
        created_at_ms: 1000 + i,
      }));
    }
    const first = await renderPromptItemsHandler(cfg, "slime-bounce", null);
    assert.doesNotMatch(first.body, /<html/);
    const match = first.body.match(/data-next="\/prompts\/slime-bounce\/items\?cursor=([^"]+)"/);
    assert.ok(match, "expected a next cursor on the first fragment");
    const second = await renderPromptItemsHandler(cfg, "slime-bounce", match![1]);
    assert.ok(second.body.includes("0".padStart(64, "b")), "expected the oldest row on page 2");
    assert.doesNotMatch(second.body, /data-next=/);
  });
});
