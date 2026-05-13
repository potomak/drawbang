import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import renderDayGallery from "../builder/templates/day-gallery.js";
import renderDrawing from "../builder/templates/drawing.js";
import renderIndex from "../builder/templates/index.js";
import renderOwner from "../builder/templates/owner.js";
import renderProducts from "../builder/templates/products.js";

const REPO = "https://github.com/potomak/drawbang";

const SAMPLE_DRAWING = {
  id: "a".repeat(64),
  id_short: "aaaaaaaa",
  created_at: "2026-04-01T00:00:00.000Z",
  required_bits: 12,
  solve_ms: 50,
  bench_hps: 100000,
  parent: null,
  owner: null,
  repo_url: REPO,
};

test("nav: gallery landing has both /gallery and /products links, gallery active", () => {
  const html = renderIndex({
    today: "2026-05-11",
    drawings: [],
    days: [],
    repo_url: REPO,
  });
  assert.match(html, /href="\/gallery"/);
  assert.match(html, /href="\/products"/);
  assert.match(html, /href="\/gallery"[^>]*aria-current="page"/);
});

test("nav: day gallery surfaces gallery + products + day breadcrumb", () => {
  const html = renderDayGallery({
    date: "2026-05-11",
    page: 1,
    total_pages: 1,
    drawings: [],
    prev_page: null,
    next_page: null,
    repo_url: REPO,
  });
  assert.match(html, /href="\/gallery"[^>]*aria-current="page"/);
  assert.match(html, /href="\/products"/);
  assert.match(html, /href="\/days\/2026-05-11\/p\/1"/);
});

test("nav: drawing page header has gallery + products links", () => {
  const html = renderDrawing(SAMPLE_DRAWING);
  assert.match(html, /<nav>[\s\S]*href="\/gallery"[\s\S]*href="\/products"[\s\S]*<\/nav>/);
});

test("nav: owner page header has gallery + products links", () => {
  const html = renderOwner({
    pubkey: "b".repeat(64),
    pubkey_short: "bbbbbbbb",
    drawings: [],
    repo_url: REPO,
  });
  assert.match(html, /<nav>[\s\S]*href="\/gallery"[\s\S]*href="\/products"[\s\S]*<\/nav>/);
});

test("nav: /products marks the products link as active (aria-current=page + class=active)", () => {
  const html = renderProducts({
    page: 1,
    total_pages: 1,
    cards: [],
    prev_page: null,
    next_page: null,
    repo_url: REPO,
  });
  assert.match(html, /href="\/products"[^>]*aria-current="page"/);
  assert.match(html, /href="\/products"[^>]*class="active"/);
});

test("nav: static merch + order pages use the chrome marker (chrome plugin injects /products link)", async () => {
  // Before #168 these pages duplicated the nav markup inline. After the
  // chrome refactor they declare the active section + a marker comment,
  // and the Vite plugin injects the shared nav at build time. The /products
  // link landing in the output is asserted by test/chrome-vite-plugin.test.ts
  // and test/chrome.test.ts; here we just verify the source uses the
  // marker pattern, not the old hand-written nav.
  const root = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");
  for (const rel of ["merch.html", "order.html", "share.html"]) {
    const html = await fs.readFile(path.join(root, rel), "utf8");
    assert.match(html, /<!--CHROME:HEADER-->/, `${rel} should use the chrome header marker`);
    assert.match(html, /<!--CHROME:FOOTER-->/, `${rel} should use the chrome footer marker`);
  }
});
