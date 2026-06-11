import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  DescribeTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  GetQueryResultsCommand,
  StartQueryCommand,
  type CloudWatchLogsClient,
} from "@aws-sdk/client-cloudwatch-logs";
import { handleAdminRoute, parseRange } from "../ingest/admin-handler.js";
import {
  MemoryDrawingStore,
  type DrawingRow,
  type DrawingStore,
} from "../ingest/drawing-store.js";
import { renderAdminShell } from "../lib/templates/admin.js";

// Fakes the AWS SDK clients with handcrafted responses. Tests stay
// hermetic and assert what we'd actually want to render: counts, success
// rates, failures table content.

type SendInput = Record<string, unknown>;

function fakeDdb(itemCountByTable: Record<string, number>): Pick<DynamoDBClient, "send"> {
  return {
    send: (async (cmd: { input: SendInput }) => {
      if (cmd instanceof DescribeTableCommand) {
        const t = cmd.input.TableName as string;
        return { Table: { ItemCount: itemCountByTable[t] ?? 0 } };
      }
      throw new Error(`unexpected DDB command: ${cmd.constructor.name}`);
    }) as unknown as DynamoDBClient["send"],
  };
}

interface InsightsScenario {
  // Maps the queryString → rows the fake should return when polled.
  // The order of the keys matches the order admin-handler.ts dispatches
  // them, but we key on substring so the test stays decoupled from
  // exact query strings.
  matchers: Array<{ contains: string; rows: Array<Array<{ field: string; value: string }>> }>;
}

function fakeCwLogs(scenario: InsightsScenario): {
  client: Pick<CloudWatchLogsClient, "send">;
  startedQueries: string[];
} {
  const startedQueries: string[] = [];
  const queryIdToRows = new Map<
    string,
    Array<Array<{ field: string; value: string }>>
  >();
  let nextId = 1;
  const client = {
    send: (async (cmd: { input: SendInput }) => {
      if (cmd instanceof StartQueryCommand) {
        const q = (cmd.input.queryString as string) ?? "";
        startedQueries.push(q);
        const match = scenario.matchers.find((m) => q.includes(m.contains));
        const id = `q-${nextId++}`;
        queryIdToRows.set(id, match?.rows ?? []);
        return { queryId: id };
      }
      if (cmd instanceof GetQueryResultsCommand) {
        const id = (cmd.input as { queryId: string }).queryId;
        return { status: "Complete", results: queryIdToRows.get(id) ?? [] };
      }
      throw new Error(`unexpected CW Logs command: ${cmd.constructor.name}`);
    }) as unknown as CloudWatchLogsClient["send"],
  };
  return { client, startedQueries };
}

const FIXED_NOW = new Date("2026-06-08T18:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function drawingRow(overrides: Partial<DrawingRow> = {}): DrawingRow {
  const ms = overrides.created_at_ms ?? FIXED_NOW.getTime();
  return {
    drawing_id: overrides.drawing_id ?? "a".repeat(64),
    size: overrides.size ?? 16,
    created_at: overrides.created_at ?? new Date(ms).toISOString(),
    created_at_ms: ms,
    user_id: overrides.user_id ?? "u".repeat(64),
    username: overrides.username ?? "alice",
    parent_id: overrides.parent_id ?? null,
    frames: overrides.frames ?? 1,
    gif_size_bytes: overrides.gif_size_bytes ?? 1234,
  };
}

function baseCfg(args: {
  itemCounts?: Record<string, number>;
  scenario?: InsightsScenario;
  drawingStore?: DrawingStore;
}) {
  const cw = fakeCwLogs(args.scenario ?? { matchers: [] });
  return {
    ddbClient: fakeDdb(args.itemCounts ?? {}),
    cwLogsClient: cw.client,
    cwSpy: cw,
    drawingStore: args.drawingStore ?? new MemoryDrawingStore(),
    usersTable: "drawbang-users",
    drawingsTable: "drawbang-drawings",
    logGroup: "/aws/lambda/drawbang-ingest",
    now: () => FIXED_NOW,
  };
}

describe("parseRange", () => {
  test("accepts 24h, 7d, 30d; defaults everything else to 24h", () => {
    assert.equal(parseRange("24h"), "24h");
    assert.equal(parseRange("7d"), "7d");
    assert.equal(parseRange("30d"), "30d");
    assert.equal(parseRange(null), "24h");
    assert.equal(parseRange(""), "24h");
    assert.equal(parseRange("365d"), "24h");
    assert.equal(parseRange("0' or 1=1"), "24h"); // garbage = default
  });
});

