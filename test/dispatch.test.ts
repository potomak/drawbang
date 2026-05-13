import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import { placePrintifyOrder, type PlacePrintifyOrderDeps } from "../merch/dispatch.js";
import type { MerchCatalog } from "../merch/lambda.js";
import type { Order, OrderStatus, OrdersStore } from "../merch/orders.js";
import { PrintifyError, type PrintifyClient } from "../merch/printify.js";
import type { ProductCountersStore } from "../merch/product-counters.js";

const FIXTURE_CATALOG: MerchCatalog = {
  products: [
    {
      id: "tee",
      name: "Unisex T-shirt",
      blueprint_id: 6,
      print_provider_id: 99,
      print_area_px: { width: 4500, height: 5400 },
      shipping_cents: 500,
      variants: [
        { id: 18395, label: "S / Black", base_cost_cents: 1199, retail_cents: 2400 },
      ],
    },
  ],
};

function makeGif(): Uint8Array {
  const b = new Bitmap();
  for (let i = 0; i < 16; i++) b.set(i, i, (i % 15) + 1);
  return encodeGif({ frames: [b], activePalette: DEFAULT_ACTIVE_PALETTE });
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    order_id: "ord_42",
    drawing_id: "f".repeat(64),
    frame: 0,
    product_id: "tee",
    variant_id: 18395,
    retail_cents: 2400,
    base_cost_cents: 1199,
    status: "paid" as OrderStatus,
    customer_email: "buyer@example.com",
    shipping_address: {
      first_name: "Jane",
      last_name: "Doe",
      email: "buyer@example.com",
      country: "US",
      region: "CA",
      address1: "1 Market St",
      city: "San Francisco",
      zip: "94105",
    },
    created_at: "2026-04-27T10:00:00.000Z",
    updated_at: "2026-04-27T11:00:00.000Z",
    ...overrides,
  };
}

interface OrdersCalls {
  getOrder: string[];
  transition: Array<{ id: string; expectedStatus: OrderStatus; patch: Partial<Order> }>;
}
interface PrintifyCalls {
  uploadImage: Array<{ filename: string; bytesLen: number }>;
  createProduct: Parameters<PrintifyClient["createProduct"]>[0][];
  createOrder: Parameters<PrintifyClient["createOrder"]>[0][];
  sendToProduction: string[];
  findOrderByExternalId: string[];
}

interface StubBehavior {
  order?: Order | null;
  uploadImage?: PrintifyClient["uploadImage"];
  createProduct?: PrintifyClient["createProduct"];
  createOrder?: PrintifyClient["createOrder"];
  sendToProduction?: PrintifyClient["sendToProduction"];
  findOrderByExternalId?: PrintifyClient["findOrderByExternalId"];
  transition?: OrdersStore["transition"];
  fetchDrawing?: PlacePrintifyOrderDeps["fetchDrawing"];
  // When set, dispatch is built with a ProductCountersStore stub that
  // delegates to this fn. Otherwise deps.productCounters is left
  // undefined, mirroring tests/non-prod environments where the table
  // isn't wired up.
  incrementOnSubmit?: ProductCountersStore["incrementOnSubmit"];
}

interface CounterCalls {
  incrementOnSubmit: Array<{ drawing_id: string; product_id: string; now: string }>;
}

