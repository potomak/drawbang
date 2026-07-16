import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FsStorage } from "./storage.js";
import { MemoryUserStore } from "./user-store.js";
import { MemoryDrawingStore } from "./drawing-store.js";
import { MemoryLikesStore } from "./likes-store.js";
import type { LikesHandlerConfig } from "./likes-handler.js";
import { MemoryBookmarksStore } from "./bookmarks-store.js";
import type { BookmarksHandlerConfig } from "./bookmarks-handler.js";
import { MemoryFollowsStore } from "./follows-store.js";
import type { FollowsHandlerConfig } from "./follows-handler.js";
import type { HydrateHandlerConfig } from "./hydrate-handler.js";
import { MemorySubscribersStore } from "./subscribers-store.js";
import type { SubscribeHandlerConfig } from "./subscribe-handler.js";
import { ConsoleEmailSender } from "./email.js";
import { computeProductKpis, KPI_SCAN_LIMIT } from "./admin-handler.js";
import type { AdminView } from "../lib/templates/admin.js";
import { renderAdminInner } from "../lib/templates/admin.js";
import type { AuthHandlerConfig } from "./auth-handler.js";
import type { RenderHandlersConfig } from "./render-handlers.js";
import {
  authFromBearer,
  createRoutes,
  dispatch,
  type RouteRequest,
  type RouteResult,
} from "./routes.js";

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

// Same shared route table the Lambda uses (ingest/routes.ts) — only the
// wiring differs: Memory*/Fs stores, ConsoleEmailSender, the dev-open
// admin allowlist, no stats store (so /users/{id}/stats stays 404, as it
// always has locally), and no deferShareMp4 (there's no Lambda to
// self-invoke, so the -large.mp4 encode runs inline in handleIngest).
const routes = createRoutes({
  renderConfig,
  likesConfig,
  bookmarksConfig,
  followsConfig,
  hydrateConfig,
  subscribeConfig,
  authConfig,
  ingestConfig: {
    storage,
    publicBaseUrl: PUBLIC_BASE,
    drawingStore,
  },
  admin: {
    isAllowed: (username) => adminOpenInDev || adminUsernames.has(username),
    renderData: async ({ range, adminUsername }) => ({
      status: 200,
      contentType: "text/html; charset=utf-8",
      cacheControl: "private, no-store",
      body: renderAdminInner(await buildDevAdminView(adminUsername, range)),
    }),
  },
  repoUrl: process.env.REPO_URL ?? "https://github.com/potomak/drawbang",
});

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }
    cors(res);

    const u = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    // Memoized so the Bearer JWT is verified at most once per request.
    let authMemo: ReturnType<typeof authFromBearer> | undefined;
    let bodyMemo: Promise<string> | undefined;
    const routeReq: RouteRequest = {
      method: req.method ?? "GET",
      path: u.pathname,
      query: (name) => u.searchParams.get(name),
      body: () => (bodyMemo ??= readBody(req)),
      auth: () => {
        if (authMemo === undefined) {
          authMemo = authFromBearer(req.headers.authorization, JWT_SECRET);
        }
        return authMemo;
      },
      requestId: devRequestId(),
      t0: Date.now(),
    };
    writeResult(res, await dispatch(routes, routeReq), u);
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

function writeResult(res: http.ServerResponse, result: RouteResult, u: URL): void {
  switch (result.kind) {
    case "render":
      res.writeHead(result.response.status, {
        "Content-Type": result.response.contentType,
        "Cache-Control": result.response.cacheControl,
      });
      res.end(result.response.body);
      return;
    case "json":
      res.writeHead(result.status, {
        "Content-Type": "application/json",
        ...(result.headers ?? {}),
      });
      res.end(JSON.stringify(result.body));
      return;
    case "text":
      res.writeHead(result.status, { "Content-Type": "text/plain" });
      res.end(result.body);
      return;
    case "redirect301": {
      // Preserve any cursor querystring, mirroring the prod adapter.
      const target = u.search ? `${result.location}${u.search}` : result.location;
      res.writeHead(301, { Location: target, "Cache-Control": "public, max-age=3600" });
      res.end();
      return;
    }
  }
}

function cors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
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
