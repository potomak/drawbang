import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from "aws-lambda";
import { handleIngest, type AuthedUser, type IngestRequest } from "./handler.js";
import { JwtError, verifyJwt } from "./jwt.js";
import {
  authErrorCode,
  estimateBase64Bytes,
  ingestErrorCode,
  logOutcome,
} from "./log-outcome.js";
import { handleUserStats } from "./user-stats-handler.js";
import {
  handleForgotPassword,
  handleGetProfile,
  handleLogin,
  handleRegister,
  handleResetPassword,
  handleSetProfilePicture,
  handleUpdateProfile,
  type AuthHandlerConfig,
  type ProfileAuth,
  type SetProfilePictureAuth,
} from "./auth-handler.js";
import { S3Storage } from "./s3-storage.js";
import { DynamoUserStatsStore } from "./user-stats-store.js";
import { DynamoUserStore } from "./user-store.js";
import { DynamoDrawingStore } from "./drawing-store.js";
import { DynamoLikesStore } from "./likes-store.js";
import {
  handleLike,
  handleUnlike,
  type LikesHandlerConfig,
} from "./likes-handler.js";
import { DynamoBookmarksStore } from "./bookmarks-store.js";
import {
  handleBookmark,
  handleUnbookmark,
  type BookmarksHandlerConfig,
} from "./bookmarks-handler.js";
import { DynamoFollowsStore } from "./follows-store.js";
import {
  handleFollow,
  handleUnfollow,
  type FollowsHandlerConfig,
} from "./follows-handler.js";
import {
  handleHydrate,
  type HydrateHandlerConfig,
} from "./hydrate-handler.js";
import { CloudFrontInvalidator } from "./cache-invalidation.js";
import { SesEmailSender } from "./email.js";
import { DynamoSubscribersStore } from "./subscribers-store.js";
import {
  handleSubscribe,
  type SubscribeHandlerConfig,
} from "./subscribe-handler.js";
import {
  renderBookmarksPageHandler,
  renderDesignPageHandler,
  renderDrawingPageHandler,
  renderEmbedPageHandler,
  renderFeedHandler,
  renderFeedItemsHandler,
  renderFollowersItemsHandler,
  renderFollowersPageHandler,
  renderFollowingItemsHandler,
  renderFollowingPageHandler,
  renderFollowThumbsHandler,
  renderHomePageHandler,
  renderMyBookmarksFeedHandler,
  renderProductsPageHandler,
  renderProfileItemsHandler,
  renderProfilePageHandler,
  renderPromptItemsHandler,
  renderPromptPageHandler,
  renderPromptsArchiveHandler,
  renderStreakPageHandler,
  type RenderHandlersConfig,
  type RenderResponse,
} from "./render-handlers.js";
import { ProductCountersStore } from "../merch/product-counters.js";
import type { MerchCatalog } from "../merch/lambda.js";
import merchCatalogJson from "../config/merch.json" with { type: "json" };
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  handleAdminRoute,
  parseRange,
  type AdminHandlerConfig,
} from "./admin-handler.js";
import { renderAdminShell } from "../lib/templates/admin.js";

