import { strict as assert } from "node:assert";
import { test } from "node:test";
import renderDrawing, { formatCreatedAt } from "../builder/templates/drawing.js";

const baseView = {
  id: "f".repeat(64),
  id_short: "ffffffff",
  created_at: "2026-05-08T04:24:56.088Z",
  required_bits: 14,
  solve_ms: 2,
  bench_hps: 82335,
  parent: null,
  owner: { pubkey: "a".repeat(64), pubkey_short: "aaaaaaaa" },
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
  assert.match(html, /<p class="created-at">Created <time datetime="2026-05-08T04:24:56\.088Z">May 8, 2026 · 04:24 UTC<\/time><\/p>/);
});

test("drawing page: hash and proof-of-work live inside the Advanced disclosure", () => {
  const html = renderDrawing(baseView);
  // <details> precedes any of the technical fields, and they all sit
  // inside it. The order check guards against accidentally promoting one
  // back into the main flow.
  const detailsIdx = html.indexOf('<details class="advanced">');
  const closeIdx = html.indexOf("</details>", detailsIdx);
  assert.ok(detailsIdx > -1 && closeIdx > detailsIdx, "advanced section missing");
  const inside = html.slice(detailsIdx, closeIdx);
  assert.match(inside, /<dt>id<\/dt><dd><code>f{64}<\/code><\/dd>/);
  assert.match(inside, /<dt>minted<\/dt><dd><code>2026-05-08T04:24:56\.088Z<\/code><\/dd>/);
  assert.match(inside, /<dt>proof of work<\/dt><dd>14 bits in 2ms \(82335 hps\)<\/dd>/);

  // And nothing technical leaks above the disclosure.
  const before = html.slice(0, detailsIdx);
  assert.doesNotMatch(before, /<dt>id<\/dt>/);
  assert.doesNotMatch(before, /<dt>minted<\/dt>/);
  assert.doesNotMatch(before, /proof of work/);
});

test("drawing page: owner link stays in the main flow (above the Advanced disclosure)", () => {
  const html = renderDrawing(baseView);
  const ownerIdx = html.indexOf("<dt>owner</dt>");
  const detailsIdx = html.indexOf('<details class="advanced">');
  assert.ok(ownerIdx > -1 && detailsIdx > -1);
  assert.ok(ownerIdx < detailsIdx, "owner link should be above the Advanced disclosure");
});

test("drawing page: anonymous owner renders without an Advanced section regression", () => {
  const html = renderDrawing({ ...baseView, owner: null });
  assert.match(html, /<dt>owner<\/dt><dd>anonymous<\/dd>/);
  assert.match(html, /<details class="advanced">/);
});

test("drawing page: parent link (when present) sits in the main flow", () => {
  const html = renderDrawing({
    ...baseView,
    parent: { parent: "c".repeat(64), parent_short: "cccccccc" },
  });
  const parentIdx = html.indexOf("<dt>parent</dt>");
  const detailsIdx = html.indexOf('<details class="advanced">');
  assert.ok(parentIdx > -1 && parentIdx < detailsIdx);
  assert.match(html, /<dd><a href="\/d\/c{64}">cccccccc<\/a><\/dd>/);
});
