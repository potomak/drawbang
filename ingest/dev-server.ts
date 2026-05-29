import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleIngest } from "./handler.js";
import { FsStorage } from "./storage.js";
import { MemoryUserStore } from "./user-store.js";
import { MemoryDrawingStore } from "./drawing-store.js";
import { ConsoleEmailSender } from "./email.js";
import { JwtError, verifyJwt } from "./jwt.js";
import type { AuthedUser } from "./handler.js";
import {
  handleLogin,
  handleRegister,
  handleForgotPassword,
  handleResetPassword,
  handleSetAvatar,
  type AuthHandlerConfig,
  type SetAvatarAuth,
} from "./auth-handler.js";
import {
  renderDrawingPageHandler,
  renderFeedHandler,
  renderGalleryItemsHandler,
  renderGalleryPageHandler,
  renderProductsPageHandler,
  renderProfileItemsHandler,
  renderProfilePageHandler,
  type RenderHandlersConfig,
  type RenderResponse,
} from "./render-handlers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "dev-bucket");
const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_BASE = process.env.PUBLIC_BASE ?? "http://localhost:5173";
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret";

const storage = new FsStorage(ROOT);
const drawingStore = new MemoryDrawingStore();
const userStore = new MemoryUserStore();
const renderConfig: RenderHandlersConfig = {
  drawingStore,
  publicBaseUrl: PUBLIC_BASE,
  repoUrl: "https://github.com/potomak/drawbang",
  userStore,
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
      const auth = extractAuth(req);
      if (!auth) {
        json(res, 401, { error: "authentication required" });
        return;
      }
      const body = await readBody(req);
      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        json(res, 400, { error: "bad json" });
        return;
      }
      const result = await handleIngest(parsed, {
        storage,
        publicBaseUrl: PUBLIC_BASE,
        auth,
        drawingStore,
      });
      json(res, result.status, result.body);
      // No builder pass anymore — the new drawing already lives in the
      // in-memory drawing store, so /gallery and /d/<id> pick it up on
      // the next GET.
      return;
    }

    // Dynamic HTML routes (Phase 3). Same handlers the Lambda uses in prod.
    if (req.method === "GET" && req.url) {
      const u = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      const pathOnly = u.pathname;
      const cursor = u.searchParams.get("cursor");
      let rendered: RenderResponse | null = null;
      if (pathOnly === "/gallery") {
        rendered = await renderGalleryPageHandler(renderConfig, cursor);
      } else if (pathOnly === "/gallery/items") {
        rendered = await renderGalleryItemsHandler(renderConfig, cursor);
      } else if (pathOnly === "/feed.rss") {
        rendered = await renderFeedHandler(renderConfig);
      } else if (pathOnly === "/products") {
        rendered = await renderProductsPageHandler(renderConfig, "1");
      } else {
        const pm = pathOnly.match(/^\/products\/p\/(\d+)$/);
        if (pm) rendered = await renderProductsPageHandler(renderConfig, pm[1]);
        const dm = pathOnly.match(/^\/d\/([0-9a-f]{64})$/);
        if (dm) rendered = await renderDrawingPageHandler(renderConfig, dm[1]);
        const um = pathOnly.match(/^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])$/);
        if (um) rendered = await renderProfilePageHandler(renderConfig, um[1]);
        const uim = pathOnly.match(/^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])\/items$/);
        if (uim) rendered = await renderProfileItemsHandler(renderConfig, uim[1], cursor);
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

    if (req.method === "POST" && req.url && req.url.startsWith("/auth/")) {
      const body = await readBody(req);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body);
      } catch {
        json(res, 400, { error: "bad json" });
        return;
      }
      let result;
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
        case "/auth/avatar": {
          const auth = extractAuth(req);
          if (!auth) {
            json(res, 401, { error: "authentication required" });
            return;
          }
          const setAvatarAuth: SetAvatarAuth = {
            user_id: auth.user_id,
            username: auth.username,
          };
          result = await handleSetAvatar(parsed, setAvatarAuth, authConfig);
          break;
        }
        default:
          res.writeHead(404);
          res.end("not found");
          return;
      }
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