const bucket = required("DRAWBANG_BUCKET");
const publicBaseUrl = required("PUBLIC_BASE_URL");
const repoUrl = required("REPO_URL");
const userStatsTable = required("DRAWBANG_USER_STATS_TABLE");
const usersTable = required("DRAWBANG_USERS_TABLE");
const usernamesTable = required("DRAWBANG_USERNAMES_TABLE");
const drawingsTable = required("DRAWBANG_DRAWINGS_TABLE");
const likesTable = required("DRAWBANG_LIKES_TABLE");
const bookmarksTable = required("DRAWBANG_BOOKMARKS_TABLE");
const followsTable = required("DRAWBANG_FOLLOWS_TABLE");
const subscribersTable = required("DRAWBANG_SUBSCRIBERS_TABLE");
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
// Comma-separated usernames allowed to view /admin. Empty (the default)
// means nobody can — every /admin request returns 403. Update the value
// via the SAM parameter `AdminUsernames` (GitHub repository variable
// `ADMIN_USERNAMES`); the change takes effect on next deploy.
const adminUsernames = new Set(
  (process.env.ADMIN_USERNAMES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
// Log group queried by the /admin page. Defaults to the conventional
// `/aws/lambda/<function>` location; override via env when the Lambda
// is reused for testing against a different log stream.
const ingestLogGroup =
  process.env.INGEST_LOG_GROUP ?? "/aws/lambda/drawbang-ingest";

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
const bookmarksStore = new DynamoBookmarksStore({
  bookmarksTable,
  drawingStore,
});
const bookmarksConfig: BookmarksHandlerConfig = { bookmarksStore };
const followsStore = new DynamoFollowsStore({
  followsTable,
  usersTable,
});
const followsConfig: FollowsHandlerConfig = { followsStore, userStore };
const subscribersStore = new DynamoSubscribersStore({
  tableName: subscribersTable,
});
const subscribeConfig: SubscribeHandlerConfig = { subscribersStore };
const hydrateConfig: HydrateHandlerConfig = {
  likesStore,
  bookmarksStore,
  followsStore,
  userStore,
};
const cacheInvalidator = cfDistributionId
  ? new CloudFrontInvalidator({ distributionId: cfDistributionId })
  : undefined;
const productCountersStore = new ProductCountersStore({ tableName: productCountersTable });
const merchCatalog = merchCatalogJson as MerchCatalog;
// Lazily created — both clients are only used by /admin, so cold-start
// for every other route stays cheap. Lambda's container reuse keeps the
// connection pool warm once the first /admin hits.
let adminCfgCache: AdminHandlerConfig | null = null;
function adminCfg(): AdminHandlerConfig {
  if (adminCfgCache) return adminCfgCache;
  adminCfgCache = {
    ddbClient: new DynamoDBClient({}),
    cwLogsClient: new CloudWatchLogsClient({}),
    drawingStore,
    usersTable,
    drawingsTable,
    logGroup: ingestLogGroup,
  };
  return adminCfgCache;
}
const renderConfig: RenderHandlersConfig = {
  drawingStore,
  publicBaseUrl,
  repoUrl,
  productCountersSource: { listAll: () => productCountersStore.listAll() },
  merchCatalog,
  userStatsStore,
  userStore,
  bookmarksStore,
  followsStore,
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
  // Normalise HEAD → GET so uptime monitors, link checkers, and the
  // CDN-cache validators that issue HEAD requests don't 404. RFC says a
  // HEAD response MAY include a body but the client MUST ignore it, so
  // returning the GET body here is harmless — and CloudFront knows to
  // strip it before forwarding to the viewer.
  const rawMethod = event.requestContext.http.method;
  const method = rawMethod === "HEAD" ? "GET" : rawMethod;
  const path = event.rawPath ?? event.requestContext.http.path ?? "";
  // Route-outcome logging context. logOutcome() is invoked from inside
  // handleIngestRoute + handleAuthRoute (the two flows operators are most
  // likely to report on) so the JSON line carries domain fields beyond
  // status/duration. Other routes inherit only the API Gateway access
  // log entry for now.
  const t0 = Date.now();
  const requestId = event.requestContext.requestId;
  const ctx: RouteContext = { requestId, t0 };

  if (method === "POST" && path === "/ingest") {
    return handleIngestRoute(event, ctx);
  }
  // /admin — public shell. Carries no per-user data, so it ships
  // unauthenticated; an inline boot script reads the JWT from
  // localStorage and fetches /admin/data with a Bearer header. The
  // Bearer + allowlist gate lives on /admin/data below.
  if (method === "GET" && path === "/admin") {
    const range = parseRange(queryParam(event, "range"));
    return adaptRender({
      status: 200,
      contentType: "text/html; charset=utf-8",
      cacheControl: "private, no-store",
      body: renderAdminShell({ range, repo_url: repoUrl }),
    });
  }
  if (method === "GET" && path === "/admin/data") {
    return handleAdminDataRoute(event, ctx);
  }
  // Dynamic HTML routes: feed home, drawing page, profile, RSS, products.
  // Each queries the drawings DDB store + renders the matching template.
  if (method === "GET" && path === "/") {
    return adaptRender(await renderHomePageHandler(renderConfig, queryParam(event, "cursor"), queryParam(event, "sort")));
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
  if (method === "GET" && path === "/design") {
    return adaptRender(await renderDesignPageHandler(renderConfig));
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
  // /prompts — daily-prompt archive; /prompts/<slug> — submission grid;
  // /prompts/<slug>/items?cursor=… — infinite-scroll fragment. Slug
  // pattern mirrors PROMPT_SLUG_RE in config/prompts.ts.
  if (method === "GET" && path === "/prompts") {
    return adaptRender(await renderPromptsArchiveHandler(renderConfig));
  }
  {
    const m = path.match(/^\/prompts\/([a-z0-9-]{1,32})$/);
    if (method === "GET" && m) {
      return adaptRender(await renderPromptPageHandler(renderConfig, m[1]));
    }
  }
  {
    const m = path.match(/^\/prompts\/([a-z0-9-]{1,32})\/items$/);
    if (method === "GET" && m) {
      return adaptRender(
        await renderPromptItemsHandler(renderConfig, m[1], queryParam(event, "cursor")),
      );
    }
  }
  {
    const m = path.match(/^\/d\/([0-9a-f]{64})$/);
    if (method === "GET" && m) {
      return adaptRender(await renderDrawingPageHandler(renderConfig, m[1]));
    }
  }
  {
    const m = path.match(/^\/embed\/([0-9a-f]{64})$/);
    if (method === "GET" && m) {
      return adaptRender(await renderEmbedPageHandler(renderConfig, m[1]));
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
  // /u/<username>/bookmarks — the page shell. Per-user data lands via the
  // client-side fetch to /me/bookmarks/feed below; the shell ships no
  // auth-gated content so it's safe to render uncached for any caller.
  {
    const m = path.match(/^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])\/bookmarks$/);
    if (method === "GET" && m) {
      return adaptRender(await renderBookmarksPageHandler(renderConfig, m[1]));
    }
  }
  // /u/<username>/followers + /following — paginated lists.
  {
    const m = path.match(/^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])\/(followers|following)$/);
    if (method === "GET" && m) {
      const kind = m[2] as "followers" | "following";
      const handler = kind === "followers" ? renderFollowersPageHandler : renderFollowingPageHandler;
      return adaptRender(await handler(renderConfig, m[1], queryParam(event, "cursor")));
    }
  }
  // /u/<username>/{followers,following}/items?cursor=… — infinite scroll fragments.
  {
    const m = path.match(/^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])\/(followers|following)\/items$/);
    if (method === "GET" && m) {
      const kind = m[2] as "followers" | "following";
      const handler = kind === "followers" ? renderFollowersItemsHandler : renderFollowingItemsHandler;
      return adaptRender(await handler(renderConfig, m[1], queryParam(event, "cursor")));
    }
  }
  // /u/<username>/follow-thumbs?limit=N — JSON. Feeds the left-rail
  // follower/following thumb grids.
  {
    const m = path.match(/^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])\/follow-thumbs$/);
    if (method === "GET" && m) {
      return adaptRender(await renderFollowThumbsHandler(renderConfig, m[1], queryParam(event, "limit")));
    }
  }
  // /u/<username>/streak — month-stacked calendar of the user's daily
  // publishes. Public read, edge-cached via CC_PROFILE.
  {
    const m = path.match(/^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])\/streak$/);
    if (method === "GET" && m) {
      return adaptRender(await renderStreakPageHandler(renderConfig, m[1]));
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
  // /drawings/{id}/bookmark — toggle a bookmark.
  {
    const m = path.match(/^\/drawings\/([0-9a-f]{64})\/bookmark$/);
    if (m && (method === "POST" || method === "DELETE")) {
      return handleBookmarksToggleRoute(event, m[1], method);
    }
  }
  // /me/bookmarks/feed — HTML fragment of the caller's bookmarks, used by
  // the inline boot script on /u/<un>/bookmarks.
  if (method === "GET" && path === "/me/bookmarks/feed") {
    return handleMyBookmarksFeedRoute(event);
  }
  // /users/<username>/follow — toggle a follow edge.
  {
    const m = path.match(/^\/users\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])\/follow$/);
    if (m && (method === "POST" || method === "DELETE")) {
      return handleFollowToggleRoute(event, m[1], method);
    }
  }
  // /hydrate?drawings=<csv>&users=<csv> — single hydration channel. Public,
  // no-store. Optional Bearer JWT populates the viewer_* fields. Every
  // Lambda-rendered page hits this on load to overlay fresh values on the
  // edge-cached SSR markup (likes, bookmarks, follows, profile pictures).
  if (method === "GET" && path === "/hydrate") {
    const result = await handleHydrate(
      queryParam(event, "drawings"),
      queryParam(event, "users"),
      extractAuth(event),
      hydrateConfig,
    );
    return jsonWithHeaders(result.status, result.body, result.headers);
  }
  // GET /auth/profile — prefill for the edit-profile form on /account.
  // Requires a valid session; returns the caller's current bio/link.
  if (method === "GET" && path === "/auth/profile") {
    const auth = extractAuth(event);
    if (!auth) return json(401, { error: "authentication required" });
    const profileAuth: ProfileAuth = { user_id: auth.user_id, username: auth.username };
    const result = await handleGetProfile(profileAuth, authConfig);
    return jsonWithHeaders(result.status, result.body, result.headers);
  }
  // POST /subscribe — public email capture from the home-page hero.
  if (method === "POST" && path === "/subscribe") {
    const result = await handleSubscribe(rawBody(event), subscribeConfig);
    return json(result.status, result.body);
  }
  if (method === "POST" && path.startsWith("/auth/")) {
    return handleAuthRoute(event, path, ctx);
  }
  // Unknown path → 404, matching dev-server.ts. (A per-path 405 for
  // known-path-wrong-method isn't worth it: API Gateway registers
  // explicit path+method events, so those requests rarely reach us.)
  return text(404, "not found");
}

