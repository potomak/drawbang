import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { runInsightsQuery, type InsightsRow } from "./cloudwatch-logs.js";
import {
  renderAdminInner,
  type AdminRange,
  type AdminUserRow,
  type AdminView,
} from "../lib/templates/admin.js";
import type { DrawingStore, QueryPage } from "./drawing-store.js";
import type { UserStore, UserSummary } from "./user-store.js";
import type { UserStatsStore } from "./user-stats-store.js";
import type { RenderResponse } from "./render-handlers.js";
import type { AnyFlagsStore } from "../merch/flags-store.js";

// /admin/data endpoint. Returns an HTML fragment (the data-bound
// inner section: meta + cards + failures table). The /admin shell
// page fetches this with Authorization: Bearer <jwt> from its inline
// boot script — see lib/templates/admin.ts.
//
// Pulls high-level counters from DynamoDB DescribeTable (sampled
// ~every 6h, free), event aggregates from CloudWatch Logs Insights
// against the `{kind:"outcome",…}` stream emitted by
// ingest/log-outcome.ts, product KPIs (remix rate, publish pace) from a
// recent-drawings DrawingStore scan, and the accounts roster from a
// UserStore listing joined with UserStatsStore. Auth gating happens in
// lambda.ts before this handler runs.
//
// This is the ONE surface that renders account email addresses. Emails are
// private everywhere else in the app (see "Identity model" in CLAUDE.md);
// they're here because the operator needs to know who an account is, the
// allowlist gate is enforced server-side in lambda.ts, and the whole page
// is `private, no-store` + noindex. Don't copy this shape onto a public
// route.

export interface AdminHandlerConfig {
  // Both clients are injected so tests can stub them without a real
  // AWS connection. The handler only uses `.send`.
  ddbClient: Pick<DynamoDBClient, "send">;
  cwLogsClient: Pick<CloudWatchLogsClient, "send">;
  drawingStore: DrawingStore;
  userStore: UserStore;
  userStatsStore: UserStatsStore;
  usersTable: string;
  drawingsTable: string;
  logGroup: string;
  now?: () => Date;
  flagsStore?: AnyFlagsStore;
}

// Product KPIs come from a recent-drawings scan (same pattern as
// discover-handler.ts) so remix rate is measurable from server truth
// without GA. 200 rows ≈ one cheap GSI1 query.
export const KPI_SCAN_LIMIT = 200;

// Two separate caps for the accounts roster: how many rows we read (bounds
// the table scan) and how many we render (bounds the per-account stats
// fan-out AND the page weight). Reading more than we render is deliberate —
// the counters below ("signups in range", "have published") describe the
// whole scanned set, not just the visible page.
export const USER_SCAN_LIMIT = 500;
export const USER_ROWS_LIMIT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

// Builds the accounts roster: who registered, when, and what they've done
// since. One table scan plus one stats GetItem per RENDERED account —
// capped by USER_ROWS_LIMIT, so the fan-out is bounded no matter how the
// table grows. A failing stats lookup degrades that account's counters to
// null instead of the whole page.
export async function loadAdminUsers(args: {
  userStore: UserStore;
  userStatsStore: UserStatsStore;
  // Start of the selected range; signups are counted against it from
  // created_at rather than from CloudWatch, which only retains so far back.
  startMs: number;
}): Promise<AdminView["users"]> {
  const page = await args.userStore.listUsers({ limit: USER_SCAN_LIMIT });
  const sorted = [...page.users].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const shown = sorted.slice(0, USER_ROWS_LIMIT);
  const stats = await Promise.all(
    shown.map((u) => args.userStatsStore.get(u.user_id).catch(() => null))
  );
  const rows = shown.map((u, i) => toAdminUserRow(u, stats[i]));
  return {
    scanned: page.users.length,
    truncated: page.truncated,
    shown: rows.length,
    signupsInRange: sorted.filter((u) => signedUpSince(u, args.startMs)).length,
    withDrawings: rows.filter((r) => (r.drawings ?? 0) > 0).length,
    rows,
  };
}

function signedUpSince(u: UserSummary, startMs: number): boolean {
  const t = Date.parse(u.created_at);
  return Number.isFinite(t) && t >= startMs;
}

