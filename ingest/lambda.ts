import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from "aws-lambda";
import { handleIngest, type AuthedUser, type IngestRequest } from "./handler.js";
import {
  handleCanvasPublish,
  type CanvasPublishRequest,
} from "./canvas-publish-handler.js";
import { JwtError, verifyJwt } from "./jwt.js";
import {
  handleMuralClaim,
  handleMuralState,
  type MuralClaimRequest,
} from "./mural-handler.js";
import { handleUserStats } from "./user-stats-handler.js";
import {
  handleForgotPassword,
  handleLogin,
  handleRegister,
  handleResetPassword,
  type AuthHandlerConfig,
} from "./auth-handler.js";
import { S3Storage } from "./s3-storage.js";
import { DynamoMuralStore } from "./mural-store.js";
import { DynamoUserStatsStore } from "./user-stats-store.js";
import { DynamoUserStore } from "./user-store.js";
import { SesEmailSender } from "./email.js";

const bucket = required("DRAWBANG_BUCKET");
const publicBaseUrl = required("PUBLIC_BASE_URL");
const repoUrl = required("REPO_URL");
const muralTilesTable = required("DRAWBANG_MURAL_TILES_TABLE");
const muralCooldownsTable = required("DRAWBANG_MURAL_COOLDOWNS_TABLE");
const userStatsTable = required("DRAWBANG_USER_STATS_TABLE");
const usersTable = required("DRAWBANG_USERS_TABLE");
const usernamesTable = required("DRAWBANG_USERNAMES_TABLE");
const jwtSecret = required("JWT_SECRET");
// Optional: until SES is wired, password-reset emails fail at send time
// (caught + logged in the handler) but the rest of ingest stays up.
const sesFromAddress = process.env.SES_FROM_ADDRESS ?? "";

// Reused across invocations in a warm Lambda container. Cold start pays the
// SDK init cost once; subsequent requests reuse the connection pool.
const storage = new S3Storage({ bucket });
const muralStore = new DynamoMuralStore({
  tilesTable: muralTilesTable,
  cooldownsTable: muralCooldownsTable,
});
const userStatsStore = new DynamoUserStatsStore({
  tableName: userStatsTable,
});
const userStore = new DynamoUserStore({ usersTable, usernamesTable });
const authConfig: AuthHandlerConfig = {
  userStore,
  email: new SesEmailSender({ fromAddress: sesFromAddress }),
  jwtSecret,
  publicBaseUrl,
};

// Module-scope rolling baseline windows (publish + per-mural claim). Both
// survive warm containers but not across containers — the handlers already
// treat these as best-effort.
const baselineHistory: string[] = [];
const muralBaselineHistory = new Map<string, string[]>();

export async function handler(
  event: APIGatewayProxyEventV2,
  _context: Context,
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath ?? event.requestContext.http.path ?? "";

  if (method === "POST" && path === "/ingest") {
    return handleIngestRoute(event);
  }
  if (method === "POST" && path === "/canvas") {
    return handleCanvasPublishRoute(event);
  }
  if (method === "POST" && path === "/mural/claim") {
    return handleClaimRoute(event);
  }
  // /mural/{id}/state — match both raw and templated paths.
  if (method === "GET" && /^\/mural\/[^\/]+\/state$/.test(path)) {
    return handleStateRoute(event, path);
  }
  // /users/{user_id}/stats — per-account streak / total counters (#115/#116).
  if (method === "GET" && /^\/users\/[^\/]+\/stats$/.test(path)) {
    return handleUserStatsRoute(event, path);
  }
  if (method === "POST" && path.startsWith("/auth/")) {
    return handleAuthRoute(event, path);
  }
  return text(405, "method not allowed");
}

async function handleAuthRoute(
  event: APIGatewayProxyEventV2,
  path: string,
): Promise<APIGatewayProxyResultV2> {
  let body: Record<string, unknown>;
  try {
    body = parseJson(event) as Record<string, unknown>;
  } catch {
    return json(400, { error: "bad json body" });
  }
  let result;
  switch (path) {
    case "/auth/register":
      result = await handleRegister(body, authConfig);
      break;
    case "/auth/login":
      result = await handleLogin(body, authConfig);
      break;
    case "/auth/password/forgot":
      result = await handleForgotPassword(body, authConfig);
      break;
    case "/auth/password/reset":
      result = await handleResetPassword(body, authConfig);
      break;
    default:
      return text(405, "method not allowed");
  }
  return jsonWithHeaders(result.status, result.body, result.headers);
}

async function handleIngestRoute(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const auth = extractAuth(event);
  if (!auth) return json(401, { error: "authentication required" });
  let body: IngestRequest;
  try {
    body = parseJson(event) as IngestRequest;
  } catch {
    return json(400, { error: "bad json body" });
  }
  const result = await handleIngest(body, {
    storage,
    publicBaseUrl,
    auth,
    repoUrl,
    baselineHistory,
    muralStore,
    userStatsStore,
  });
  return json(result.status, result.body);
}

async function handleCanvasPublishRoute(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const auth = extractAuth(event);
  if (!auth) return json(401, { error: "authentication required" });
  let body: CanvasPublishRequest;
  try {
    body = parseJson(event) as CanvasPublishRequest;
  } catch {
    return json(400, { error: "bad json body" });
  }
  const result = await handleCanvasPublish(body, {
    storage,
    publicBaseUrl,
    auth,
    repoUrl,
    baselineHistory,
  });
  return json(result.status, result.body);
}

async function handleClaimRoute(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const auth = extractAuth(event);
  if (!auth) return json(401, { error: "authentication required" });
  let body: MuralClaimRequest;
  try {
    body = parseJson(event) as MuralClaimRequest;
  } catch {
    return json(400, { error: "bad json body" });
  }
  const result = await handleMuralClaim(body, {
    storage,
    muralStore,
    publicBaseUrl,
    auth,
    baselineHistory: muralBaselineHistory,
  });
  return jsonWithHeaders(result.status, result.body, result.headers);
}

// Verify the session JWT from the Authorization header. Returns the
// authenticated account, or null when the header is missing/invalid/expired.
function extractAuth(event: APIGatewayProxyEventV2): AuthedUser | null {
  const header =
    event.headers?.authorization ?? event.headers?.Authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  try {
    const claims = verifyJwt<{ sub?: string; un?: string }>(m[1], jwtSecret);
    if (typeof claims.sub !== "string" || typeof claims.un !== "string") {
      return null;
    }
    return { user_id: claims.sub, username: claims.un };
  } catch (e) {
    if (e instanceof JwtError) return null;
    throw e;
  }
}

async function handleStateRoute(
  event: APIGatewayProxyEventV2,
  path: string,
): Promise<APIGatewayProxyResultV2> {
  // Prefer the path parameter when API Gateway populates it; fall back to a
  // manual split for safety against template mismatch.
  const fromParam = event.pathParameters?.id;
  const fromPath = path.match(/^\/mural\/([^\/]+)\/state$/)?.[1];
  const muralId = fromParam ?? fromPath ?? "";
  const result = await handleMuralState(muralId, {
    storage,
    muralStore,
    publicBaseUrl,
  });
  return jsonWithHeaders(result.status, result.body, result.headers);
}

async function handleUserStatsRoute(
  event: APIGatewayProxyEventV2,
  path: string,
): Promise<APIGatewayProxyResultV2> {
  const fromParam = event.pathParameters?.user_id;
  const fromPath = path.match(/^\/users\/([^\/]+)\/stats$/)?.[1];
  const userId = fromParam ?? fromPath ?? "";
  const result = await handleUserStats(userId, { userStatsStore });
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