describe("handleAdminRoute", () => {
  test("renders the inner HTML fragment with private,no-store cache-control", async () => {
    const cfg = baseCfg({});
    const res = await handleAdminRoute({
      cfg, range: "24h", adminUsername: "potomak",
    });
    assert.equal(res.status, 200);
    assert.equal(res.cacheControl, "private, no-store");
    assert.match(res.contentType, /^text\/html/);
    // Fragment — no doctype, no <title>; the shell owns those.
    assert.equal(/<title>/.test(res.body), false);
    assert.equal(/<!doctype/i.test(res.body), false);
    assert.match(res.body, /signed in as potomak/);
  });

  test("renders ItemCount values in the totals cards", async () => {
    const cfg = baseCfg({
      itemCounts: { "drawbang-users": 42, "drawbang-drawings": 1337 },
    });
    const res = await handleAdminRoute({
      cfg, range: "24h", adminUsername: "potomak",
    });
    assert.match(res.body, /Total users[\s\S]*?>42</);
    assert.match(res.body, /Total drawings[\s\S]*?>1,337</);
  });

  test("renders em-dash when a DescribeTable call rejects", async () => {
    // Build a DDB client that throws on the users-table lookup.
    const ddb: Pick<DynamoDBClient, "send"> = {
      send: (async (cmd: { input: SendInput }) => {
        const t = cmd.input.TableName as string;
        if (t === "drawbang-users") throw new Error("transient");
        return { Table: { ItemCount: 999 } };
      }) as unknown as DynamoDBClient["send"],
    };
    const cw = fakeCwLogs({ matchers: [] });
    const res = await handleAdminRoute({
      cfg: {
        ddbClient: ddb,
        cwLogsClient: cw.client,
        drawingStore: new MemoryDrawingStore(),
        usersTable: "drawbang-users",
        drawingsTable: "drawbang-drawings",
        logGroup: "/aws/lambda/drawbang-ingest",
        now: () => FIXED_NOW,
      },
      range: "24h",
      adminUsername: "potomak",
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /Total users[\s\S]*?>—</);
    assert.match(res.body, /Total drawings[\s\S]*?>999</);
  });

  test("computes publish success rate from the Insights aggregate", async () => {
    const cfg = baseCfg({
      scenario: {
        matchers: [
          {
            contains: 'route = "POST /ingest"',
            rows: [[
              { field: "succ", value: "180" },
              { field: "fail", value: "20" },
              { field: "total", value: "200" },
            ]],
          },
          {
            contains: 'route = "POST /auth/register"',
            rows: [[
              { field: "succ", value: "10" },
              { field: "fail", value: "0" },
              { field: "total", value: "10" },
            ]],
          },
        ],
      },
    });
    const res = await handleAdminRoute({
      cfg, range: "7d", adminUsername: "potomak",
    });
    assert.match(res.body, /Publish success[\s\S]*?>90\.0%</);
    assert.match(res.body, /180 of 200/);
    assert.match(res.body, /Register success[\s\S]*?>100\.0%</);
    assert.match(res.body, /10 of 10/);
  });

  test("renders the failures table when Insights returns rows", async () => {
    const cfg = baseCfg({
      scenario: {
        matchers: [
          {
            contains: "status >= 400",
            rows: [
              [
                { field: "@timestamp", value: "2026-06-08 17:55:00.000" },
                { field: "route", value: "POST /ingest" },
                { field: "status", value: "400" },
                { field: "error_code", value: "invalid_gif" },
                { field: "error_message", value: "invalid gif: bad sig" },
                { field: "username", value: "alice" },
              ],
              [
                { field: "@timestamp", value: "2026-06-08 17:54:00.000" },
                { field: "route", value: "POST /auth/register" },
                { field: "status", value: "409" },
                { field: "error_code", value: "email_taken" },
                { field: "error_message", value: "email already registered" },
                { field: "username", value: "" },
              ],
            ],
          },
        ],
      },
    });
    const res = await handleAdminRoute({
      cfg, range: "30d", adminUsername: "potomak",
    });
    assert.match(res.body, /Recent failures/);
    assert.match(res.body, /invalid_gif/);
    assert.match(res.body, /email_taken/);
    assert.match(res.body, /alice/);
    // 5xx colouring class is on no <td> (the string still appears in the
    // inline <style>, which is fine — just no row uses it).
    assert.equal(/<td class="adm-status-5xx"/.test(res.body), false);
    assert.match(res.body, /<td class="adm-status-4xx">400</);
  });

  test("shows the healthy empty-state when no failures land", async () => {
    const cfg = baseCfg({
      scenario: { matchers: [{ contains: "status >= 400", rows: [] }] },
    });
    const res = await handleAdminRoute({
      cfg, range: "24h", adminUsername: "potomak",
    });
    assert.match(res.body, /site is healthy/);
  });

  test("range param widens the Insights time window", async () => {
    const cfg = baseCfg({});
    await handleAdminRoute({
      cfg, range: "24h", adminUsername: "potomak",
    });
    const startedSnapshot24h = cfg.cwSpy.startedQueries.length;

    const cfg2 = baseCfg({});
    await handleAdminRoute({
      cfg: cfg2, range: "30d", adminUsername: "potomak",
    });
    assert.equal(
      cfg2.cwSpy.startedQueries.length,
      startedSnapshot24h,
      "both ranges should issue the same number of queries (3)",
    );
    assert.equal(startedSnapshot24h, 3);
  });

  test("computes remix rate + publishes-per-day from the drawings scan", async () => {
    const store = new MemoryDrawingStore();
    const newest = FIXED_NOW.getTime();
    // 4 drawings over a 3-day span; one is a fork → 25% remix rate,
    // 4 / 3 days ≈ 1.3 publishes/day.
    await store.put(drawingRow({ drawing_id: "1".repeat(64), created_at_ms: newest - 3 * DAY_MS }));
    await store.put(drawingRow({ drawing_id: "2".repeat(64), created_at_ms: newest - 2 * DAY_MS }));
    await store.put(drawingRow({
      drawing_id: "3".repeat(64),
      created_at_ms: newest - 1 * DAY_MS,
      parent_id: "1".repeat(64),
    }));
    await store.put(drawingRow({ drawing_id: "4".repeat(64), created_at_ms: newest }));

    const cfg = baseCfg({ drawingStore: store });
    const res = await handleAdminRoute({
      cfg, range: "24h", adminUsername: "potomak",
    });
    assert.match(res.body, /Product KPIs \(last 4 drawings\)/);
    assert.match(res.body, /Remix rate[\s\S]*?>25\.0%</);
    assert.match(res.body, /1 of 4 are remixes/);
    assert.match(res.body, /Publishes \/ day[\s\S]*?>1\.3</);
  });

  test("KPI cards show em-dash when the drawings scan rejects", async () => {
    const failing = new MemoryDrawingStore();
    failing.queryGallery = async () => {
      throw new Error("transient");
    };
    const cfg = baseCfg({ drawingStore: failing });
    const res = await handleAdminRoute({
      cfg, range: "24h", adminUsername: "potomak",
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /Product KPIs/);
    assert.match(res.body, /Remix rate[\s\S]*?>—</);
    assert.match(res.body, /drawings query failed/);
  });

  test("KPI publishes-per-day needs at least two drawings", async () => {
    const store = new MemoryDrawingStore();
    await store.put(drawingRow({ parent_id: "b".repeat(64) }));
    const cfg = baseCfg({ drawingStore: store });
    const res = await handleAdminRoute({
      cfg, range: "24h", adminUsername: "potomak",
    });
    assert.match(res.body, /Product KPIs \(last 1 drawings\)/);
    assert.match(res.body, /Remix rate[\s\S]*?>100\.0%</);
    assert.match(res.body, /Publishes \/ day[\s\S]*?>—</);
    assert.match(res.body, /needs ≥ 2 drawings/);
  });

});

describe("renderAdminShell", () => {
  test("ships the chrome, loading skeleton, range nav, and inline boot script", () => {
    const html = renderAdminShell({
      range: "7d",
      repo_url: "https://github.com/potomak/drawbang",
    });
    assert.match(html, /<title>Admin — Draw!<\/title>/);
    assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
    assert.match(html, /data-admin-page/);
    assert.match(html, /data-admin-inner/);
    assert.match(html, /data-admin-loading/);
    // Selected range tab is marked current.
    assert.match(html, /href="\/admin\?range=7d"[^>]*aria-current="page"/);
    // Boot script fetches /admin/data with the Bearer token.
    assert.match(html, /localStorage\.getItem\("drawbang:jwt"\)/);
    assert.match(html, /"\/admin\/data"/);
    assert.match(html, /Authorization: "Bearer " \+ jwt/);
    // 401 redirects to /login with the original URL as next=.
    assert.match(html, /location\.replace\("\/login\?next="/);
  });
});
