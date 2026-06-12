import { strict as assert } from "node:assert";
import { describe, test, beforeEach } from "node:test";
import {
  renderAnalytics,
  GA_MEASUREMENT_ID,
  ANALYTICS_OPT_OUT_KEY,
} from "../src/layout/tracking.js";
import { Tracker } from "../src/analytics/analytics.js";

// In-process stand-in for window.gtag / window.fbq. Each test installs
// these so the Tracker's vendor wrappers can call into a real function
// we can inspect afterwards.
type Args = unknown[];
type Stub = (...args: Args) => void;
interface MockWin {
  gtag?: Stub;
  fbq?: Stub;
}

function installVendors(): {
  gtag: Args[];
  fbq: Args[];
  reset: () => void;
} {
  const gtagCalls: Args[] = [];
  const fbqCalls: Args[] = [];
  const g: MockWin = (globalThis as unknown as { window?: MockWin }).window ??
    (globalThis as unknown as MockWin);
  // Some node:test environments don't have a globalThis.window; the vendor
  // wrappers guard on `typeof window === 'undefined'` so we must materialise one.
  (globalThis as { window?: MockWin }).window = g;
  g.gtag = (...args: Args) => gtagCalls.push(args);
  g.fbq = (...args: Args) => fbqCalls.push(args);
  return {
    gtag: gtagCalls,
    fbq: fbqCalls,
    reset: () => {
      gtagCalls.length = 0;
      fbqCalls.length = 0;
      g.gtag = (...args: Args) => gtagCalls.push(args);
      g.fbq = (...args: Args) => fbqCalls.push(args);
    },
  };
}