interface RouteContext {
  requestId: string;
  t0: number;
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
  ctx: RouteContext,
): Promise<APIGatewayProxyResultV2> {
  const route = `POST ${path}`;
  let body: Record<string, unknown>;
  try {
    body = parseJson(event) as Record<string, unknown>;
  } catch {
    logOutcome({
      requestId: ctx.requestId,
      route,
      status: 400,
      duration_ms: Date.now() - ctx.t0,
      error_code: "bad_json",
      error_message: "bad json body",
    });
    return json(400, { error: "bad json body" });
  }
  let result;
  let auth: AuthedUser | null = null;
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
    case "/auth/profile-picture": {
      auth = extractAuth(event);
      if (!auth) {
        logOutcome({
          requestId: ctx.requestId,
          route,
          status: 401,
          duration_ms: Date.now() - ctx.t0,
          error_code: "unauthorized",
        });
        return json(401, { error: "authentication required" });
      }
      const setPpAuth: SetProfilePictureAuth = {
        user_id: auth.user_id,
        username: auth.username,
      };
      result = await handleSetProfilePicture(body, setPpAuth, authConfig);
      break;
    }
    case "/auth/profile": {
      auth = extractAuth(event);
      if (!auth) {
        logOutcome({
          requestId: ctx.requestId,
          route,
          status: 401,
          duration_ms: Date.now() - ctx.t0,
          error_code: "unauthorized",
        });
        return json(401, { error: "authentication required" });
      }
      const profileAuth: ProfileAuth = {
        user_id: auth.user_id,
        username: auth.username,
      };
      result = await handleUpdateProfile(body, profileAuth, authConfig);
      break;
    }
    default:
      logOutcome({
        requestId: ctx.requestId,
        route,
        status: 404,
        duration_ms: Date.now() - ctx.t0,
      });
      return text(404, "not found");
  }
  // Pull identity off the success body for register/login, and off the
  // verified JWT for profile-picture/profile. Failure bodies don't carry
  // identity, so it stays undefined.
  const success =
    result.status >= 200 && result.status < 300
      ? (result.body as { user_id?: string; username?: string })
      : null;
  const errorMessage =
    result.status >= 400
      ? (result.body as { error?: string }).error
      : undefined;
  logOutcome({
    requestId: ctx.requestId,
    route,
    status: result.status,
    duration_ms: Date.now() - ctx.t0,
    user_id: auth?.user_id ?? success?.user_id,
    username: auth?.username ?? success?.username,
    error_code: errorMessage ? authErrorCode(path, errorMessage) : undefined,
    error_message: errorMessage,
  });
  return jsonWithHeaders(result.status, result.body, result.headers);
}

