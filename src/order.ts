import { tracker } from "./analytics/analytics.js";
import { esc as escapeHtml } from "../lib/templates/_escape.js";
import merchCatalogImport from "../config/merch.json";
import mockupsConfigImport from "../config/mockups.json";
const merchCatalog = ((merchCatalogImport as unknown as { default?: unknown }).default ??
  merchCatalogImport) as unknown as {
  products: {
    id: string;
    name: string;
    variants: { id: number; size?: string; color?: string }[];
  }[];
};
const mockupsConfig = ((mockupsConfigImport as unknown as { default?: unknown }).default ??
  mockupsConfigImport) as unknown as { products: Record<string, { mockup_url: string }> };

interface OrderView {
  order_id?: string;
  drawing_id?: string;
  canvas_id?: string;
  frame?: number;
  product_id?: string;
  variant_id?: number;
  retail_cents?: number;
  status?: string;
  created_at?: string;
  updated_at?: string;
  customer_email?: string;
}

interface MerchProduct {
  id: string;
  name: string;
  variants: { id: number; size?: string; color?: string }[];
}

interface MockupEntry {
  mockup_url: string;
}

const INGEST_URL = import.meta.env.VITE_INGEST_URL ?? "/ingest";
const DRAWING_BASE_URL = import.meta.env.VITE_DRAWING_BASE_URL ?? "/tiles";
const API_BASE = INGEST_URL.replace(/\/ingest\/?$/, "");

const ORDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POLL_MS = 30_000;
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "shipped",
  "delivered",
  "failed",
  "refunded",
]);

const STATUS_COPY: Record<string, string> = {
  pending: "Waiting for payment confirmation. Refresh in a minute.",
  paid: "Payment received! Sending to Printify…",
  submitted: "Your order is in production — we'll email you when it ships.",
  in_production: "Your order is in production — we'll email you when it ships.",
  shipped: "Shipped! Check your email for tracking.",
  delivered: "Delivered.",
  failed: "Something went wrong. We'll refund you shortly.",
  refunded: "Refunded.",
};

const THANK_YOU_COPY: Record<string, { title: string; subtitle: string }> = {
  pending: {
    title: "Thanks — order received",
    subtitle: "Confirming your payment — usually under a minute.",
  },
  paid: {
    title: "Payment confirmed",
    subtitle: "Thanks! We're getting your order ready for the printer.",
  },
  submitted: {
    title: "In production",
    subtitle: "Your tee is being printed — we'll email you when it ships.",
  },
  in_production: {
    title: "In production",
    subtitle: "Your tee is being printed — we'll email you when it ships.",
  },
  shipped: {
    title: "Shipped!",
    subtitle: "Tracking is in your email.",
  },
  delivered: {
    title: "Delivered",
    subtitle: "Enjoy your tee!",
  },
  failed: {
    title: "Order failed",
    subtitle: "We couldn’t complete it — you haven’t been charged, or a refund is on the way.",
  },
  refunded: { title: "Refunded", subtitle: "Your order has been refunded." },
};

type ProgressStep = { label: string; key: string };
const PROGRESS_STEPS: ReadonlyArray<ProgressStep> = [
  { label: "Received", key: "pending" },
  { label: "Paid", key: "paid" },
  { label: "In production", key: "submitted" },
  { label: "Shipped", key: "shipped" },
];

function stepIndex(status: string): number {
  switch (status) {
    case "pending":
      return 0;
    case "paid":
      return 1;
    case "submitted":
    case "in_production":
      return 2;
    case "shipped":
    case "delivered":
      return 3;
    default:
      return -1;
  }
}

function isFailedStatus(status: string): boolean {
  return status === "failed" || status === "refunded";
}

const CATALOG = merchCatalog as unknown as { products: MerchProduct[] };
const MOCKUPS = mockupsConfig as unknown as { products: Record<string, MockupEntry> };

const cardEl = document.getElementById("orderCard") as HTMLDivElement;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let lastTrackedStatus: string | null = null;

