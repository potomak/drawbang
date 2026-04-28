import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import Stripe from "stripe";
import { handle, type MerchCatalog, type MerchHandlerDeps } from "../merch/lambda.js";
import { StripeHelper } from "../merch/stripe.js";
import type { OrdersStore, Order, OrderStatus } from "../merch/orders.js";

const FIXTURE_CATALOG: MerchCatalog = { products: [] };

interface OrdersCalls {
  transition: Array<{ id: string; expectedStatus: OrderStatus; patch: Partial<Order> }>;
}

function buildDeps(stub: {
  parseWebhook?: StripeHelper["parseWebhook"];
  transitionResult?: Order | null;
  realStripeHelper?: StripeHelper;
  dispatch?: (orderId: string) => Promise<void>;
}): { deps: MerchHandlerDeps; ordersCalls: OrdersCalls; dispatchCalls: string[] } {
  const ordersCalls: OrdersCalls = { transition: [] };
  const dispatchCalls: string[] = [];
  const orders = {
    transition: async (id: string, expectedStatus: OrderStatus, patch: Partial<Order>) => {
      ordersCalls.transition.push({ id, expectedStatus, patch });
      return stub.transitionResult ?? null;
    },
  } as unknown as OrdersStore;

  const stripe =
    stub.realStripeHelper ??
    ({
      parseWebhook:
        stub.parseWebhook ??
        ((_b: string, _s: string) => ({ id: "evt_x", type: "ping" } as unknown as Stripe.Event)),
    } as unknown as StripeHelper);

  const deps: MerchHandlerDeps = {
    orders,
    stripe,
    catalog: FIXTURE_CATALOG,
    shippingCountries: ["US"],
    uuid: () => "ord_test",
    now: () => "2026-04-27T11:00:00.000Z",
    dispatch:
      stub.dispatch ??
      (async (orderId: string) => {
        dispatchCalls.push(orderId);
      }),
  };
  return { deps, ordersCalls, dispatchCalls };
}

function webhookEvent(body: unknown, sig: string): APIGatewayProxyEventV2 {
  return {
    routeKey: "POST /merch/webhook/stripe",
    rawPath: "/merch/webhook/stripe",
    rawQueryString: "",
    headers: { "stripe-signature": sig },
    requestContext: {
      http: { method: "POST", path: "/merch/webhook/stripe", protocol: "HTTP/1.1", sourceIp: "x", userAgent: "x" },
    },
    isBase64Encoded: false,
    body: typeof body === "string" ? body : JSON.stringify(body),
    version: "2.0",
  } as unknown as APIGatewayProxyEventV2;
}

function statusOf(res: APIGatewayProxyResultV2): number | undefined {
  return typeof res === "string" ? undefined : res.statusCode;
}

function bodyOf(res: APIGatewayProxyResultV2): string {
  if (typeof res === "string") return res;
  return res.body ?? "";
}

function makeFixtureOrder(overrides: Partial<Order> = {}): Order {
  return {
    order_id: "ord_42",
    drawing_id: "f".repeat(64),
    frame: 0,
    product_id: "tee",
    variant_id: 18395,
    retail_cents: 2400,
    base_cost_cents: 1199,
    status: "paid",
    created_at: "2026-04-27T10:00:00.000Z",
    updated_at: "2026-04-27T11:00:00.000Z",
    ...overrides,
  };
}

type SessionCustomerDetails = NonNullable<Stripe.Checkout.Session["customer_details"]>;
type SessionCollectedInfo = NonNullable<Stripe.Checkout.Session["collected_information"]>;

test("checkout.session.completed: transitions pending -> paid with email + shipping address", async () => {
  const session: Partial<Stripe.Checkout.Session> = {
    id: "cs_test_x",
    object: "checkout.session",
    metadata: { order_id: "ord_42" },
    customer_details: { email: "buyer@example.com" } as SessionCustomerDetails,
    collected_information: {
      business_name: null,
      individual_name: null,
      shipping_details: {
        name: "Jane Doe",
        address: {
          city: "San Francisco",
          country: "US",
          line1: "1 Market St",
          line2: "Apt 5",
          postal_code: "94105",
          state: "CA",
        },
      },
    } as SessionCollectedInfo,
  };
  const evt = { id: "evt_1", type: "checkout.session.completed", data: { object: session } } as unknown as Stripe.Event;

  const { deps, ordersCalls } = buildDeps({
    parseWebhook: () => evt,
    transitionResult: makeFixtureOrder(),
  });

  const res = await handle(webhookEvent({ type: "checkout.session.completed" }, "sig_x"), deps);
  assert.equal(statusOf(res), 204);
  assert.equal(ordersCalls.transition.length, 1);
  const t = ordersCalls.transition[0];
  assert.equal(t.id, "ord_42");
  assert.equal(t.expectedStatus, "pending");
  assert.equal(t.patch.status, "paid");
  assert.equal(t.patch.customer_email, "buyer@example.com");
  assert.deepEqual(t.patch.shipping_address, {
    first_name: "Jane",
    last_name: "Doe",
    email: "buyer@example.com",
    country: "US",
    region: "CA",
    address1: "1 Market St",
    address2: "Apt 5",
    city: "San Francisco",
    zip: "94105",
  });
});

