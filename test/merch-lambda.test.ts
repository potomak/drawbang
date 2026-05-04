import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { handle, type MerchCatalog, type MerchHandlerDeps } from "../merch/lambda.js";
import type { OrdersStore, Order, OrderStatus } from "../merch/orders.js";
import type { StripeHelper } from "../merch/stripe.js";

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
        { id: 18396, label: "M / Black", base_cost_cents: 1199, retail_cents: 2400 },
      ],
    },
  ],
};

interface OrdersCalls {
  createOrder: Order[];
  getOrder: string[];
  transition: Array<{ id: string; expectedStatus: OrderStatus; patch: Partial<Order> }>;
}

interface StripeCalls {
  createCheckoutSession: Parameters<StripeHelper["createCheckoutSession"]>[0][];
  parseWebhook: Array<{ body: string; sig: string }>;
}

function fixtureOrder(overrides: Partial<Order> = {}): Order {
  return {
    order_id: "ord_existing",
    drawing_id: "deadbeef".repeat(8),
    frame: 0,
    product_id: "tee",
    variant_id: 18395,
    retail_cents: 2400,
    base_cost_cents: 1199,
    status: "paid",
    stripe_session_id: "cs_test_x",
    printify_product_id: "prod_x",
    printify_order_id: "po_x",
    customer_email: "buyer@example.com",
    created_at: "2026-04-27T10:00:00.000Z",
    updated_at: "2026-04-27T10:01:00.000Z",
    ...overrides,
  };
}

interface StubBehavior {
  catalog?: MerchCatalog;
  ordersStub?: Partial<{
    createOrder: (o: Order) => Promise<void>;
    getOrder: (id: string) => Promise<Order | null>;
    transition: (id: string, expectedStatus: OrderStatus, patch: Partial<Order>) => Promise<Order | null>;
  }>;
  stripeStub?: Partial<{
    createCheckoutSession: StripeHelper["createCheckoutSession"];
    parseWebhook: StripeHelper["parseWebhook"];
  }>;
}

function buildDeps(stub: StubBehavior = {}): {
  deps: MerchHandlerDeps;
  ordersCalls: OrdersCalls;
  stripeCalls: StripeCalls;
} {
  const ordersCalls: OrdersCalls = { createOrder: [], getOrder: [], transition: [] };
  const stripeCalls: StripeCalls = { createCheckoutSession: [], parseWebhook: [] };

  const orders = {
    createOrder: async (o: Order) => {
      ordersCalls.createOrder.push(o);
      if (stub.ordersStub?.createOrder) await stub.ordersStub.createOrder(o);
    },
    getOrder: async (id: string) => {
      ordersCalls.getOrder.push(id);
      return stub.ordersStub?.getOrder ? await stub.ordersStub.getOrder(id) : null;
    },
    transition: async (id: string, expectedStatus: OrderStatus, patch: Partial<Order>) => {
      ordersCalls.transition.push({ id, expectedStatus, patch });
      return stub.ordersStub?.transition
        ? await stub.ordersStub.transition(id, expectedStatus, patch)
        : null;
    },
  } as unknown as OrdersStore;

  const stripe = {
    createCheckoutSession: async (args: Parameters<StripeHelper["createCheckoutSession"]>[0]) => {
      stripeCalls.createCheckoutSession.push(args);
      if (stub.stripeStub?.createCheckoutSession) {
        return stub.stripeStub.createCheckoutSession(args);
      }
      return { id: "cs_test_default", url: "https://checkout.stripe.example/cs_test_default" };
    },
    parseWebhook: (body: string, sig: string) => {
      stripeCalls.parseWebhook.push({ body, sig });
      if (stub.stripeStub?.parseWebhook) return stub.stripeStub.parseWebhook(body, sig);
      // Default to an unhandled event type so the dispatcher is a clean no-op
      // for tests focused on signature/transport behavior. Tests that exercise
      // dispatch live in test/merch-webhook.test.ts.
      return { id: "evt_default", type: "ping" } as unknown as ReturnType<StripeHelper["parseWebhook"]>;
    },
  } as unknown as StripeHelper;

  let counter = 0;
  const deps: MerchHandlerDeps = {
    orders,
    stripe,
    catalog: stub.catalog ?? FIXTURE_CATALOG,
    shippingCountries: ["US", "CA", "GB"],
    uuid: () => `ord_test_${++counter}`,
    now: () => "2026-04-27T11:00:00.000Z",
  };
  return { deps, ordersCalls, stripeCalls };
}

function event(
  routeKey: string,
  opts: {
    body?: unknown;
    rawBody?: string;
    isBase64Encoded?: boolean;
    headers?: Record<string, string>;
    pathParameters?: Record<string, string>;
  } = {},
): APIGatewayProxyEventV2 {
  const [method] = routeKey.split(" ");
  const body =
    opts.rawBody !== undefined
      ? opts.rawBody
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;
  return {
    routeKey,
    rawPath: routeKey.split(" ")[1],
    rawQueryString: "",
    headers: opts.headers ?? {},
    requestContext: {
      http: { method, path: routeKey.split(" ")[1], protocol: "HTTP/1.1", sourceIp: "x", userAgent: "x" },
    },
    pathParameters: opts.pathParameters,
    isBase64Encoded: opts.isBase64Encoded ?? false,
    body,
    version: "2.0",
  } as unknown as APIGatewayProxyEventV2;
}

