// TODO (#analytics): This should be moved into an analytics directory

// Thin typed wrapper around the Meta (Facebook) Pixel fbq global injected
// by renderMetaPixel() in src/layout/chrome.ts. Mirrors the structure of
// src/analytics.ts (the gtag wrapper) — separate modules per vendor so a
// call site can fire both events without coupling the two SDKs.
//
// Param shapes follow Meta's standard events reference:
//   https://developers.facebook.com/docs/meta-pixel/reference

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
  }
}

export interface PixelContentItem {
  id: string;
  // In the major currency unit (USD dollars), NOT cents — Meta aggregates
  // value as a float.
  item_price?: number;
  quantity?: number;
}

export function trackPixelEvent(
  name: string,
  params: Record<string, unknown> = {},
): void {
  if (typeof window === "undefined" || typeof window.fbq !== "function") return;
  try {
    window.fbq("track", name, params);
  } catch {
    // Pixel failures must never break the page.
  }
}

export function trackViewContent(args: {
  content_id: string;
  content_name: string;
  value?: number;
}): void {
  trackPixelEvent("ViewContent", {
    content_ids: [args.content_id],
    content_name: args.content_name,
    content_type: "product",
    currency: "USD",
    value: args.value ?? 0,
  });
}

export function trackInitiateCheckout(args: {
  content_ids: string[];
  content_name?: string;
  value: number;
  num_items: number;
  contents?: PixelContentItem[];
}): void {
  trackPixelEvent("InitiateCheckout", {
    content_ids: args.content_ids,
    content_type: "product",
    currency: "USD",
    value: args.value,
    num_items: args.num_items,
    ...(args.content_name ? { content_name: args.content_name } : {}),
    ...(args.contents ? { contents: args.contents } : {}),
  });
}
