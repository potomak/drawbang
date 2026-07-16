import {
  handleIngest,
  type AuthedUser,
  type HandlerConfig,
  type IngestRequest,
} from "./handler.js";
import { JwtError, verifyJwt } from "./jwt.js";
import {
  authErrorCode,
  estimateBase64Bytes,
  ingestErrorCode,
  logOutcome,
} from "./log-outcome.js";
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
import { handleUserStats } from "./user-stats-handler.js";
import type { UserStatsStore } from "./user-stats-store.js";
import { handleLike, handleUnlike, type LikesHandlerConfig } from "./likes-handler.js";
import {
  handleBookmark,
  handleUnbookmark,
  type BookmarksHandlerConfig,
} from "./bookmarks-handler.js";
import { handleFollow, handleUnfollow, type FollowsHandlerConfig } from "./follows-handler.js";
import { handleHydrate, type HydrateHandlerConfig } from "./hydrate-handler.js";
import { handleSubscribe, type SubscribeHandlerConfig } from "./subscribe-handler.js";
import { parseRange } from "./admin-handler.js";
import { renderAdminShell, type AdminRange } from "../lib/templates/admin.js";
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

// Single source of truth for the ingest service's route table
// (#dev-server-drift). lambda.ts and dev-server.ts used to hand-mirror
// every regex, auth gate, and dispatch — a route added to one worked in
// prod and 404ed in dev (or vice versa). Now both entry points build the
// same table via createRoutes() and keep only their event-adaptation
// layers: lambda converts APIGatewayProxyEventV2 ↔ RouteRequest/RouteResult,
// dev-server converts node:http req/res.

// The transport-agnostic request each adapter constructs. `auth()` runs
// (and should memoize) the Bearer-JWT verification; `body()` yields the
// raw request body (lambda decodes base64, dev streams the socket).
export interface RouteRequest {
  method: string; // HEAD→GET normalization is the adapter's job
  path: string;
  query(name: string): string | null;
  body(): Promise<string>;
  auth(): AuthedUser | null;
  requestId: string;
  t0: number;
}

// The transport-agnostic response each adapter serializes.
export type RouteResult =
  | { kind: "render"; response: RenderResponse }
  | { kind: "json"; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: "text"; status: number; body: string }
  // Adapter appends the original query string (so /gallery/items?cursor=…
  // reaches /feed/items?cursor=… intact) and the edge Cache-Control.
  | { kind: "redirect301"; location: string };

export interface Route {
  methods: readonly string[];
  pattern: RegExp;
  // "required": dispatch answers 401 before the handler runs. "optional":
  // the handler receives the auth result, null when absent (/hydrate).
  // "none": public — or the handler owns a finer-grained gate (POST
  // /auth/* checks per-subroute, /admin/data adds the allowlist 403).
  auth: "required" | "optional" | "none";
  // When set, the dispatch-level 401 also emits a logOutcome line under
  // this route name — preserves the ingest/admin outcome streams.
  logName?: string;
  handler(req: RouteRequest, params: string[], auth: AuthedUser | null): Promise<RouteResult>;
}

// Everything the route table needs, injected per entry point: the Lambda
// wires Dynamo/S3/SES-backed configs, the dev server wires Memory*/Fs
// ones. Behavioural differences between the two servers live here as
// data (admin allowlist policy, optional stats store, deferShareMp4),
// not as forked route code.
export interface RouteDeps {
  renderConfig: RenderHandlersConfig;
  likesConfig: LikesHandlerConfig;
  bookmarksConfig: BookmarksHandlerConfig;
  followsConfig: FollowsHandlerConfig;
  hydrateConfig: HydrateHandlerConfig;
  subscribeConfig: SubscribeHandlerConfig;
  authConfig: AuthHandlerConfig;
  // Base publish config; the route injects the verified `auth` per call.
  ingestConfig: Omit<HandlerConfig, "auth">;
  // Absent in dev (no stats store wired) — the route isn't registered,
  // matching the dev server's historical 404 for /users/{id}/stats.
  userStatsStore?: UserStatsStore;
  admin: {
    // Allowlist policy differs on purpose: prod's empty list locks everyone
    // out, dev's empty list lets any signed-in user through.
    isAllowed(username: string): boolean;
    renderData(args: { range: AdminRange; adminUsername: string }): Promise<RenderResponse>;
  };
  repoUrl: string;
}

const USERNAME = "[a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_]";
const HEX64 = "[0-9a-f]{64}";

