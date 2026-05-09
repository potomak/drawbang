import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type Stripe from "stripe";
import catalog from "../config/merch.json";
import { S3Storage } from "../ingest/s3-storage.js";
import { createBrandLogoProvider } from "./brand-logo.js";
import { placePrintifyOrder } from "./dispatch.js";
import { OrdersStore, type Order, type OrderStatus } from "./orders.js";
import { PrintifyClient, type ShippingAddress } from "./printify.js";
import { StripeHelper } from "./stripe.js";

export interface MerchVariant {
  id: number;
  label: string;
  base_cost_cents: number;
  retail_cents: number;
}

export interface MerchProduct {
  id: string;
  name: string;
  blueprint_id: number;
  print_provider_id: number;
  print_area_px: { width: number; height: number };
  // Printify placeholder positions to upload the design into. Defaults to
  // ["front"] when missing — fine for tees/mugs. Sticker sheets need
  // ["front_1","front_2","front_3","front_4"]; some apparel may add "neck".
  placeholder_positions?: string[];
  // Additional placeholders that always carry the Draw! brand wordmark
  // (uploaded once per Lambda cold start by `BrandLogoProvider`). Used
  // for the inside-neck logo on the tee. Empty / missing = no brand
  // decoration on this product.
  brand_decorations?: { position: string }[];
  // Flat US shipping fee added at checkout as a separate Stripe line so the
  // customer sees "+ shipping" instead of paying it bundled into the unit
  // price. Per-product because mug shipping >> tee >> sticker.
  // TODO: replace with the real Printify shipping calc:
  //   POST /v1/shops/{shop_id}/orders/shipping.json
  // — needs blueprint_id, print_provider_id, variants, address. That call
  // can run inside the merch checkout handler before we hit Stripe.
  shipping_cents: number;
  variants: MerchVariant[];
}

export interface MerchCatalog {
  products: MerchProduct[];
}

export interface MerchHandlerDeps {
  orders: OrdersStore;
  stripe: StripeHelper;
  catalog: MerchCatalog;
  shippingCountries: string[];
  uuid: () => string;
  now: () => string;
  // Called from the Stripe webhook after a successful pending->paid
  // transition. In production this is a fire-and-forget Lambda self-invoke
  // (returns in ~30ms), so the webhook response can fit Stripe's 30s
  // timeout even when Printify's createProduct alone takes 20+s. Tests
  // pass a synchronous stub to assert the dispatch is invoked.
  dispatch?: (orderId: string) => Promise<void>;
  // The synchronous dispatch entry point invoked by the async self-call.
  // In production this is placePrintifyOrder(...). Tests don't need it
  // because they exercise the dispatch path directly via dispatch.test.ts.
  dispatchSync?: (orderId: string) => Promise<void>;
}

// The merch Lambda handles two event shapes:
//   1. APIGatewayProxyEventV2 — sync invocation from API Gateway routes.
//   2. AsyncDispatchEvent — fire-and-forget self-invoke from the webhook
//      handler, carrying the order id whose Printify dispatch should run.
export interface AsyncDispatchEvent {
  async_dispatch_order_id: string;
}

type MerchEvent = APIGatewayProxyEventV2 | AsyncDispatchEvent;

function isAsyncDispatchEvent(event: MerchEvent): event is AsyncDispatchEvent {
  return (
    typeof (event as AsyncDispatchEvent).async_dispatch_order_id === "string"
  );
}

const SANITIZED_FIELDS: ReadonlySet<keyof Order> = new Set([
  "stripe_session_id",
  "printify_product_id",
  "printify_order_id",
]);

export async function handle(
  event: MerchEvent,
  deps: MerchHandlerDeps,
): Promise<APIGatewayProxyResultV2 | void> {
  if (isAsyncDispatchEvent(event)) {
    if (deps.dispatchSync) {
      await deps.dispatchSync(event.async_dispatch_order_id);
    }
    return;
  }
  switch (event.routeKey) {
    case "GET /merch/products":
      return json(200, deps.catalog);
    case "POST /merch/checkout":
      return checkout(event, deps);
    case "POST /merch/webhook/stripe":
      return webhook(event, deps);
    case "GET /merch/order/{id}":
      return getOrderRoute(event, deps);
    default:
      return text(405, "method not allowed");
  }
}

interface CheckoutBody {
  drawing_id?: unknown;
  frame?: unknown;
  product_id?: unknown;
  variant_id?: unknown;
  success_url?: unknown;
  cancel_url?: unknown;
  customer_email?: unknown;
}