function toAdminUserRow(
  u: UserSummary,
  stats: Awaited<ReturnType<UserStatsStore["get"]>>
): AdminUserRow {
  return {
    username: u.username,
    email: u.email,
    created_at: u.created_at,
    // No stats row = the account has never published (the row is created
    // by the first publish), which reads as 0, not "unknown".
    drawings: stats?.daily_total ?? 0,
    streak: stats?.daily_streak_current ?? 0,
    last_publish: stats?.daily_last_date ?? null,
    followers: u.follower_count ?? 0,
    following: u.following_count ?? 0,
    has_profile_picture: typeof u.profile_picture_drawing_id === "string",
    bio: u.bio ?? "",
    link: u.link ?? "",
  };
}

export function computeProductKpis(page: QueryPage | null): AdminView["kpis"] {
  if (!page) return null;
  const scanned = page.items.length;
  // `!= null` on purpose: DDB omits parent_id on non-fork rows (GSI3
  // sparseness), so it reads back undefined despite the DrawingRow type.
  const remixes = page.items.filter((r) => r.parent_id != null).length;
  const remixRatePct = scanned > 0 ? (remixes / scanned) * 100 : null;
  let publishesPerDay: number | null = null;
  if (scanned >= 2) {
    const times = page.items.map((r) => r.created_at_ms);
    const spanMs = Math.max(...times) - Math.min(...times);
    if (spanMs > 0) publishesPerDay = scanned / (spanMs / DAY_MS);
  }
  return { scanned, remixes, remixRatePct, publishesPerDay };
}

const RANGES: ReadonlyArray<AdminRange> = ["24h", "7d", "30d"];

export function parseRange(raw: string | null | undefined): AdminRange {
  if (raw && (RANGES as ReadonlyArray<string>).includes(raw)) {
    return raw as AdminRange;
  }
  return "24h";
}

// Exported so the dev server can build the same window without
// duplicating the range table.
export function rangeStartMs(range: AdminRange, now: Date): number {
  return now.getTime() - rangeMs(range);
}

function rangeMs(range: AdminRange): number {
  switch (range) {
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return 30 * 24 * 60 * 60 * 1000;
  }
}

export async function handleAdminRoute(args: {
  cfg: AdminHandlerConfig;
  range: AdminRange;
  adminUsername: string;
}): Promise<RenderResponse> {
  const { cfg, range, adminUsername } = args;
  const now = (cfg.now ?? (() => new Date()))();
  const endMs = now.getTime();
  const startMs = rangeStartMs(range, now);

  const insights = (query: string) =>
    runInsightsQuery({
      client: cfg.cwLogsClient,
      logGroup: cfg.logGroup,
      query,
      startMs,
      endMs,
    });

  // Five Insights queries in parallel + two DescribeTable calls.
  // DescribeTable is control-plane and free; the throughput hit is
  // negligible. All paths swallow their own errors so a single failing
  // query (e.g. log group temporarily missing during a deploy) doesn't
  // 500 the whole page — the affected card just shows "—".
  const [
    totalUsers,
    totalDrawings,
    publishStats,
    registerStats,
    failures,
    kpiPage,
    users,
    merchFlags,
  ] = await Promise.all([
    describeItemCount(cfg.ddbClient, cfg.usersTable).catch(() => null),
    describeItemCount(cfg.ddbClient, cfg.drawingsTable).catch(() => null),
    insights(PUBLISH_STATS_QUERY).catch(() => null),
    insights(REGISTER_STATS_QUERY).catch(() => null),
    insights(FAILURES_QUERY).catch(() => null),
    cfg.drawingStore.queryGallery({ limit: KPI_SCAN_LIMIT }).catch(() => null),
    loadAdminUsers({
      userStore: cfg.userStore,
      userStatsStore: cfg.userStatsStore,
      startMs,
    }).catch(() => null),
    loadMerchFlags(cfg.flagsStore).catch(() => null),
  ]);

  const view: AdminView = {
    adminUsername,
    range,
    generatedAtISO: now.toISOString(),
    totalUsers,
    totalDrawings,
    publish: summariseOutcome(publishStats),
    register: summariseOutcome(registerStats),
    kpis: computeProductKpis(kpiPage),
    users,
    failures: parseFailures(failures),
    merchFlags,
  };

  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: "private, no-store",
    body: renderAdminInner(view),
  };
}

async function describeItemCount(
  client: Pick<DynamoDBClient, "send">,
  tableName: string
): Promise<number | null> {
  const out = (await client.send(
    new DescribeTableCommand({ TableName: tableName }) as never
  )) as unknown as { Table?: { ItemCount?: number } };
  return out.Table?.ItemCount ?? null;
}