async function handleIngestRoute(
  event: APIGatewayProxyEventV2,
  ctx: RouteContext,
): Promise<APIGatewayProxyResultV2> {
  const route = "POST /ingest";
  const auth = extractAuth(event);
  if (!auth) {
    logOutcome({
      requestId: ctx.requestId,
      route,
      status: 401,
      duration_ms: Date.now() - ctx.t0,
      error_code: "unauthorized",
    });
    return json(401, { error: "authentication required" });
  }
  let body: IngestRequest;
  try {
    // TODO (#type-safety): `parseJson(event) as IngestRequest` trusts the
    // shape of any well-formed JSON. Validate the keys (gif_b64, palette,
    // etc.) before passing to handleIngest. Same gap on the register /
    // login / set-profile-picture routes.
    body = parseJson(event) as IngestRequest;
  } catch {
    logOutcome({
      requestId: ctx.requestId,
      route,
      status: 400,
      duration_ms: Date.now() - ctx.t0,
      user_id: auth.user_id,
      username: auth.username,
      error_code: "bad_json",
      error_message: "bad json body",
    });
    return json(400, { error: "bad json body" });
  }
  const gifSize = typeof body.gif === "string" ? estimateBase64Bytes(body.gif) : undefined;
  const result = await handleIngest(body, {
    storage,
    publicBaseUrl,
    auth,
    repoUrl,
    userStatsStore,
    drawingStore,
    cacheInvalidator,
  });
  const success = result.status === 200 || result.status === 202;
  const errorMessage =
    !success ? (result.body as { error?: string }).error : undefined;
  logOutcome({
    requestId: ctx.requestId,
    route,
    status: result.status,
    duration_ms: Date.now() - ctx.t0,
    user_id: auth.user_id,
    username: auth.username,
    drawing_id: success
      ? (result.body as { id: string }).id
      : undefined,
    parent_id: body.parent ?? null,
    gif_size_bytes: gifSize,
    error_code: errorMessage ? ingestErrorCode(errorMessage) : undefined,
    error_message: errorMessage,
  });
  return json(result.status, result.body);
}

