import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from "aws-lambda";
import { handleIngest, type AuthedUser, type IngestRequest } from "./handler.js";
import { JwtError, verifyJwt } from "./jwt.js";
import { handleUserStats } from "./user-stats-handler.js";
import {
  handleForgotPassword,
  handleLogin,
  handleRegister,
  handleResetPassword,
  handleSetAvatar,
  type AuthHandlerConfig,
  type SetAvatarAuth,
} from "./auth-handler.js";
import { S3Storage } from "./s3-storage.js";
import { DynamoUserStatsStore } from "./user-stats-store.js";
import { DynamoUserStore } from "./user-store.js";
import { DynamoDrawingStore } from "./drawing-store.js";
import { DynamoLikesStore } from "./likes-store.js";
import {
  handleLike,
  handleMyLikes,
  handleUnlike,
  type LikesHandlerConfig,
} from "./likes-handler.js";
import { CloudFrontInvalidator } from "./cache-invalidation.js";
import { SesEmailSender } from "./email.js";
import {
  renderDrawingPageHandler,
  renderFeedHandler,
  renderFeedItemsHandler,
  renderHomePageHandler,
  renderProductsPageHandler,
  renderProfileItemsHandler,
  renderProfilePageHandler,
  type RenderHandlersConfig,
  type RenderResponse,
} from "./render-handlers.js";
import { ProductCountersStore } from "../merch/product-counters.js";
import type { MerchCatalog } from "../merch/lambda.js";
import merchCatalogJson from "../config/merch.json" with { type: "json" };

const bucket = required("DRAWBANG_BUCKET");
const publicBaseUrl = required("PUBLIC_BASE_URL");
const repoUrl = required("REPO_URL");
const userStatsTable = required("DRAWBANG_USER_STATS_TABLE");
const usersTable = required("DRAWBANG_USERS_TABLE");
const usernamesTable = required("DRAWBANG_USERNAMES_TABLE");
const drawingsTable = required("DRAWBANG_DRAWINGS_TABLE");
const likesTable = required("DRAWBANG_LIKES_TABLE");
// Optional: when unset (e.g. local dev), publish skips CF invalidation —
// cached pages refresh at s-maxage instead.
const cfDistributionId = process.env.CF_DISTRIBUTION_ID ?? "";
// /products feeds off this table (drawing_id × product_id → count) which
// the merch dispatch increments on each paid-→-submitted transition.
const productCountersTable = process.env.DRAWBANG_PRODUCT_COUNTERS_TABLE ?? "drawbang-product-counters";
const jwtSecret = required("JWT_SECRET");
// Optional: until SES is wired, password-reset emails fail at send time
// (caught + logged in the handler) but the rest of ingest stays up.
const sesFromAddress = process.env.SES_FROM_ADDRESS ?? "";

// Reused across invocations in a warm Lambda container. Cold start pays the
// SDK init cost once; subsequent requests reuse the connection pool.
const storage = new S3Storage({ bucket });
const userStatsStore = new DynamoUserStatsStore({
  tableName: userStatsTable,
});
const userStore = new DynamoUserStore({ usersTable, usernamesTable });
const drawingStore = new DynamoDrawingStore({ tableName: drawingsTable });
const likesStore = new DynamoLikesStore({
  likesTable,
  drawingsTable,
});
const likesConfig: LikesHandlerConfig = { likesStore };
const cacheInvalidator = cfDistributionId
  ? new CloudFrontInvalidator({ distributionId: cfDistributionId })
  : undefined;
const productCountersStore = new ProductCountersStore({ tableName: productCountersTable });
const merchCatalog = merchCatalogJson as MerchCatalog;
const renderConfig: RenderHandlersConfig = {
  drawingStore,
  publicBaseUrl,
  repoUrl,
  productCountersSource: { listAll: () => productCountersStore.listAll() },
  merchCatalog,
  userStatsStore,
  userStore,
};
const authConfig: AuthHandlerConfig = {
  userStore,
  email: new SesEmailSender({ fromAddress: sesFromAddress }),
  jwtSecret,
  publicBaseUrl,
  drawingStore,
  cacheInvalidator,
};