function buildDeps(stub: StubBehavior = {}): {
  deps: PlacePrintifyOrderDeps;
  ordersCalls: OrdersCalls;
  printifyCalls: PrintifyCalls;
  counterCalls: CounterCalls;
} {
  const ordersCalls: OrdersCalls = { getOrder: [], transition: [] };
  const printifyCalls: PrintifyCalls = {
    uploadImage: [],
    createProduct: [],
    createOrder: [],
    sendToProduction: [],
    findOrderByExternalId: [],
  };
  const counterCalls: CounterCalls = { incrementOnSubmit: [] };

  const orders = {
    getOrder: async (id: string) => {
      ordersCalls.getOrder.push(id);
      return stub.order === undefined ? makeOrder() : stub.order;
    },
    transition: async (id: string, expectedStatus: OrderStatus, patch: Partial<Order>) => {
      ordersCalls.transition.push({ id, expectedStatus, patch });
      if (stub.transition) return stub.transition(id, expectedStatus, patch);
      return null;
    },
  } as unknown as OrdersStore;

  const printify = {
    uploadImage: async (filename: string, bytes: Uint8Array) => {
      printifyCalls.uploadImage.push({ filename, bytesLen: bytes.length });
      if (stub.uploadImage) return stub.uploadImage(filename, bytes);
      return { id: "img_1", preview_url: "https://printify.example/img_1" };
    },
    createProduct: async (args: Parameters<PrintifyClient["createProduct"]>[0]) => {
      printifyCalls.createProduct.push(args);
      if (stub.createProduct) return stub.createProduct(args);
      return { id: "prod_99" };
    },
    createOrder: async (args: Parameters<PrintifyClient["createOrder"]>[0]) => {
      printifyCalls.createOrder.push(args);
      if (stub.createOrder) return stub.createOrder(args);
      return { id: "po_1", status: "pending" };
    },
    sendToProduction: async (id: string) => {
      printifyCalls.sendToProduction.push(id);
      if (stub.sendToProduction) return stub.sendToProduction(id);
      return { id };
    },
    findOrderByExternalId: async (externalId: string) => {
      printifyCalls.findOrderByExternalId.push(externalId);
      if (stub.findOrderByExternalId) return stub.findOrderByExternalId(externalId);
      return null;
    },
  } as unknown as PrintifyClient;

  const deps: PlacePrintifyOrderDeps = {
    orders,
    printify,
    catalog: FIXTURE_CATALOG,
    publicBaseUrl: "https://drawbang.example",
    fetchDrawing: stub.fetchDrawing ?? (async () => makeGif()),
    now: () => "2026-05-11T09:00:00.000Z",
  };

  if (stub.incrementOnSubmit !== undefined) {
    const stubFn = stub.incrementOnSubmit;
    deps.productCounters = {
      incrementOnSubmit: async (args: Parameters<ProductCountersStore["incrementOnSubmit"]>[0]) => {
        counterCalls.incrementOnSubmit.push(args);
        return stubFn(args);
      },
    } as unknown as ProductCountersStore;
  }

  return { deps, ordersCalls, printifyCalls, counterCalls };
}

// Default helper: a `transition` stub that returns a fake updated Order
// (non-null) so the dispatch's counter-increment gate fires. Existing
// idempotency tests stub a null return explicitly when they need it.
function transitionReturnsOrder(): OrdersStore["transition"] {
  return (async (id: string, _expected: OrderStatus, patch: Partial<Order>) =>
    ({ ...makeOrder(), ...patch, order_id: id }) as Order) as OrdersStore["transition"];
}

