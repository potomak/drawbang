import { strict as assert } from "node:assert";
import { test } from "node:test";
import renderTilePage, { formatCreatedAt } from "../lib/templates/tile-page.js";

const baseView = {
  drawing_id: "f".repeat(64),
  id_short: "ffffffff",
  created_at: "2026-05-08T04:24:56.088Z",
  parent: null,
  author: {
    user_id: "a".repeat(64),
    username: "alice",
    avatar_drawing_id: null,
  },
  like_count: 0,
  public_base_url: "https://pixel.drawbang.com",
  repo_url: "https://github.com/example/drawbang",
};

test("formatCreatedAt: produces a UTC-anchored, locale-neutral string", () => {
  assert.equal(
    formatCreatedAt("2026-05-08T04:24:56.088Z"),
    "May 8, 2026 · 04:24 UTC",
  );
  assert.equal(
    formatCreatedAt("2026-12-31T23:59:00.000Z"),
    "December 31, 2026 · 23:59 UTC",
  );
  assert.equal(
    formatCreatedAt("2026-01-01T00:00:00.000Z"),
    "January 1, 2026 · 00:00 UTC",
  );
});

test("formatCreatedAt: returns the input verbatim on unparseable strings", () => {
  assert.equal(formatCreatedAt("not-a-date"), "not-a-date");
});

test("tile page: friendly date is up front", () => {
  const html = renderTilePage(baseView);
  assert.match(
    html,
    /<dt>Created<\/dt>\s*<dd><time datetime="2026-05-08T04:24:56\.088Z">May 8, 2026 · 04:24 UTC<\/time><\/dd>/,
  );
});

test("tile page: short ID renders without trailing ellipsis", () => {
  const html = renderTilePage(baseView);
  assert.match(html, /<dt>ID<\/dt>\s*<dd><code class="mono-trunc">ffffffff<\/code><\/dd>/);
  assert.doesNotMatch(html, /ffffffff…/);
});

test("tile page: no Advanced disclosure / no technical fields", () => {
  const html = renderTilePage(baseView);
  assert.doesNotMatch(html, /<details/);
  assert.doesNotMatch(html, /Advanced/);
  assert.doesNotMatch(html, /Proof of work/);
  assert.doesNotMatch(html, /Minted/);
});

test("tile page: author label (signed)", () => {
  const html = renderTilePage(baseView);
  assert.match(
    html,
    /<dt>Author<\/dt><dd><a class="dr-author" href="\/u\/alice">alice<\/a><\/dd>/,
  );
});

test("tile page: avatar renders before the username when set", () => {
  const id = "b".repeat(64);
  const html = renderTilePage({
    ...baseView,
    author: { user_id: "a".repeat(64), username: "alice", avatar_drawing_id: id },
  });
  assert.match(html, new RegExp(`<img class="avatar" src="/tiles/${id}\\.gif"`));
});

test("tile page: no avatar img when author has none set", () => {
  const html = renderTilePage(baseView);
  assert.doesNotMatch(html, /<img class="avatar"/);
});

test("tile page: author label (anonymous)", () => {
  const html = renderTilePage({ ...baseView, author: null });
  assert.match(html, /<dt>Author<\/dt><dd>anonymous<\/dd>/);
});

test("tile page: parent link (when present) renders in the meta dl", () => {
  const html = renderTilePage({
    ...baseView,
    parent: { parent: "c".repeat(64), parent_short: "cccccccc" },
  });
  assert.match(html, /<dt>Parent<\/dt><dd><a href="\/d\/c{64}">cccccccc<\/a><\/dd>/);
});

test("tile page: forks rendered server-side when present", () => {
  const html = renderTilePage({
    ...baseView,
    forks: [
      {
        id: "c".repeat(64),
        id_short: "cccccccc",
        href: `/d/${"c".repeat(64)}`,
        thumb: `/tiles/${"c".repeat(64)}.gif`,
        created_at: "2026-05-09T00:00:00.000Z",
      },
    ],
  });
  assert.match(html, /<p class="panel-h">Forks · 1<\/p>/);
  assert.match(html, new RegExp(`href="/d/${"c".repeat(64)}"`));
});

test("tile page: no forks section when forks is empty/omitted", () => {
  const html = renderTilePage(baseView);
  assert.doesNotMatch(html, /<section class="dr-forks">/);
});

test("tile page: Copy link is an interactive button, not a self-link", () => {
  const html = renderTilePage(baseView);
  assert.match(html, /<button class="btn" id="dr-copy-link" type="button">Copy link<\/button>/);
  assert.doesNotMatch(html, /<a class="btn" href="\/t\/[^"]+">Copy link<\/a>/);
});

test("tile page: loads /flash.js + /tile-page.js so the lifted client behaviour fires", () => {
  const html = renderTilePage(baseView);
  assert.match(html, /<script src="\/flash\.js"><\/script>/);
  assert.match(html, /<script src="\/tile-page\.js"><\/script>/);
});

test("tile page: <main> ships the drawing/author data attributes the script reads", () => {
  const html = renderTilePage(baseView);
  assert.match(html, /<main data-tile-page data-drawing-id="f{64}" data-id-short="ffffffff" data-author-username="alice">/);
});

test("tile page: <main> data-author-username is empty when the drawing is anonymous", () => {
  const html = renderTilePage({ ...baseView, author: null });
  assert.match(html, /<main data-tile-page [^>]*data-author-username="">/);
});

