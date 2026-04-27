import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import catalog from "../config/merch.json";
import { OrdersStore, type Order, type OrderStatus } from "./orders.js";
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
}

const SANITIZED_FIELDS: ReadonlySet<keyof Order> = new Set([
  "stripe_session_id",
  "printify_product_id",
  "printify_order_id",
]);

export async function handle(
  event: APIGatewayProxyEventV2,
  deps: MerchHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
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

  const session = await deps.stripe.createCheckoutSession({
    orderId,
    productName: variant.label,
    amountCents: variant.retail_cents,
    successUrl: body.success_url,
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
  try {
    deps.stripe.parseWebhook(raw, signature);
  } catch {
    return json(400, { error: "bad signature" });
  }
  // Real dispatch lands in #77.
  return { statusCode: 204, body: "" };
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
  booted = {
    orders: new OrdersStore({ tableName: required("ORDERS_TABLE") }),
    stripe: new StripeHelper({
      secretKey: required("STRIPE_SECRET_KEY"),
      webhookSecret: required("STRIPE_WEBHOOK_SECRET"),
    }),
    catalog: catalog as MerchCatalog,
    shippingCountries: ["US", "CA", "GB"],
    uuid: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
  };
  return booted;
}

export const handler = (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => handle(event, bootDeps());
