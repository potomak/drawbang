import { strict as assert } from "node:assert";
import { test } from "node:test";
import { injectChrome } from "../vite/plugins/chrome.js";

const REPO = "https://github.com/example/repo";

test("injectChrome: replaces <!--CHROME:HEADER--> with the rendered header markup", () => {
  const input = `<!doctype html><html><body><!--CHROME:HEADER--><main>x</main></body></html>`;
  const out = injectChrome(input, REPO);
  assert.match(out, /<header class="chrome-header">/);
  assert.match(out, /<a class="chrome-logo" href="\/"/);
  // The marker is gone.
  assert.doesNotMatch(out, /CHROME:HEADER/);
});

test("injectChrome: replaces <!--CHROME:FOOTER--> with the rendered footer + repoUrl", () => {
  const input = `<!doctype html><html><body><main>x</main><!--CHROME:FOOTER--></body></html>`;
  const out = injectChrome(input, REPO);
  assert.match(out, /<footer class="chrome-footer">/);
  assert.match(out, new RegExp(`href="${REPO.replace(/\//g, "\\/")}"`));
  assert.doesNotMatch(out, /CHROME:FOOTER/);
});

test("injectChrome: <meta name='drawbang:active'> drives the active link AND is stripped from output", () => {
  const input = `<!doctype html><html><head><meta name="drawbang:active" content="products" /></head><body><!--CHROME:HEADER--><!--CHROME:FOOTER--></body></html>`;
  const out = injectChrome(input, REPO);
  // products link is marked active in both surfaces.
  const hits = [...out.matchAll(/data-nav="products"[^>]*aria-current="page"/g)];
  assert.equal(hits.length, 2, "active link in header AND footer");
  // No other link is active.
  assert.equal((out.match(/aria-current="page"/g) ?? []).length, 2);
  // Meta tag is stripped — it's a build-time hint only.
  assert.doesNotMatch(out, /drawbang:active/);
});

test("injectChrome: no meta tag → no active state, no errors", () => {
  const input = `<!doctype html><html><body><!--CHROME:HEADER--></body></html>`;
  const out = injectChrome(input, REPO);
  assert.doesNotMatch(out, /aria-current="page"/);
});

test("injectChrome: no markers → input is returned essentially unchanged (still strips active meta)", () => {
  // A page that opts out of the chrome — e.g. an iframe-only landing — just
  // omits both markers. The plugin shouldn't crash or inject anything.
  const input = `<!doctype html><html><body><h1>hello</h1></body></html>`;
  const out = injectChrome(input, REPO);
  assert.equal(out, input);
});

test("injectChrome: handles unquoted meta + extra whitespace", () => {
  // Defensive — Vite's HTML transform pipeline can reformat input.
  const input = `<!doctype html><html><head>\n    <meta name="drawbang:active"   content="gallery"  />\n  </head><body><!--CHROME:HEADER--></body></html>`;
  const out = injectChrome(input, REPO);
  assert.match(out, /data-nav="gallery"[^>]*aria-current="page"/);
});
