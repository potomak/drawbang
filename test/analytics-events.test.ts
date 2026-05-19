import { strict as assert } from "node:assert";
import { describe, test, beforeEach } from "node:test";
import {
  renderAnalytics,
  GA_MEASUREMENT_ID,
  ANALYTICS_OPT_OUT_KEY,
} from "../src/layout/tracking.js";
import * as analytics from "../src/analytics.js";

// In-process stand-in for window.gtag. Each test sets it up so the
// wrappers in src/analytics.ts can call into a real function we can
// inspect afterwards.
type GtagArgs = unknown[];
type Gtag = (...args: GtagArgs) => void;
interface MockWin {
  gtag?: Gtag;
}

function installGtag(): { calls: GtagArgs[]; reset: () => void } {
  const calls: GtagArgs[] = [];
  const g: MockWin = (globalThis as unknown as { window?: MockWin }).window ??
    (globalThis as unknown as MockWin);
  // Some node:test environments don't have a globalThis.window; src/analytics.ts
  // guards on `typeof window === 'undefined'` so we must materialise one.
  (globalThis as { window?: MockWin }).window = g;
  g.gtag = (...args: GtagArgs) => {
    calls.push(args);
  };
  return {
    calls,
    reset: () => {
      calls.length = 0;
      g.gtag = (...args: GtagArgs) => calls.push(args);
    },
  };
}

describe("renderAnalytics() — DNT / opt-out gate", () => {
  test("emits a gate script that runs before gtag.js loads", () => {
    const html = renderAnalytics();
    // Pre-snippet script comes first.
    const gateIdx = html.indexOf("Drawbang analytics opt-out gate");
    const gtagIdx = html.indexOf("googletagmanager.com/gtag/js");
    assert.ok(gateIdx >= 0, "gate comment should appear");
    assert.ok(gtagIdx > gateIdx, "gate script must precede gtag.js");
  });

  test("gate references the configured GA measurement id", () => {
    const html = renderAnalytics();
    assert.match(html, new RegExp(`ga-disable-${GA_MEASUREMENT_ID}`));
  });

  test("gate reads the documented localStorage opt-out key", () => {
    const html = renderAnalytics();
    assert.ok(
      html.includes(JSON.stringify(ANALYTICS_OPT_OUT_KEY)),
      "expected the opt-out key to appear as a JSON-quoted literal",
    );
  });

  test("gate stubs window.fbq so Meta Pixel is silenced too", () => {
    const html = renderAnalytics();
    assert.match(html, /window\.fbq\s*=\s*function\s*\(\)\s*\{\s*\}/);
  });

  test("gate fires on navigator.doNotTrack === '1'", () => {
    const html = renderAnalytics();
    assert.match(html, /navigator\.doNotTrack === '1'/);
  });
});

describe("src/analytics.ts — typed event wrappers", () => {
  let gtag: ReturnType<typeof installGtag>;

  beforeEach(() => {
    gtag = installGtag();
  });

  test("trackToolClick → gtag('event', 'tool_click', { tool })", () => {
    analytics.trackToolClick("pixel");
    assert.deepEqual(gtag.calls[0], ["event", "tool_click", { tool: "pixel" }]);
  });

  test("trackFrameAddClick / trackFrameDeleteClick include total_after", () => {
    analytics.trackFrameAddClick(3);
    analytics.trackFrameDeleteClick(2);
    assert.deepEqual(gtag.calls[0], ["event", "frame_add_click", { total_after: 3 }]);
    assert.deepEqual(gtag.calls[1], ["event", "frame_delete_click", { total_after: 2 }]);
  });

  test("trackPublishClick / trackPublishSuccess shape", () => {
    analytics.trackPublishClick(4);
    analytics.trackPublishSuccess({ frames: 4, solve_ms: 1200 });
    assert.deepEqual(gtag.calls[0], ["event", "publish_click", { frames: 4 }]);
    assert.deepEqual(gtag.calls[1], [
      "event",
      "publish_success",
      { frames: 4, solve_ms: 1200 },
    ]);
  });

  test("trackGifDownloadClick distinguishes editor / drawing_page via source", () => {
    analytics.trackGifDownloadClick({ source: "editor", frames: 2 });
    analytics.trackGifDownloadClick({ source: "drawing_page" });
    assert.equal((gtag.calls[0][2] as { source: string }).source, "editor");
    assert.equal((gtag.calls[1][2] as { source: string }).source, "drawing_page");
  });

  test("trackCopyShareLinkClick / trackShareClick / trackForkClick / trackMakeMerchClick", () => {
    analytics.trackCopyShareLinkClick();
    analytics.trackShareClick("reddit");
    analytics.trackForkClick("abcd1234");
    analytics.trackMakeMerchClick("abcd1234");
    assert.deepEqual(gtag.calls.map((c) => c[1]), [
      "copy_share_link_click",
      "share_click",
      "fork_click",
      "make_merch_click",
    ]);
    assert.deepEqual(gtag.calls[1][2], { target: "reddit" });
    assert.deepEqual(gtag.calls[2][2], { drawing_id: "abcd1234" });
    assert.deepEqual(gtag.calls[3][2], { drawing_id: "abcd1234" });
  });

  test("trackMerch* wrappers each carry product_id + the axis-specific dim", () => {
    analytics.trackMerchProductClick("tee");
    analytics.trackMerchPlacementClick({ product_id: "tee", placement: "left-chest" });
    analytics.trackMerchSizeClick({ product_id: "tee", size: "L" });
    analytics.trackMerchColorClick({ product_id: "tee", color: "white" });
    assert.deepEqual(gtag.calls[0], ["event", "merch_product_click", { product_id: "tee" }]);
    assert.deepEqual(gtag.calls[1], [
      "event",
      "merch_placement_click",
      { product_id: "tee", placement: "left-chest" },
    ]);
    assert.deepEqual(gtag.calls[2], [
      "event",
      "merch_size_click",
      { product_id: "tee", size: "L" },
    ]);
    assert.deepEqual(gtag.calls[3], [
      "event",
      "merch_color_click",
      { product_id: "tee", color: "white" },
    ]);
  });

  test("trackPurchase shape matches GA4 Monetization", () => {
    analytics.trackPurchase({
      transaction_id: "ord-1",
      value: 24.99,
      items: [{ item_id: "tee", item_name: "tee", price: 24.99, quantity: 1 }],
    });
    const [evt, name, params] = gtag.calls[0] as [string, string, Record<string, unknown>];
    assert.equal(evt, "event");
    assert.equal(name, "purchase");
    assert.equal(params.currency, "USD");
    assert.equal(params.transaction_id, "ord-1");
    assert.equal(params.value, 24.99);
    assert.ok(Array.isArray(params.items));
  });

  test("trackOrderStatusView → gtag('event', 'order_status_view', { status })", () => {
    analytics.trackOrderStatusView("paid");
    assert.deepEqual(gtag.calls[0], ["event", "order_status_view", { status: "paid" }]);
  });

  test("trackEvent no-ops silently when window.gtag is missing", () => {
    delete (globalThis as { window?: MockWin }).window?.gtag;
    // Should not throw.
    analytics.trackToolClick("erase");
  });
});
