import { strict as assert } from "node:assert";
import { test } from "node:test";
import { injectChrome } from "../vite/plugins/chrome.js";

const REPO = "https://github.com/example/repo";

test("injectChrome: replaces <!--CHROME:HEADER--> with the rendered header markup", () => {
  const input = `<!doctype html><html><body><!--CHROME:HEADER--><main>x</main></body></html>`;
  const out = injectChrome(input, REPO);
  assert.match(out, /<header class="hdr">/);
  assert.match(out, /<a class="hdr-logo" href="\/"/);
  // The marker is gone.
  assert.doesNotMatch(out, /CHROME:HEADER/);
});

test("injectChrome: replaces <!--CHROME:FOOTER--> with the closing app-shell + scripts (2-col default, no right rail)", () => {
  const input = `<!doctype html><html><body><main>x</main><!--CHROME:FOOTER--></body></html>`;
  const out = injectChrome(input, REPO);
  // The footer closes the app-shell wrapper opened by renderHeader and
  // emits the chrome scripts. Right rail is opt-in (only the feed turns
  // it on) so Vite pages stay 2-col by default.
  assert.doesNotMatch(out, /class="rail-right"/);
  assert.match(out, /<script src="\/chrome-toggle\.js"/);
  assert.doesNotMatch(out, /CHROME:FOOTER/);
});

test("injectChrome: <meta name='drawbang:active'> drives the active link AND is stripped from output", () => {
  const input = `<!doctype html><html><head><meta name="drawbang:active" content="products" /></head><body><!--CHROME:HEADER--><!--CHROME:FOOTER--></body></html>`;
  const out = injectChrome(input, REPO);
  // The products link is marked active in the left rail (the only place
  // primary nav lives now).
  const hits = [...out.matchAll(/data-nav="products"[^>]*aria-current="page"/g)];
  assert.equal(hits.length, 1, "active link in left rail");
  assert.equal((out.match(/aria-current="page"/g) ?? []).length, 1);
  // Meta tag is stripped — it's a build-time hint only.
  assert.doesNotMatch(out, /drawbang:active/);
});

test("injectChrome: no meta tag → no active state, no errors", () => {
  const input = `<!doctype html><html><body><!--CHROME:HEADER--></body></html>`;
  const out = injectChrome(input, REPO);
  assert.doesNotMatch(out, /aria-current="page"/);
});

test("injectChrome: no markers → input is returned essentially unchanged (still strips active meta)", () => {
  // A page that opts out of the chrome — e.g. an iframe-only landing —
  // just omits both markers. The plugin shouldn't crash or inject
  // anything.
  const input = `<!doctype html><html><body><h1>hello</h1></body></html>`;
  const out = injectChrome(input, REPO);
  assert.equal(out, input);
});

test("injectChrome: handles unquoted meta + extra whitespace", () => {
  // Defensive — Vite's HTML transform pipeline can reformat input.
  const input = `<!doctype html><html><head>\n    <meta name="drawbang:active"   content="products"  />\n  </head><body><!--CHROME:HEADER--></body></html>`;
  const out = injectChrome(input, REPO);
  assert.match(out, /data-nav="products"[^>]*aria-current="page"/);
});

test("injectChrome: <meta name='drawbang:rails' content='off'> suppresses the app-shell wrapper + rails", () => {
  // Default: rails on. .app-shell opens, .rail-left ships inline.
  const inputWith = `<!doctype html><html><head></head><body><!--CHROME:HEADER--><!--CHROME:FOOTER--></body></html>`;
  const outWith = injectChrome(inputWith, REPO);
  assert.match(outWith, /<div class="app-shell">/);
  assert.match(outWith, /<aside class="rail-left"/);
  // Vite pages don't pass rightRail, so the discover rail is absent
  // by default.
  assert.doesNotMatch(outWith, /<aside class="rail-right"/);

  // Opt-out: the editor uses this so the canvas gets the full viewport.
  const inputWithout = `<!doctype html><html><head><meta name="drawbang:rails" content="off" /></head><body><!--CHROME:HEADER--><!--CHROME:FOOTER--></body></html>`;
  const outWithout = injectChrome(inputWithout, REPO);
  assert.doesNotMatch(outWithout, /class="app-shell"/);
  assert.doesNotMatch(outWithout, /class="rail-left"/);
  assert.doesNotMatch(outWithout, /class="rail-right"/);
  // The meta tag itself is stripped from the output.
  assert.doesNotMatch(outWithout, /drawbang:rails/);
});
