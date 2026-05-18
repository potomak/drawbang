// Thin typed wrapper around the gtag.js global injected by
// renderAnalytics() in src/layout/chrome.ts. Centralises three things:
//
//   1. The window.gtag type (the global isn't in @types/web).
//   2. A no-op guard so pages that somehow ship without the GA snippet
//      (or visitors with an ad blocker) don't throw.
//   3. Helpers for the GA4-recommended ecommerce events the codebase
//      cares about — call sites pass a typed shape instead of crafting
//      the params object by hand.
//
// Param schemas follow the GA4 reference:
//   https://developers.google.com/analytics/devguides/collection/ga4/reference/events

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

export interface AnalyticsItem {
  item_id: string;
  item_name: string;
  // Prices are in the major currency unit (USD dollars), NOT cents.
  // gtag aggregates `value` and `price` as floats; sending cents would
  // inflate revenue 100x in reports.
  price?: number;
  quantity?: number;
  item_variant?: string;
}

export function trackEvent(
  name: string,
  params: Record<string, unknown> = {},
): void {
  if (typeof window === "undefined" || typeof window.gtag !== "function") return;
  try {
    window.gtag("event", name, params);
  } catch {
    // Analytics failures must never break the page.
  }
}

export function trackViewItem(item: AnalyticsItem): void {
  trackEvent("view_item", {
    currency: "USD",
    value: item.price ?? 0,
    items: [item],
  });
}

export function trackBeginCheckout(args: {
  value: number;
  items: AnalyticsItem[];
}): void {
  trackEvent("begin_checkout", {
    currency: "USD",
    value: args.value,
    items: args.items,
  });
}
