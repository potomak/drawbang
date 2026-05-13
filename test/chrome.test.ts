import { strict as assert } from "node:assert";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { transform } from "esbuild";
import {
  IDENTITY_FALLBACK_HREF,
  NAV_LINKS,
  renderFooter,
  renderHeader,
} from "../src/layout/chrome.js";

const REPO = "https://github.com/potomak/drawbang";

test("renderHeader contains the logo link to /", () => {
  const html = renderHeader();
  assert.match(html, /<a class="chrome-logo" href="\/"/);
});

test("renderHeader nav order matches NAV_LINKS, with identity appended last", () => {
  const html = renderHeader();
  const fixedIds = NAV_LINKS.map((l) => l.id);
  // identity is computed at render time; not in NAV_LINKS but must follow.
  const expectedIds = [...fixedIds, "identity"];
  const datas = [...html.matchAll(/data-nav="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(datas, expectedIds);
});

test("renderHeader: active='gallery' marks only the gallery link with aria-current='page'", () => {
  const html = renderHeader({ active: "gallery" });
  // Exactly one aria-current="page" attribute…
  const ariaMatches = [...html.matchAll(/aria-current="page"/g)];
  assert.equal(ariaMatches.length, 1);
  // …and it sits on the gallery link.
  assert.match(html, /data-nav="gallery"[^>]*aria-current="page"/);
  // products and identity links are NOT marked active.
  assert.doesNotMatch(html, /data-nav="products"[^>]*aria-current/);
  assert.doesNotMatch(html, /data-nav="identity"[^>]*aria-current/);
});

test("renderFooter contains the repo link and the same nav as the header", () => {
  const footer = renderFooter({ repoUrl: REPO });
  assert.match(footer, /<a class="chrome-footer-repo" href="https:\/\/github\.com\/potomak\/drawbang"/);
  // Same nav entries as the header, in the same order.
  const fixedIds = NAV_LINKS.map((l) => l.id);
  const expectedIds = [...fixedIds, "identity"];
  const datas = [...footer.matchAll(/data-nav="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(datas, expectedIds);
});

test("identity link: hasIdentity + pubkey → /keys/<pubkey>", () => {
  const pk = "a".repeat(64);
  const header = renderHeader({ hasIdentity: true, identityPubkey: pk });
  assert.match(header, new RegExp(`<a href="/keys/${pk}" data-nav="identity"`));
  const footer = renderFooter({ hasIdentity: true, identityPubkey: pk, repoUrl: REPO });
  assert.match(footer, new RegExp(`<a href="/keys/${pk}" data-nav="identity"`));
});

test("identity link: no pubkey falls back to the in-page-dialog href", () => {
  const header = renderHeader();
  assert.match(header, new RegExp(`<a href="${IDENTITY_FALLBACK_HREF}" data-nav="identity"`));
  // hasIdentity=true alone (no pubkey) also falls back.
  const header2 = renderHeader({ hasIdentity: true });
  assert.match(header2, new RegExp(`<a href="${IDENTITY_FALLBACK_HREF}" data-nav="identity"`));
});

test("chrome module gzips under 1 KB (acceptance criterion from #167)", async () => {
  // Measure what would ship after bundling: esbuild minifies the TS the
  // same way Vite does for prod builds, then gzip. JSDoc + whitespace
  // are stripped before the size check, so the budget is about the
  // actual browser payload, not the source-with-comments.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = await fs.readFile(path.join(here, "../src/layout/chrome.ts"), "utf8");
  const { code } = await transform(src, { loader: "ts", minify: true });
  const gz = gzipSync(code);
  assert.ok(gz.length < 1024, `chrome.ts minified+gzipped to ${gz.length} bytes, expected < 1024`);
});

test("renderFooter references the chrome-toggle.js at a stable URL", () => {
  // #170 ships the hamburger toggle as a single static asset
  // (`static/chrome-toggle.js`) loaded by every surface. The script tag
  // attaches in the footer so the page parser has the markup before
  // executing.
  const html = renderFooter({ repoUrl: REPO });
  assert.match(html, /<script src="\/chrome-toggle\.js"><\/script>/);
});

test("renderHeader exposes the menu toggle button + nav id linkage for #170's responsive JS", () => {
  // The hamburger toggle and the nav share aria-controls / id="chrome-nav".
  // #170 wires the JS, but the markup contract lives here so the JS can
  // assume it.
  const html = renderHeader();
  assert.match(html, /<button class="chrome-menu-toggle" aria-controls="chrome-nav" aria-expanded="false" hidden>/);
  assert.match(html, /<nav id="chrome-nav"/);
});

test("renderHeader escapes user-controlled identityPubkey defensively", () => {
  // identityPubkey is callsite-supplied — guard against an injection
  // even though real pubkeys are always 64 hex.
  const html = renderHeader({ hasIdentity: true, identityPubkey: '"><script>x()</script>' });
  assert.ok(!html.includes("<script>x()"));
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
});