async function checkout(
  event: APIGatewayProxyEventV2,
  deps: MerchHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
  let body: CheckoutBody;
  try {
    body = parseJsonBody<CheckoutBody>(event);
  } catch {
    return json(400, { error: "bad json body" });
  }

  if (typeof body.drawing_id !== "string" || !/^[0-9a-f]{64}$/.test(body.drawing_id)) {
    return json(400, { error: "bad drawing_id" });
  }
  if (typeof body.frame !== "number" || !Number.isInteger(body.frame) || body.frame < 0) {
    return json(400, { error: "bad frame" });
  }
  if (typeof body.product_id !== "string") {
    return json(400, { error: "bad product_id" });
  }
  if (typeof body.variant_id !== "number" || !Number.isInteger(body.variant_id)) {
    return json(400, { error: "bad variant_id" });
  }
  if (typeof body.success_url !== "string" || !/^https?:\/\//.test(body.success_url)) {
    return json(400, { error: "bad success_url" });
  }
  if (typeof body.cancel_url !== "string" || !/^https?:\/\//.test(body.cancel_url)) {
    return json(400, { error: "bad cancel_url" });
  }
  const customerEmail = typeof body.customer_email === "string" ? body.customer_email : undefined;

  const product = deps.catalog.products.find((p) => p.id === body.product_id);
  if (!product) return json(400, { error: "unknown product_id" });
  const variant = product.variants.find((v) => v.id === body.variant_id);
  if (!variant) return json(400, { error: "unknown variant_id" });

  const orderId = deps.uuid();
  const now = deps.now();
  const order: Order = {
    order_id: orderId,
    drawing_id: body.drawing_id,
    frame: body.frame,
    product_id: product.id,
    variant_id: variant.id,
    retail_cents: variant.retail_cents,
    base_cost_cents: variant.base_cost_cents,
    status: "pending" as OrderStatus,
    created_at: now,
    updated_at: now,
    ...(customerEmail ? { customer_email: customerEmail } : {}),
  };
  await deps.orders.createOrder(order);

  // The picker can't know the order id at request time, so it embeds the
  // literal "{ORDER_ID}" placeholder. Substitute here before Stripe sees it.
  const successUrl = body.success_url.replace("{ORDER_ID}", orderId);
  const session = await deps.stripe.createCheckoutSession({
    orderId,
    productName: variant.label,
    amountCents: variant.retail_cents,
    shippingCents: product.shipping_cents,
    successUrl,
    cancelUrl: body.cancel_url,
    ...(customerEmail ? { customerEmail } : {}),
    shippingCountries: deps.shippingCountries,
  });

  await deps.orders.transition(orderId, "pending", { stripe_session_id: session.id });

  return json(200, { order_id: orderId, checkout_url: session.url });
}

async function webhook(
  event: APIGatewayProxyEventV2,
  deps: MerchHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
  const headers = event.headers ?? {};
  const signature =
    headers["stripe-signature"] ??
    headers["Stripe-Signature"];
  if (!signature) return json(400, { error: "missing signature" });
  const raw = readRawBody(event);
  let evt: Stripe.Event;
  try {
    evt = deps.stripe.parseWebhook(raw, signature);
  } catch (err) {
    return text(400, `bad signature: ${(err as Error).message}`);
  }

  // Always 204 after the signature check passes — surfacing dispatch failures
  // would just make Stripe retry, which can produce duplicate side effects.
  // Failures are logged and orders flipped to "failed" inline.
  try {
    switch (evt.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(evt.data.object as Stripe.Checkout.Session, deps);
        break;
      case "payment_intent.payment_failed":
        await handlePaymentFailed(evt.data.object as Stripe.PaymentIntent, deps);
        break;
      default:
        console.log("unhandled stripe event", evt.type);
    }
  } catch (err) {
    console.error("stripe webhook dispatch failed", { type: evt.type, err });
  }
  return { statusCode: 204, body: "" };
}

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  deps: MerchHandlerDeps,
): Promise<void> {
  const orderId = session.metadata?.order_id;
  if (!orderId) {
    console.error("checkout.session.completed missing metadata.order_id", { sessionId: session.id });
    return;
  }

  const patch: Partial<Order> = { status: "paid" };
  const email = session.customer_details?.email;
  if (email) patch.customer_email = email;
  const shipping = extractShippingAddress(session, email ?? undefined);
  if (shipping) patch.shipping_address = shipping;

  const updated = await deps.orders.transition(orderId, "pending", patch);
  if (!updated) {
    // Already processed (or never created). Webhook retries land here too.
    console.log("order not in pending; skipping", { orderId });
    return;
  }

  if (deps.dispatch) {
    await deps.dispatch(orderId);
  }
}