export async function handler(
  event: APIGatewayProxyEventV2,
  _context: Context,
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath ?? event.requestContext.http.path ?? "";

  if (method === "POST" && path === "/ingest") {
    return handleIngestRoute(event);
  }
  // Dynamic HTML routes: feed home, drawing page, profile, RSS, products.
  // Each queries the drawings DDB store + renders the matching template.
  if (method === "GET" && path === "/") {
    return adaptRender(await renderHomePageHandler(renderConfig, queryParam(event, "cursor")));
  }
  if (method === "GET" && path === "/feed/items") {
    return adaptRender(await renderFeedItemsHandler(renderConfig, queryParam(event, "cursor")));
  }
  // /gallery still routes to the Lambda as a safety net behind the
  // CloudFront 301; emit a 301 here too in case a request bypasses the
  // edge (direct API Gateway hit during a deploy, e.g.).
  if (method === "GET" && (path === "/gallery" || path === "/gallery/items")) {
    return redirect301(path === "/gallery" ? "/" : "/feed/items", event);
  }
  if (method === "GET" && path === "/feed.rss") {
    return adaptRender(await renderFeedHandler(renderConfig));
  }
  if (method === "GET" && path === "/products") {
    return adaptRender(await renderProductsPageHandler(renderConfig, "1"));
  }
  {
    const m = path.match(/^\/products\/p\/(\d+)$/);
    if (method === "GET" && m) {
      return adaptRender(await renderProductsPageHandler(renderConfig, m[1]));
    }
  }
  {
    const m = path.match(/^\/d\/([0-9a-f]{64})$/);
    if (method === "GET" && m) {
      return adaptRender(await renderDrawingPageHandler(renderConfig, m[1]));
    }
  }
  {
    const m = path.match(/^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])$/);
    if (method === "GET" && m) {
      return adaptRender(await renderProfilePageHandler(renderConfig, m[1]));
    }
  }
  {
    const m = path.match(/^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])\/items$/);
    if (method === "GET" && m) {
      return adaptRender(
        await renderProfileItemsHandler(renderConfig, m[1], queryParam(event, "cursor")),
      );
    }
  }
  // /users/{user_id}/stats — per-account streak / total counters (#115/#116).
  if (method === "GET" && /^\/users\/[^\/]+\/stats$/.test(path)) {
    return handleUserStatsRoute(event, path);
  }
  // /drawings/{id}/like — toggle a like.
  {
    const m = path.match(/^\/drawings\/([0-9a-f]{64})\/like$/);
    if (m && (method === "POST" || method === "DELETE")) {
      return handleLikesToggleRoute(event, m[1], method);
    }
  }
  // /me/likes?ids=<csv> — return the subset the caller has liked.
  if (method === "GET" && path === "/me/likes") {
    return handleMyLikesRoute(event);
  }
  if (method === "POST" && path.startsWith("/auth/")) {
    return handleAuthRoute(event, path);
  }
  return text(405, "method not allowed");
}

function queryParam(event: APIGatewayProxyEventV2, name: string): string | null {
  return event.queryStringParameters?.[name] ?? null;
}

function adaptRender(r: RenderResponse): APIGatewayProxyResultV2 {
  return {
    statusCode: r.status,
    headers: {
      "Content-Type": r.contentType,
      "Cache-Control": r.cacheControl,
    },
    body: r.body,
  };
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
    case "/auth/avatar": {
      const auth = extractAuth(event);
      if (!auth) return json(401, { error: "authentication required" });
      const setAvatarAuth: SetAvatarAuth = {
        user_id: auth.user_id,
        username: auth.username,
      };
      result = await handleSetAvatar(body, setAvatarAuth, authConfig);
      break;
    }
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
    userStatsStore,
    drawingStore,
    cacheInvalidator,
  });
  return json(result.status, result.body);
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

async function handleLikesToggleRoute(
  event: APIGatewayProxyEventV2,
  drawing_id: string,
  method: "POST" | "DELETE",
): Promise<APIGatewayProxyResultV2> {
  const auth = extractAuth(event);
  if (!auth) return json(401, { error: "authentication required" });
  const result =
    method === "POST"
      ? await handleLike(drawing_id, auth, likesConfig)
      : await handleUnlike(drawing_id, auth, likesConfig);
  return jsonWithHeaders(result.status, result.body, result.headers);
}

async function handleMyLikesRoute(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const auth = extractAuth(event);
  if (!auth) return json(401, { error: "authentication required" });
  const result = await handleMyLikes(queryParam(event, "ids"), auth, likesConfig);
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

function redirect301(
  location: string,
  event: APIGatewayProxyEventV2,
): APIGatewayProxyResultV2 {
  // Preserve any cursor querystring so /gallery/items?cursor=… reaches
  // /feed/items?cursor=… intact.
  const qs = event.rawQueryString;
  const target = qs ? `${location}?${qs}` : location;
  return {
    statusCode: 301,
    headers: { Location: target, "Cache-Control": "public, max-age=3600" },
    body: "",
  };
}