test("happy path: upload -> create product -> create order -> submitted", async () => {
  const { deps, ordersCalls, printifyCalls } = buildDeps({
    uploadImage: async () => ({ id: "img_42", preview_url: "u" }),
    createProduct: async () => ({ id: "prod_42" }),
    createOrder: async () => ({ id: "po_42", status: "pending" }),
  });

  await placePrintifyOrder("ord_42", deps);

  // Order fetched once
  assert.deepEqual(ordersCalls.getOrder, ["ord_42"]);

  // Image upload: uses deterministic filename derived from drawing_id + frame
  assert.equal(printifyCalls.uploadImage.length, 1);
  const upload = printifyCalls.uploadImage[0];
  assert.equal(
    upload.filename,
    `drawbang-${"f".repeat(64)}-f0.svg`,
  );
  assert.ok(upload.bytesLen > 0, "non-empty PNG");

  // Product creation: title, blueprint, print provider, single variant + placeholder
  assert.equal(printifyCalls.createProduct.length, 1);
  const product = printifyCalls.createProduct[0];
  assert.equal(product.title, `Drawbang #${"f".repeat(8)}`);
  assert.match(product.description, /https:\/\/drawbang\.example\/d\/ffffff/);
  assert.equal(product.blueprint_id, 6);
  assert.equal(product.print_provider_id, 99);
  assert.deepEqual(product.variants, [{ id: 18395, price: 2400, is_enabled: true }]);
  assert.equal(product.print_areas.length, 1);
  assert.deepEqual(product.print_areas[0].variant_ids, [18395]);
  const placeholder = product.print_areas[0].placeholders[0];
  assert.equal(placeholder.position, "front");
  assert.equal(placeholder.images[0].id, "img_42");

  // Order creation: external_id is our internal order_id (idempotency key
  // for Printify), shipping address forwarded as-is
  assert.equal(printifyCalls.createOrder.length, 1);
  const printifyOrder = printifyCalls.createOrder[0];
  assert.equal(printifyOrder.external_id, "ord_42");
  assert.equal(printifyOrder.line_items[0].product_id, "prod_42");
  assert.equal(printifyOrder.line_items[0].variant_id, 18395);
  assert.equal(printifyOrder.line_items[0].quantity, 1);
  assert.equal(printifyOrder.shipping_method, 1);
  assert.equal(printifyOrder.is_printify_express, false);
  assert.equal(printifyOrder.send_shipping_notification, false);
  assert.equal(printifyOrder.address_to.country, "US");

  // Transitions stamp printify ids incrementally so a Lambda timeout
  // between API calls leaves a recoverable trail. Then sendToProduction +
  // a final transition to submitted.
  assert.equal(printifyCalls.sendToProduction.length, 1);
  assert.equal(printifyCalls.sendToProduction[0], "po_42");
  assert.equal(ordersCalls.transition.length, 3);
  assert.deepEqual(
    ordersCalls.transition.map((t) => t.patch),
    [
      { printify_product_id: "prod_42" },
      { printify_order_id: "po_42" },
      { status: "submitted" },
    ],
  );
  for (const t of ordersCalls.transition) {
    assert.equal(t.id, "ord_42");
    assert.equal(t.expectedStatus, "paid");
  }
});

test("idempotent: prior printify_product_id skips upload + createProduct", async () => {
  const { deps, printifyCalls, ordersCalls } = buildDeps({
    order: makeOrder({ printify_product_id: "prod_existing" }),
  });
  await placePrintifyOrder("ord_42", deps);
  assert.equal(printifyCalls.uploadImage.length, 0);
  assert.equal(printifyCalls.createProduct.length, 0);
  assert.equal(printifyCalls.createOrder.length, 1);
  assert.equal(printifyCalls.createOrder[0].line_items[0].product_id, "prod_existing");
  assert.equal(printifyCalls.sendToProduction.length, 1);
  // Only the order_id stamp + final submitted; no product_id (already set).
  assert.deepEqual(
    ordersCalls.transition.map((t) => t.patch),
    [{ printify_order_id: "po_1" }, { status: "submitted" }],
  );
});

test("idempotent: prior printify_order_id skips createOrder, still calls sendToProduction", async () => {
  const { deps, printifyCalls, ordersCalls } = buildDeps({
    order: makeOrder({
      printify_product_id: "prod_existing",
      printify_order_id: "po_existing",
    }),
  });
  await placePrintifyOrder("ord_42", deps);
  assert.equal(printifyCalls.createOrder.length, 0);
  assert.equal(printifyCalls.sendToProduction.length, 1);
  assert.equal(printifyCalls.sendToProduction[0], "po_existing");
  assert.deepEqual(
    ordersCalls.transition.map((t) => t.patch),
    [{ status: "submitted" }],
  );
});