describe("renderAnalytics() — DNT / opt-out gate", () => {
  test("emits a gate script that runs before gtag.js loads", () => {
    const html = renderAnalytics();
    // Pre-snippet script comes first.
    const gateIdx = html.indexOf("Draw! analytics opt-out gate");
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

describe("Tracker — typed event methods", () => {
  let vendors: ReturnType<typeof installVendors>;
  let tracker: Tracker;

  beforeEach(() => {
    vendors = installVendors();
    tracker = new Tracker();
  });

  test("toolClick → gtag('event', 'tool_click', { tool })", () => {
    tracker.toolClick("pixel");
    assert.deepEqual(vendors.gtag[0], ["event", "tool_click", { tool: "pixel" }]);
  });

  test("frameAddClick / frameDeleteClick include total_after", () => {
    tracker.frameAddClick(3);
    tracker.frameDeleteClick(2);
    assert.deepEqual(vendors.gtag[0], ["event", "frame_add_click", { total_after: 3 }]);
    assert.deepEqual(vendors.gtag[1], ["event", "frame_delete_click", { total_after: 2 }]);
  });

  test("publishClick / publishSuccess shape", () => {
    tracker.publishClick(4);
    tracker.publishSuccess({ frames: 4, solve_ms: 1200, remix: true, prompt: null });
    assert.deepEqual(vendors.gtag[0], ["event", "publish_click", { frames: 4 }]);
    assert.deepEqual(vendors.gtag[1], [
      "event",
      "publish_success",
      { frames: 4, solve_ms: 1200, remix: true, prompt: null },
    ]);
  });

  test("gifDownloadClick distinguishes editor / drawing_page via source", () => {
    tracker.gifDownloadClick({ source: "editor", frames: 2 });
    tracker.gifDownloadClick({ source: "drawing_page" });
    assert.equal((vendors.gtag[0][2] as { source: string }).source, "editor");
    assert.equal((vendors.gtag[1][2] as { source: string }).source, "drawing_page");
  });

  test("copyShareLinkClick / shareClick / forkClick / makeMerchClick", () => {
    tracker.copyShareLinkClick();
    tracker.shareClick("reddit");
    tracker.forkClick("abcd1234");
    tracker.makeMerchClick("abcd1234");
    assert.deepEqual(vendors.gtag.map((c) => c[1]), [
      "copy_share_link_click",
      "share_click",
      "fork_click",
      "make_merch_click",
    ]);
    assert.deepEqual(vendors.gtag[1][2], { target: "reddit" });
    assert.deepEqual(vendors.gtag[2][2], { drawing_id: "abcd1234" });
    assert.deepEqual(vendors.gtag[3][2], { drawing_id: "abcd1234" });
  });

  test("merch* wrappers each carry product_id + the axis-specific dim", () => {
    tracker.merchProductClick("tee");
    tracker.merchPlacementClick({ product_id: "tee", placement: "left-chest" });
    tracker.merchSizeClick({ product_id: "tee", size: "L" });
    tracker.merchColorClick({ product_id: "tee", color: "white" });
    assert.deepEqual(vendors.gtag[0], ["event", "merch_product_click", { product_id: "tee" }]);
    assert.deepEqual(vendors.gtag[1], [
      "event",
      "merch_placement_click",
      { product_id: "tee", placement: "left-chest" },
    ]);
    assert.deepEqual(vendors.gtag[2], [
      "event",
      "merch_size_click",
      { product_id: "tee", size: "L" },
    ]);
    assert.deepEqual(vendors.gtag[3], [
      "event",
      "merch_color_click",
      { product_id: "tee", color: "white" },
    ]);
  });

  test("viewMerchItem fires GA view_item + Meta Pixel ViewContent", () => {
    tracker.viewMerchItem({ item_id: "tee", item_name: "Tee", price: 24.99 });
    assert.deepEqual(vendors.gtag[0], [
      "event",
      "view_item",
      {
        currency: "USD",
        value: 24.99,
        items: [{ item_id: "tee", item_name: "Tee", price: 24.99 }],
      },
    ]);
    assert.deepEqual(vendors.fbq[0], [
      "track",
      "ViewContent",
      {
        content_ids: ["tee"],
        content_name: "Tee",
        content_type: "product",
        currency: "USD",
        value: 24.99,
      },
    ]);
  });

  test("beginMerchCheckout fires GA begin_checkout + Meta Pixel InitiateCheckout", () => {
    tracker.beginMerchCheckout({
      value: 27.5,
      items: [{ item_id: "tee", item_name: "Tee", price: 24.99, quantity: 1 }],
      pixel: {
        content_ids: ["tee"],
        content_name: "Tee",
        num_items: 1,
        contents: [{ id: "tee", item_price: 24.99, quantity: 1 }],
      },
    });
    const [gEvt, gName, gParams] = vendors.gtag[0] as [string, string, Record<string, unknown>];
    assert.equal(gEvt, "event");
    assert.equal(gName, "begin_checkout");
    assert.equal(gParams.currency, "USD");
    assert.equal(gParams.value, 27.5);
    const [pEvt, pName, pParams] = vendors.fbq[0] as [string, string, Record<string, unknown>];
    assert.equal(pEvt, "track");
    assert.equal(pName, "InitiateCheckout");
    assert.equal(pParams.value, 27.5);
    assert.equal(pParams.num_items, 1);
    assert.deepEqual(pParams.content_ids, ["tee"]);
  });

  test("purchase shape matches GA4 Monetization", () => {
    tracker.purchase({
      transaction_id: "ord-1",
      value: 24.99,
      items: [{ item_id: "tee", item_name: "tee", price: 24.99, quantity: 1 }],
    });
    const [evt, name, params] = vendors.gtag[0] as [string, string, Record<string, unknown>];
    assert.equal(evt, "event");
    assert.equal(name, "purchase");
    assert.equal(params.currency, "USD");
    assert.equal(params.transaction_id, "ord-1");
    assert.equal(params.value, 24.99);
    assert.ok(Array.isArray(params.items));
  });

  test("orderStatusView → gtag('event', 'order_status_view', { status })", () => {
    tracker.orderStatusView("paid");
    assert.deepEqual(vendors.gtag[0], ["event", "order_status_view", { status: "paid" }]);
  });

  test("trackEvent no-ops silently when window.gtag is missing", () => {
    delete (globalThis as { window?: MockWin }).window?.gtag;
    // Should not throw.
    tracker.toolClick("erase");
  });
});
