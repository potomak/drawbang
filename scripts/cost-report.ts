// Daily Drawbang cost report. Runs from cron on the Pi, posts to Discord.
//
// Computes month-to-date AWS cost from CloudWatch + CloudFront APIs (both are
// effectively free at our query volume) instead of Cost Explorer (which costs
// $0.01/request — ~7× the app's own steady-state runtime cost).
//
// See docs/cost-audit-2026-06.md for the audit that motivated this script and
// for the pricing constants below.
//
// Usage:
//   npm run cost:report -- --env-file /home/pi/flint_and_flag/config/.env
//   DRY_RUN=1 npm run cost:report -- --env-file …   # print, don't post
//
// AWS credentials are picked up via the default chain (env vars or
// ~/.aws/credentials).

import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  type Dimension,
} from "@aws-sdk/client-cloudwatch";
import {
  CloudFrontClient,
  ListInvalidationsCommand,
  GetInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  LambdaClient,
  GetFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";

// ── What we measure ─────────────────────────────────────────────────────────
const CF_DISTRIBUTION_ID = "E6J784BTWEBRC"; // pixel.drawbang.com
const REGION = "us-east-1";
const LAMBDA_FUNCTIONS = ["drawbang-ingest", "drawbang-merch"];
const DDB_TABLES = [
  "drawbang-drawings",
  "drawbang-users",
  "drawbang-usernames",
  "drawbang-likes",
  "drawbang-bookmarks",
  "drawbang-follows",
  "drawbang-account-stats",
  "drawbang-product-counters",
  "drawbang-orders",
];

// ── us-east-1 pricing (as of 2026-06) ───────────────────────────────────────
// Free tiers are subtracted for invalidations (the actual cost driver in
// May 2026) but NOT for Lambda or DDB — showing the raw cost makes trend
// changes visible while we're well below those free tiers.
const CF_REQUESTS_PER_10K = 0.0075;
const CF_EGRESS_PER_GB = 0.085;
const CF_INVALIDATION_PER_PATH = 0.005;
const CF_INVALIDATION_FREE_PATHS = 1000;
const LAMBDA_REQUEST = 0.0000002;
const LAMBDA_GB_SECOND = 0.0000166667;
const DDB_READ_PER_M = 0.25;
const DDB_WRITE_PER_M = 1.25;

const MTD_ALERT_THRESHOLD = parseFloat(process.env.MTD_ALERT_THRESHOLD ?? "5");
const INV_PATHS_ALERT = 800; // 80% of free tier

// ── Env file loader (no dotenv dep) ─────────────────────────────────────────
// Later definitions within the file override earlier ones (the flint .env
// declares some keys twice — first empty, then with the real value).
// Anything already in process.env at script start wins over the file.
function loadEnvFile(path: string, preexisting: Set<string>): void {
  const text = readFileSync(path, "utf8");
  const fromFile: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fromFile[key] = value;
  }
  for (const [k, v] of Object.entries(fromFile)) {
    if (!preexisting.has(k)) process.env[k] = v;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const envFileIdx = args.indexOf("--env-file");
if (envFileIdx !== -1 && args[envFileIdx + 1]) {
  const preexisting = new Set(Object.keys(process.env));
  loadEnvFile(args[envFileIdx + 1], preexisting);
}
const dryRun = process.env.DRY_RUN === "1" || args.includes("--dry-run");

// ── AWS clients ─────────────────────────────────────────────────────────────
const cw = new CloudWatchClient({ region: REGION });
const cf = new CloudFrontClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });

// ── Time window: first of month UTC → now ───────────────────────────────────
const now = new Date();
const start = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
);
const monthDays = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
).getUTCDate();
const elapsedHours = Math.max(1, (now.getTime() - start.getTime()) / 3600_000);
const elapsedDays = elapsedHours / 24;

// ── Metric helper ───────────────────────────────────────────────────────────
// One GetMetricStatistics call per metric. Deliberately NOT GetMetricData,
// even though it could batch all ~25 reads into a single call: the AWS free
// tier of 1M API requests/month covers GetMetricStatistics but explicitly
// excludes GetMetricData, which is always billed. ~750 calls/month here
// stays free; the equivalent GetMetricData usage would not.
async function metric(
  namespace: string,
  name: string,
  dims: Dimension[],
  stat: "Sum" | "Average",
): Promise<number> {
  const out = await cw.send(
    new GetMetricStatisticsCommand({
      Namespace: namespace,
      MetricName: name,
      Dimensions: dims,
      StartTime: start,
      EndTime: now,
      Period: 86400,
      Statistics: [stat],
    }),
  );
  const pts = out.Datapoints ?? [];
  if (pts.length === 0) return 0;
  if (stat === "Sum") return pts.reduce((s, p) => s + (p.Sum ?? 0), 0);
  return pts.reduce((s, p) => s + (p.Average ?? 0), 0) / pts.length;
}

