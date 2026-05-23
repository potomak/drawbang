import { strict as assert } from "node:assert";
import { test } from "node:test";
import renderDrawing, { formatCreatedAt } from "../builder/templates/drawing.js";

const baseView = {
  id: "f".repeat(64),
  id_short: "ffffffff",
  created_at: "2026-05-08T04:24:56.088Z",
  parent: null,
  author: { pubkey: "a".repeat(64), pubkey_short: "aaaaaaaa" },
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

test("drawing page: friendly date is up front", () => {
  const html = renderDrawing(baseView);
  assert.match(
    html,
    /<dt>Created<\/dt>\s*<dd><time datetime="2026-05-08T04:24:56\.088Z">May 8, 2026 · 04:24 UTC<\/time><\/dd>/,
  );
});

test("drawing page: short ID renders without trailing ellipsis", () => {
  const html = renderDrawing(baseView);
  assert.match(html, /<dt>ID<\/dt>\s*<dd><code class="mono-trunc">ffffffff<\/code><\/dd>/);
  assert.doesNotMatch(html, /ffffffff…/);
});

test("drawing page: no Advanced disclosure / no technical fields", () => {
  const html = renderDrawing(baseView);
  assert.doesNotMatch(html, /<details/);
  assert.doesNotMatch(html, /Advanced/);
  assert.doesNotMatch(html, /Proof of work/);
  assert.doesNotMatch(html, /Minted/);
});

test("drawing page: author label (signed)", () => {
  const html = renderDrawing(baseView);
  assert.match(html, /<dt>Author<\/dt><dd><a href="\/keys\/a{64}">aaaaaaaa<\/a><\/dd>/);
});

test("drawing page: author label (anonymous)", () => {
  const html = renderDrawing({ ...baseView, author: null });
  assert.match(html, /<dt>Author<\/dt><dd>anonymous<\/dd>/);
});

test("drawing page: parent link (when present) renders in the meta dl", () => {
  const html = renderDrawing({
    ...baseView,
    parent: { parent: "c".repeat(64), parent_short: "cccccccc" },
  });
  assert.match(html, /<dt>Parent<\/dt><dd><a href="\/d\/c{64}">cccccccc<\/a><\/dd>/);
});

test("drawing page: hidden children placeholders ship on every drawing", () => {
  const html = renderDrawing(baseView);
  // Both <dt> and <dd> are present and start hidden — the inline script
  // unhides them on successful hydration.
  assert.match(html, /<dt id="dr-children-dt" hidden>Children<\/dt>/);
  assert.match(html, /<dd id="dr-children-dd" hidden><\/dd>/);
});

test("drawing page: hydration script fetches /drawings/<id>.children.json", () => {
  const html = renderDrawing(baseView);
  assert.match(html, /<script>/);
  // The id is JSON-stringified into the script so the fetch URL is built
  // safely client-side.
  assert.match(html, new RegExp(`"${"f".repeat(64)}"`));
  assert.match(html, /\.children\.json/);
});

test("drawing page: Copy link is an interactive button, not a self-link", () => {
  const html = renderDrawing(baseView);
  // Regression: this used to be `<a href="/d/<id>">Copy link</a>` which
  // just reloaded the current page. Now a button driven by the inline
  // copy handler that calls navigator.clipboard.writeText.
  assert.match(html, /<button class="btn" id="dr-copy-link" type="button">Copy link<\/button>/);
  assert.doesNotMatch(html, /<a class="btn" href="\/d\/[^"]+">Copy link<\/a>/);
});

test("drawing page: copy handler loads /flash.js and surfaces a flash on success", () => {
  // UI consistency (CLAUDE.md): the copy confirmation reuses the shared
  // flash slot rather than a one-off toast. /flash.js must be loaded
  // before the inline script that calls window.drawbangShowFlash.
  const html = renderDrawing(baseView);
  assert.match(html, /<script src="\/flash\.js"><\/script>/);
  assert.match(html, /navigator\.clipboard\.writeText/);
  assert.match(html, /window\.drawbangShowFlash/);
  // execCommand path for browsers without async clipboard.
  assert.match(html, /document\.execCommand\('copy'\)/);
});

test("drawing page: emits the full OG suite with absolute URLs and the -large.gif image", () => {
  const html = renderDrawing(baseView);
  const id = "f".repeat(64);
  // Each tag with the value crawlers (Reddit, X, Slack, Discord) consume.
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
  assert.match(html, /<meta property="og:title" content="Drawing ID ffffffff"/);
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
      `<meta property="og:image" content="https://pixel\\.drawbang\\.com/drawings/${id}-large\\.gif"`,
    ),
  );
  assert.match(html, /<meta property="og:image:type" content="image\/gif"/);
  assert.match(html, /<meta property="og:image:width" content="960"/);
  assert.match(html, /<meta property="og:image:height" content="960"/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image"/);
});