test("placeholder_positions: each configured position uploads the same image", async () => {
  // Sticker-sheet style: 4 placements per sheet.
  const stickerCatalog: MerchCatalog = {
    products: [
      {
        id: "tee",
        name: "Sticker Sheet",
        blueprint_id: 661,
        print_provider_id: 73,
        print_area_px: { width: 1575, height: 1200 },
        shipping_cents: 500,
        placeholder_positions: ["front_1", "front_2", "front_3", "front_4"],
        variants: [{ id: 18395, label: "x", base_cost_cents: 369, retail_cents: 800 }],
      },
    ],
  };
  const { deps, printifyCalls } = buildDeps();
  deps.catalog = stickerCatalog;
  await placePrintifyOrder("ord_42", deps);
  assert.equal(printifyCalls.createProduct.length, 1);
  const placeholders = printifyCalls.createProduct[0].print_areas[0].placeholders;
  assert.deepEqual(
    placeholders.map((p) => p.position),
    ["front_1", "front_2", "front_3", "front_4"],
  );
  // Same image id repeated in every position.
  for (const p of placeholders) {
    assert.equal(p.images.length, 1);
    assert.equal(p.images[0].id, "img_1");
  }
});

test("upscale to a giant print area still uploads a tiny SVG", async () => {
  // tee print area is 4500×5400. The pre-SVG PNG path needed a hard cap
  // here to avoid an 80MB raster buffer in Lambda memory; the SVG path
  // is bounded by rect count, not sizePx, so the upload payload stays
  // well under any sensible budget regardless of print resolution.
  const catalogOdd: MerchCatalog = {
    products: [
      {
        id: "tee",
        name: "tee",
        blueprint_id: 1,
        print_provider_id: 1,
        print_area_px: { width: 4500, height: 5400 },
        shipping_cents: 500,
        variants: [{ id: 18395, label: "x", base_cost_cents: 1, retail_cents: 1 }],
      },
    ],
  };
  const { deps, printifyCalls } = buildDeps();
  deps.catalog = catalogOdd;
  await placePrintifyOrder("ord_42", deps);
  assert.equal(printifyCalls.uploadImage.length, 1);
  assert.ok(printifyCalls.uploadImage[0].filename.endsWith(".svg"));
  assert.ok(printifyCalls.uploadImage[0].bytesLen > 0);
  assert.ok(
    printifyCalls.uploadImage[0].bytesLen < 32_000,
    `SVG bytes ${printifyCalls.uploadImage[0].bytesLen} unexpectedly large for a 16×16 source`,
  );
});

test("idempotent: order already submitted -> no-op (no Printify calls, no transition)", async () => {
  const { deps, printifyCalls, ordersCalls } = buildDeps({
    order: makeOrder({ status: "submitted" }),
  });
  await placePrintifyOrder("ord_42", deps);
  assert.equal(printifyCalls.uploadImage.length, 0);
  assert.equal(printifyCalls.createProduct.length, 0);
  assert.equal(printifyCalls.createOrder.length, 0);
  assert.equal(ordersCalls.transition.length, 0);
});

test("idempotent: order missing -> no-op", async () => {
  const { deps, printifyCalls, ordersCalls } = buildDeps({ order: null });
  await placePrintifyOrder("ord_missing", deps);
  assert.equal(printifyCalls.uploadImage.length, 0);
  assert.equal(ordersCalls.transition.length, 0);
});

test("Printify error -> order transitions to failed", async () => {
  const { deps, ordersCalls, printifyCalls } = buildDeps({
    uploadImage: async () => {
      throw new Error("Printify exploded");
    },
  });

  await placePrintifyOrder("ord_42", deps);

  assert.equal(printifyCalls.uploadImage.length, 1);
  assert.equal(printifyCalls.createProduct.length, 0);
  assert.equal(ordersCalls.transition.length, 1);
  const t = ordersCalls.transition[0];
  assert.equal(t.id, "ord_42");
  assert.equal(t.expectedStatus, "paid");
  assert.deepEqual(t.patch, { status: "failed" });
});

