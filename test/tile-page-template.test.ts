import { strict as assert } from "node:assert";
import { test } from "node:test";
import renderTilePage, { formatCreatedAt } from "../builder/templates/tile-page.js";

const baseView = {
  tile_id: "f".repeat(64),
  id_short: "ffffffff",
  created_at: "2026-05-08T04:24:56.088Z",
  parent: null,
  author: { user_id: "a".repeat(64), username: "alice" },
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
  assert.match(html, /<dt>Author<\/dt><dd><a href="\/u\/alice">alice<\/a><\/dd>/);
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
  assert.match(html, /<dt>Parent<\/dt><dd><a href="\/t\/c{64}">cccccccc<\/a><\/dd>/);
});

test("tile page: mural memberships link to the mural + claimer", () => {
  const html = renderTilePage({
    ...baseView,
    murals: [
      {
        id: "mural-2026-W19",
        name: "Mural 2026-W19",
        x: 3,
        y: 7,
        claimed_by: "b".repeat(64),
        claimed_by_username: "bob",
      },
    ],
  });
  assert.match(html, /<dt>Murals<\/dt>/);
  assert.match(html, /<a href="\/murals\/mural-2026-W19#tile-3-7">Mural 2026-W19<\/a>/);
  assert.match(html, /by <a href="\/u\/bob">bob<\/a>/);
});

test("tile page: hidden children placeholders ship on every tile", () => {
  const html = renderTilePage(baseView);
  assert.match(html, /<dt id="dr-children-dt" hidden>Children<\/dt>/);
  assert.match(html, /<dd id="dr-children-dd" hidden><\/dd>/);
});

test("tile page: hydration script fetches /tiles/<id>.children.json", () => {
  const html = renderTilePage(baseView);
  assert.match(html, /<script>/);
  assert.match(html, new RegExp(`"${"f".repeat(64)}"`));
  assert.match(html, /\/tiles\/' \+ id \+ '\.children\.json/);
});

test("tile page: Copy link is an interactive button, not a self-link", () => {
  const html = renderTilePage(baseView);
  assert.match(html, /<button class="btn" id="dr-copy-link" type="button">Copy link<\/button>/);
  assert.doesNotMatch(html, /<a class="btn" href="\/t\/[^"]+">Copy link<\/a>/);
});

test("tile page: copy handler loads /flash.js and surfaces a flash on success", () => {
  const html = renderTilePage(baseView);
  assert.match(html, /<script src="\/flash\.js"><\/script>/);
  assert.match(html, /navigator\.clipboard\.writeText/);
  assert.match(html, /window\.drawbangShowFlash/);
  assert.match(html, /document\.execCommand\('copy'\)/);
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
    new RegExp(`<link rel="canonical" href="https://pixel\\.drawbang\\.com/t/${id}"`),
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
    new RegExp(`<meta property="og:url" content="https://pixel\\.drawbang\\.com/t/${id}"`),
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
  const expectedUrl = encodeURIComponent(`https://pixel.drawbang.com/t/${id}`);
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
  const expectedUrl = encodeURIComponent(`https://pixel.drawbang.com/t/${id}`);
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
  const expectedUrl = encodeURIComponent(`https://pixel.drawbang.com/t/${id}`);
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

test("tile page: Web Share script feature-tests navigator.share and falls back silently", () => {
  const html = renderTilePage(baseView);
  assert.match(html, /typeof navigator\.share !== 'function'/);
  assert.match(html, /navigator\.canShare/);
  assert.match(html, /navigator\.share\(payload\)/);
  assert.match(html, /e\.name !== 'AbortError'/);
});

test("tile page: inline GA tracking wires each action button to its event", () => {
  const html = renderTilePage(baseView);
  assert.match(html, /id="dr-make-merch"/);
  assert.match(html, /id="dr-fork"/);
  assert.match(html, /id="dr-share-threads"/);
  assert.match(html, /id="dr-share-reddit"/);
  assert.match(html, /id="dr-share-x"/);
  assert.match(html, /id="dr-download-gif"/);
  for (const ev of [
    "make_merch_click",
    "fork_click",
    "share_click",
    "gif_download_click",
    "copy_share_link_click",
  ]) {
    assert.match(html, new RegExp(`'${ev}'`));
  }
  assert.match(html, /typeof window\.gtag !== 'function'/);
});
