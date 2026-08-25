import { CC_PRODUCTS, PER_PAGE } from "../../config/constants.js";
import renderProducts from "../../lib/templates/products.js";
import { productCardsFromCounters } from "../../lib/products-cards.js";
import type { RenderHandlersConfig, RenderResponse } from "./shared.js";
import { notFound } from "./shared.js";

export async function renderProductsPageHandler(
  cfg: RenderHandlersConfig,
  rawPage: string | null
): Promise<RenderResponse> {
  if (!cfg.productCountersSource || !cfg.merchCatalog) return notFound(cfg);
  const perPage = cfg.perPage ?? PER_PAGE;
  const page = rawPage ? Math.max(1, Number.parseInt(rawPage, 10)) : 1;
  if (!Number.isFinite(page) || page < 1) return notFound(cfg);

  const counters = await cfg.productCountersSource.listAll();
  const now = cfg.now ? cfg.now() : new Date();
  const cards = productCardsFromCounters(counters, cfg.merchCatalog, now);
  const totalPages = Math.max(1, Math.ceil(cards.length / perPage));
  if (page > totalPages) return notFound(cfg);
  const slice = cards.slice((page - 1) * perPage, page * perPage);
  const body = renderProducts({
    page,
    total_pages: totalPages,
    cards: slice,
    prev_page: page > 1 ? { prev_page: page - 1 } : null,
    next_page: page < totalPages ? { next_page: page + 1 } : null,
    repo_url: cfg.repoUrl,
  });
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_PRODUCTS,
    body,
  };
}