test("missing shipping_address -> order transitions to failed before hitting Printify", async () => {
  const { deps, ordersCalls, printifyCalls } = buildDeps({
    order: makeOrder({ shipping_address: undefined }),
  });

  await placePrintifyOrder("ord_42", deps);

  assert.equal(printifyCalls.uploadImage.length, 0);
  assert.deepEqual(ordersCalls.transition[0].patch, { status: "failed" });
});

test("drawing missing in S3 -> order transitions to failed", async () => {
  const { deps, ordersCalls, printifyCalls } = buildDeps({
    fetchDrawing: async () => null,
  });

  await placePrintifyOrder("ord_42", deps);

  assert.equal(printifyCalls.uploadImage.length, 0);
  assert.deepEqual(ordersCalls.transition[0].patch, { status: "failed" });
});

test("unknown product_id -> order transitions to failed", async () => {
  const { deps, ordersCalls, printifyCalls } = buildDeps({
    order: makeOrder({ product_id: "ghost" }),
  });

  await placePrintifyOrder("ord_42", deps);

  assert.equal(printifyCalls.uploadImage.length, 0);
  assert.deepEqual(ordersCalls.transition[0].patch, { status: "failed" });
});

test("createOrder error after a successful uploadImage + createProduct still flips to failed", async () => {
  const { deps, ordersCalls, printifyCalls } = buildDeps({
    createOrder: async () => {
      throw new Error("Printify orders down");
    },
  });

  await placePrintifyOrder("ord_42", deps);

  assert.equal(printifyCalls.uploadImage.length, 1);
  assert.equal(printifyCalls.createProduct.length, 1);
  assert.equal(printifyCalls.createOrder.length, 1);
  // Two transitions: the early product_id stamp before createOrder, and the
  // failure flip from the catch block.
  assert.equal(ordersCalls.transition.length, 2);
  assert.deepEqual(ordersCalls.transition[0].patch, { printify_product_id: "prod_99" });
  assert.deepEqual(ordersCalls.transition[1].patch, { status: "failed" });
});

test("createOrder 409 with an existing external_id recovers via findOrderByExternalId", async () => {
  // The orphan-from-prior-timeout case: createOrder rejects with 409
  // because Printify already has an order for this external_id. Dispatch
  // should look it up and treat it as the order id.
  const { deps, ordersCalls, printifyCalls } = buildDeps({
    createOrder: async () => {
      throw new PrintifyError(409, {
        status: "error",
        code: 8503,
        message: "Operation failed.",
      });
    },
    findOrderByExternalId: async () => ({ id: "po_recovered" }),
  });

  await placePrintifyOrder("ord_42", deps);

  assert.equal(printifyCalls.createOrder.length, 1);
  assert.deepEqual(printifyCalls.findOrderByExternalId, ["ord_42"]);
  assert.equal(printifyCalls.sendToProduction.length, 1);
  assert.equal(printifyCalls.sendToProduction[0], "po_recovered");
  // Transitions: product_id (after createProduct) -> order_id (recovered)
  // -> status: submitted.
  assert.deepEqual(
    ordersCalls.transition.map((t) => t.patch),
    [
      { printify_product_id: "prod_99" },
      { printify_order_id: "po_recovered" },
      { status: "submitted" },
    ],
  );
});

test("createOrder 409 with no recoverable order still flips to failed", async () => {
  // Defensive case: 409 fired but the existing order lives outside the
  // listing window we search. Re-throws and the outer catch flips to
  // failed — better than silently submitting a duplicate.
  const { deps, ordersCalls, printifyCalls } = buildDeps({
    createOrder: async () => {
      throw new PrintifyError(409, { code: 8503 });
    },
    findOrderByExternalId: async () => null,
  });

  await placePrintifyOrder("ord_42", deps);

  assert.equal(printifyCalls.createOrder.length, 1);
  assert.deepEqual(printifyCalls.findOrderByExternalId, ["ord_42"]);
  assert.equal(printifyCalls.sendToProduction.length, 0);
  assert.deepEqual(ordersCalls.transition[ordersCalls.transition.length - 1].patch, {
    status: "failed",
  });
});

