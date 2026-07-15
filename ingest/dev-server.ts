import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleIngest } from "./handler.js";
import { FsStorage } from "./storage.js";
import { MemoryUserStore } from "./user-store.js";
import { MemoryDrawingStore } from "./drawing-store.js";
import { MemoryLikesStore } from "./likes-store.js";
import {
  handleLike,
  handleUnlike,
  type LikesHandlerConfig,
} from "./likes-handler.js";
import { MemoryBookmarksStore } from "./bookmarks-store.js";
import {
  handleBookmark,
  handleUnbookmark,
  type BookmarksHandlerConfig,
} from "./bookmarks-handler.js";
import { MemoryFollowsStore } from "./follows-store.js";
import {
  handleFollow,
  handleUnfollow,
  type FollowsHandlerConfig,
} from "./follows-handler.js";
import {
  handleHydrate,
  type HydrateHandlerConfig,
} from "./hydrate-handler.js";
import { MemorySubscribersStore } from "./subscribers-store.js";
import {
  handleSubscribe,
  type SubscribeHandlerConfig,
} from "./subscribe-handler.js";
import { ConsoleEmailSender } from "./email.js";
import { JwtError, verifyJwt } from "./jwt.js";
import type { AuthedUser } from "./handler.js";
import {
  authErrorCode,
  estimateBase64Bytes,
  ingestErrorCode,
  logOutcome,
} from "./log-outcome.js";
import { computeProductKpis, KPI_SCAN_LIMIT, parseRange } from "./admin-handler.js";
import {
  renderAdminInner,
  renderAdminShell,
  type AdminView,
} from "../lib/templates/admin.js";
import {
  handleGetProfile,
  handleLogin,
  handleRegister,
  handleForgotPassword,
  handleResetPassword,
  handleSetProfilePicture,
  handleUpdateProfile,
  type AuthHandlerConfig,
  type ProfileAuth,
  type SetProfilePictureAuth,
} from "./auth-handler.js";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "dev-bucket");
const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_BASE = process.env.PUBLIC_BASE ?? "http://localhost:5173";
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret";
// In dev, an empty allowlist means "any signed-in user is admin" so the
// local /admin loop is one-step. In prod, an empty allowlist locks
// everyone out — different default on purpose.
const adminUsernames = new Set(
  (process.env.ADMIN_USERNAMES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const adminOpenInDev = adminUsernames.size === 0;

const storage = new FsStorage(ROOT);
const drawingStore = new MemoryDrawingStore();
const userStore = new MemoryUserStore();
const likesStore = new MemoryLikesStore(drawingStore);
const likesConfig: LikesHandlerConfig = { likesStore };
const bookmarksStore = new MemoryBookmarksStore(drawingStore);
const bookmarksConfig: BookmarksHandlerConfig = { bookmarksStore };
const followsStore = new MemoryFollowsStore(userStore);
const followsConfig: FollowsHandlerConfig = { followsStore, userStore };
const subscribersStore = new MemorySubscribersStore();
const subscribeConfig: SubscribeHandlerConfig = { subscribersStore };
const hydrateConfig: HydrateHandlerConfig = {
  likesStore,
  bookmarksStore,
  followsStore,
  userStore,
};
const renderConfig: RenderHandlersConfig = {
  drawingStore,
  publicBaseUrl: PUBLIC_BASE,
  repoUrl: "https://github.com/potomak/drawbang",
  userStore,
  bookmarksStore,
  followsStore,
};
const authConfig: AuthHandlerConfig = {
  userStore,
  email: new ConsoleEmailSender(),
  jwtSecret: JWT_SECRET,
  publicBaseUrl: PUBLIC_BASE,
  drawingStore,
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }
    cors(res);

    if (req.method === "POST" && req.url === "/ingest") {
      const route = "POST /ingest";
      const t0 = Date.now();
      const requestId = devRequestId();
      const auth = extractAuth(req);
      if (!auth) {
        logOutcome({
          requestId, route, status: 401,
          duration_ms: Date.now() - t0,
          error_code: "unauthorized",
        });
        json(res, 401, { error: "authentication required" });
        return;
      }
      const body = await readBody(req);
      // TODO (#type-safety): `let parsed: any` followed by an unchecked
      // hand-off to handleIngest. Validate the body matches IngestRequest
      // before passing it through (same gap exists in lambda.ts).
      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        logOutcome({
          requestId, route, status: 400,
          duration_ms: Date.now() - t0,
          user_id: auth.user_id, username: auth.username,
          error_code: "bad_json", error_message: "bad json",
        });
        json(res, 400, { error: "bad json" });
        return;
      }
      // deferShareMp4 deliberately unset: there's no Lambda to self-invoke
      // locally, so the -large.mp4 encode runs inline (handleIngest falls
      // back to the synchronous path when the hook is absent).
      const result = await handleIngest(parsed, {
        storage,
        publicBaseUrl: PUBLIC_BASE,
        auth,
        drawingStore,
      });
      const success = result.status === 200 || result.status === 202;
      const errorMessage = !success
        ? (result.body as { error?: string }).error
        : undefined;
      logOutcome({
        requestId, route, status: result.status,
        duration_ms: Date.now() - t0,
        user_id: auth.user_id, username: auth.username,
        drawing_id: success ? (result.body as { id: string }).id : undefined,
        parent_id: parsed?.parent ?? null,
        gif_size_bytes: typeof parsed?.gif === "string"
          ? estimateBase64Bytes(parsed.gif)
          : undefined,
        error_code: errorMessage ? ingestErrorCode(errorMessage) : undefined,
        error_message: errorMessage,
      });
      json(res, result.status, result.body);
      // No builder pass anymore — the new drawing already lives in the
      // in-memory drawing store, so /gallery and /d/<id> pick it up on
      // the next GET.
      return;
    }

    // /admin shell + /admin/data fragment — mirrors the prod split.
    // Shell ships unauthenticated; data endpoint runs the Bearer +
    // allowlist gate. In dev, an empty ADMIN_USERNAMES means "any
    // signed-in user is admin" so the local loop stays one-step.
    if (req.method === "GET" && req.url) {
      const u = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      if (u.pathname === "/admin") {
        const range = parseRange(u.searchParams.get("range"));
        const body = renderAdminShell({
          range,
          repo_url: process.env.REPO_URL ?? "https://github.com/potomak/drawbang",
        });
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "private, no-store",
        });
        res.end(body);
        return;
      }
      if (u.pathname === "/admin/data") {
        const route = "GET /admin/data";
        const t0 = Date.now();
        const requestId = devRequestId();
        const auth = extractAuth(req);
        if (!auth) {
          logOutcome({ requestId, route, status: 401, duration_ms: Date.now() - t0, error_code: "unauthorized" });
          json(res, 401, { error: "authentication required" });
          return;
        }
        if (!adminOpenInDev && !adminUsernames.has(auth.username)) {
          logOutcome({ requestId, route, status: 403, duration_ms: Date.now() - t0, user_id: auth.user_id, username: auth.username, error_code: "forbidden" });
          json(res, 403, { error: "not authorised" });
          return;
        }
        const range = parseRange(u.searchParams.get("range"));
        const view = await buildDevAdminView(auth.username, range);
        const body = renderAdminInner(view);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "private, no-store",
        });
        res.end(body);
        logOutcome({ requestId, route, status: 200, duration_ms: Date.now() - t0, user_id: auth.user_id, username: auth.username });
        return;
      }
    }

    // Dynamic HTML routes (Phase 3). Same handlers the Lambda uses in prod.
    if (req.method === "GET" && req.url) {
      const u = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      const pathOnly = u.pathname;
      const cursor = u.searchParams.get("cursor");
      // /gallery -> 301 / (mirrors the prod CloudFront Function redirect).
      if (pathOnly === "/gallery" || pathOnly === "/gallery/items") {
        const target = pathOnly === "/gallery" ? "/" : "/feed/items";
        const qs = u.search;
        res.writeHead(301, { Location: qs ? `${target}${qs}` : target });
        res.end();
        return;
      }
      let rendered: RenderResponse | null = null;
      if (pathOnly === "/") {
        rendered = await renderHomePageHandler(renderConfig, cursor, u.searchParams.get("sort"));
      } else if (pathOnly === "/feed/items") {
        rendered = await renderFeedItemsHandler(renderConfig, cursor);
      } else if (pathOnly === "/feed.rss") {
        rendered = await renderFeedHandler(renderConfig);
      } else if (pathOnly === "/design") {
        rendered = await renderDesignPageHandler(renderConfig);
      } else if (pathOnly === "/products") {
        rendered = await renderProductsPageHandler(renderConfig, "1");
      } else if (pathOnly === "/prompts") {
        rendered = await renderPromptsArchiveHandler(renderConfig);
      } else {
        const pm = pathOnly.match(/^\/products\/p\/(\d+)$/);
        if (pm) rendered = await renderProductsPageHandler(renderConfig, pm[1]);
        const prm = pathOnly.match(/^\/prompts\/([a-z0-9-]{1,32})$/);
        if (prm) rendered = await renderPromptPageHandler(renderConfig, prm[1]);
        const prim = pathOnly.match(/^\/prompts\/([a-z0-9-]{1,32})\/items$/);
        if (prim) rendered = await renderPromptItemsHandler(renderConfig, prim[1], cursor);
        const dm = pathOnly.match(/^\/d\/([0-9a-f]{64})$/);
        if (dm) rendered = await renderDrawingPageHandler(renderConfig, dm[1]);
        const em = pathOnly.match(/^\/embed\/([0-9a-f]{64})$/);
        if (em) rendered = await renderEmbedPageHandler(renderConfig, em[1]);
        const um = pathOnly.match(/^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])$/);
        if (um) rendered = await renderProfilePageHandler(renderConfig, um[1]);
        const uim = pathOnly.match(/^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])\/items$/);
        if (uim) rendered = await renderProfileItemsHandler(renderConfig, uim[1], cursor);
        const ubm = pathOnly.match(/^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])\/bookmarks$/);
        if (ubm) {
          rendered = await renderBookmarksPageHandler(renderConfig, ubm[1]);
        }
        const ufl = pathOnly.match(/^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])\/(followers|following)$/);
        if (ufl) {
          const h = ufl[2] === "followers" ? renderFollowersPageHandler : renderFollowingPageHandler;
          rendered = await h(renderConfig, ufl[1], cursor);
        }
        const ufi = pathOnly.match(/^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])\/(followers|following)\/items$/);
        if (ufi) {
          const h = ufi[2] === "followers" ? renderFollowersItemsHandler : renderFollowingItemsHandler;
          rendered = await h(renderConfig, ufi[1], cursor);
        }
        const uft = pathOnly.match(/^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])\/follow-thumbs$/);
        if (uft) {
          rendered = await renderFollowThumbsHandler(renderConfig, uft[1], u.searchParams.get("limit"));
        }
        const usm = pathOnly.match(/^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])\/streak$/);
        if (usm) rendered = await renderStreakPageHandler(renderConfig, usm[1]);
      }
      if (rendered) {
        res.writeHead(rendered.status, {
          "Content-Type": rendered.contentType,
          "Cache-Control": rendered.cacheControl,
        });
        res.end(rendered.body);
        return;
      }
    }

    // /drawings/{id}/like (POST + DELETE) — toggle a like.
    if (req.url) {
      const u = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      const likeMatch = u.pathname.match(/^\/drawings\/([0-9a-f]{64})\/like$/);
      if (likeMatch && (req.method === "POST" || req.method === "DELETE")) {
        const auth = extractAuth(req);
        if (!auth) {
          json(res, 401, { error: "authentication required" });
          return;
        }
        const result =
          req.method === "POST"
            ? await handleLike(likeMatch[1], auth, likesConfig)
            : await handleUnlike(likeMatch[1], auth, likesConfig);
        jsonWithHeaders(res, result.status, result.body, result.headers);
        return;
      }
      const bookmarkMatch = u.pathname.match(/^\/drawings\/([0-9a-f]{64})\/bookmark$/);
      if (bookmarkMatch && (req.method === "POST" || req.method === "DELETE")) {
        const auth = extractAuth(req);
        if (!auth) {
          json(res, 401, { error: "authentication required" });
          return;
        }
        const result =
          req.method === "POST"
            ? await handleBookmark(bookmarkMatch[1], auth, bookmarksConfig)
            : await handleUnbookmark(bookmarkMatch[1], auth, bookmarksConfig);
        jsonWithHeaders(res, result.status, result.body, result.headers);
        return;
      }
      if (req.method === "GET" && u.pathname === "/me/bookmarks/feed") {
        const auth = extractAuth(req);
        if (!auth) {
          json(res, 401, { error: "authentication required" });
          return;
        }
        const rendered = await renderMyBookmarksFeedHandler(renderConfig, auth);
        res.writeHead(rendered.status, {
          "Content-Type": rendered.contentType,
          "Cache-Control": rendered.cacheControl,
        });
        res.end(rendered.body);
        return;
      }
      const followMatch = u.pathname.match(/^\/users\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])\/follow$/);
      if (followMatch && (req.method === "POST" || req.method === "DELETE")) {
        const auth = extractAuth(req);
        if (!auth) {
          json(res, 401, { error: "authentication required" });
          return;
        }
        const result =
          req.method === "POST"
            ? await handleFollow(followMatch[1], auth, followsConfig)
            : await handleUnfollow(followMatch[1], auth, followsConfig);
        jsonWithHeaders(res, result.status, result.body, result.headers);
        return;
      }
      // Single hydration channel. Optional Bearer JWT populates viewer_*
      // fields; otherwise they're null. See ingest/hydrate-handler.ts.
      if (req.method === "GET" && u.pathname === "/hydrate") {
        const drawings = u.searchParams.get("drawings");
        const users = u.searchParams.get("users");
        const result = await handleHydrate(drawings, users, extractAuth(req), hydrateConfig);
        jsonWithHeaders(res, result.status, result.body, result.headers);
        return;
      }
      // GET /auth/profile — prefill for the edit-profile form on /account.
      if (req.method === "GET" && u.pathname === "/auth/profile") {
        const auth = extractAuth(req);
        if (!auth) {
          json(res, 401, { error: "authentication required" });
          return;
        }
        const profileAuth: ProfileAuth = { user_id: auth.user_id, username: auth.username };
        const result = await handleGetProfile(profileAuth, authConfig);
        jsonWithHeaders(res, result.status, result.body, result.headers);
        return;
      }
    }

    // POST /subscribe — public email capture from the home-page hero.
    if (req.method === "POST" && req.url === "/subscribe") {
      const body = await readBody(req);
      const result = await handleSubscribe(body, subscribeConfig);
      json(res, result.status, result.body);
      return;
    }

    if (req.method === "POST" && req.url && req.url.startsWith("/auth/")) {
      const route = `POST ${req.url}`;
      const t0 = Date.now();
      const requestId = devRequestId();
      const body = await readBody(req);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body);
      } catch {
        logOutcome({
          requestId, route, status: 400,
          duration_ms: Date.now() - t0,
          error_code: "bad_json", error_message: "bad json",
        });
        json(res, 400, { error: "bad json" });
        return;
      }
      let result;
      let authedUser: AuthedUser | null = null;
      switch (req.url) {
        case "/auth/register":
          result = await handleRegister(parsed, authConfig);
          break;
        case "/auth/login":
          result = await handleLogin(parsed, authConfig);
          break;
        case "/auth/password/forgot":
          result = await handleForgotPassword(parsed, authConfig);
          break;
        case "/auth/password/reset":
          result = await handleResetPassword(parsed, authConfig);
          break;
        case "/auth/profile-picture": {
          authedUser = extractAuth(req);
          if (!authedUser) {
            logOutcome({
              requestId, route, status: 401,
              duration_ms: Date.now() - t0,
              error_code: "unauthorized",
            });
            json(res, 401, { error: "authentication required" });
            return;
          }
          const setPpAuth: SetProfilePictureAuth = {
            user_id: authedUser.user_id,
            username: authedUser.username,
          };
          result = await handleSetProfilePicture(parsed, setPpAuth, authConfig);
          break;
        }
        case "/auth/profile": {
          authedUser = extractAuth(req);
          if (!authedUser) {
            logOutcome({
              requestId, route, status: 401,
              duration_ms: Date.now() - t0,
              error_code: "unauthorized",
            });
            json(res, 401, { error: "authentication required" });
            return;
          }
          const profileAuth: ProfileAuth = {
            user_id: authedUser.user_id,
            username: authedUser.username,
          };
          result = await handleUpdateProfile(parsed, profileAuth, authConfig);
          break;
        }
        default:
          logOutcome({
            requestId, route, status: 404,
            duration_ms: Date.now() - t0,
          });
          res.writeHead(404);
          res.end("not found");
          return;
      }
      const success = result.status >= 200 && result.status < 300;
      const successBody = success
        ? (result.body as { user_id?: string; username?: string })
        : null;
      const errorMessage = !success
        ? (result.body as { error?: string }).error
        : undefined;
      logOutcome({
        requestId, route, status: result.status,
        duration_ms: Date.now() - t0,
        user_id: authedUser?.user_id ?? successBody?.user_id,
        username: authedUser?.username ?? successBody?.username,
        error_code: errorMessage ? authErrorCode(req.url, errorMessage) : undefined,
        error_message: errorMessage,
      });
      jsonWithHeaders(res, result.status, result.body, result.headers);
      return;
    }

    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