// ── Gather ──────────────────────────────────────────────────────────────────
type LambdaUsage = {
  name: string;
  invocations: number;
  totalDurationMs: number;
  memoryMB: number;
};
type DdbUsage = { name: string; rcu: number; wcu: number };
type GatherResult = {
  cf: { requests: number; bytes: number };
  lambdas: LambdaUsage[];
  ddb: DdbUsage[];
  inv: { count: number; paths: number };
};

async function gather(): Promise<GatherResult> {
  const cfDims: Dimension[] = [
    { Name: "DistributionId", Value: CF_DISTRIBUTION_ID },
    { Name: "Region", Value: "Global" },
  ];
  const [cfReq, cfBytes] = await Promise.all([
    metric("AWS/CloudFront", "Requests", cfDims, "Sum"),
    metric("AWS/CloudFront", "BytesDownloaded", cfDims, "Sum"),
  ]);

  const lambdas: LambdaUsage[] = await Promise.all(
    LAMBDA_FUNCTIONS.map(async (fn): Promise<LambdaUsage> => {
      const dims: Dimension[] = [{ Name: "FunctionName", Value: fn }];
      const [invs, durSum, cfg] = await Promise.all([
        metric("AWS/Lambda", "Invocations", dims, "Sum"),
        metric("AWS/Lambda", "Duration", dims, "Sum"),
        lambda.send(new GetFunctionConfigurationCommand({ FunctionName: fn })),
      ]);
      return {
        name: fn,
        invocations: invs,
        totalDurationMs: durSum,
        memoryMB: cfg.MemorySize ?? 128,
      };
    }),
  );

  const ddb: DdbUsage[] = await Promise.all(
    DDB_TABLES.map(async (t): Promise<DdbUsage> => {
      const dims: Dimension[] = [{ Name: "TableName", Value: t }];
      const [rcu, wcu] = await Promise.all([
        metric("AWS/DynamoDB", "ConsumedReadCapacityUnits", dims, "Sum"),
        metric("AWS/DynamoDB", "ConsumedWriteCapacityUnits", dims, "Sum"),
      ]);
      return { name: t, rcu, wcu };
    }),
  );

  const list = await cf.send(
    new ListInvalidationsCommand({
      DistributionId: CF_DISTRIBUTION_ID,
      MaxItems: "1000",
    }),
  );
  const items = (list.InvalidationList?.Items ?? []).filter(
    (it) => it.CreateTime && it.CreateTime >= start,
  );
  const details = await Promise.all(
    items.map((it) =>
      cf.send(
        new GetInvalidationCommand({
          DistributionId: CF_DISTRIBUTION_ID,
          Id: it.Id!,
        }),
      ),
    ),
  );
  const invPaths = details.reduce(
    (s, d) => s + (d.Invalidation?.InvalidationBatch?.Paths?.Quantity ?? 0),
    0,
  );

  return {
    cf: { requests: cfReq, bytes: cfBytes },
    lambdas,
    ddb,
    inv: { count: items.length, paths: invPaths },
  };
}

// ── Cost math ───────────────────────────────────────────────────────────────
type CostBreakdown = {
  cfReq: number;
  cfEgress: number;
  cfTotal: number;
  lambdaTotal: number;
  ddbTotal: number;
  invTotal: number;
  invBillablePaths: number;
  total: number;
};

function compute(d: GatherResult): CostBreakdown {
  const cfReq = (d.cf.requests / 10_000) * CF_REQUESTS_PER_10K;
  const cfEgress = (d.cf.bytes / 1e9) * CF_EGRESS_PER_GB;
  const lambdaTotal = d.lambdas.reduce((s, f) => {
    const gbSeconds = (f.memoryMB / 1024) * (f.totalDurationMs / 1000);
    return s + gbSeconds * LAMBDA_GB_SECOND + f.invocations * LAMBDA_REQUEST;
  }, 0);
  const ddbTotal = d.ddb.reduce(
    (s, t) => s + (t.rcu / 1e6) * DDB_READ_PER_M + (t.wcu / 1e6) * DDB_WRITE_PER_M,
    0,
  );
  const invBillablePaths = Math.max(0, d.inv.paths - CF_INVALIDATION_FREE_PATHS);
  const invTotal = invBillablePaths * CF_INVALIDATION_PER_PATH;
  const total = cfReq + cfEgress + lambdaTotal + ddbTotal + invTotal;
  return {
    cfReq,
    cfEgress,
    cfTotal: cfReq + cfEgress,
    lambdaTotal,
    ddbTotal,
    invTotal,
    invBillablePaths,
    total,
  };
}