test("brand_decorations: appends a neck placeholder with the brand logo image id", async () => {
  const catalogWithNeck: MerchCatalog = {
    products: [
      {
        id: "tee",
        name: "tee",
        blueprint_id: 6,
        print_provider_id: 99,
        print_area_px: { width: 3951, height: 4919 },
        brand_decorations: [{ position: "neck" }],
        shipping_cents: 500,
        variants: [{ id: 18395, label: "x", base_cost_cents: 1199, retail_cents: 2400 }],
      },
    ],
  };
  const brandImageIdCalls: string[] = [];
  const { deps, printifyCalls } = buildDeps();
  deps.catalog = catalogWithNeck;
  deps.brandLogo = {
    async getImageId() {
      brandImageIdCalls.push("called");
      return "img_brand_42";
    },
  };

  await placePrintifyOrder("ord_42", deps);

  // brandLogo.getImageId() called exactly once during dispatch
  assert.equal(brandImageIdCalls.length, 1);

  // createProduct payload now carries TWO placeholders: front (the drawing)
  // and neck (the Draw! wordmark).
  const placeholders = printifyCalls.createProduct[0].print_areas[0].placeholders;
  assert.equal(placeholders.length, 2);
  assert.equal(placeholders[0].position, "front");
  assert.equal(placeholders[1].position, "neck");
  assert.equal(placeholders[1].images[0].id, "img_brand_42");
  // Same x/y/scale convention as the front print
  assert.deepEqual(placeholders[1].images[0], {
    id: "img_brand_42",
    x: 0.5,
    y: 0.5,
    scale: 1,
    angle: 0,
  });
});

test("brand_decorations: not configured -> no extra placeholders, brandLogo never called", async () => {
  const brandImageIdCalls: string[] = [];
  const { deps, printifyCalls } = buildDeps();
  deps.brandLogo = {
    async getImageId() {
      brandImageIdCalls.push("called");
      return "img_brand_42";
    },
  };

  await placePrintifyOrder("ord_42", deps);

  // FIXTURE_CATALOG has no brand_decorations — provider must not be invoked
  assert.equal(brandImageIdCalls.length, 0);
  const placeholders = printifyCalls.createProduct[0].print_areas[0].placeholders;
  assert.equal(placeholders.length, 1);
  assert.equal(placeholders[0].position, "front");
});

test("brand_decorations: configured but no provider injected -> dispatch silently skips brand", async () => {
  // Defensive default. Lets a misconfigured non-prod environment still
  // ship orders, just without the brand mark.
  const catalogWithNeck: MerchCatalog = {
    products: [
      {
        id: "tee",
        name: "tee",
        blueprint_id: 6,
        print_provider_id: 99,
        print_area_px: { width: 3951, height: 4919 },
        brand_decorations: [{ position: "neck" }],
        shipping_cents: 500,
        variants: [{ id: 18395, label: "x", base_cost_cents: 1199, retail_cents: 2400 }],
      },
    ],
  };
  const { deps, printifyCalls } = buildDeps();
  deps.catalog = catalogWithNeck;
  // No deps.brandLogo on purpose.

  await placePrintifyOrder("ord_42", deps);

  const placeholders = printifyCalls.createProduct[0].print_areas[0].placeholders;
  assert.equal(placeholders.length, 1);
  assert.equal(placeholders[0].position, "front");
});

test("productCounters: paid->submitted transition increments the counter exactly once", async () => {
  const { deps, counterCalls } = buildDeps({
    transition: transitionReturnsOrder(),
    incrementOnSubmit: async () => undefined,
  });

  await placePrintifyOrder("ord_42", deps);

  assert.equal(counterCalls.incrementOnSubmit.length, 1);
  assert.deepEqual(counterCalls.incrementOnSubmit[0], {
    drawing_id: "f".repeat(64),
    product_id: "tee",
    now: "2026-05-11T09:00:00.000Z",
  });
});