function cors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// TODO (#dev-server-drift): this and the route table above hand-mirror
// lambda.ts — see docs/architecture-review-2026-06.md.
function extractAuth(req: http.IncomingMessage): AuthedUser | null {
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  try {
    const claims = verifyJwt<{ sub?: string; un?: string }>(m[1], JWT_SECRET);
    if (typeof claims.sub !== "string" || typeof claims.un !== "string") {
      return null;
    }
    return { user_id: claims.sub, username: claims.un };
  } catch (e) {
    if (e instanceof JwtError) return null;
    throw e;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function jsonWithHeaders(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...(headers ?? {}),
  });
  res.end(JSON.stringify(body));
}

// Cheap monotonic request id for the dev server. Mirrors the
// $context.requestId field the prod API Gateway access log carries
// so log-outcome JSON lines look the same in both environments.
let devReqCounter = 0;
function devRequestId(): string {
  devReqCounter += 1;
  return `dev-${process.pid}-${devReqCounter}`;
}

// In-memory AdminView for the dev /admin page. Counts + product KPIs
// come from the Memory stores; success-rate cards stay null (rendered
// as "—") because there's no real outcome stream locally. Use the dev
// loop to verify layout + auth gate; visit prod for the real numbers.
async function buildDevAdminView(
  adminUsername: string,
  range: AdminView["range"],
): Promise<AdminView> {
  const drawingsPage = await drawingStore.queryGallery({ limit: 1000 });
  const totalDrawings = drawingsPage.items.length;
  const totalUsers = userStoreSize();
  const kpiPage = await drawingStore.queryGallery({ limit: KPI_SCAN_LIMIT });
  return {
    adminUsername,
    range,
    generatedAtISO: new Date().toISOString(),
    totalUsers,
    totalDrawings,
    publish: null,
    register: null,
    kpis: computeProductKpis(kpiPage),
    failures: [],
  };
}

// MemoryUserStore has no public size(); peek at the private map.
function userStoreSize(): number | null {
  const m = (userStore as unknown as { byEmail?: Map<unknown, unknown> }).byEmail;
  return m instanceof Map ? m.size : null;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

server.listen(PORT, () => {
  console.log(`ingest dev server on http://localhost:${PORT} → ${ROOT}`);
});
