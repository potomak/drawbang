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
  renderLeftRail,
} from "../src/layout/chrome.js";

const REPO = "https://github.com/potomak/drawbang";

// ===== Header =====

test("renderHeader contains the logo link to /", () => {
  const html = renderHeader();
  assert.match(html, /<a class="hdr-logo" href="\/"/);
});

test("renderHeader: header has no primary nav — that moves to the left rail", () => {
  const html = renderHeader({ rails: false });
  // No <nav> inside the header — the primary nav lives in the rail.
  // (When rails are on, the rail's nav follows, so scope the assertion
  // to the header-only render.)
  assert.doesNotMatch(html, /<nav/);
});

test("renderHeader: auth slot ships both states, signed-in hidden by default", () => {
  const html = renderHeader();
  // Signed-out fallback (the build-time default).
  assert.match(html, /<a class="hdr-signin" href="\/login" data-identity-link="1" data-auth-state="signed-out">Sign in<\/a>/);
  // Signed-in slot ships hidden — chrome-identity.js reveals it client-side
  // when localStorage has a username.
  assert.match(html, /<a class="hdr-profile" href="#" data-identity-link="1" data-auth-state="signed-in" hidden>/);
  assert.match(html, /<img class="profile-picture hdr-profile-pic"/);
  assert.match(html, /<span class="hdr-profile-name"><\/span>/);
});

test("renderHeader: identity fallback href is /login (constant)", () => {
  const html = renderHeader();
  assert.match(html, new RegExp(`href="${IDENTITY_FALLBACK_HREF}"`));
});

test("renderHeader: opens .app-shell + emits .rail-left when rails=true (default)", () => {
  const html = renderHeader({ active: "home" });
  assert.match(html, /<div class="app-shell">/);
  assert.match(html, /<aside class="rail-left" id="rail-left">/);
  // The rail-left content (CTA, nav, foot) is emitted by renderLeftRail
  // and embedded inline.
  assert.match(html, /class="rail-cta"/);
});

test("renderHeader: rails=false suppresses the app-shell wrapper", () => {
  const html = renderHeader({ rails: false });
  assert.doesNotMatch(html, /class="app-shell"/);
  assert.doesNotMatch(html, /class="rail-left"/);
});

test("renderHeader: menu button is rendered hidden so chrome-toggle.js can wire it on mobile", () => {
  const html = renderHeader();
  assert.match(html, /<button class="hdr-menu" aria-controls="rail-left" aria-expanded="false" aria-label="Menu" hidden>/);
});

// ===== Footer =====

test("renderFooter: closes .app-shell when rails=true (default 2-col, no right rail)", () => {
  const html = renderFooter({ repoUrl: REPO });
  assert.match(html, /<\/div>/);
  // Right rail is opt-in (only the feed turns it on). Default is 2-col.
  assert.doesNotMatch(html, /class="rail-right"/);
});

test("renderFooter: rightRail=true adds the right discover rail", () => {
  const html = renderFooter({ repoUrl: REPO, rightRail: true });
  assert.match(html, /<aside class="rail-right" data-rail-right><\/aside>/);
});

test("renderFooter: rails=false suppresses the rail-right + closing wrapper", () => {
  const html = renderFooter({ repoUrl: REPO, rails: false });
  assert.doesNotMatch(html, /class="rail-right"/);
});

test("renderHeader: rightRail=true marks the shell with .has-rail-right", () => {
  const html = renderHeader({ rightRail: true });
  assert.match(html, /class="app-shell has-rail-right"/);
  const html2 = renderHeader();
  assert.match(html2, /class="app-shell"/);
  assert.doesNotMatch(html2, /has-rail-right/);
});

test("renderFooter references the chrome-toggle.js at a stable URL", () => {
  const html = renderFooter({ repoUrl: REPO });
  assert.match(html, /<script src="\/chrome-toggle\.js"[^>]*><\/script>/);
});

test("renderFooter references the chrome-identity.js patcher", () => {
  const html = renderFooter({ repoUrl: REPO });
  assert.match(html, /<script src="\/chrome-identity\.js"[^>]*><\/script>/);
});

test("renderFooter references /flash.js so window.drawbang{Show,Hide}Flash + pending-flash auto-consume are wired on every surface", () => {
  const html = renderFooter({ repoUrl: REPO });
  assert.match(html, /<script src="\/flash\.js"[^>]*><\/script>/);
  // flash.js must load before chrome-identity.js — the latter's logout
  // path queues a pending flash, and we want the consumer wired by the
  // time any page interaction can trigger it.
  const flashIdx = html.indexOf("flash.js");
  const identityIdx = html.indexOf("chrome-identity.js");
  assert.ok(flashIdx >= 0 && identityIdx >= 0 && flashIdx < identityIdx);
});