test("checkout.session.completed: still transitions when shipping_details is absent", async () => {
  const session: Partial<Stripe.Checkout.Session> = {
    id: "cs_test_no_ship",
    object: "checkout.session",
    metadata: { order_id: "ord_99" },
    customer_details: { email: "x@y.example" } as SessionCustomerDetails,
    collected_information: null,
  };
  const evt = { id: "evt_2", type: "checkout.session.completed", data: { object: session } } as unknown as Stripe.Event;

  const { deps, ordersCalls } = buildDeps({
    parseWebhook: () => evt,
    transitionResult: makeFixtureOrder({ order_id: "ord_99" }),
  });

  await handle(webhookEvent({}, "sig_x"), deps);
  assert.equal(ordersCalls.transition[0].patch.shipping_address, undefined);
  assert.equal(ordersCalls.transition[0].patch.customer_email, "x@y.example");
});

test("checkout.session.completed: missing metadata.order_id is logged but webhook still 204s", async () => {
  const evt = {
    id: "evt_3",
    type: "checkout.session.completed",
    data: { object: { id: "cs_no_meta", object: "checkout.session", metadata: null } },
  } as unknown as Stripe.Event;

  const { deps, ordersCalls } = buildDeps({ parseWebhook: () => evt });

  const res = await handle(webhookEvent({}, "sig_x"), deps);
  assert.equal(statusOf(res), 204);
  assert.equal(ordersCalls.transition.length, 0);
});

test("checkout.session.completed: invokes dispatch after a successful pending->paid transition", async () => {
  const evt = {
    id: "evt_dispatch",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_x",
        object: "checkout.session",
        metadata: { order_id: "ord_dispatch" },
        customer_details: null,
        collected_information: null,
      },
    },
  } as unknown as Stripe.Event;

  const { deps, dispatchCalls, ordersCalls } = buildDeps({
    parseWebhook: () => evt,
    transitionResult: makeFixtureOrder({ order_id: "ord_dispatch" }),
  });

  await handle(webhookEvent({}, "sig_x"), deps);
  assert.deepEqual(dispatchCalls, ["ord_dispatch"]);
  assert.equal(ordersCalls.transition.length, 1);
});

test("checkout.session.completed: dispatch errors are swallowed by the webhook try/catch", async () => {
  const evt = {
    id: "evt_dispatch_err",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_x",
        object: "checkout.session",
        metadata: { order_id: "ord_dispatch" },
        customer_details: null,
        collected_information: null,
      },
    },
  } as unknown as Stripe.Event;

  const { deps } = buildDeps({
    parseWebhook: () => evt,
    transitionResult: makeFixtureOrder({ order_id: "ord_dispatch" }),
    dispatch: async () => {
      throw new Error("dispatch boom");
    },
  });

  const res = await handle(webhookEvent({}, "sig_x"), deps);
  assert.equal(statusOf(res), 204);
});

test("checkout.session.completed: dispatch is NOT called when the transition is a no-op (replay)", async () => {
  const evt = {
    id: "evt_replay",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_x",
        object: "checkout.session",
        metadata: { order_id: "ord_replay" },
        customer_details: null,
        collected_information: null,
      },
    },
  } as unknown as Stripe.Event;

  const { deps, dispatchCalls } = buildDeps({
    parseWebhook: () => evt,
    transitionResult: null, // already-paid; transition is a no-op
  });

  await handle(webhookEvent({}, "sig_x"), deps);
  assert.deepEqual(dispatchCalls, []);
});

