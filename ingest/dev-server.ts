import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { handleIngest } from "./handler.js";
import {
  handleMuralClaim,
  handleMuralState,
} from "./mural-handler.js";
import { FsStorage } from "./storage.js";
import { MemoryMuralStore } from "./mural-store.js";
import { MemoryUserStore } from "./user-store.js";
import { ConsoleEmailSender } from "./email.js";
import { JwtError, verifyJwt } from "./jwt.js";
import type { AuthedUser } from "./handler.js";
import { handleCanvasPublish } from "./canvas-publish-handler.js";
import {
  handleLogin,
  handleRegister,
  handleResetConfirm,
  handleResetRequest,
  type AuthHandlerConfig,
} from "./auth-handler.js";
import { build } from "../builder/build.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "dev-bucket");
const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_BASE = process.env.PUBLIC_BASE ?? "http://localhost:5173";
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret";

const storage = new FsStorage(ROOT);
const muralStore = new MemoryMuralStore();
const muralBaselineHistory = new Map<string, string[]>();
const authConfig: AuthHandlerConfig = {
  userStore: new MemoryUserStore(),
  email: new ConsoleEmailSender(),
  jwtSecret: JWT_SECRET,
  publicBaseUrl: PUBLIC_BASE,
};

// Inline rebuild after every successful ingest. The builder is incremental
// and FsStorage is local, so the round-trip is well under a second on a
// small dev-bucket — awaiting it keeps the publish → /gallery view race-
// free for the user. Failures are logged but don't poison the ingest 200
// (the inbox bytes are already on disk).
async function rebuildAfterPublish(): Promise<void> {
  const start = Date.now();
  try {
    const result = await build({
      storage,
      publicBaseUrl: PUBLIC_BASE,
      logger: () => {},
    });
    const ms = Date.now() - start;
    console.log(
      `[builder] rebuilt in ${ms}ms — swept ${result.sweptDrawings}, touched: ${
        result.touchedDays.join(", ") || "(none)"
      }`,
    );
  } catch (err) {
    console.error("[builder] rebuild failed:", err);
  }
}

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
        muralStore,
      });
      json(res, result.status, result.body);
      // 202 = newly accepted, 200 = idempotent retry of an existing
      // drawing. Either way the inbox is in a coherent state, so rebuild.
      if (result.status === 200 || result.status === 202) {
        await rebuildAfterPublish();
      }
      return;
    }

    if (req.method === "POST" && req.url === "/canvas") {
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
      const result = await handleCanvasPublish(parsed, {
        storage,
        publicBaseUrl: PUBLIC_BASE,
        auth,
      });
      json(res, result.status, result.body);
      if (result.status === 200 || result.status === 202) {
        await rebuildAfterPublish();
      }
      return;
    }

    if (req.method === "GET" && req.url === "/state/last-publish.json") {
      const body = await fs.readFile(path.join(ROOT, "public/state/last-publish.json")).catch(() => null);
      if (!body) {
        json(res, 200, { last_publish_at: "1970-01-01T00:00:00.000Z", last_difficulty_bits: 20 });
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(body);
      return;
    }

    if (req.method === "GET" && req.url === "/state/current-mural.json") {
      const body = await fs.readFile(path.join(ROOT, "public/state/current-mural.json")).catch(() => null);
      if (!body) {
        // No state file yet — run the builder once so the banner has data.
        await rebuildAfterPublish();
        const retry = await fs.readFile(path.join(ROOT, "public/state/current-mural.json")).catch(() => null);
        if (retry) {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(retry);
          return;
        }
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(body);
      return;
    }

    if (req.method === "POST" && req.url === "/mural/claim") {
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
      const result = await handleMuralClaim(parsed, {
        storage,
        muralStore,
        publicBaseUrl: PUBLIC_BASE,
        auth,
        baselineHistory: muralBaselineHistory,
      });
      jsonWithHeaders(res, result.status, result.body, result.headers);
      if (result.status === 201) {
        await rebuildAfterPublish();
      }
      return;
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
        case "/auth/reset/request":
          result = await handleResetRequest(parsed, authConfig);
          break;
        case "/auth/reset/confirm":
          result = await handleResetConfirm(parsed, authConfig);
          break;
        default:
          res.writeHead(404);
          res.end("not found");
          return;
      }
      jsonWithHeaders(res, result.status, result.body, result.headers);
      return;
    }

    if (req.method === "GET" && req.url) {
      const m = req.url.match(/^\/mural\/([^\/]+)\/state$/);
      if (m) {
        const result = await handleMuralState(m[1], {
          storage,
          muralStore,
          publicBaseUrl: PUBLIC_BASE,
        });
        jsonWithHeaders(res, result.status, result.body, result.headers);
        return;
      }
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