const PURCHASE_FIRED_KEY_PREFIX = "drawbang:purchase_fired:";
function hasPurchaseFired(orderId: string): boolean {
  try {
    return localStorage.getItem(PURCHASE_FIRED_KEY_PREFIX + orderId) === "1";
  } catch {
    return false;
  }
}
function markPurchaseFired(orderId: string): void {
  try {
    localStorage.setItem(PURCHASE_FIRED_KEY_PREFIX + orderId, "1");
  } catch {
    /* private mode etc. — accept the rare double-count */
  }
}

function parseOrderId(): string | null {
  const m = location.pathname.match(/\/merch\/order\/([0-9a-f-]+)\/?$/);
  if (!m) return null;
  return ORDER_ID_RE.test(m[1]) ? m[1] : null;
}

function formatUsd(cents: number | undefined): string {
  if (typeof cents !== "number") return "";
  return `$${(cents / 100).toFixed(2)}`;
}

function formatHumanDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function variantLabel(productId: string | undefined, variantId: number | undefined): string {
  if (!productId) return "";
  const product = CATALOG.products.find((p) => p.id === productId);
  if (!product) return productId;
  if (variantId === undefined) return product.name;
  const variant = product.variants.find((v) => v.id === variantId);
  if (!variant) return `${product.name} · ${variantId}`;
  const parts = [variant.size, variant.color].filter(Boolean);
  const variantStr = parts.length ? parts.join(" / ") : String(variant.id);
  return `${product.name} — ${variantStr}`;
}

function mockupUrl(productId: string | undefined): string | null {
  if (!productId) return null;
  const entry = MOCKUPS.products[productId];
  if (entry?.mockup_url) return entry.mockup_url;
  return MOCKUPS.products["tee"]?.mockup_url ?? null;
}

function renderProgress(status: string): string {
  const failed = isFailedStatus(status);
  const idx = stepIndex(status);
  const steps = PROGRESS_STEPS.map((step, i) => {
    let state: "completed" | "current" | "pending" | "failed" = "pending";
    if (failed) {
      if (i < idx) state = "completed";
      else if (i === idx) state = "failed";
      else state = "pending";
    } else if (i < idx) state = "completed";
    else if (i === idx) state = "current";
    const ariaCurrent = state === "current" ? ' aria-current="step"' : "";
    const marker = state === "completed" ? "✓" : state === "failed" ? "✕" : String(i + 1);
    return `<li class="order-progress-step order-progress-step--${state}"${ariaCurrent}><span class="order-progress-marker">${escapeHtml(marker)}</span><span class="order-progress-label">${escapeHtml(step.label)}</span></li>`;
  }).join("");
  const failedClass = failed ? " order-progress--failed" : "";
  return `<ol class="order-progress${failedClass}" aria-label="Order progress">${steps}</ol>`;
}

function renderRetry(msg: string, onRetry: () => void): void {
  cardEl.innerHTML = `
    <p class="merch-status">${escapeHtml(msg)}</p>
    <button id="retryBtn" type="button">retry</button>
  `;
  document.getElementById("retryBtn")?.addEventListener("click", onRetry);
}