test("productCounters: re-dispatch of already-submitted order does NOT increment", async () => {
  // The dispatch exits early at the status guard (order.status !== "paid"),
  // never reaches the transition, never increments.
  const { deps, counterCalls, ordersCalls } = buildDeps({
    order: makeOrder({ status: "submitted" }),
    transition: transitionReturnsOrder(),
    incrementOnSubmit: async () => undefined,
  });

  await placePrintifyOrder("ord_42", deps);

  assert.equal(ordersCalls.transition.length, 0);
  assert.equal(counterCalls.incrementOnSubmit.length, 0);
});

test("productCounters: race-loser whose paid->submitted transition returns null does NOT increment", async () => {
  // Two dispatchers race on the same order. One wins the conditional
  // update; the loser's final transition returns null. The loser must
  // not also count this order.
  const transition: OrdersStore["transition"] = (async (
    _id: string,
    _expected: OrderStatus,
    patch: Partial<Order>,
  ) => {
    // First two transitions (printify_product_id stamp, printify_order_id
    // stamp) succeed and return a fake order. The third — the status
    // flip to "submitted" — returns null, as if a sibling dispatch
    // already flipped it.
    if (patch.status === "submitted") return null;
    return { ...makeOrder(), ...patch } as Order;
  }) as OrdersStore["transition"];

  const { deps, counterCalls } = buildDeps({
    transition,
    incrementOnSubmit: async () => undefined,
  });

  await placePrintifyOrder("ord_42", deps);

  assert.equal(counterCalls.incrementOnSubmit.length, 0);
});

test("productCounters: increment failure is swallowed; order still ends up submitted", async () => {
  // The counter is best-effort analytics. A throw must not propagate
  // and must not flip the (already in-production) order to "failed".
  const { deps, counterCalls, ordersCalls } = buildDeps({
    transition: transitionReturnsOrder(),
    incrementOnSubmit: async () => {
      throw new Error("DynamoDB throttled");
    },
  });

  await placePrintifyOrder("ord_42", deps);

  assert.equal(counterCalls.incrementOnSubmit.length, 1);
  // No subsequent "failed" transition — the final patch was "submitted".
  const lastPatch = ordersCalls.transition[ordersCalls.transition.length - 1].patch;
  assert.deepEqual(lastPatch, { status: "submitted" });
});

test("productCounters: deps without a counters store skip the increment silently", async () => {
  // Mirrors a non-prod environment that hasn't deployed the table yet.
  const { deps, counterCalls } = buildDeps({
    transition: transitionReturnsOrder(),
    // No incrementOnSubmit -> deps.productCounters stays undefined.
  });

  await placePrintifyOrder("ord_42", deps);

  assert.equal(counterCalls.incrementOnSubmit.length, 0);
});

test("placement: defaults to full-chest when order.placement is absent (pre-#147 orders)", async () => {
  const { deps, printifyCalls } = buildDeps();
  await placePrintifyOrder("ord_42", deps);
  const placeholders = printifyCalls.createProduct[0].print_areas[0].placeholders;
  // Single front placeholder, single image entry at the centre with scale 1.
  assert.equal(placeholders[0].images.length, 1);
  assert.deepEqual(placeholders[0].images[0], { id: "img_1", x: 0.5, y: 0.5, scale: 1, angle: 0 });
});

test("placement: left-chest sends one entry at x=0.3, y=0.25, scale=0.25", async () => {
  const { deps, printifyCalls } = buildDeps({
    order: makeOrder({ placement: "left-chest" }),
  });
  await placePrintifyOrder("ord_42", deps);
  const front = printifyCalls.createProduct[0].print_areas[0].placeholders[0];
  assert.equal(front.images.length, 1);
  assert.deepEqual(front.images[0], { id: "img_1", x: 0.3, y: 0.25, scale: 0.25, angle: 0 });
});