function parseJson(res: APIGatewayProxyResultV2): unknown {
  if (typeof res === "string") return JSON.parse(res);
  return res.body ? JSON.parse(res.body) : null;
}

function statusOf(res: APIGatewayProxyResultV2): number | undefined {
  return typeof res === "string" ? undefined : res.statusCode;
}

test("GET /merch/products returns the catalog", async () => {
  const { deps } = buildDeps();
  const res = await handle(event("GET /merch/products"), deps);
  assert.equal(statusOf(res), 200);
  assert.deepEqual(parseJson(res), FIXTURE_CATALOG);
});

test("POST /merch/checkout: 400 on bad json body", async () => {
  const { deps } = buildDeps();
  const res = await handle(event("POST /merch/checkout", { rawBody: "not json" }), deps);
  assert.equal(statusOf(res), 400);
  assert.match(JSON.stringify(parseJson(res)), /bad json/);
});

test("POST /merch/checkout: 400 on bad drawing_id", async () => {
  const { deps } = buildDeps();
  const res = await handle(
    event("POST /merch/checkout", {
      body: {
        drawing_id: "not-a-sha",
        frame: 0,
        product_id: "tee",
        variant_id: 18395,
        success_url: "https://x.example/s",
        cancel_url: "https://x.example/c",
      },
    }),
    deps,
  );
  assert.equal(statusOf(res), 400);
  assert.match(JSON.stringify(parseJson(res)), /drawing_id/);
});

test("POST /merch/checkout: 400 when product_id is unknown", async () => {
  const { deps, ordersCalls, stripeCalls } = buildDeps();
  const res = await handle(
    event("POST /merch/checkout", {
      body: {
        drawing_id: "a".repeat(64),
        frame: 0,
        product_id: "mug-not-in-catalog",
        variant_id: 1,
        success_url: "https://x.example/s",
        cancel_url: "https://x.example/c",
      },
    }),
    deps,
  );
  assert.equal(statusOf(res), 400);
  assert.match(JSON.stringify(parseJson(res)), /unknown product_id/);
  assert.equal(ordersCalls.createOrder.length, 0);
  assert.equal(stripeCalls.createCheckoutSession.length, 0);
});

test("POST /merch/checkout: 400 when variant_id is not in the product's variants", async () => {
  const { deps, ordersCalls } = buildDeps();
  const res = await handle(
    event("POST /merch/checkout", {
      body: {
        drawing_id: "a".repeat(64),
        frame: 0,
        product_id: "tee",
        variant_id: 999999,
        success_url: "https://x.example/s",
        cancel_url: "https://x.example/c",
      },
    }),
    deps,
  );
  assert.equal(statusOf(res), 400);
  assert.match(JSON.stringify(parseJson(res)), /unknown variant_id/);
  assert.equal(ordersCalls.createOrder.length, 0);
});

test("POST /merch/checkout: happy path persists, calls Stripe, transitions, returns checkout url", async () => {
  const { deps, ordersCalls, stripeCalls } = buildDeps({
    stripeStub: {
      createCheckoutSession: async () => ({
        id: "cs_test_happy",
        url: "https://checkout.stripe.example/cs_test_happy",
      }),
    },
  });

  const res = await handle(
    event("POST /merch/checkout", {
      body: {
        drawing_id: "f".repeat(64),
        frame: 2,
        product_id: "tee",
        variant_id: 18396,
        success_url: "https://drawbang.example/m/success",
        cancel_url: "https://drawbang.example/m/cancel",
        customer_email: "buyer@example.com",
      },
    }),
    deps,
  );

  assert.equal(statusOf(res), 200);
  const out = parseJson(res) as { order_id: string; checkout_url: string };
  assert.equal(out.order_id, "ord_test_1");
  assert.equal(out.checkout_url, "https://checkout.stripe.example/cs_test_happy");

  // PutItem: pending order, no stripe_session_id yet
  assert.equal(ordersCalls.createOrder.length, 1);
  const created = ordersCalls.createOrder[0];
  assert.equal(created.order_id, "ord_test_1");
  assert.equal(created.status, "pending");
  assert.equal(created.product_id, "tee");
  assert.equal(created.variant_id, 18396);
  assert.equal(created.retail_cents, 2400);
  assert.equal(created.base_cost_cents, 1199);
  assert.equal(created.frame, 2);
  assert.equal(created.customer_email, "buyer@example.com");
  assert.equal(created.created_at, "2026-04-27T11:00:00.000Z");
  assert.equal(created.updated_at, "2026-04-27T11:00:00.000Z");
  assert.equal(created.stripe_session_id, undefined);

  // Stripe Checkout call uses variant pricing + label
  assert.equal(stripeCalls.createCheckoutSession.length, 1);
  const stripeArgs = stripeCalls.createCheckoutSession[0];
  assert.equal(stripeArgs.orderId, "ord_test_1");
  assert.equal(stripeArgs.amountCents, 2400);
  assert.equal(stripeArgs.productName, "M / Black");
  assert.equal(stripeArgs.customerEmail, "buyer@example.com");
  assert.deepEqual(stripeArgs.shippingCountries, ["US", "CA", "GB"]);

  // Transition stamps the stripe session id on the pending order
  assert.equal(ordersCalls.transition.length, 1);
  const t = ordersCalls.transition[0];
  assert.equal(t.id, "ord_test_1");
  assert.equal(t.expectedStatus, "pending");
  assert.deepEqual(t.patch, { stripe_session_id: "cs_test_happy" });
});