// Returns `{succ, fail, total}` from an Insights query that ships three
// `count(*)` aggregates. See PUBLISH_STATS_QUERY / REGISTER_STATS_QUERY
// for the field names.
function summariseOutcome(rows: InsightsRow[] | null): {
  succ: number;
  fail: number;
  total: number;
} | null {
  if (!rows || rows.length === 0) return null;
  // We ship one summary row with three fields. Parse defensively in
  // case Insights returns the column in different orders.
  const r = rows[0];
  const succ = num(r.succ);
  const fail = num(r.fail);
  const total = num(r.total);
  return { succ, fail, total };
}

function parseFailures(rows: InsightsRow[] | null): AdminView["failures"] {
  if (!rows) return [];
  return rows.map((r) => ({
    timestamp: r["@timestamp"] ?? "",
    route: r.route ?? "",
    status: num(r.status),
    error_code: r.error_code ?? "",
    error_message: r.error_message ?? "",
    username: r.username ?? "",
  }));
}

function num(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function loadMerchFlags(flagsStore?: AnyFlagsStore): Promise<AdminView["merchFlags"]> {
  if (!flagsStore) return null;
  const row = await flagsStore.getFlag("merch_dry_run");
  if (!row) {
    // No row yet — default to dry-run true (safe) with no timestamp.
    return { merch_dry_run: true, updated_at: null, updated_by: null };
  }
  const val =
    (row as { enabled?: boolean; value?: boolean }).enabled ??
    (row as { value?: boolean }).value ??
    true;
  return {
    merch_dry_run: Boolean(val),
    updated_at: row.updated_at ?? null,
    updated_by: row.updated_by ?? null,
  };
}

// Standalone JSON handlers for GET /admin/merch/flags and POST /admin/merch/flags
// (allowlisted in routes.ts via deps.admin.isAllowed, same gate as /admin/data).
export async function handleGetMerchFlags(args: {
  flagsStore: AnyFlagsStore;
}): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
  const row = await args.flagsStore.getFlag("merch_dry_run");
  if (!row) {
    return {
      status: 200,
      body: { merch_dry_run: true, updated_at: null, updated_by: null },
      headers: { "Cache-Control": "private, no-store" },
    };
  }
  const val =
    (row as { enabled?: boolean; value?: boolean }).enabled ??
    (row as { value?: boolean }).value ??
    true;
  return {
    status: 200,
    body: {
      merch_dry_run: Boolean(val),
      updated_at: row.updated_at,
      updated_by: row.updated_by ?? null,
    },
    headers: { "Cache-Control": "private, no-store" },
  };
}

export async function handleSetMerchFlags(args: {
  flagsStore: AnyFlagsStore;
  body: string;
  username: string;
}): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.body);
  } catch {
    return { status: 400, body: { error: "bad json body" } };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.merch_dry_run !== "boolean") {
    return { status: 400, body: { error: "bad merch_dry_run: expected boolean" } };
  }
  const row = await args.flagsStore.setFlag("merch_dry_run", obj.merch_dry_run, args.username);
  const val =
    (row as { enabled?: boolean; value?: boolean }).enabled ??
    (row as { value?: boolean }).value ??
    obj.merch_dry_run;
  return {
    status: 200,
    body: {
      merch_dry_run: Boolean(val),
      updated_at: row.updated_at,
      updated_by: row.updated_by ?? null,
    },
    headers: { "Cache-Control": "private, no-store" },
  };
}

// `stats by … as succ, fail, total` is the canonical Insights pattern
// for "success rate of route X". `bin(1)` would let us draw a sparkline
// later; v1 just shows the totals so the cards stay legible.
const PUBLISH_STATS_QUERY = `
fields @timestamp, status
| filter kind = "outcome" and route = "POST /ingest"
| stats sum(status >= 200 and status < 300) as succ,
        sum(status >= 400) as fail,
        count(*) as total
`.trim();

const REGISTER_STATS_QUERY = `
fields @timestamp, status
| filter kind = "outcome" and route = "POST /auth/register"
| stats sum(status >= 200 and status < 300) as succ,
        sum(status >= 400) as fail,
        count(*) as total
`.trim();

const FAILURES_QUERY = `
fields @timestamp, route, status, error_code, error_message, username, user_id
| filter kind = "outcome" and status >= 400
| sort @timestamp desc
| limit 50
`.trim();
