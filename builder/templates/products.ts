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
  const items = v.cards.map(renderCard).join("\n");
  const prev = v.prev_page
    ? `<a href="${prevHref(v.prev_page.prev_page)}">← prev</a>`
    : "";
  const next = v.next_page
    ? `<a href="/products/p/${esc(v.next_page.next_page)}">next →</a>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · products · page ${esc(v.page)}</title>
    <link rel="stylesheet" href="/gallery.css" />
  </head>
  <body>
    <header>
      <h1><a href="/">Draw!</a></h1>
      <nav>
        <a href="/gallery">gallery</a>
        <a href="/products" aria-current="page" class="active">products</a>
      </nav>
    </header>
    <main>
      <h2>products — page ${esc(v.page)} of ${esc(v.total_pages)}</h2>
      <ul class="grid products-grid">
${items}
      </ul>
      <nav class="pager">
        ${prev}
        ${next}
      </nav>
    </main>
    <footer>
      <a href="${esc(v.repo_url)}" target="_blank" rel="noopener">source on github</a>
    </footer>
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