// ── Persistence for day-over-day ────────────────────────────────────────────
const STATE_DIR = join(homedir(), ".local", "state", "drawbang-cost-report");
const STATE_FILE = join(STATE_DIR, "last.json");

type LastState = { date: string; mtd_cost: number };

function readLast(): LastState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as LastState;
  } catch {
    return null;
  }
}

function writeLast(mtd: number): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ date: now.toISOString().slice(0, 10), mtd_cost: mtd }),
  );
}

// ── Format ──────────────────────────────────────────────────────────────────
const dollars = (n: number) => `$${n.toFixed(3)}`;
const count = (n: number) => Math.round(n).toLocaleString("en-US");
function bytes(b: number): string {
  if (b < 1e6) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1e9) return `${(b / 1e6).toFixed(1)} MB`;
  return `${(b / 1e9).toFixed(2)} GB`;
}

function buildReport(d: GatherResult, c: CostBreakdown): string {
  const day = now.toISOString().slice(0, 10);
  const projected = (c.total / elapsedDays) * monthDays;

  const lambdaInvs = d.lambdas.reduce((s, f) => s + f.invocations, 0);
  const ddbRCU = d.ddb.reduce((s, t) => s + t.rcu, 0);
  const ddbWCU = d.ddb.reduce((s, t) => s + t.wcu, 0);

  const last = readLast();
  const todayDaily = c.total / elapsedDays;
  let priorDaily = 0;
  if (last && last.date !== day) {
    const prevDay = Number(last.date.slice(8, 10));
    priorDaily = last.mtd_cost / Math.max(1, prevDay);
  }
  const deltaLine =
    priorDaily > 0
      ? `  Δ daily-rate vs prior: ${(todayDaily / priorDaily).toFixed(2)}×`
      : "";

  const flags: string[] = [];
  if (c.total > MTD_ALERT_THRESHOLD) {
    flags.push(`MTD > $${MTD_ALERT_THRESHOLD.toFixed(2)}`);
  }
  if (d.inv.paths > INV_PATHS_ALERT) {
    flags.push(
      `invalidations ${d.inv.paths}/${CF_INVALIDATION_FREE_PATHS} paths (>80%)`,
    );
  }
  if (priorDaily > 0 && todayDaily > priorDaily * 3) {
    flags.push("daily rate >3× prior");
  }

  const body = [
    `  CloudFront    ${dollars(c.cfTotal).padEnd(8)} (${count(d.cf.requests)} req, ${bytes(d.cf.bytes)})`,
    `  Lambda        ${dollars(c.lambdaTotal).padEnd(8)} (${count(lambdaInvs)} invs across ${LAMBDA_FUNCTIONS.length} fns)`,
    `  DynamoDB      ${dollars(c.ddbTotal).padEnd(8)} (${count(ddbRCU)} RCU + ${count(ddbWCU)} WCU)`,
    `  Invalidations ${dollars(c.invTotal).padEnd(8)} (${d.inv.paths}/${CF_INVALIDATION_FREE_PATHS} free paths used, ${d.inv.count} batches)`,
    `  ─────────────`,
    `  Total MTD     ${dollars(c.total)}`,
    `  Projected     ${dollars(projected)}  (linear, full month)`,
  ];
  if (deltaLine) body.push(deltaLine);

  const flagLine =
    flags.length > 0 ? `\n⚠ flags: ${flags.join("; ")}` : "";
  const day1Indexed = now.getUTCDate();
  return [
    `Drawbang cost — MTD ${day} (day ${day1Indexed} of ${monthDays})`,
    "```",
    ...body,
    "```",
    flagLine,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// ── Discord ─────────────────────────────────────────────────────────────────
async function postDiscord(content: string): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (!token || !channelId) {
    throw new Error("missing DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID");
  }
  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    },
  );
  if (!res.ok) {
    throw new Error(`Discord POST ${res.status}: ${await res.text()}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const data = await gather();
  const cost = compute(data);
  const message = buildReport(data, cost);
  if (dryRun) {
    console.log(message);
    console.log("\n[DRY RUN — not posting to Discord, not persisting state]");
    return;
  }
  await postDiscord(message);
  writeLast(cost.total);
  console.log(`[cost-report] posted MTD ${dollars(cost.total)} to Discord`);
})().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[cost-report] fatal: ${msg}`);
  process.exit(1);
});
