import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from "aws-lambda";
import { handleIngest, type IngestRequest } from "./handler.js";
import {
  handleCanvasClaim,
  handleCanvasState,
  type CanvasClaimRequest,
} from "./canvas-handler.js";
import { S3Storage } from "./s3-storage.js";
import { DynamoCanvasStore } from "./canvas-store.js";
import { DynamoUserStatsStore } from "./user-stats-store.js";

const bucket = required("DRAWBANG_BUCKET");
const publicBaseUrl = required("PUBLIC_BASE_URL");
const repoUrl = required("REPO_URL");
const canvasTilesTable = required("DRAWBANG_CANVAS_TILES_TABLE");
const canvasCooldownsTable = required("DRAWBANG_CANVAS_COOLDOWNS_TABLE");
const userStatsTable = required("DRAWBANG_USER_STATS_TABLE");

// Reused across invocations in a warm Lambda container. Cold start pays the
// SDK init cost once; subsequent requests reuse the connection pool.
const storage = new S3Storage({ bucket });
const canvasStore = new DynamoCanvasStore({
  tilesTable: canvasTilesTable,
  cooldownsTable: canvasCooldownsTable,
});
const userStatsStore = new DynamoUserStatsStore({
  tableName: userStatsTable,
});

// Module-scope rolling baseline windows (publish + per-canvas claim). Both
// survive warm containers but not across containers — the handlers already
// treat these as best-effort.
const baselineHistory: string[] = [];
const canvasBaselineHistory = new Map<string, string[]>();

export async function handler(
  event: APIGatewayProxyEventV2,
  _context: Context,
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath ?? event.requestContext.http.path ?? "";

  if (method === "POST" && path === "/ingest") {
    return handleIngestRoute(event);
  }
  if (method === "POST" && path === "/canvas/claim") {
    return handleClaimRoute(event);
  }
  // /canvas/{id}/state — match both raw and templated paths.
  if (method === "GET" && /^\/canvas\/[^\/]+\/state$/.test(path)) {
    return handleStateRoute(event, path);
  }
  return text(405, "method not allowed");
}

async function handleIngestRoute(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  let body: IngestRequest;
  try {
    body = parseJson(event) as IngestRequest;
  } catch {
    return json(400, { error: "bad json body" });
  }
  const result = await handleIngest(body, {
    storage,
    publicBaseUrl,
    repoUrl,
    baselineHistory,
    canvasStore,
    userStatsStore,
  });
  return json(result.status, result.body);
}

async function handleClaimRoute(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  let body: CanvasClaimRequest;
  try {
    body = parseJson(event) as CanvasClaimRequest;
  } catch {
    return json(400, { error: "bad json body" });
  }
  const result = await handleCanvasClaim(body, {
    storage,
    canvasStore,
    publicBaseUrl,
    baselineHistory: canvasBaselineHistory,
  });
  return jsonWithHeaders(result.status, result.body, result.headers);
}

async function handleStateRoute(
  event: APIGatewayProxyEventV2,
  path: string,
): Promise<APIGatewayProxyResultV2> {
  // Prefer the path parameter when API Gateway populates it; fall back to a
  // manual split for safety against template mismatch.
  const fromParam = event.pathParameters?.id;
  const fromPath = path.match(/^\/canvas\/([^\/]+)\/state$/)?.[1];
  const canvasId = fromParam ?? fromPath ?? "";
  const result = await handleCanvasState(canvasId, {
    storage,
    canvasStore,
    publicBaseUrl,
  });
  return jsonWithHeaders(result.status, result.body, result.headers);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

function parseJson(event: APIGatewayProxyEventV2): unknown {
  const raw =
    event.isBase64Encoded && event.body
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body ?? "";
  return JSON.parse(raw);
}

function json(status: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function jsonWithHeaders(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
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
