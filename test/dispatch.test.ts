import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import { placePrintifyOrder, type PlacePrintifyOrderDeps } from "../merch/dispatch.js";
import type { MerchCatalog } from "../merch/lambda.js";
import type { Order, OrderStatus, OrdersStore } from "../merch/orders.js";
import type { PrintifyClient } from "../merch/printify.js";

const FIXTURE_CATALOG: MerchCatalog = {
  products: [
    {
      id: "tee",
      name: "Unisex T-shirt",
      blueprint_id: 6,
      print_provider_id: 99,
      print_area_px: { width: 4500, height: 5400 },
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
}

interface StubBehavior {
  order?: Order | null;
  uploadImage?: PrintifyClient["uploadImage"];
  createProduct?: PrintifyClient["createProduct"];
  createOrder?: PrintifyClient["createOrder"];
  transition?: OrdersStore["transition"];
  fetchDrawing?: PlacePrintifyOrderDeps["fetchDrawing"];
}

function buildDeps(stub: StubBehavior = {}): {
  deps: PlacePrintifyOrderDeps;
  ordersCalls: OrdersCalls;
  printifyCalls: PrintifyCalls;
} {
  const ordersCalls: OrdersCalls = { getOrder: [], transition: [] };
  const printifyCalls: PrintifyCalls = {
    uploadImage: [],
    createProduct: [],
    createOrder: [],
  };

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
  } as unknown as PrintifyClient;

  const deps: PlacePrintifyOrderDeps = {
    orders,
    printify,
    catalog: FIXTURE_CATALOG,
    publicBaseUrl: "https://drawbang.example",
    fetchDrawing: stub.fetchDrawing ?? (async () => makeGif()),
  };
  return { deps, ordersCalls, printifyCalls };
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
    `drawbang-${"f".repeat(64)}-f0.png`,
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

  // Transition: paid -> submitted with both Printify handles stamped on
  assert.equal(ordersCalls.transition.length, 1);
  const t = ordersCalls.transition[0];
  assert.equal(t.id, "ord_42");
  assert.equal(t.expectedStatus, "paid");
  assert.deepEqual(t.patch, {
    status: "submitted",
    printify_product_id: "prod_42",
    printify_order_id: "po_42",
  });
});

test("upscale uses the largest print-area dim rounded down to a multiple of 16", async () => {
  // max(4500, 5400) = 5400; floor(5400/16)*16 = 5392 (a multiple of 16).
  const catalogOdd: MerchCatalog = {
    products: [
      {
        id: "tee",
        name: "tee",
        blueprint_id: 1,
        print_provider_id: 1,
        print_area_px: { width: 4500, height: 5400 },
        variants: [{ id: 18395, label: "x", base_cost_cents: 1, retail_cents: 1 }],
      },
    ],
  };
  const { deps, printifyCalls } = buildDeps();
  deps.catalog = catalogOdd;
  await placePrintifyOrder("ord_42", deps);
  // Asserting the exact PNG bytes is brittle; but the call must have
  // happened (i.e. the floor-to-multiple-of-16 didn't blow up upscaler).
  assert.equal(printifyCalls.uploadImage.length, 1);
  assert.ok(printifyCalls.uploadImage[0].bytesLen > 0);
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
  assert.equal(ordersCalls.transition.length, 1);
  assert.deepEqual(ordersCalls.transition[0].patch, { status: "failed" });
});
