import { strict as assert } from "node:assert";
import { test } from "node:test";
import renderDrawing, { formatCreatedAt } from "../builder/templates/drawing.js";

const baseView = {
  id: "f".repeat(64),
  id_short: "ffffffff",
  created_at: "2026-05-08T04:24:56.088Z",
  parent: null,
  author: { pubkey: "a".repeat(64), pubkey_short: "aaaaaaaa" },
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
