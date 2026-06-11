import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { runInsightsQuery, type InsightsRow } from "./cloudwatch-logs.js";
import { renderAdminInner, type AdminView, type AdminRange } from "../lib/templates/admin.js";
import type { DrawingStore, QueryPage } from "./drawing-store.js";
import type { RenderResponse } from "./render-handlers.js";

// /admin/data endpoint. Returns an HTML fragment (the data-bound
// inner section: meta + cards + failures table). The /admin shell
// page fetches this with Authorization: Bearer <jwt> from its inline
// boot script — see lib/templates/admin.ts.
//
// Pulls high-level counters from DynamoDB DescribeTable (sampled
// ~every 6h, free), event aggregates from CloudWatch Logs Insights
// against the `{kind:"outcome",…}` stream emitted by
// ingest/log-outcome.ts, and product KPIs (remix rate, publish pace)
// from a recent-drawings DrawingStore scan. Auth gating happens in
// lambda.ts before this handler runs.

export interface AdminHandlerConfig {
  // Both clients are injected so tests can stub them without a real
  // AWS connection. The handler only uses `.send`.
  ddbClient: Pick<DynamoDBClient, "send">;
  cwLogsClient: Pick<CloudWatchLogsClient, "send">;
  drawingStore: DrawingStore;
  usersTable: string;
  drawingsTable: string;
  logGroup: string;
  now?: () => Date;
}

// Product KPIs come from a recent-drawings scan (same pattern as
// discover-handler.ts) so remix rate is measurable from server truth
// without GA. 200 rows ≈ one cheap GSI1 query.
export const KPI_SCAN_LIMIT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeProductKpis(
  page: QueryPage | null,
): AdminView["kpis"] {
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

function rangeMs(range: AdminRange): number {
  switch (range) {
    case "24h": return 24 * 60 * 60 * 1000;
    case "7d":  return 7 * 24 * 60 * 60 * 1000;
    case "30d": return 30 * 24 * 60 * 60 * 1000;
  }
}

export async function handleAdminRoute(
  args: {
    cfg: AdminHandlerConfig;
    range: AdminRange;
    adminUsername: string;
  },
): Promise<RenderResponse> {
  const { cfg, range, adminUsername } = args;
  const now = (cfg.now ?? (() => new Date()))();
  const endMs = now.getTime();
  const startMs = endMs - rangeMs(range);

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
  ] = await Promise.all([
    describeItemCount(cfg.ddbClient, cfg.usersTable).catch(() => null),
    describeItemCount(cfg.ddbClient, cfg.drawingsTable).catch(() => null),
    insights(PUBLISH_STATS_QUERY).catch(() => null),
    insights(REGISTER_STATS_QUERY).catch(() => null),
    insights(FAILURES_QUERY).catch(() => null),
    cfg.drawingStore.queryGallery({ limit: KPI_SCAN_LIMIT }).catch(() => null),
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
    failures: parseFailures(failures),
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
  tableName: string,
): Promise<number | null> {
  const out = (await client.send(
    new DescribeTableCommand({ TableName: tableName }) as never,
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
