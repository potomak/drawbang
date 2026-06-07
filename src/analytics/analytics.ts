// Single public entry-point for tracking events across all vendors.
// Callers import the `tracker` singleton (or instantiate `Tracker` in
// tests); the typed methods below fan each event out to whichever
// vendor module needs it. The gtag and fbq wrappers in
// ./google-analytics.ts and ./meta-pixel.ts stay internal.
//
// Naming: <noun><Verb>() for user-initiated clicks and surface views
// (e.g. toolClick, publishClick, copyShareLinkClick). Merch + order
// flows use ecommerce shapes (viewMerchItem, beginMerchCheckout,
// purchase) that fire both vendors at once — keeping that fan-out
// inside the Tracker is the whole point of consolidating.

import { gtagEvent } from "./google-analytics.js";
import { fbqEvent } from "./meta-pixel.js";

export interface AnalyticsItem {
  item_id: string;
  item_name: string;
  // Prices are in the major currency unit (USD dollars), NOT cents.
  // gtag and fbq both aggregate `value`/`price` as floats; sending cents
  // would inflate revenue 100x in reports.
  price?: number;
  quantity?: number;
  item_variant?: string;
}

export interface PixelContentItem {
  id: string;
  item_price?: number;
  quantity?: number;
}

export type EditorTool =
  | "pixel"
  | "erase"
  | "fill"
  | "eyedrop"
  | "shift"
  | "clear"
  | string;

export type GifDownloadSource = "editor" | "drawing_page";
export type ShareTarget = "reddit" | "x" | "threads" | "web_share";

export class Tracker {
  trackEvent(name: string, params: Record<string, unknown> = {}): void {
    gtagEvent(name, params);
  }

  // -- Editor --------------------------------------------------------------

  toolClick(tool: EditorTool): void {
    gtagEvent("tool_click", { tool });
  }

  frameAddClick(totalAfter: number): void {
    gtagEvent("frame_add_click", { total_after: totalAfter });
  }

  frameDeleteClick(totalAfter: number): void {
    gtagEvent("frame_delete_click", { total_after: totalAfter });
  }

  publishClick(frames: number): void {
    gtagEvent("publish_click", { frames });
  }

  publishSuccess(args: { frames: number; solve_ms: number }): void {
    gtagEvent("publish_success", args);
  }

  gifDownloadClick(args: { source: GifDownloadSource; frames?: number }): void {
    // `frames` is editor-only; the drawing page hits the static gif URL
    // via the browser's download attribute and doesn't know the count.
    gtagEvent("gif_download_click", args);
  }

  // -- Drawing detail / share ---------------------------------------------

  copyShareLinkClick(): void {
    gtagEvent("copy_share_link_click", {});
  }

  shareClick(target: ShareTarget): void {
    gtagEvent("share_click", { target });
  }

  forkClick(drawingId: string): void {
    gtagEvent("fork_click", { drawing_id: drawingId });
  }

  makeMerchClick(drawingId: string): void {
    gtagEvent("make_merch_click", { drawing_id: drawingId });
  }

  // -- Merch picker -------------------------------------------------------

  merchProductClick(productId: string): void {
    gtagEvent("merch_product_click", { product_id: productId });
  }

  merchPlacementClick(args: { product_id: string; placement: string }): void {
    gtagEvent("merch_placement_click", args);
  }

  merchSizeClick(args: { product_id: string; size: string }): void {
    gtagEvent("merch_size_click", args);
  }

  merchColorClick(args: { product_id: string; color: string }): void {
    gtagEvent("merch_color_click", args);
  }

  // -- Ecommerce funnel (fans out to GA + Meta Pixel) ---------------------

  viewMerchItem(item: AnalyticsItem): void {
    const value = item.price ?? 0;
    gtagEvent("view_item", {
      currency: "USD",
      value,
      items: [item],
    });
    fbqEvent("ViewContent", {
      content_ids: [item.item_id],
      content_name: item.item_name,
      content_type: "product",
      currency: "USD",
      value,
    });
  }

  beginMerchCheckout(args: {
    value: number;
    items: AnalyticsItem[];
    pixel?: {
      content_ids: string[];
      content_name?: string;
      num_items: number;
      contents?: PixelContentItem[];
    };
  }): void {
    gtagEvent("begin_checkout", {
      currency: "USD",
      value: args.value,
      items: args.items,
    });
    if (args.pixel) {
      fbqEvent("InitiateCheckout", {
        content_ids: args.pixel.content_ids,
        content_type: "product",
        currency: "USD",
        value: args.value,
        num_items: args.pixel.num_items,
        ...(args.pixel.content_name ? { content_name: args.pixel.content_name } : {}),
        ...(args.pixel.contents ? { contents: args.pixel.contents } : {}),
      });
    }
  }

  // -- Order status -------------------------------------------------------

  orderStatusView(status: string): void {
    gtagEvent("order_status_view", { status });
  }

  purchase(args: {
    transaction_id: string;
    value: number;
    items: AnalyticsItem[];
  }): void {
    gtagEvent("purchase", {
      currency: "USD",
      transaction_id: args.transaction_id,
      value: args.value,
      items: args.items,
    });
  }
}

export const tracker = new Tracker();
