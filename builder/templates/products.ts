import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { esc } from "./_escape.js";

export interface ProductCard {
  drawing_id: string;
  drawing_id_short: string;
  product_id: string;
  product_name: string;
  from_dollars: string;
  count: number;
  // Optional human-readable relative time ("3 days ago"). v1 leaves null and
  // renders just the count; a follow-up can compute and inject this.
  recency_label: string | null;
}

export interface ProductsView {
  page: number;
  total_pages: number;
  cards: ProductCard[];
  prev_page: { prev_page: number } | null;
  next_page: { next_page: number } | null;
  repo_url: string;
}

export default function renderProducts(v: ProductsView): string {
  const isEmpty = v.cards.length === 0;
  const body = isEmpty
    ? `      <h2>products</h2>
      <p class="muted">No merch ordered yet — once someone buys their first item, it'll show up here ranked by popularity. Want to be first? Pick a drawing from <a href="/gallery">the gallery</a> and hit "make merch".</p>`
    : `      <h2>products — page ${esc(v.page)} of ${esc(v.total_pages)}</h2>
      <ul class="grid products-grid">
${v.cards.map(renderCard).join("\n")}
      </ul>
      <nav class="pager">
        ${v.prev_page ? `<a href="${prevHref(v.prev_page.prev_page)}">← prev</a>` : ""}
        ${v.next_page ? `<a href="/products/p/${esc(v.next_page.next_page)}">next →</a>` : ""}
      </nav>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · products · page ${esc(v.page)}</title>
    <link rel="stylesheet" href="/gallery.css" />
  </head>
  <body>
    ${renderHeader({ active: "products" })}
    <main>
${body}
    </main>
    ${renderFooter({ active: "products", repoUrl: v.repo_url })}
  </body>
</html>
`;
}

function prevHref(n: number): string {
  return n === 1 ? "/products" : `/products/p/${n}`;
}

function renderCard(c: ProductCard): string {
  const recency = c.recency_label ? ` · ${esc(c.recency_label)}` : "";
  return `          <li class="product-card" data-drawing-id="${esc(c.drawing_id)}" data-product-id="${esc(c.product_id)}">
            <a href="/merch?d=${esc(c.drawing_id)}&amp;product=${esc(c.product_id)}">
              <img src="/drawings/${esc(c.drawing_id)}.gif" alt="${esc(c.product_name)} featuring drawing ${esc(c.drawing_id_short)}" width="128" height="128" loading="lazy" />
              <div class="product-card-meta">
                <span class="product-name">${esc(c.product_name)}</span>
                <span class="product-price">from $${esc(c.from_dollars)}</span>
                <span class="product-stats">${esc(c.count)} order${c.count === 1 ? "" : "s"}${recency}</span>
              </div>
            </a>
          </li>`;
}
