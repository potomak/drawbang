import type { MerchCatalog } from "../merch/lambda.js";
import type { ProductCounter } from "../merch/product-counters.js";
import type { ProductCard } from "./templates/products.js";

// Turn the (drawing, product) counter rows into ProductCard view models the
// products template renders. Skips counters whose product isn't in the
// catalog (catalog edits don't poison the list) and counters with non-positive
// counts. Sort: count desc, then recency desc — popular items first, freshest
// breaking ties.

export function productCardsFromCounters(
  counters: readonly ProductCounter[],
  catalog: MerchCatalog,
  now: Date,
): ProductCard[] {
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  const enriched: Array<{ card: ProductCard; last_ordered_at: string }> = [];
  for (const c of counters) {
    if (c.count <= 0) continue;
    const product = byId.get(c.product_id);
    if (!product) continue;
    const cheapestCents = product.variants.reduce(
      (acc, v) => (v.retail_cents < acc ? v.retail_cents : acc),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(cheapestCents)) continue;
    enriched.push({
      card: {
        drawing_id: c.drawing_id,
        drawing_id_short: c.drawing_id.slice(0, 8),
        product_id: c.product_id,
        product_name: product.name,
        from_dollars: (cheapestCents / 100).toFixed(2),
        count: c.count,
        recency_label: relativeTimeLabel(c.last_ordered_at, now),
      },
      last_ordered_at: c.last_ordered_at,
    });
  }
  enriched.sort((a, b) => {
    if (b.card.count !== a.card.count) return b.card.count - a.card.count;
    return b.last_ordered_at.localeCompare(a.last_ordered_at);
  });
  return enriched.map((e) => e.card);
}

// Coarse "N units ago" label, server-rendered so the products page is
// deterministic + cacheable for the s-maxage window. Returns null for
// invalid timestamps; "just now" for clock-skew futures.
function relativeTimeLabel(iso: string, now: Date): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const diffMs = now.getTime() - t;
  if (diffMs < 0) return null;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