// GET /admin/data — JWT-gated HTML fragment used by the /admin shell
// to populate its data-bound area. 401 on missing/invalid token, 403
// when the verified username isn't on the allowlist, 200 with the
// inner HTML otherwise. The handler emits its own logOutcome so
// admin views show up in the outcome stream too.
async function handleAdminDataRoute(
  event: APIGatewayProxyEventV2,
  ctx: RouteContext,
): Promise<APIGatewayProxyResultV2> {
  const route = "GET /admin/data";
  const auth = extractAuth(event);
  if (!auth) {
    logOutcome({
      requestId: ctx.requestId, route, status: 401,
      duration_ms: Date.now() - ctx.t0,
      error_code: "unauthorized",
    });
    return json(401, { error: "authentication required" });
  }
  if (!adminUsernames.has(auth.username)) {
    logOutcome({
      requestId: ctx.requestId, route, status: 403,
      duration_ms: Date.now() - ctx.t0,
      user_id: auth.user_id, username: auth.username,
      error_code: "forbidden",
    });
    return json(403, { error: "not authorised" });
  }
  const range = parseRange(queryParam(event, "range"));
  const rendered = await handleAdminRoute({
    cfg: adminCfg(),
    range,
    adminUsername: auth.username,
  });
  logOutcome({
    requestId: ctx.requestId, route, status: rendered.status,
    duration_ms: Date.now() - ctx.t0,
    user_id: auth.user_id, username: auth.username,
  });
  return adaptRender(rendered);
}

// Verify the session JWT from the Authorization header. Returns the
// authenticated account, or null when the header is missing/invalid/expired.
// TODO (#dev-server-drift): this and the route table above are hand-mirrored
// in dev-server.ts — see docs/architecture-review-2026-06.md.
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

async function handleBookmarksToggleRoute(
  event: APIGatewayProxyEventV2,
  drawing_id: string,
  method: "POST" | "DELETE",
): Promise<APIGatewayProxyResultV2> {
  const auth = extractAuth(event);
  if (!auth) return json(401, { error: "authentication required" });
  const result =
    method === "POST"
      ? await handleBookmark(drawing_id, auth, bookmarksConfig)
      : await handleUnbookmark(drawing_id, auth, bookmarksConfig);
  return jsonWithHeaders(result.status, result.body, result.headers);
}

async function handleMyBookmarksFeedRoute(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const auth = extractAuth(event);
  if (!auth) return json(401, { error: "authentication required" });
  return adaptRender(await renderMyBookmarksFeedHandler(renderConfig, auth));
}

async function handleFollowToggleRoute(
  event: APIGatewayProxyEventV2,
  target_username: string,
  method: "POST" | "DELETE",
): Promise<APIGatewayProxyResultV2> {
  const auth = extractAuth(event);
  if (!auth) return json(401, { error: "authentication required" });
  const result =
    method === "POST"
      ? await handleFollow(target_username, auth, followsConfig)
      : await handleUnfollow(target_username, auth, followsConfig);
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

function rawBody(event: APIGatewayProxyEventV2): string {
  return event.isBase64Encoded && event.body
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body ?? "";
}

function parseJson(event: APIGatewayProxyEventV2): unknown {
  return JSON.parse(rawBody(event));
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
