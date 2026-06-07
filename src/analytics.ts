// TODO (#analytics): This should be renamed to google-analytics.ts and moved into an analytics directory

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

export function trackPurchase(args: {
  transaction_id: string;
  value: number;
  items: AnalyticsItem[];
}): void {
  trackEvent("purchase", {
    currency: "USD",
    transaction_id: args.transaction_id,
    value: args.value,
    items: args.items,
  });
}

// -- Custom click / completion events ----------------------------------------
//
// Naming convention (see plan): <noun>_click for user-initiated clicks,
// <noun>_success for multi-step completions, <noun>_view for surfaces
// not already covered by GA4's automatic page_view. Each wrapper exists
// so call sites can't drift in name / param shape across files.

export type EditorTool =
  | "pixel"
  | "erase"
  | "fill"
  | "eyedrop"
  | "shift"
  | "clear"
  | string;

export function trackToolClick(tool: EditorTool): void {
  trackEvent("tool_click", { tool });
}

export function trackFrameAddClick(totalAfter: number): void {
  trackEvent("frame_add_click", { total_after: totalAfter });
}

export function trackFrameDeleteClick(totalAfter: number): void {
  trackEvent("frame_delete_click", { total_after: totalAfter });
}

export function trackPublishClick(frames: number): void {
  trackEvent("publish_click", { frames });
}

export function trackPublishSuccess(args: {
  frames: number;
  solve_ms: number;
}): void {
  trackEvent("publish_success", args);
}

export type GifDownloadSource = "editor" | "drawing_page";

export function trackGifDownloadClick(args: {
  source: GifDownloadSource;
  frames?: number;
}): void {
  // `frames` is editor-only; the drawing page hits the static gif URL via
  // the browser's download attribute and doesn't know the frame count.
  trackEvent("gif_download_click", args);
}

export function trackCopyShareLinkClick(): void {
  trackEvent("copy_share_link_click", {});
}

export type ShareTarget = "reddit" | "x" | "threads" | "web_share";

export function trackShareClick(target: ShareTarget): void {
  trackEvent("share_click", { target });
}

export function trackForkClick(drawingId: string): void {
  trackEvent("fork_click", { drawing_id: drawingId });
}

export function trackMakeMerchClick(drawingId: string): void {
  trackEvent("make_merch_click", { drawing_id: drawingId });
}

export function trackMerchProductClick(productId: string): void {
  trackEvent("merch_product_click", { product_id: productId });
}

export function trackMerchPlacementClick(args: {
  product_id: string;
  placement: string;
}): void {
  trackEvent("merch_placement_click", args);
}

export function trackMerchSizeClick(args: {
  product_id: string;
  size: string;
}): void {
  trackEvent("merch_size_click", args);
}

export function trackMerchColorClick(args: {
  product_id: string;
  color: string;
}): void {
  trackEvent("merch_color_click", args);
}

export function trackOrderStatusView(status: string): void {
  trackEvent("order_status_view", { status });
}
