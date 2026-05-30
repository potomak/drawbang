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
  assert.match(html, /<a class="hdr-logo" href="\/"/);
});

test("renderHeader nav order matches NAV_LINKS, then identity, then logout", () => {
  const html = renderHeader();
  const fixedIds = NAV_LINKS.map((l) => l.id);
  // identity + logout are computed at render time; not in NAV_LINKS but must
  // follow, in that order.
  const expectedIds = [...fixedIds, "identity", "logout"];
  const datas = [...html.matchAll(/data-nav="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(datas, expectedIds);
});

test("renderHeader: no Home link in the nav (the logo is the home link)", () => {
  const html = renderHeader();
  assert.doesNotMatch(html, /data-nav="home"/);
});

test("renderHeader: active='products' marks the products link with aria-current='page'", () => {
  const html = renderHeader({ active: "products" });
  const ariaMatches = [...html.matchAll(/aria-current="page"/g)];
  assert.equal(ariaMatches.length, 1);
  assert.match(html, /data-nav="products"[^>]*aria-current="page"/);
  assert.doesNotMatch(html, /data-nav="identity"[^>]*aria-current/);
});

test("renderFooter exposes X, Discord, Facebook, Instagram, and Threads social links in a nav", () => {
  const footer = renderFooter({ repoUrl: REPO });
  assert.match(footer, /<nav class="ftr-social" aria-label="Social">/);
  assert.match(footer, /href="https:\/\/x\.com\/drawbang"[^>]*>X</);
  assert.match(footer, /href="https:\/\/discord\.gg\/mXA4NQjcxg"[^>]*>Discord</);
  assert.match(footer, /href="https:\/\/facebook\.com\/drawbang"[^>]*>Facebook</);
  assert.match(footer, /href="https:\/\/instagram\.com\/drawbang256"[^>]*>Instagram</);
  assert.match(footer, /href="https:\/\/www\.threads\.net\/@drawbang256"[^>]*>Threads</);
});

test("renderFooter groups nav + social on the left, repo + feedback on the right", () => {
  const footer = renderFooter({ repoUrl: REPO });
  // Left column wraps the nav links and the social nav.
  assert.match(
    footer,
    /<div class="ftr-left">[\s\S]*<nav class="ftr-links"[\s\S]*<nav class="ftr-social"[\s\S]*<\/div>/,
  );
  // Right column wraps the repo link and the new feedback link in that order.
  assert.match(
    footer,
    /<div class="ftr-right">[\s\S]*ftr-repo[\s\S]*ftr-feedback[\s\S]*<\/div>/,
  );
});

test("renderFooter exposes a Feedback link to the labelled GitHub issue form", () => {
  const footer = renderFooter({ repoUrl: REPO });
  assert.match(
    footer,
    /<a class="ftr-feedback" href="https:\/\/github\.com\/potomak\/drawbang\/issues\/new\?labels=feedback" target="_blank" rel="noopener">/,
  );
  assert.match(footer, /<span>Feedback<\/span>/);
  // Placeholder icon present and marked aria-hidden so screen readers don't
  // announce "image" before the label.
  assert.match(footer, /<svg[^>]*aria-hidden="true"/);
});

test("renderFooter contains the repo link and the same nav as the header", () => {
  const footer = renderFooter({ repoUrl: REPO });
  assert.match(footer, /<a class="ftr-repo" href="https:\/\/github\.com\/potomak\/drawbang"/);
  // Footer mirrors the header's nav now that the editor lives at /
  // (reachable via the logo).
  const fixedIds = NAV_LINKS.map((l) => l.id);
  const expectedIds = [...fixedIds, "identity", "logout"];
  const datas = [...footer.matchAll(/data-nav="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(datas, expectedIds);
});

test("identity link: hasIdentity + username → /u/<username>", () => {
  const header = renderHeader({ hasIdentity: true, identityUsername: "alice" });
  assert.match(header, /href="\/u\/alice" data-nav="identity"/);
  assert.match(header, />Profile</);
  const footer = renderFooter({ hasIdentity: true, identityUsername: "alice", repoUrl: REPO });
  assert.match(footer, /href="\/u\/alice" data-nav="identity"/);
});

test("identity link: no username falls back to the sign-in href", () => {
  const header = renderHeader();
  assert.match(header, new RegExp(`href="${IDENTITY_FALLBACK_HREF}" data-nav="identity"`));
  assert.match(header, />Sign in</);
  // hasIdentity=true alone (no username) also falls back.
  const header2 = renderHeader({ hasIdentity: true });
  assert.match(header2, new RegExp(`href="${IDENTITY_FALLBACK_HREF}" data-nav="identity"`));
});

test("chrome module gzips under 1.5 KB", async () => {
  // Measure what would ship after bundling: esbuild minifies the TS the
  // same way Vite does for prod builds, then gzip. JSDoc + whitespace
  // are stripped before the size check, so the budget is about the
  // actual browser payload, not the source-with-comments.
  // Budget bumps: 1024 → 1536 once social links + feedback + placeholder
  // bug icon SVG landed; 1536 → 1664 once the FAB landed with its inline
  // "+" SVG. Leaves a bit of headroom for the next small chrome addition.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = await fs.readFile(path.join(here, "../src/layout/chrome.ts"), "utf8");
  const { code } = await transform(src, { loader: "ts", minify: true });
  const gz = gzipSync(code);
  assert.ok(gz.length < 1664, `chrome.ts minified+gzipped to ${gz.length} bytes, expected < 1664`);
});

test("renderFooter references the chrome-toggle.js at a stable URL", () => {
  // #170 ships the hamburger toggle as a single static asset
  // (`static/chrome-toggle.js`) loaded by every surface. The script tag
  // attaches in the footer so the page parser has the markup before
  // executing.
  const html = renderFooter({ repoUrl: REPO });
  assert.match(html, /<script src="\/chrome-toggle\.js"><\/script>/);
});

test("renderFooter references the chrome-identity.js patcher (#171)", () => {
  const html = renderFooter({ repoUrl: REPO });
  assert.match(html, /<script src="\/chrome-identity\.js"><\/script>/);
});

test("renderFooter references /flash.js so window.drawbang{Show,Hide}Flash + pending-flash auto-consume are wired on every surface", () => {
  const html = renderFooter({ repoUrl: REPO });
  assert.match(html, /<script src="\/flash\.js"><\/script>/);
  // flash.js must load before chrome-identity.js — the latter's logout path
  // queues a pending flash, and we want the consumer wired by the time any
  // page interaction can trigger it.
  const flashIdx = html.indexOf('src="/flash.js"');
  const identityIdx = html.indexOf('src="/chrome-identity.js"');
  assert.ok(flashIdx >= 0 && identityIdx >= 0 && flashIdx < identityIdx);
});

test("identity link carries data-identity-link='1' so the patcher can find it", () => {
  const header = renderHeader();
  assert.match(header, /data-nav="identity"[^>]*data-identity-link="1"/);
  const footer = renderFooter({ repoUrl: REPO });
  assert.match(footer, /data-nav="identity"[^>]*data-identity-link="1"/);
});

test("non-identity links do NOT carry data-identity-link", () => {
  const header = renderHeader();
  // Only the identity link should have the marker. The products link
  // would be a footgun if it got rewritten by the patcher.
  const matches = [...header.matchAll(/data-identity-link="1"/g)];
  assert.equal(matches.length, 1);
  assert.doesNotMatch(header, /data-nav="products"[^>]*data-identity-link/);
});

test("logout link: rendered hidden with data-logout-link='1' so the patcher reveals it when logged in", () => {
  // Build-time chrome is always logged-out, so the sign-out link ships
  // hidden; /chrome-identity.js unhides it + wires the click when a session
  // is present. It lives in both the header and footer nav.
  for (const html of [renderHeader(), renderFooter({ repoUrl: REPO })]) {
    assert.match(html, /data-nav="logout"[^>]*data-logout-link="1"[^>]*hidden/);
    assert.match(html, /href="\/"[^>]*data-nav="logout"[^>]*>Sign out</);
  }
});

test("logout link does NOT carry the identity-link marker (patcher must not rewrite it to a profile href)", () => {
  const header = renderHeader();
  assert.doesNotMatch(header, /data-nav="logout"[^>]*data-identity-link/);
});

test("renderHeader exposes the menu toggle button + nav id linkage for #170's responsive JS", () => {
  // The hamburger toggle and the nav share aria-controls / id="chrome-nav".
  // #170 wires the JS, but the markup contract lives here so the JS can
  // assume it.
  const html = renderHeader();
  assert.match(html, /<button class="chrome-menu-toggle" aria-controls="chrome-nav" aria-expanded="false" hidden>/);
  assert.match(html, /<nav id="chrome-nav"/);
});

test("renderFooter renders the FAB linking to /draw by default", () => {
  const html = renderFooter({ repoUrl: REPO });
  assert.match(html, /<a class="fab" href="\/draw" aria-label="New drawing"/);
});

test("renderFooter suppresses the FAB when fab: false (editor page)", () => {
  const html = renderFooter({ repoUrl: REPO, fab: false });
  assert.doesNotMatch(html, /class="fab"/);
});

test("renderHeader escapes user-controlled identityUsername defensively", () => {
  // identityUsername is callsite-supplied — guard against an injection
  // even though real usernames are always [a-z0-9_-]{3,20}.
  const html = renderHeader({ hasIdentity: true, identityUsername: '"><script>x()</script>' });
  assert.ok(!html.includes("<script>x()"));
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
});
