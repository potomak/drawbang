import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type Stripe from "stripe";
import catalog from "../config/merch.json";
import { S3Storage } from "../ingest/s3-storage.js";
import { createBrandLogoProvider } from "./brand-logo.js";
import { placePrintifyOrder } from "./dispatch.js";
import { FlagsStore, MERCH_DRY_RUN_FLAG } from "./flags-store.js";
import { OrdersStore, type Order, type OrderStatus } from "./orders.js";
import { isValidPlacement, type Placement } from "./placement.js";
import { PrintifyClient, type ShippingAddress } from "./printify.js";
import { ProductCountersStore } from "./product-counters.js";
import { StripeHelper } from "./stripe.js";

export interface MerchVariant {
  id: number;
  // Structured size/color axes. The merch picker derives separate size and
  // color pill groups from these; products with a single SKU (the mug) omit
  // both fields and auto-select. Either can be present alone.
  size?: string;
  color?: string;
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
  // Runtime dry-run selection: live vs test Stripe helpers picked per-
  // request based on the merch_dry_run flag. Both are optional so
  // existing tests that inject a single `stripe` continue to pass
  // without changes. When present, checkout/webhook resolve via
  // resolveStripeHelper().
  stripeLive?: StripeHelper;
  stripeTest?: StripeHelper;
  flags?: FlagsStore;
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

async function isDryRunFlag(flags: MerchHandlerDeps["flags"]): Promise<boolean> {
  if (!flags) return false;
  try {
    const flag = await flags.getFlag(MERCH_DRY_RUN_FLAG);
    if (!flag) return false;
    // Flag may carry `enabled` (new) or `value` (compat) — treat either.
    const v = (flag as { enabled?: boolean; value?: boolean }).enabled ?? (flag as { value?: boolean }).value;
    return Boolean(v);
  } catch {
    return false;
  }
}

async function isDryRun(deps: MerchHandlerDeps): Promise<boolean> {
  return isDryRunFlag(deps.flags);
}

async function resolveStripeHelper(deps: MerchHandlerDeps): Promise<StripeHelper> {
  if (!deps.flags) return deps.stripe;
  const dry = await isDryRun(deps);
  if (dry) {
    if (deps.stripeTest) return deps.stripeTest;
    return deps.stripe;
  }
  if (deps.stripeLive) return deps.stripeLive;
  return deps.stripe;
}

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
  canvas_id?: unknown;
  frame?: unknown;
  product_id?: unknown;
  variant_id?: unknown;
  placement?: unknown;
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

  // The print source is EITHER a single tile (drawing_id) or a multi-tile
  // canvas (canvas_id) — exactly one. A canvas order carries canvas_id and
  // mirrors it into drawing_id so the order/counter/title code paths keyed on
  // drawing_id keep working; dispatch keys off canvas_id to rebuild the
  // composite.
  const hasDrawing = typeof body.drawing_id === "string" && /^[0-9a-f]{64}$/.test(body.drawing_id);
  const hasCanvas = typeof body.canvas_id === "string" && /^[0-9a-f]{64}$/.test(body.canvas_id);
  if (hasDrawing === hasCanvas) {
    return json(400, { error: "provide exactly one of drawing_id or canvas_id" });
  }
  const canvasId = hasCanvas ? (body.canvas_id as string) : undefined;
  const sourceId = canvasId ?? (body.drawing_id as string);
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
  // placement is optional — absent means full-chest (the dispatch default).
  // Anything present must match a known preset; we reject unknown strings
  // rather than silently falling back so a typo doesn't ship the wrong
  // print.
  let placement: Placement | undefined;
  if (body.placement !== undefined && body.placement !== null) {
    if (!isValidPlacement(body.placement)) {
      return json(400, { error: "bad placement" });
    }
    placement = body.placement;
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
    drawing_id: sourceId,
    frame: body.frame,
    product_id: product.id,
    variant_id: variant.id,
    retail_cents: variant.retail_cents,
    base_cost_cents: variant.base_cost_cents,
    status: "pending" as OrderStatus,
    created_at: now,
    updated_at: now,
    ...(canvasId ? { canvas_id: canvasId } : {}),
    ...(placement ? { placement } : {}),
    ...(customerEmail ? { customer_email: customerEmail } : {}),
  };
  await deps.orders.createOrder(order);