export function createRoutes(deps: RouteDeps): Route[] {
  const render = (response: RenderResponse): RouteResult => ({ kind: "render", response });
  const json = (
    status: number,
    body: unknown,
    headers?: Record<string, string>,
  ): RouteResult => ({ kind: "json", status, body, headers });

  const routes: Route[] = [
    {
      methods: ["POST"],
      pattern: /^\/ingest$/,
      auth: "required",
      logName: "POST /ingest",
      handler: (req, _params, auth) => ingestRoute(req, auth!, deps),
    },
    // /admin — public shell. Carries no per-user data, so it ships
    // unauthenticated; an inline boot script reads the JWT from
    // localStorage and fetches /admin/data with a Bearer header. The
    // Bearer + allowlist gate lives on /admin/data below.
    {
      methods: ["GET"],
      pattern: /^\/admin$/,
      auth: "none",
      handler: async (req) =>
        render({
          status: 200,
          contentType: "text/html; charset=utf-8",
          cacheControl: "private, no-store",
          body: renderAdminShell({
            range: parseRange(req.query("range")),
            repo_url: deps.repoUrl,
          }),
        }),
    },
    // 401 on missing/invalid token, 403 when the verified username isn't
    // on the allowlist, 200 with the inner HTML otherwise. Emits its own
    // logOutcome so admin views show up in the outcome stream too.
    {
      methods: ["GET"],
      pattern: /^\/admin\/data$/,
      auth: "required",
      logName: "GET /admin/data",
      handler: async (req, _params, auth) => {
        const route = "GET /admin/data";
        if (!deps.admin.isAllowed(auth!.username)) {
          logOutcome({
            requestId: req.requestId, route, status: 403,
            duration_ms: Date.now() - req.t0,
            user_id: auth!.user_id, username: auth!.username,
            error_code: "forbidden",
          });
          return json(403, { error: "not authorised" });
        }
        const rendered = await deps.admin.renderData({
          range: parseRange(req.query("range")),
          adminUsername: auth!.username,
        });
        logOutcome({
          requestId: req.requestId, route, status: rendered.status,
          duration_ms: Date.now() - req.t0,
          user_id: auth!.user_id, username: auth!.username,
        });
        return render(rendered);
      },
    },
    // Dynamic HTML routes: feed home, drawing page, profile, RSS, products.
    // Each queries the drawings store + renders the matching template.
    {
      methods: ["GET"],
      pattern: /^\/$/,
      auth: "none",
      handler: async (req) =>
        render(await renderHomePageHandler(deps.renderConfig, req.query("cursor"), req.query("sort"))),
    },
    {
      methods: ["GET"],
      pattern: /^\/feed\/items$/,
      auth: "none",
      handler: async (req) =>
        render(await renderFeedItemsHandler(deps.renderConfig, req.query("cursor"))),
    },
    // /gallery still resolves as a safety net behind the CloudFront 301;
    // emit a 301 here too in case a request bypasses the edge (direct API
    // Gateway hit during a deploy, e.g.).
    {
      methods: ["GET"],
      pattern: /^\/gallery(\/items)?$/,
      auth: "none",
      handler: async (_req, params) => ({
        kind: "redirect301",
        location: params[0] === "/items" ? "/feed/items" : "/",
      }),
    },
    {
      methods: ["GET"],
      pattern: /^\/feed\.rss$/,
      auth: "none",
      handler: async () => render(await renderFeedHandler(deps.renderConfig)),
    },
    {
      methods: ["GET"],
      pattern: /^\/design$/,
      auth: "none",
      handler: async () => render(await renderDesignPageHandler(deps.renderConfig)),
    },
    {
      methods: ["GET"],
      pattern: /^\/products$/,
      auth: "none",
      handler: async () => render(await renderProductsPageHandler(deps.renderConfig, "1")),
    },
    {
      methods: ["GET"],
      pattern: /^\/products\/p\/(\d+)$/,
      auth: "none",
      handler: async (_req, [page]) =>
        render(await renderProductsPageHandler(deps.renderConfig, page)),
    },
    // /prompts — daily-prompt archive; /prompts/<slug> — submission grid;
    // /prompts/<slug>/items?cursor=… — infinite-scroll fragment. Slug
    // pattern mirrors PROMPT_SLUG_RE in config/prompts.ts.
    {
      methods: ["GET"],
      pattern: /^\/prompts$/,
      auth: "none",
      handler: async () => render(await renderPromptsArchiveHandler(deps.renderConfig)),
    },
    {
      methods: ["GET"],
      pattern: /^\/prompts\/([a-z0-9-]{1,32})$/,
      auth: "none",
      handler: async (_req, [slug]) =>
        render(await renderPromptPageHandler(deps.renderConfig, slug)),
    },
    {
      methods: ["GET"],
      pattern: /^\/prompts\/([a-z0-9-]{1,32})\/items$/,
      auth: "none",
      handler: async (req, [slug]) =>
        render(await renderPromptItemsHandler(deps.renderConfig, slug, req.query("cursor"))),
    },
    {
      methods: ["GET"],
      pattern: new RegExp(`^\\/d\\/(${HEX64})$`),
      auth: "none",
      handler: async (_req, [id]) =>
        render(await renderDrawingPageHandler(deps.renderConfig, id)),
    },
    {
      methods: ["GET"],
      pattern: new RegExp(`^\\/embed\\/(${HEX64})$`),
      auth: "none",
      handler: async (_req, [id]) =>
        render(await renderEmbedPageHandler(deps.renderConfig, id)),
    },
    {
      methods: ["GET"],
      pattern: new RegExp(`^\\/u\\/(${USERNAME})$`),
      auth: "none",
      handler: async (_req, [username]) =>
        render(await renderProfilePageHandler(deps.renderConfig, username)),
    },
    {
      methods: ["GET"],
      pattern: new RegExp(`^\\/u\\/(${USERNAME})\\/items$`),
      auth: "none",
      handler: async (req, [username]) =>
        render(await renderProfileItemsHandler(deps.renderConfig, username, req.query("cursor"))),
    },
    // /u/<username>/bookmarks — the page shell. Per-user data lands via the
    // client-side fetch to /me/bookmarks/feed below; the shell ships no
    // auth-gated content so it's safe to render uncached for any caller.
    {
      methods: ["GET"],
      pattern: new RegExp(`^\\/u\\/(${USERNAME})\\/bookmarks$`),
      auth: "none",
      handler: async (_req, [username]) =>
        render(await renderBookmarksPageHandler(deps.renderConfig, username)),
    },
    {
      methods: ["GET"],
      pattern: new RegExp(`^\\/u\\/(${USERNAME})\\/(followers|following)$`),
      auth: "none",
      handler: async (req, [username, kind]) => {
        const h = kind === "followers" ? renderFollowersPageHandler : renderFollowingPageHandler;
        return render(await h(deps.renderConfig, username, req.query("cursor")));
      },
    },
    {
      methods: ["GET"],
      pattern: new RegExp(`^\\/u\\/(${USERNAME})\\/(followers|following)\\/items$`),
      auth: "none",
      handler: async (req, [username, kind]) => {
        const h = kind === "followers" ? renderFollowersItemsHandler : renderFollowingItemsHandler;
        return render(await h(deps.renderConfig, username, req.query("cursor")));
      },
    },
    // /u/<username>/follow-thumbs?limit=N — JSON. Feeds the left-rail
    // follower/following thumb grids.
    {
      methods: ["GET"],
      pattern: new RegExp(`^\\/u\\/(${USERNAME})\\/follow-thumbs$`),
      auth: "none",
      handler: async (req, [username]) =>
        render(await renderFollowThumbsHandler(deps.renderConfig, username, req.query("limit"))),
    },
    // /u/<username>/streak — month-stacked calendar of the user's daily
    // publishes. Public read, edge-cached via CC_PROFILE.
    {
      methods: ["GET"],
      pattern: new RegExp(`^\\/u\\/(${USERNAME})\\/streak$`),
      auth: "none",
      handler: async (_req, [username]) =>
        render(await renderStreakPageHandler(deps.renderConfig, username)),
    },
    // /users/{user_id}/stats — per-account streak / total counters
    // (#115/#116). Registered only when a stats store is wired (the dev
    // server has none, and historically 404ed this path).
    ...(deps.userStatsStore
      ? [
          {
            methods: ["GET"],
            pattern: /^\/users\/([^/]+)\/stats$/,
            auth: "none",
            handler: async (_req: RouteRequest, [userId]: string[]) => {
              const result = await handleUserStats(userId, {
                userStatsStore: deps.userStatsStore!,
              });
              return json(result.status, result.body, result.headers);
            },
          } satisfies Route,
        ]
      : []),
    {
      methods: ["POST", "DELETE"],
      pattern: new RegExp(`^\\/drawings\\/(${HEX64})\\/like$`),
      auth: "required",
      handler: async (req, [id], auth) => {
        const result =
          req.method === "POST"
            ? await handleLike(id, auth!, deps.likesConfig)
            : await handleUnlike(id, auth!, deps.likesConfig);
        return json(result.status, result.body, result.headers);
      },
    },
    {
      methods: ["POST", "DELETE"],
      pattern: new RegExp(`^\\/drawings\\/(${HEX64})\\/bookmark$`),
      auth: "required",
      handler: async (req, [id], auth) => {
        const result =
          req.method === "POST"
            ? await handleBookmark(id, auth!, deps.bookmarksConfig)
            : await handleUnbookmark(id, auth!, deps.bookmarksConfig);
        return json(result.status, result.body, result.headers);
      },
    },
    // HTML fragment of the caller's bookmarks, used by the inline boot
    // script on /u/<un>/bookmarks.
    {
      methods: ["GET"],
      pattern: /^\/me\/bookmarks\/feed$/,
      auth: "required",
      handler: async (_req, _params, auth) =>
        render(await renderMyBookmarksFeedHandler(deps.renderConfig, auth!)),
    },
    {
      methods: ["POST", "DELETE"],
      pattern: new RegExp(`^\\/users\\/(${USERNAME})\\/follow$`),
      auth: "required",
      handler: async (req, [username], auth) => {
        const result =
          req.method === "POST"
            ? await handleFollow(username, auth!, deps.followsConfig)
            : await handleUnfollow(username, auth!, deps.followsConfig);
        return json(result.status, result.body, result.headers);
      },
    },
    // /hydrate?drawings=<csv>&users=<csv> — single hydration channel.
    // Public, no-store. Optional Bearer JWT populates the viewer_* fields.
    {
      methods: ["GET"],
      pattern: /^\/hydrate$/,
      auth: "optional",
      handler: async (req, _params, auth) => {
        const result = await handleHydrate(
          req.query("drawings"),
          req.query("users"),
          auth,
          deps.hydrateConfig,
        );
        return json(result.status, result.body, result.headers);
      },
    },
    // GET /auth/profile — prefill for the edit-profile form on /account.
    {
      methods: ["GET"],
      pattern: /^\/auth\/profile$/,
      auth: "required",
      handler: async (_req, _params, auth) => {
        const profileAuth: ProfileAuth = { user_id: auth!.user_id, username: auth!.username };
        const result = await handleGetProfile(profileAuth, deps.authConfig);
        return json(result.status, result.body, result.headers);
      },
    },
    // POST /subscribe — public email capture from the home-page hero.
    {
      methods: ["POST"],
      pattern: /^\/subscribe$/,
      auth: "none",
      handler: async (req) => {
        const result = await handleSubscribe(await req.body(), deps.subscribeConfig);
        return json(result.status, result.body);
      },
    },
    // POST /auth/* — per-subroute dispatch; profile-picture and profile
    // gate on the session inside authRoute (with their own 401 logging).
    {
      methods: ["POST"],
      pattern: /^\/auth\/.+$/,
      auth: "none",
      handler: (req) => authRoute(req, deps),
    },
  ];
  return routes;
}

