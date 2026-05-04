interface OrderView {
  order_id?: string;
  drawing_id?: string;
  frame?: number;
  product_id?: string;
  variant_id?: number;
  retail_cents?: number;
  status?: string;
  created_at?: string;
  updated_at?: string;
  customer_email?: string;
}

const INGEST_URL = import.meta.env.VITE_INGEST_URL ?? "/ingest";
const DRAWING_BASE_URL = import.meta.env.VITE_DRAWING_BASE_URL ?? "/drawings";
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
  submitted: "In production.",
  in_production: "In production.",
  shipped: "Shipped! Check your email for tracking.",
  delivered: "Delivered.",
  failed: "Something went wrong. We'll refund you shortly.",
  refunded: "Refunded.",
};

const cardEl = document.getElementById("orderCard") as HTMLDivElement;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function parseOrderId(): string | null {
  const m = location.pathname.match(/\/merch\/order\/([0-9a-f-]+)\/?$/);
  if (!m) return null;
  return ORDER_ID_RE.test(m[1]) ? m[1] : null;
}

function formatUsd(cents: number | undefined): string {
  if (typeof cents !== "number") return "";
  return `$${(cents / 100).toFixed(2)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      default: return "&#39;";
    }
  });
}

function renderError(msg: string): void {
  cardEl.innerHTML = `<p class="merch-status">${escapeHtml(msg)}</p>`;
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
  const drawingImg = order.drawing_id
    ? `<img class="order-thumb" src="${DRAWING_BASE_URL}/${escapeHtml(order.drawing_id)}.gif" alt="drawing ${escapeHtml(order.drawing_id.slice(0, 8))}" width="128" height="128" />`
    : "";
  const lines: string[] = [];
  if (order.order_id) lines.push(`<dt>order</dt><dd><code>${escapeHtml(order.order_id)}</code></dd>`);
  if (order.product_id) {
    const variant = order.variant_id !== undefined ? ` · variant ${escapeHtml(String(order.variant_id))}` : "";
    lines.push(`<dt>product</dt><dd>${escapeHtml(order.product_id)}${variant}</dd>`);
  }
  if (order.retail_cents !== undefined) {
    lines.push(`<dt>amount</dt><dd>${escapeHtml(formatUsd(order.retail_cents))}</dd>`);
  }
  if (order.frame !== undefined) lines.push(`<dt>frame</dt><dd>${escapeHtml(String(order.frame + 1))}</dd>`);
  if (order.created_at) lines.push(`<dt>placed</dt><dd>${escapeHtml(order.created_at)}</dd>`);

  cardEl.innerHTML = `
    ${drawingImg}
    <p class="status-badge status-${escapeHtml(status)}">${escapeHtml(status)}</p>
    <p class="merch-status">${escapeHtml(copy)}</p>
    <dl>${lines.join("")}</dl>
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
      () => void load(id),
    );
    return;
  }
  if (!order) {
    renderError("Order not found.");
    return;
  }
  renderOrder(order);
  schedulePoll(id, order.status ?? "");
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
    renderError("Order id missing or malformed in URL.");
    return;
  }
  void load(id);
}

boot();
