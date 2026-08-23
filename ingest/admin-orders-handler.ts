import type { OrdersStore, OrderStatus, OrderEnv } from "../merch/orders.js";
import type { RenderResponse } from "./render-handlers.js";
import { renderAdminOrdersShell, renderAdminOrdersInner } from "../lib/templates/admin-orders.js";

export interface AdminOrdersConfig {
  ordersStore: OrdersStore;
}

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "paid",
  "submitted",
  "in_production",
  "shipped",
  "delivered",
  "failed",
  "refunded",
]);

const VALID_ENVS: ReadonlySet<string> = new Set(["prod", "sandbox", "test"]);

function normalizeStatus(raw: string): OrderStatus | null {
  return VALID_STATUSES.has(raw) ? (raw as OrderStatus) : null;
}

function normalizeEnv(raw: string): OrderEnv | null {
  const s = raw.trim().toLowerCase();
  if (s === "prod" || s === "production" || s === "live") return "prod";
  if (s === "sandbox" || s === "test" || s === "dry-run" || s === "dry_run") return "sandbox";
  return VALID_ENVS.has(s) ? (s as OrderEnv) : null;
}

export async function handleAdminOrdersPage(): Promise<RenderResponse> {
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: "private, no-store",
    body: renderAdminOrdersShell(),
  };
}

export async function handleAdminOrdersData(cfg: AdminOrdersConfig): Promise<RenderResponse> {
  const orders = await cfg.ordersStore.scanRecent(100);
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: "private, no-store",
    body: renderAdminOrdersInner(orders),
  };
}

export async function handleAdminOrderUpdate(
  cfg: AdminOrdersConfig,
  orderId: string,
  body: string,
): Promise<{ status: number; body: unknown }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: 400, body: { error: "bad json body" } };
  }
  const obj = parsed as Record<string, unknown>;
  const statusRaw = typeof obj.status === "string" ? obj.status : null;
  const envRaw = typeof obj.env === "string" ? obj.env : null;

  if (!statusRaw && !envRaw) {
    return { status: 400, body: { error: "provide status and/or env" } };
  }

  let updated: unknown = null;
  if (statusRaw) {
    const status = normalizeStatus(statusRaw);
    if (!status) return { status: 400, body: { error: "bad status" } };
    const res = await cfg.ordersStore.adminSetStatus(orderId, status);
    if (!res) return { status: 404, body: { error: "order not found" } };
    updated = res;
  }
  if (envRaw) {
    const env = normalizeEnv(envRaw);
    if (!env) return { status: 400, body: { error: "bad env: expected prod or sandbox" } };
    const res = await cfg.ordersStore.adminSetEnv(orderId, env);
    if (!res) return { status: 404, body: { error: "order not found" } };
    updated = res;
  }
  return { status: 200, body: updated };
}