test("drawing page: drops the legacy 16x16 og:image — only the -large.gif tag survives", () => {
  const html = renderDrawing(baseView);
  const id = "f".repeat(64);
  // Regression: the previous og:image pointed at the raw 16×16 gif which
  // rendered as a pixel speck on every preview surface.
  assert.doesNotMatch(
    html,
    new RegExp(`og:image" content="/drawings/${id}\\.gif"`),
  );
});

test("drawing page: Reddit button links directly to reddit.com/submit, not the /share page", () => {
  const html = renderDrawing(baseView);
  const id = "f".repeat(64);
  // Stage 2 of the OG plan: the dedicated /share page is gone. The Reddit
  // submit page now uses the drawing's OG tags for the preview, so the
  // button can just open reddit.com/submit?url=... directly.
  const expectedUrl = encodeURIComponent(`https://pixel.drawbang.com/d/${id}`);
  const expectedTitle = encodeURIComponent("Pixel art from Draw! · Drawing ID ffffffff");
  const reddit = new RegExp(
    `<a class="btn" id="dr-share-reddit" href="https://www\\.reddit\\.com/submit\\?url=${expectedUrl}&amp;title=${expectedTitle}"[^>]*>Share to Reddit</a>`,
  );
  assert.match(html, reddit);
  assert.doesNotMatch(html, /href="\/share\?d=/);
});

test("drawing page: X share button opens twitter.com/intent/tweet with the drawing URL", () => {
  const html = renderDrawing(baseView);
  const id = "f".repeat(64);
  // Stage 3: X share. twitter.com/intent/tweet is a universal link / app
  // link on iOS + Android; the installed app handles it without a custom
  // scheme. We use twitter.com (not x.com) because the latter currently
  // 301-redirects to twitter.com and avoiding the hop is cheap.
  const expectedUrl = encodeURIComponent(`https://pixel.drawbang.com/d/${id}`);
  const expectedText = encodeURIComponent("Pixel art from Draw! · Drawing ID ffffffff");
  const x = new RegExp(
    `<a class="btn" id="dr-share-x" href="https://twitter\\.com/intent/tweet\\?url=${expectedUrl}&amp;text=${expectedText}"[^>]*>Share to X</a>`,
  );
  assert.match(html, x);
});

test("drawing page: Threads share button opens threads.net/intent/post with caption + url", () => {
  const html = renderDrawing(baseView);
  const id = "f".repeat(64);
  // Threads Web Intents: /intent/post?text=...&url=... — same caption/url
  // split as the X button. text is the caption, url attaches the drawing link.
  const expectedText = encodeURIComponent("Pixel art from Draw! · Drawing ID ffffffff");
  const expectedUrl = encodeURIComponent(`https://pixel.drawbang.com/d/${id}`);
  const threads = new RegExp(
    `<a class="btn" id="dr-share-threads" href="https://www\\.threads\\.net/intent/post\\?text=${expectedText}&amp;url=${expectedUrl}"[^>]*>Share to Threads</a>`,
  );
  assert.match(html, threads);
});

test("drawing page: actions split into two .dr-action-row groups", () => {
  const html = renderDrawing(baseView);
  const groups = html.match(/class="dr-action-row"/g) ?? [];
  assert.equal(groups.length, 2);
});

test("drawing page: Web Share button is rendered hidden by default (progressive enhancement)", () => {
  // #107 Option A: Native Share… button as one extra entry next to the
  // targeted Reddit/X buttons. Starts hidden so browsers without
  // navigator.share (notably desktop Firefox) keep the dedicated
  // buttons as the working fallback.
  const html = renderDrawing(baseView);
  assert.match(
    html,
    /<button class="btn" id="dr-share" type="button" hidden>Share…<\/button>/,
  );
});

test("drawing page: Web Share script feature-tests navigator.share and falls back silently", () => {
  // The inline script must check navigator.share (and canShare when
  // present) before unhiding the button. AbortError on the resulting
  // promise = user dismissed the sheet, not an error — must not flash.
  const html = renderDrawing(baseView);
  assert.match(html, /typeof navigator\.share !== 'function'/);
  assert.match(html, /navigator\.canShare/);
  assert.match(html, /navigator\.share\(payload\)/);
  // AbortError check is the "user cancelled" path — flash only on real errors.
  assert.match(html, /e\.name !== 'AbortError'/);
});

test("drawing page: inline GA tracking wires each action button to its event", () => {
  const html = renderDrawing(baseView);
  // Anchor IDs the inline tracking IIFE iterates over.
  assert.match(html, /id="dr-make-merch"/);
  assert.match(html, /id="dr-fork"/);
  assert.match(html, /id="dr-share-threads"/);
  assert.match(html, /id="dr-share-reddit"/);
  assert.match(html, /id="dr-share-x"/);
  assert.match(html, /id="dr-download-gif"/);
  // Event names baked into the IIFE.
  for (const ev of [
    "make_merch_click",
    "fork_click",
    "share_click",
    "gif_download_click",
    "copy_share_link_click",
  ]) {
    assert.match(html, new RegExp(`'${ev}'`));
  }
  // window.gtag is feature-tested before each call.
  assert.match(html, /typeof window\.gtag !== 'function'/);
});
