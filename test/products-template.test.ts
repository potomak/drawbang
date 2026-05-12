import { strict as assert } from "node:assert";
import { test } from "node:test";
import renderProducts, { type ProductCard } from "../builder/templates/products.js";

function makeCard(overrides: Partial<ProductCard> = {}): ProductCard {
  return {
    drawing_id: "a".repeat(64),
    drawing_id_short: "aaaaaaaa",
    product_id: "tee",
    product_name: "Unisex Heavy Cotton Tee",
    from_dollars: "24.00",
    count: 12,
    recency_label: "3 days ago",
    ...overrides,
  };
}

test("product card carries data-drawing-id + data-product-id for future composite mount", () => {
  const html = renderProducts({
    page: 1,
    total_pages: 1,
    cards: [makeCard()],
    prev_page: null,
    next_page: null,
    repo_url: "https://github.com/example/repo",
  });
  assert.match(html, /data-drawing-id="a{64}"/);
  assert.match(html, /data-product-id="tee"/);
});

test("product card href deep-links into the merch picker with d= and product=", () => {
  const html = renderProducts({
    page: 1,
    total_pages: 1,
    cards: [makeCard()],
    prev_page: null,
    next_page: null,
    repo_url: "https://github.com/example/repo",
  });
  assert.match(html, /href="\/merch\?d=a{64}&amp;product=tee"/);
});

test("product card shows name, 'from $X', count + recency", () => {
  const html = renderProducts({
    page: 1,
    total_pages: 1,
    cards: [makeCard({ count: 12, recency_label: "3 days ago", from_dollars: "24.00", product_name: "Unisex Heavy Cotton Tee" })],
    prev_page: null,
    next_page: null,
    repo_url: "https://github.com/example/repo",
  });
  assert.match(html, /Unisex Heavy Cotton Tee/);
  assert.match(html, /from \$24\.00/);
  assert.match(html, /12 orders · 3 days ago/);
});

test("singular vs plural: one order does not get an 's'", () => {
  const html = renderProducts({
    page: 1,
    total_pages: 1,
    cards: [makeCard({ count: 1, recency_label: null })],
    prev_page: null,
    next_page: null,
    repo_url: "https://github.com/example/repo",
  });
  assert.match(html, /1 order(?!s)/);
});

test("pager: page 2 of 3 → prev links to /products (not /products/p/1), next to /products/p/3", () => {
  const html = renderProducts({
    page: 2,
    total_pages: 3,
    cards: [makeCard()],
    prev_page: { prev_page: 1 },
    next_page: { next_page: 3 },
    repo_url: "https://github.com/example/repo",
  });
  // Canonical first-page URL is /products, not /products/p/1 — avoids two
  // URLs serving the same content (and matches the builder's output path).
  assert.match(html, /href="\/products"/);
  assert.match(html, /href="\/products\/p\/3"/);
});

test("empty cards list renders an empty-state body with no grid markup", () => {
  const html = renderProducts({
    page: 1,
    total_pages: 1,
    cards: [],
    prev_page: null,
    next_page: null,
    repo_url: "https://github.com/example/repo",
  });
  assert.match(html, /No merch ordered yet/);
  // The grid list and pager should not appear when there are no cards.
  assert.ok(!html.includes("products-grid"));
  assert.ok(!html.includes("class=\"pager\""));
});

test("escapes user-controlled strings in product_name + recency_label", () => {
  const html = renderProducts({
    page: 1,
    total_pages: 1,
    cards: [makeCard({ product_name: "<script>alert(1)</script>", recency_label: "<b>now</b>" })],
    prev_page: null,
    next_page: null,
    repo_url: "https://github.com/example/repo",
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;now&lt;\/b&gt;/);
});