// Walk the table top to bottom; first match wins. Required-auth routes
// answer 401 before their handler runs. Unknown paths fall through to
// 404 — identically in both servers.
export async function dispatch(routes: Route[], req: RouteRequest): Promise<RouteResult> {
  for (const route of routes) {
    if (!route.methods.includes(req.method)) continue;
    const m = route.pattern.exec(req.path);
    if (!m) continue;
    let auth: AuthedUser | null = null;
    if (route.auth !== "none") {
      auth = req.auth();
      if (route.auth === "required" && !auth) {
        if (route.logName) {
          logOutcome({
            requestId: req.requestId,
            route: route.logName,
            status: 401,
            duration_ms: Date.now() - req.t0,
            error_code: "unauthorized",
          });
        }
        return { kind: "json", status: 401, body: { error: "authentication required" } };
      }
    }
    return route.handler(req, m.slice(1), auth);
  }
  return { kind: "text", status: 404, body: "not found" };
}

// Verify the session JWT from an Authorization header value. Returns the
// authenticated account, or null when the header is missing/invalid/expired.
export function authFromBearer(
  header: string | null | undefined,
  jwtSecret: string,
): AuthedUser | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
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

// POST /ingest — publish flow + the outcome log line operators report on.
async function ingestRoute(
  req: RouteRequest,
  auth: AuthedUser,
  deps: RouteDeps,
): Promise<RouteResult> {
  const route = "POST /ingest";
  let body: IngestRequest;
  try {
    // The cast is compile-time only; handleIngest shape-checks every field
    // (shapeError in handler-utils.ts) before use and 400s naming the bad
    // field. The auth handlers do the same with their normalize*/typeof
    // guards, so parsed-JSON casts on those routes are equally covered.
    body = JSON.parse(await req.body()) as IngestRequest;
  } catch {
    logOutcome({
      requestId: req.requestId, route, status: 400,
      duration_ms: Date.now() - req.t0,
      user_id: auth.user_id, username: auth.username,
      error_code: "bad_json", error_message: "bad json body",
    });
    return { kind: "json", status: 400, body: { error: "bad json body" } };
  }
  const gifSize = typeof body.gif === "string" ? estimateBase64Bytes(body.gif) : undefined;
  const result = await handleIngest(body, { ...deps.ingestConfig, auth });
  const success = result.status === 200 || result.status === 202;
  const errorMessage = !success ? (result.body as { error?: string }).error : undefined;
  logOutcome({
    requestId: req.requestId, route, status: result.status,
    duration_ms: Date.now() - req.t0,
    user_id: auth.user_id, username: auth.username,
    drawing_id: success ? (result.body as { id: string }).id : undefined,
    parent_id: body.parent ?? null,
    gif_size_bytes: gifSize,
    error_code: errorMessage ? ingestErrorCode(errorMessage) : undefined,
    error_message: errorMessage,
  });
  return { kind: "json", status: result.status, body: result.body };
}

