// DOM-free helpers for parsing the merch picker's query parameters. Kept
// in its own module so unit tests can import without pulling in the
// browser-only top-level of src/merch.ts.

export interface ProductLike {
  id: string;
}

export interface VariantLike {
  id: number;
  size?: string;
  color?: string;
  retail_cents: number;
}

export interface ProductWithVariants extends ProductLike {
  variants: readonly VariantLike[];
}

export function pickProductFromQuery<T extends ProductLike>(
  products: readonly T[],
  productId: string | null | undefined
): T | null {
  if (!productId) return null;
  return products.find((p) => p.id === productId) ?? null;
}

/**
 * Deterministic default variant selection for a merch product.
 *
 * Rules (mirrors src/merch.ts selectProduct auto-select + design spec):
 * - Mug / single-variant products: return the sole variant.
 * - Tee families: prefer `M / Black` if present (most common size/color).
 * - Sticker-sheet / price-tiered products: cheapest retail wins; ties broken
 *   by color preference White > Transparent > Holographic, then by size order
 *   (smallest first), then by stable id sort.
 * - Generic fallback: cheapest retail, then size rank (XS<S<M<L<XL<2XL),
 *   then color lexicographic, then id.
 *
 * This is the SSR + SPA shared source of truth — both the render handler
 * (ingest/render-handlers.ts) and the client boot (src/product.ts /
 * src/merch.ts) call it so the pre-selected variant is identical before
 * and after hydration.
 */
export function defaultVariant<T extends VariantLike>(
  product: ProductWithVariants & { variants: readonly T[] }
): T | null {
  const variants = product.variants;
  if (variants.length === 0) return null;
  if (variants.length === 1) return variants[0];

  // Preferred M Black for apparel (tee, tee-softstyle). Covers the common
  // case explicitly so the generic cheapest sort doesn't arbitrarily pick S.
  const preferredMBlack = variants.find((v) => v.size === "M" && v.color === "Black");
  if (preferredMBlack) return preferredMBlack as T;

  // Cheapest-first sort with secondary ties matching the design spec.
  const sizeRank: Record<string, number> = { XS: 0, S: 1, M: 2, L: 3, XL: 4, "2XL": 5 };
  const colorPref: Record<string, number> = { White: 0, Transparent: 1, Holographic: 2, Black: 3 };
  const sorted = [...variants].sort((a, b) => {
    if (a.retail_cents !== b.retail_cents) return a.retail_cents - b.retail_cents;
    const aColorPref = a.color !== undefined ? (colorPref[a.color] ?? 99) : 99;
    const bColorPref = b.color !== undefined ? (colorPref[b.color] ?? 99) : 99;
    if (aColorPref !== bColorPref) return aColorPref - bColorPref;
    const aRank = a.size !== undefined ? (sizeRank[a.size] ?? 99) : 99;
    const bRank = b.size !== undefined ? (sizeRank[b.size] ?? 99) : 99;
    if (aRank !== bRank) return aRank - bRank;
    if ((a.color ?? "") !== (b.color ?? "")) return (a.color ?? "").localeCompare(b.color ?? "");
    return a.id - b.id;
  });
  return sorted[0] as T;
}

export function findVariantBySizeColor<T extends VariantLike>(
  variants: readonly T[],
  size: string | null,
  color: string | null
): T | null {
  return (
    (variants.find((v) => (v.size ?? null) === size && (v.color ?? null) === color) as T) ?? null
  );
}