test("POST /merch/checkout: substitutes {ORDER_ID} in success_url", async () => {
  const { deps, stripeCalls } = buildDeps();
  const res = await handle(
    event("POST /merch/checkout", {
      body: {
        drawing_id: "a".repeat(64),
        frame: 0,
        product_id: "tee",
        variant_id: 18395,
        success_url: "https://drawbang.example/merch/order/{ORDER_ID}",
        cancel_url: "https://drawbang.example/merch?d=" + "a".repeat(64),
      },
    }),
    deps,
  );
  assert.equal(statusOf(res), 200);
  assert.equal(stripeCalls.createCheckoutSession.length, 1);
  assert.equal(
    stripeCalls.createCheckoutSession[0].successUrl,
    "https://drawbang.example/merch/order/ord_test_1",
  );
});

test("POST /merch/webhook/stripe: 400 when signature header is missing", async () => {
  const { deps, stripeCalls } = buildDeps();
  const res = await handle(event("POST /merch/webhook/stripe", { body: { type: "evt" } }), deps);
  assert.equal(statusOf(res), 400);
  assert.equal(stripeCalls.parseWebhook.length, 0);
});

test("POST /merch/webhook/stripe: 400 when parseWebhook throws", async () => {
  const { deps } = buildDeps({
    stripeStub: {
      parseWebhook: () => {
        throw new Error("bad sig");
      },
    },
  });
  const res = await handle(
    event("POST /merch/webhook/stripe", {
      body: { type: "evt" },
      headers: { "stripe-signature": "t=1,v1=garbage" },
    }),
    deps,
  );
  assert.equal(statusOf(res), 400);
  // bad-sig response is plain text including the underlying error message
  const body = typeof res === "string" ? res : (res.body ?? "");
  assert.match(body, /bad signature.*bad sig/);
});

test("POST /merch/webhook/stripe: 204 on a valid signature; signature passed unchanged", async () => {
  const { deps, stripeCalls } = buildDeps();
  const res = await handle(
    event("POST /merch/webhook/stripe", {
      body: { type: "checkout.session.completed" },
      headers: { "stripe-signature": "t=1,v1=ok" },
    }),
    deps,
  );
  assert.equal(statusOf(res), 204);
  assert.equal(stripeCalls.parseWebhook.length, 1);
  assert.equal(stripeCalls.parseWebhook[0].sig, "t=1,v1=ok");
  assert.equal(stripeCalls.parseWebhook[0].body, JSON.stringify({ type: "checkout.session.completed" }));
});

test("POST /merch/webhook/stripe: base64-encoded body is decoded before signature check", async () => {
  const raw = JSON.stringify({ type: "x" });
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  const { deps, stripeCalls } = buildDeps();
  await handle(
    event("POST /merch/webhook/stripe", {
      rawBody: b64,
      isBase64Encoded: true,
      headers: { "stripe-signature": "ok" },
    }),
    deps,
  );
  assert.equal(stripeCalls.parseWebhook[0].body, raw);
});

test("GET /merch/order/{id}: 404 when not found", async () => {
  const { deps } = buildDeps({ ordersStub: { getOrder: async () => null } });
  const res = await handle(
    event("GET /merch/order/{id}", { pathParameters: { id: "missing" } }),
    deps,
  );
  assert.equal(statusOf(res), 404);
});

test("GET /merch/order/{id}: 200 strips internal-only fields from the response", async () => {
  const { deps } = buildDeps({ ordersStub: { getOrder: async () => fixtureOrder() } });
  const res = await handle(
    event("GET /merch/order/{id}", { pathParameters: { id: "ord_existing" } }),
    deps,
  );
  assert.equal(statusOf(res), 200);
  const out = parseJson(res) as Record<string, unknown>;
  assert.equal(out.order_id, "ord_existing");
  assert.equal(out.status, "paid");
  assert.equal(out.customer_email, "buyer@example.com");
  // Sanitized: must not leak Stripe / Printify internal handles
  assert.equal(out.stripe_session_id, undefined);
  assert.equal(out.printify_product_id, undefined);
  assert.equal(out.printify_order_id, undefined);
});

test("Unmatched routes return 405", async () => {
  const { deps } = buildDeps();
  const res = await handle(event("DELETE /merch/products"), deps);
  assert.equal(statusOf(res), 405);
});