async function handlePaymentFailed(
  intent: Stripe.PaymentIntent,
  deps: MerchHandlerDeps,
): Promise<void> {
  const orderId = intent.metadata?.order_id;
  if (!orderId) {
    console.error("payment_intent.payment_failed missing metadata.order_id", { intentId: intent.id });
    return;
  }
  const updated = await deps.orders.transition(orderId, "pending", { status: "failed" });
  if (!updated) {
    console.log("order not in pending; skipping payment_failed", { orderId });
  }
}

function extractShippingAddress(
  session: Stripe.Checkout.Session,
  email: string | undefined,
): ShippingAddress | undefined {
  const details = session.collected_information?.shipping_details;
  if (!details) return undefined;
  const addr = details.address;
  if (!addr || !addr.country || !addr.line1 || !addr.city || !addr.postal_code) return undefined;
  const [first, ...rest] = (details.name ?? "").trim().split(/\s+/);
  return {
    first_name: first ?? "",
    last_name: rest.join(" "),
    email: email ?? "",
    country: addr.country,
    region: addr.state ?? "",
    address1: addr.line1,
    ...(addr.line2 ? { address2: addr.line2 } : {}),
    city: addr.city,
    zip: addr.postal_code,
  };
}

async function getOrderRoute(
  event: APIGatewayProxyEventV2,
  deps: MerchHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
  const id = event.pathParameters?.id;
  if (!id) return json(400, { error: "missing id" });
  const order = await deps.orders.getOrder(id);
  if (!order) return json(404, { error: "not found" });
  return json(200, sanitize(order));
}

function sanitize(order: Order): Partial<Order> {
  const out: Partial<Order> = {};
  for (const [key, val] of Object.entries(order)) {
    if (SANITIZED_FIELDS.has(key as keyof Order)) continue;
    (out as Record<string, unknown>)[key] = val;
  }
  return out;
}

function readRawBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) return "";
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
}

function parseJsonBody<T>(event: APIGatewayProxyEventV2): T {
  return JSON.parse(readRawBody(event)) as T;
}

function json(status: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function text(status: number, body: string): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { "Content-Type": "text/plain" },
    body,
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

let booted: MerchHandlerDeps | null = null;
function bootDeps(): MerchHandlerDeps {
  if (booted) return booted;
  const orders = new OrdersStore({ tableName: required("ORDERS_TABLE") });
  const printify = new PrintifyClient({
    token: required("PRINTIFY_API_TOKEN"),
    shopId: required("PRINTIFY_SHOP_ID"),
  });
  const drawingsBucket = required("DRAWINGS_BUCKET");
  const publicBaseUrl = required("PUBLIC_BASE_URL");
  const merchFunctionName = required("MERCH_FUNCTION_NAME");
  const s3 = new S3Storage({ bucket: drawingsBucket });
  const merchCatalog = catalog as MerchCatalog;
  const lambdaClient = new LambdaClient({});

  // One BrandLogoProvider per cold start — caches the brand wordmark's
  // Printify image id internally so we upload it exactly once per
  // container, regardless of how many orders this container processes.
  const brandLogo = createBrandLogoProvider(printify);

  const dispatchSync = (orderId: string) =>
    placePrintifyOrder(orderId, {
      orders,
      printify,
      catalog: merchCatalog,
      publicBaseUrl,
      fetchDrawing: (drawingId) => s3.getBytes(`public/drawings/${drawingId}.gif`),
      brandLogo,
    });

  // Fire-and-forget self-invoke: returns once Lambda has accepted the
  // payload, leaving the async invocation to run with the full Lambda
  // timeout (60s). This keeps the webhook handler under Stripe's 30s
  // ceiling even when Printify's createProduct alone takes 20s+.
  const dispatchAsync = async (orderId: string) => {
    const payload: AsyncDispatchEvent = { async_dispatch_order_id: orderId };
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: merchFunctionName,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
  };

  booted = {
    orders,
    stripe: new StripeHelper({
      secretKey: required("STRIPE_SECRET_KEY"),
      webhookSecret: required("STRIPE_WEBHOOK_SECRET"),
    }),
    catalog: merchCatalog,
    shippingCountries: ["US", "CA", "GB"],
    uuid: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
    dispatch: dispatchAsync,
    dispatchSync,
  };
  return booted;
}

export const handler = (
  event: MerchEvent,
): Promise<APIGatewayProxyResultV2 | void> => handle(event, bootDeps());