// ===== Left rail =====

test("renderLeftRail: NEW DRAWING CTA links to /draw", () => {
  const html = renderLeftRail({});
  assert.match(html, /<a class="rail-cta" href="\/draw"/);
  assert.match(html, /New drawing/);
});

test("renderLeftRail: primary nav contains every NAV_LINKS entry", () => {
  const html = renderLeftRail({});
  for (const l of NAV_LINKS) {
    assert.match(html, new RegExp(`href="${l.href}" data-nav="${l.id}"`));
  }
});

test("renderLeftRail: active='products' marks the products link with aria-current='page'", () => {
  const html = renderLeftRail({ active: "products" });
  const ariaMatches = [...html.matchAll(/aria-current="page"/g)];
  assert.equal(ariaMatches.length, 1);
  assert.match(html, /data-nav="products"[^>]*aria-current="page"/);
});

test("renderLeftRail: followers + following blocks ship hidden so chrome-identity.js can reveal them when signed-in", () => {
  const html = renderLeftRail({});
  assert.match(html, /<div class="rail-follow" data-profile-username="" data-rail-follow="followers" hidden>/);
  assert.match(html, /<div class="rail-follow" data-profile-username="" data-rail-follow="following" hidden>/);
  // The link inside each block has the per-kind marker chrome-identity.js
  // looks for to set the href.
  assert.match(html, /data-rail-follow-link="followers"/);
  assert.match(html, /data-rail-follow-link="following"/);
});

test("renderLeftRail: follower/following counts ship as 0 and live behind hydrate.js's [data-follower-count]/[data-following-count] hooks", () => {
  const html = renderLeftRail({});
  assert.match(html, /<span data-follower-count>0<\/span>/);
  assert.match(html, /<span data-following-count>0<\/span>/);
});

test("renderLeftRail: bookmarks/account/sign-out rows ship hidden and wire to chrome-identity.js markers", () => {
  const html = renderLeftRail({});
  assert.match(html, /<a class="rail-link" data-rail-bookmarks href="#" hidden>Bookmarks<\/a>/);
  assert.match(html, /<a class="rail-link" data-rail-account href="\/account" hidden>Account<\/a>/);
  assert.match(html, /<a class="rail-link rail-logout" href="\/" data-logout-link="1" hidden>Sign out<\/a>/);
});

test("renderLeftRail: secondary group has the social row + Privacy + Feedback, anchored via .rail-foot", () => {
  const html = renderLeftRail({});
  assert.match(html, /<div class="rail-foot">/);
  // Social links (kept identical to the previous footer's order).
  assert.match(html, /href="https:\/\/x\.com\/drawbang"[^>]*aria-label="X"/);
  assert.match(html, /href="https:\/\/discord\.gg\/mXA4NQjcxg"/);
  assert.match(html, /href="https:\/\/facebook\.com\/drawbang"/);
  assert.match(html, /href="https:\/\/instagram\.com\/drawbang256"/);
  assert.match(html, /href="https:\/\/www\.threads\.net\/@drawbang256"/);
  // Privacy + Feedback live in a nav below the social row.
  assert.match(html, /href="\/privacy"[^>]*>Privacy</);
  assert.match(html, /href="https:\/\/github\.com\/potomak\/drawbang\/issues\/new\?labels=feedback"/);
});

test("renderLeftRail: identity-link marker present on the only element the patcher should rewrite (= no false matches)", () => {
  // chrome-identity.js uses data-identity-link="1" to find the auth
  // anchor. The rail must not introduce another match; otherwise the
  // patcher rewrites the wrong link.
  const html = renderLeftRail({});
  assert.doesNotMatch(html, /data-identity-link/);
});

test("renderLeftRail: logout link does NOT carry the identity-link marker", () => {
  const html = renderLeftRail({});
  assert.doesNotMatch(html, /data-logout-link[^>]*data-identity-link/);
});

// ===== FAB is gone =====

test("chrome no longer ships a FAB (the CTA lives in the rail now)", () => {
  const header = renderHeader();
  const footer = renderFooter({ repoUrl: REPO });
  assert.doesNotMatch(header, /class="fab"/);
  assert.doesNotMatch(footer, /class="fab"/);
});

// ===== Bundle budget =====

test("chrome module gzips under 2.5 KB", async () => {
  // The left-rail content (CTA + nav + social row + secondary nav) is
  // ~1KB heavier than the v2 chrome was; bumped budget covers it with
  // a small headroom for the next addition.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = await fs.readFile(path.join(here, "../src/layout/chrome.ts"), "utf8");
  const { code } = await transform(src, { loader: "ts", minify: true });
  const gz = gzipSync(code);
  assert.ok(gz.length < 2560, `chrome.ts minified+gzipped to ${gz.length} bytes, expected < 2560`);
});
