// Single source of truth for merch catalog helpers.
// Used by both the existing /merch picker (src/merch.ts) and the future
// product page (/products/:drawingId/:productId). Keeps SSR and hydration
// from diverging on defaults, price formatting, and placement support.
// See issue #296 § A.

export interface CatalogVariant {
  id: number;
  size?: string;
  color?: string;
  retail_cents: number;
  base_cost_cents: number;
}

export interface CatalogProduct {
  id: string;
  name: string;
  blueprint_id: number;
  print_provider_id: number;
  shipping_cents: number;
  variants: CatalogVariant[];
}

// Deterministic default: prefers M Black → cheapest retail → color-rank → size-rank.
// Mirrors the policy that was duplicated between lib/templates/product-page.ts
// and src/product.ts before #296. Both surfaces must call this one function.
const COLOR_RANK: Record<string, number> = { Black: 0, White: 1 };
const SIZE_RANK: Record<string, number> = { XS: 0, S: 1, M: 2, L: 3, XL: 4, "2XL": 5 };

function variantRank(v: CatalogVariant): number {
  const colorRank = v.color != null ? (COLOR_RANK[v.color] ?? 99) : 99;
  const sizeRank = v.size != null ? (SIZE_RANK[v.size] ?? 99) : 99;
  return colorRank * 10 + sizeRank;
}

export function defaultVariant(variants: readonly CatalogVariant[]): CatalogVariant | null {
  if (variants.length === 0) return null;
  // 1. Prefer M Black exactly.
  const preferred = variants.find((v) => v.size === "M" && v.color === "Black");
  if (preferred) return preferred;
  // 2. Cheapest retail, tie-break by color/size rank.
  let best = variants[0];
  for (const v of variants.slice(1)) {
    if (v.retail_cents < best.retail_cents) {
      best = v;
      continue;
    }
    if (v.retail_cents === best.retail_cents && variantRank(v) < variantRank(best)) {
      best = v;
    }
  }
  return best;
}

export function formatUsd(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function priceDollars(variant: CatalogVariant | null): string | null {
  if (!variant) return null;
  return formatUsd(variant.retail_cents);
}

// Placement helpers re-exported for convenience so product page code
// imports once from merch/catalog.ts.
export { DEFAULT_PLACEMENT, isValidPlacement, PLACEMENT_PRESETS } from "./placement.js";
export type { Placement } from "./placement.js";
