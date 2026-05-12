// DOM-free helpers for parsing the merch picker's query parameters. Kept
// in its own module so unit tests can import without pulling in the
// browser-only top-level of src/merch.ts.

export interface ProductLike {
  id: string;
}

export function pickProductFromQuery<T extends ProductLike>(
  products: readonly T[],
  productId: string | null | undefined,
): T | null {
  if (!productId) return null;
  return products.find((p) => p.id === productId) ?? null;
}
