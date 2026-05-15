import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import renderDayGallery from "../builder/templates/day-gallery.js";
import renderDrawing from "../builder/templates/drawing.js";
import renderIndex from "../builder/templates/index.js";
import renderOwner from "../builder/templates/owner.js";
import renderProducts from "../builder/templates/products.js";

// After #169 every builder template delegates to src/layout/chrome.ts.
// The chrome's own rendering is exhaustively tested in test/chrome.test.ts;
// here we verify each template (a) emits the chrome markup at all (rather
// than re-implementing nav inline) and (b) marks the right section active.

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

function activeFor(html: string): string | null {
  const m = html.match(/data-nav="([^"]+)"[^>]*aria-current="page"/);
  return m?.[1] ?? null;
}

test("index.ts (gallery landing) emits chrome and marks gallery active", () => {
  const html = renderIndex({
    today: "2026-05-11",
    drawings: [],
    days: [],
    repo_url: REPO,
  });
  assert.match(html, /<header class="hdr">/);
  assert.match(html, /<footer class="ftr">/);
  assert.equal(activeFor(html), "gallery");
});

test("day-gallery.ts emits chrome and marks gallery active", () => {
  const html = renderDayGallery({
    date: "2026-05-11",
    page: 1,
    total_pages: 1,
    drawings: [],
    prev_page: null,
    next_page: null,
    repo_url: REPO,
  });
  assert.match(html, /<header class="hdr">/);
  assert.equal(activeFor(html), "gallery");
});

test("drawing.ts emits chrome and marks gallery active", () => {
  const html = renderDrawing(SAMPLE_DRAWING);
  assert.match(html, /<header class="hdr">/);
  assert.match(html, /<footer class="ftr">/);
  assert.equal(activeFor(html), "gallery");
});

test("owner.ts emits chrome and marks identity active", () => {
  const html = renderOwner({
    pubkey: "b".repeat(64),
    pubkey_short: "bbbbbbbb",
    drawings: [],
    repo_url: REPO,
  });
  assert.match(html, /<header class="hdr">/);
  assert.equal(activeFor(html), "identity");
});

test("products.ts emits chrome and marks products active", () => {
  const html = renderProducts({
    page: 1,
    total_pages: 1,
    cards: [],
    prev_page: null,
    next_page: null,
    repo_url: REPO,
  });
  assert.match(html, /<header class="hdr">/);
  assert.equal(activeFor(html), "products");
});

test("every builder template threads repo_url into the chrome footer", () => {
  // The footer's repo link must come out of v.repo_url, not the chrome
  // module's default. Pass a sentinel and confirm it appears on every
  // surface.
  const sentinel = "https://example.test/sentinel-repo";
  const surfaces = [
    renderIndex({ today: "x", drawings: [], days: [], repo_url: sentinel }),
    renderDayGallery({ date: "x", page: 1, total_pages: 1, drawings: [], prev_page: null, next_page: null, repo_url: sentinel }),
    renderDrawing({ ...SAMPLE_DRAWING, repo_url: sentinel }),
    renderOwner({ pubkey: "b".repeat(64), pubkey_short: "bbbbbbbb", drawings: [], repo_url: sentinel }),
    renderProducts({ page: 1, total_pages: 1, cards: [], prev_page: null, next_page: null, repo_url: sentinel }),
  ];
  for (const html of surfaces) {
    assert.match(html, new RegExp(`href="${sentinel.replace(/[/.]/g, "\\$&")}"`));
  }
});

test("static merch + order + share pages use the chrome marker — plugin (#168) injects the nav", async () => {
  const root = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");
  for (const rel of ["merch.html", "order.html", "share.html"]) {
    const html = await fs.readFile(path.join(root, rel), "utf8");
    assert.match(html, /<!--CHROME:HEADER-->/, `${rel} should use the chrome header marker`);
    assert.match(html, /<!--CHROME:FOOTER-->/, `${rel} should use the chrome footer marker`);
  }
});