test("tile page: emits the full OG suite with absolute URLs and the -large.gif image", () => {
  const html = renderTilePage(baseView);
  const id = "f".repeat(64);
  assert.match(
    html,
    /<meta name="description" content="Pixel art from Draw! · Create your own at https:\/\/pixel\.drawbang\.com"/,
  );
  assert.match(
    html,
    new RegExp(`<link rel="canonical" href="https://pixel\\.drawbang\\.com/d/${id}"`),
  );
  assert.match(html, /<meta property="og:type" content="website"/);
  assert.match(html, /<meta property="og:site_name" content="Draw!"/);
  assert.match(html, /<meta property="og:title" content="Tile ID ffffffff"/);
  assert.match(
    html,
    /<meta property="og:description" content="Pixel art from Draw! · Create your own pixel art at https:\/\/pixel\.drawbang\.com"/,
  );
  assert.match(
    html,
    new RegExp(`<meta property="og:url" content="https://pixel\\.drawbang\\.com/d/${id}"`),
  );
  assert.match(
    html,
    new RegExp(
      `<meta property="og:image" content="https://pixel\\.drawbang\\.com/tiles/${id}-large\\.gif"`,
    ),
  );
  assert.match(html, /<meta property="og:image:type" content="image\/gif"/);
  assert.match(html, /<meta property="og:image:width" content="960"/);
  assert.match(html, /<meta property="og:image:height" content="960"/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image"/);
});

test("tile page: og:image is the -large.gif, not the raw 16×16 gif", () => {
  const html = renderTilePage(baseView);
  const id = "f".repeat(64);
  assert.doesNotMatch(
    html,
    new RegExp(`og:image" content="https://pixel\\.drawbang\\.com/tiles/${id}\\.gif"`),
  );
});

test("tile page: Reddit button links directly to reddit.com/submit, not the /share page", () => {
  const html = renderTilePage(baseView);
  const id = "f".repeat(64);
  const expectedUrl = encodeURIComponent(`https://pixel.drawbang.com/d/${id}`);
  const expectedTitle = encodeURIComponent("Pixel art from Draw! · Tile ID ffffffff");
  const reddit = new RegExp(
    `<a class="btn" id="dr-share-reddit" href="https://www\\.reddit\\.com/submit\\?url=${expectedUrl}&amp;title=${expectedTitle}"[^>]*>Share to Reddit</a>`,
  );
  assert.match(html, reddit);
  assert.doesNotMatch(html, /href="\/share\?d=/);
});

test("tile page: X share button opens twitter.com/intent/tweet with the tile URL", () => {
  const html = renderTilePage(baseView);
  const id = "f".repeat(64);
  const expectedUrl = encodeURIComponent(`https://pixel.drawbang.com/d/${id}`);
  const expectedText = encodeURIComponent("Pixel art from Draw! · Tile ID ffffffff");
  const x = new RegExp(
    `<a class="btn" id="dr-share-x" href="https://twitter\\.com/intent/tweet\\?url=${expectedUrl}&amp;text=${expectedText}"[^>]*>Share to X</a>`,
  );
  assert.match(html, x);
});

test("tile page: Threads share button opens threads.net/intent/post with caption + url", () => {
  const html = renderTilePage(baseView);
  const id = "f".repeat(64);
  const expectedText = encodeURIComponent("Pixel art from Draw! · Tile ID ffffffff");
  const expectedUrl = encodeURIComponent(`https://pixel.drawbang.com/d/${id}`);
  const threads = new RegExp(
    `<a class="btn" id="dr-share-threads" href="https://www\\.threads\\.net/intent/post\\?text=${expectedText}&amp;url=${expectedUrl}"[^>]*>Share to Threads</a>`,
  );
  assert.match(html, threads);
});

test("tile page: actions split into two .dr-action-row groups", () => {
  const html = renderTilePage(baseView);
  const groups = html.match(/class="dr-action-row"/g) ?? [];
  assert.equal(groups.length, 2);
});

test("tile page: Web Share button is rendered hidden by default (progressive enhancement)", () => {
  const html = renderTilePage(baseView);
  assert.match(
    html,
    /<button class="btn" id="dr-share" type="button" hidden>Share…<\/button>/,
  );
});

test("tile page: action buttons ship their GA-wired ids", () => {
  const html = renderTilePage(baseView);
  assert.match(html, /id="dr-make-merch"/);
  assert.match(html, /id="dr-fork"/);
  assert.match(html, /id="dr-share-threads"/);
  assert.match(html, /id="dr-share-reddit"/);
  assert.match(html, /id="dr-share-x"/);
  assert.match(html, /id="dr-download-gif"/);
  assert.match(html, /id="dr-copy-link"/);
  assert.match(html, /id="dr-share"/);
  assert.match(html, /id="dr-set-avatar"/);
});

test("tile page: drawing-action behaviour is NOT inlined (lives in /tile-page.js)", () => {
  const html = renderTilePage(baseView);
  // Analytics + Meta Pixel still inject their own inline scripts via
  // renderAnalytics/renderMetaPixel — they're allowed. What we don't want
  // back is the per-button IIFE blob that used to live here.
  assert.doesNotMatch(html, /getElementById\('dr-set-avatar'\)/);
  assert.doesNotMatch(html, /getElementById\('dr-copy-link'\)/);
  assert.doesNotMatch(html, /navigator\.clipboard\.writeText/);
  assert.doesNotMatch(html, /navigator\.share\(payload\)/);
});

test("tile page: renders a like button with the SSR count + loads /like.js", () => {
  const html = renderTilePage({ ...baseView, like_count: 12 });
  assert.match(html, new RegExp(`data-like-target="${"f".repeat(64)}"`));
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /<span class="like-count" data-like-count>12<\/span>/);
  assert.match(html, /<script src="\/like\.js"><\/script>/);
});