test("checkout.session.completed: idempotent — replay returns 204 even when transition returns null", async () => {
  const evt = {
    id: "evt_dup",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_x",
        object: "checkout.session",
        metadata: { order_id: "ord_42" },
        customer_details: null,
        collected_information: null,
      },
    },
  } as unknown as Stripe.Event;

  const { deps, ordersCalls } = buildDeps({
    parseWebhook: () => evt,
    transitionResult: null, // simulate already-paid
  });

  const res = await handle(webhookEvent({}, "sig_x"), deps);
  assert.equal(statusOf(res), 204);
  assert.equal(ordersCalls.transition.length, 1); // attempted, but returned null
});

test("payment_intent.payment_failed: transitions pending -> failed", async () => {
  const intent = {
    id: "pi_x",
    object: "payment_intent",
    metadata: { order_id: "ord_42" },
  } as unknown as Stripe.PaymentIntent;
  const evt = { id: "evt_4", type: "payment_intent.payment_failed", data: { object: intent } } as unknown as Stripe.Event;

  const { deps, ordersCalls } = buildDeps({
    parseWebhook: () => evt,
    transitionResult: makeFixtureOrder({ status: "failed" }),
  });

  const res = await handle(webhookEvent({}, "sig_x"), deps);
  assert.equal(statusOf(res), 204);
  assert.equal(ordersCalls.transition.length, 1);
  assert.equal(ordersCalls.transition[0].id, "ord_42");
  assert.equal(ordersCalls.transition[0].expectedStatus, "pending");
  assert.deepEqual(ordersCalls.transition[0].patch, { status: "failed" });
});

test("unhandled event types are logged and 204'd without touching orders", async () => {
  const evt = {
    id: "evt_unknown",
    type: "invoice.paid",
    data: { object: {} },
  } as unknown as Stripe.Event;
  const { deps, ordersCalls } = buildDeps({ parseWebhook: () => evt });
  const res = await handle(webhookEvent({}, "sig_x"), deps);
  assert.equal(statusOf(res), 204);
  assert.equal(ordersCalls.transition.length, 0);
});

test("dispatch errors are swallowed — webhook still returns 204 so Stripe doesn't retry", async () => {
  const evt = {
    id: "evt_err",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_x",
        object: "checkout.session",
        metadata: { order_id: "ord_x" },
        customer_details: null,
        collected_information: null,
      },
    },
  } as unknown as Stripe.Event;

  const orders = {
    transition: async () => {
      throw new Error("DynamoDB on fire");
    },
  } as unknown as OrdersStore;

  const deps: MerchHandlerDeps = {
    orders,
    stripe: { parseWebhook: () => evt } as unknown as StripeHelper,
    catalog: FIXTURE_CATALOG,
    shippingCountries: ["US"],
    uuid: () => "x",
    now: () => "n",
  };

  const res = await handle(webhookEvent({}, "sig_x"), deps);
  assert.equal(statusOf(res), 204);
});

test("bad signature returns 400 with the underlying error message", async () => {
  const { deps } = buildDeps({
    parseWebhook: () => {
      throw new Error("No signatures found matching the expected signature");
    },
  });
  const res = await handle(webhookEvent({}, "sig_bad"), deps);
  assert.equal(statusOf(res), 400);
  assert.match(bodyOf(res), /bad signature.*No signatures found/);
});

test("integration: real Stripe-signed webhook drives the dispatch end-to-end", async () => {
  const webhookSecret = "whsec_test_77";
  const stripeHelper = new StripeHelper({ secretKey: "sk_test_dummy", webhookSecret });
  const stripe = new Stripe("sk_test_dummy");

  const session = {
    id: "cs_test_real",
    object: "checkout.session",
    metadata: { order_id: "ord_real_42" },
    customer_details: { email: "real@example.com" },
    collected_information: null,
  };
  const payload = JSON.stringify({
    id: "evt_real",
    object: "event",
    type: "checkout.session.completed",
    data: { object: session },
  });
  const sigHeader = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });

  const { deps, ordersCalls } = buildDeps({
    realStripeHelper: stripeHelper,
    transitionResult: makeFixtureOrder({ order_id: "ord_real_42" }),
  });

  const res = await handle(webhookEvent(payload, sigHeader), deps);
  assert.equal(statusOf(res), 204);
  assert.equal(ordersCalls.transition.length, 1);
  assert.equal(ordersCalls.transition[0].id, "ord_real_42");
  assert.equal(ordersCalls.transition[0].patch.status, "paid");
  assert.equal(ordersCalls.transition[0].patch.customer_email, "real@example.com");
});