function renderOrder(order: OrderView): void {
  const status = order.status ?? "unknown";
  const copy = STATUS_COPY[status] ?? `Status: ${status}.`;
  const thankYou = THANK_YOU_COPY[status] ?? { title: "Thank you for your order!", subtitle: copy };

  const thumbSrc = order.canvas_id
    ? `/c/${escapeHtml(order.canvas_id)}.gif`
    : order.drawing_id
      ? `${DRAWING_BASE_URL}/${escapeHtml(order.drawing_id)}.gif`
      : "";
  const drawingImg = thumbSrc
    ? `<img class="order-thumb" src="${thumbSrc}" alt="Your drawing" width="160" height="160" loading="eager" />`
    : `<div class="order-thumb order-thumb--empty" aria-hidden="true"></div>`;

  const productMockup = mockupUrl(order.product_id);
  const mockupImg = productMockup
    ? `<img class="order-mockup" src="${escapeHtml(productMockup)}" alt="${escapeHtml(variantLabel(order.product_id, undefined).split(" — ")[0] ?? "Product")}" width="320" height="320" loading="eager" />`
    : "";

  const productLabel = variantLabel(order.product_id, order.variant_id);
  const placed = formatHumanDate(order.created_at);
  const shortId = order.order_id ? order.order_id.slice(0, 8) : "";

  const lines: string[] = [];
  if (order.order_id)
    lines.push(
      `<dt>Order</dt><dd><code title="${escapeHtml(order.order_id)}">${escapeHtml(shortId)}…</code> <span class="order-id-full">${escapeHtml(order.order_id)}</span></dd>`
    );
  if (productLabel) lines.push(`<dt>Product</dt><dd>${escapeHtml(productLabel)}</dd>`);
  if (order.retail_cents !== undefined) {
    lines.push(`<dt>Amount</dt><dd>${escapeHtml(formatUsd(order.retail_cents))}</dd>`);
  }
  if (placed) lines.push(`<dt>Placed</dt><dd>${escapeHtml(placed)}</dd>`);
  if (order.customer_email)
    lines.push(`<dt>Email</dt><dd>${escapeHtml(order.customer_email)}</dd>`);

  cardEl.innerHTML = `
    <div class="order-thanks">
      <h2 class="order-thanks-title">${escapeHtml(thankYou.title)}</h2>
      <p class="order-thanks-sub">${escapeHtml(thankYou.subtitle)}</p>
    </div>
    ${renderProgress(status)}
    <div class="order-visuals">
      <div class="order-visual order-visual--drawing">
        <span class="order-visual-label">Your Draw!</span>
        ${drawingImg}
        ${order.frame !== undefined ? `<span class="order-visual-caption">Frame ${escapeHtml(String(order.frame + 1))}</span>` : ""}
      </div>
      <div class="order-visual order-visual--product">
        <span class="order-visual-label">Printed on</span>
        ${mockupImg}
      </div>
    </div>
    <p class="status-badge status-${escapeHtml(status)}">${escapeHtml(status)}</p>
    <p class="merch-status">${escapeHtml(copy)}</p>
    <dl class="order-details">${lines.join("")}</dl>
  `;
}

async function fetchOrder(id: string): Promise<OrderView | null> {
  const res = await fetch(`${API_BASE}/merch/order/${encodeURIComponent(id)}`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as OrderView;
}

async function load(id: string): Promise<void> {
  let order: OrderView | null;
  try {
    order = await fetchOrder(id);
  } catch (err) {
    renderRetry(
      `failed to load order: ${err instanceof Error ? err.message : String(err)}`,
      () => void load(id)
    );
    return;
  }
  if (!order) {
    location.replace("/404");
    return;
  }
  renderOrder(order);
  trackStatusEvents(order);
  schedulePoll(id, order.status ?? "");
}

function trackStatusEvents(order: OrderView): void {
  const status = order.status ?? "unknown";
  if (status !== lastTrackedStatus) {
    tracker.orderStatusView(status);
    lastTrackedStatus = status;
  }
  if (
    status === "paid" &&
    order.order_id &&
    order.product_id &&
    typeof order.retail_cents === "number" &&
    !hasPurchaseFired(order.order_id)
  ) {
    tracker.purchase({
      transaction_id: order.order_id,
      value: order.retail_cents / 100,
      items: [
        {
          item_id: order.product_id,
          item_name: order.product_id,
          price: order.retail_cents / 100,
          quantity: 1,
          ...(order.variant_id !== undefined ? { item_variant: String(order.variant_id) } : {}),
        },
      ],
    });
    markPurchaseFired(order.order_id);
  }
}

function schedulePoll(id: string, status: string): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (TERMINAL_STATUSES.has(status)) return;
  pollTimer = setTimeout(() => void load(id), POLL_MS);
}

function boot(): void {
  const id = parseOrderId();
  if (!id) {
    location.replace("/404");
    return;
  }
  void load(id);
}

boot();