// POST /auth/{register,login,password/forgot,password/reset,
// profile-picture,profile} — plus the outcome log line per attempt.
async function authRoute(req: RouteRequest, deps: RouteDeps): Promise<RouteResult> {
  const route = `POST ${req.path}`;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await req.body()) as Record<string, unknown>;
  } catch {
    logOutcome({
      requestId: req.requestId, route, status: 400,
      duration_ms: Date.now() - req.t0,
      error_code: "bad_json", error_message: "bad json body",
    });
    return { kind: "json", status: 400, body: { error: "bad json body" } };
  }
  let result;
  let auth: AuthedUser | null = null;
  switch (req.path) {
    case "/auth/register":
      result = await handleRegister(body, deps.authConfig);
      break;
    case "/auth/login":
      result = await handleLogin(body, deps.authConfig);
      break;
    case "/auth/password/forgot":
      result = await handleForgotPassword(body, deps.authConfig);
      break;
    case "/auth/password/reset":
      result = await handleResetPassword(body, deps.authConfig);
      break;
    case "/auth/profile-picture": {
      auth = req.auth();
      if (!auth) {
        logOutcome({
          requestId: req.requestId, route, status: 401,
          duration_ms: Date.now() - req.t0,
          error_code: "unauthorized",
        });
        return { kind: "json", status: 401, body: { error: "authentication required" } };
      }
      const setPpAuth: SetProfilePictureAuth = {
        user_id: auth.user_id,
        username: auth.username,
      };
      result = await handleSetProfilePicture(body, setPpAuth, deps.authConfig);
      break;
    }
    case "/auth/profile": {
      auth = req.auth();
      if (!auth) {
        logOutcome({
          requestId: req.requestId, route, status: 401,
          duration_ms: Date.now() - req.t0,
          error_code: "unauthorized",
        });
        return { kind: "json", status: 401, body: { error: "authentication required" } };
      }
      const profileAuth: ProfileAuth = {
        user_id: auth.user_id,
        username: auth.username,
      };
      result = await handleUpdateProfile(body, profileAuth, deps.authConfig);
      break;
    }
    default:
      // Unknown /auth/* subpath → 404, same as the table fallthrough.
      logOutcome({
        requestId: req.requestId, route, status: 404,
        duration_ms: Date.now() - req.t0,
      });
      return { kind: "text", status: 404, body: "not found" };
  }
  // Pull identity off the success body for register/login, and off the
  // verified JWT for profile-picture/profile. Failure bodies don't carry
  // identity, so it stays undefined.
  const success = result.status >= 200 && result.status < 300;
  const successBody = success
    ? (result.body as { user_id?: string; username?: string })
    : null;
  const errorMessage = !success ? (result.body as { error?: string }).error : undefined;
  logOutcome({
    requestId: req.requestId, route, status: result.status,
    duration_ms: Date.now() - req.t0,
    user_id: auth?.user_id ?? successBody?.user_id,
    username: auth?.username ?? successBody?.username,
    error_code: errorMessage ? authErrorCode(req.path, errorMessage) : undefined,
    error_message: errorMessage,
  });
  return { kind: "json", status: result.status, body: result.body, headers: result.headers };
}