test("placement: pattern-3x3 expands to 9 entries on a third-cell grid, scale 1/3", async () => {
  const { deps, printifyCalls } = buildDeps({
    order: makeOrder({ placement: "pattern-3x3" }),
  });
  await placePrintifyOrder("ord_42", deps);
  const front = printifyCalls.createProduct[0].print_areas[0].placeholders[0];
  assert.equal(front.images.length, 9);
  // First cell — top-left
  assert.ok(Math.abs(front.images[0].x - 1 / 6) < 1e-9);
  assert.ok(Math.abs(front.images[0].y - 1 / 6) < 1e-9);
  // Last cell — bottom-right
  assert.ok(Math.abs(front.images[8].x - 5 / 6) < 1e-9);
  assert.ok(Math.abs(front.images[8].y - 5 / 6) < 1e-9);
  for (const img of front.images) {
    assert.ok(Math.abs(img.scale - 1 / 3) < 1e-9);
    assert.equal(img.id, "img_1");
  }
});

test("placement: brand decorations stay centred regardless of user-facing placement", async () => {
  // The neck label is a separate placeholder. Whatever the user picked
  // for the front shouldn't smear the brand wordmark across the neck.
  const catalogWithNeck: MerchCatalog = {
    products: [
      {
        id: "tee",
        name: "tee",
        blueprint_id: 6,
        print_provider_id: 99,
        print_area_px: { width: 3951, height: 4919 },
        brand_decorations: [{ position: "neck" }],
        shipping_cents: 500,
        variants: [{ id: 18395, label: "x", base_cost_cents: 1199, retail_cents: 2400 }],
      },
    ],
  };
  const { deps, printifyCalls } = buildDeps({
    order: makeOrder({ placement: "pattern-4x4" }),
  });
  deps.catalog = catalogWithNeck;
  deps.brandLogo = { async getImageId() { return "img_brand_42"; } };

  await placePrintifyOrder("ord_42", deps);

  const placeholders = printifyCalls.createProduct[0].print_areas[0].placeholders;
  assert.equal(placeholders.length, 2);
  // Front: 4×4 = 16 user entries
  assert.equal(placeholders[0].position, "front");
  assert.equal(placeholders[0].images.length, 16);
  // Neck: ONE centred brand entry
  assert.equal(placeholders[1].position, "neck");
  assert.equal(placeholders[1].images.length, 1);
  assert.deepEqual(placeholders[1].images[0], {
    id: "img_brand_42", x: 0.5, y: 0.5, scale: 1, angle: 0,
  });
});

test("placement: each placeholder_positions slot on a multi-up product (sticker sheet) inherits the same placement", async () => {
  // Sticker sheets have 4 placeholders; a pattern placement gets applied
  // to EACH — 4 sheets × 4 cells = 16 image entries total, but each
  // placeholder still gets its own 4-cell grid.
  const stickerCatalog: MerchCatalog = {
    products: [
      {
        id: "tee",
        name: "Sticker Sheet",
        blueprint_id: 661,
        print_provider_id: 73,
        print_area_px: { width: 1575, height: 1200 },
        shipping_cents: 500,
        placeholder_positions: ["front_1", "front_2", "front_3", "front_4"],
        variants: [{ id: 18395, label: "x", base_cost_cents: 369, retail_cents: 800 }],
      },
    ],
  };
  const { deps, printifyCalls } = buildDeps({
    order: makeOrder({ placement: "pattern-2x2" }),
  });
  deps.catalog = stickerCatalog;

  await placePrintifyOrder("ord_42", deps);

  const placeholders = printifyCalls.createProduct[0].print_areas[0].placeholders;
  assert.equal(placeholders.length, 4);
  for (const p of placeholders) {
    assert.equal(p.images.length, 4); // 2×2 grid per slot
  }
});