  // The picker can't know the order id at request time, so it embeds the
  // literal "{ORDER_ID}" placeholder. Substitute here before Stripe sees it.
  const successUrl = body.success_url.replace("{ORDER_ID}", orderId);
  const stripeHelper = await resolveStripeHelper(deps);
  const session = await stripeHelper.createCheckoutSession({
    orderId,
    productName: variantDisplayName(product, variant),
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

function variantDisplayName(product: MerchProduct, variant: MerchVariant): string {
  const axes = [variant.size, variant.color].filter(Boolean).join(" / ");
  return axes ? `${product.name} — ${axes}` : product.name;
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
  const stripeHelper = await resolveStripeHelper(deps);
  let evt: Stripe.Event;
  try {
    evt = stripeHelper.parseWebhook(raw, signature);
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

function env(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : undefined;
}

function requiredWithFallback(primary: string, fallback: string): string {
  const v = env(primary) ?? env(fallback);
  if (!v) throw new Error(`missing required env var: ${primary} (or ${fallback})`);
  return v;
}

let booted: MerchHandlerDeps | null = null;
function bootDeps(): MerchHandlerDeps {
  if (booted) return booted;
  const orders = new OrdersStore({ tableName: required("ORDERS_TABLE") });
  const productCounters = new ProductCountersStore({
    tableName: required("PRODUCT_COUNTERS_TABLE"),
  });
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

  // Flags store for runtime dry-run toggle (merch_dry_run). Backwards
  // compat: FLAGS_TABLE may be unset in older deploys — default to the
  // canonical table name so existing stacks keep working and tests that
  // inject deps directly are unaffected (they bypass bootDeps anyway).
  const flagsTable = env("FLAGS_TABLE") ?? env("DRAWBANG_FLAGS_TABLE") ?? "drawbang-flags";
  const flags = new FlagsStore({ tableName: flagsTable });

  // Stripe key pairs — live vs test. The runtime picks per-request based
  // on the merch_dry_run flag. Backwards compat: when the new
  // _LIVE/_TEST vars are unset, fall back to the legacy STRIPE_SECRET_KEY
  // / STRIPE_WEBHOOK_SECRET so existing deploys keep working without a
  // table or flag.
  const liveSecret = requiredWithFallback("STRIPE_SECRET_KEY_LIVE", "STRIPE_SECRET_KEY");
  const liveWebhook = requiredWithFallback("STRIPE_WEBHOOK_SECRET_LIVE", "STRIPE_WEBHOOK_SECRET");
  const testSecret = env("STRIPE_SECRET_KEY_TEST") ?? env("STRIPE_SECRET_KEY") ?? liveSecret;
  const testWebhook = env("STRIPE_WEBHOOK_SECRET_TEST") ?? env("STRIPE_WEBHOOK_SECRET") ?? liveWebhook;

  const stripeLive = new StripeHelper({ secretKey: liveSecret, webhookSecret: liveWebhook });
  const stripeTest = new StripeHelper({ secretKey: testSecret, webhookSecret: testWebhook });
  // Legacy `stripe` kept as alias to live for backwards compat with
  // callers that still read deps.stripe directly.
  const stripe = stripeLive;

  // One BrandLogoProvider per cold start — caches the brand wordmark's
  // Printify image id internally so we upload it exactly once per
  // container, regardless of how many orders this container processes.
  const brandLogo = createBrandLogoProvider(printify);

  // Real Printify path — used when dry_run is false.
  const realDispatchSync = (orderId: string) =>
    placePrintifyOrder(orderId, {
      orders,
      printify,
      catalog: merchCatalog,
      publicBaseUrl,
      fetchDrawing: async (drawingId) =>
        (await s3.getBytes(`public/tiles/${drawingId}.gif`)) ??
        (await s3.getBytes(`public/drawings/${drawingId}.gif`)),
      brandLogo,
      productCounters,
    });

  // Dry-run-aware dispatchSync. At request time we check the flag;
  // when true we transition paid -> submitted without touching Printify
  // (and still bump the product counter so /products ranking stays
  // consistent in dry-run).
  const dispatchSync = async (orderId: string): Promise<void> => {
    if (await isDryRunFlag(flags)) {
      const order = await orders.getOrder(orderId);
      if (!order) {
        console.error("dry-run dispatch: order not found", { orderId });
        return;
      }
      if (order.status !== "paid") {
        console.log("dry-run dispatch: order not in paid; skipping", {
          orderId,
          status: order.status,
        });
        return;
      }
      const submitted = await orders.transition(orderId, "paid", { status: "submitted" });
      if (submitted && productCounters) {
        try {
          await productCounters.incrementOnSubmit({
            drawing_id: order.drawing_id,
            product_id: order.product_id,
            now: new Date().toISOString(),
          });
        } catch (counterErr) {
          console.error("dry-run dispatch: counter increment failed", { orderId, counterErr });
        }
      }
      console.log("dry-run dispatch: order submitted without Printify", { orderId });
      return;
    }
    await realDispatchSync(orderId);
  };

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
    stripe,
    stripeLive,
    stripeTest,
    flags,
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
