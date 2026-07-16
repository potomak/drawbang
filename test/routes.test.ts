import { strict as assert } from "node:assert";
import { beforeEach, describe, test } from "node:test";
import {
  authFromBearer,
  createRoutes,
  dispatch,
  type Route,
  type RouteDeps,
  type RouteRequest,
} from "../ingest/routes.js";
import type { AuthedUser } from "../ingest/handler.js";
import { MemoryDrawingStore } from "../ingest/drawing-store.js";
import { MemoryUserStore } from "../ingest/user-store.js";
import { MemoryLikesStore } from "../ingest/likes-store.js";
import { MemoryBookmarksStore } from "../ingest/bookmarks-store.js";
import { MemoryFollowsStore } from "../ingest/follows-store.js";
import { MemorySubscribersStore } from "../ingest/subscribers-store.js";
import { MemoryUserStatsStore } from "../ingest/user-stats-store.js";
import { ConsoleEmailSender } from "../ingest/email.js";
import { signJwt } from "../ingest/jwt.js";
import type { Storage } from "../ingest/storage.js";

// The shared route table (ingest/routes.ts) is what both lambda.ts and
// dev-server.ts dispatch through, so exercising it here covers both
// servers at once: per-route auth gates (401 before the handler runs),
// method matching, param extraction, and the 404 fallthrough.

class NullStorage implements Storage {
  async putIfAbsent(): Promise<boolean> { return true; }
  async put(): Promise<void> {}
  async getJSON<T>(): Promise<T | null> { return null; }
  async exists(): Promise<boolean> { return false; }
  async listPrefix(): Promise<string[]> { return []; }
  async getBytes(): Promise<Uint8Array | null> { return null; }
  async remove(): Promise<void> {}
}

const VIEWER: AuthedUser = { user_id: "u".repeat(64), username: "alice" };
const ADMIN: AuthedUser = { user_id: "a".repeat(64), username: "root" };

function makeDeps(opts: { userStats?: boolean } = {}): RouteDeps {
  const drawingStore = new MemoryDrawingStore();
  const userStore = new MemoryUserStore();
  const likesStore = new MemoryLikesStore(drawingStore);
  const bookmarksStore = new MemoryBookmarksStore(drawingStore);
  const followsStore = new MemoryFollowsStore(userStore);
  return {
    renderConfig: {
      drawingStore,
      publicBaseUrl: "https://example.test",
      repoUrl: "https://github.com/example/drawbang",
      userStore,
      bookmarksStore,
      followsStore,
    },
    likesConfig: { likesStore },
    bookmarksConfig: { bookmarksStore },
    followsConfig: { followsStore, userStore },
    hydrateConfig: { likesStore, bookmarksStore, followsStore, userStore },
    subscribeConfig: { subscribersStore: new MemorySubscribersStore() },
    authConfig: {
      userStore,
      email: new ConsoleEmailSender(),
      jwtSecret: "route-test-secret",
      publicBaseUrl: "https://example.test",
      drawingStore,
    },
    ingestConfig: {
      storage: new NullStorage(),
      publicBaseUrl: "https://example.test",
      drawingStore,
    },
    ...(opts.userStats ? { userStatsStore: new MemoryUserStatsStore() } : {}),
    admin: {
      isAllowed: (username) => username === ADMIN.username,
      renderData: async () => ({
        status: 200,
        contentType: "text/html; charset=utf-8",
        cacheControl: "private, no-store",
        body: "<section>admin</section>",
      }),
    },
    repoUrl: "https://github.com/example/drawbang",
  };
}

function makeReq(partial: {
  method: string;
  path: string;
  auth?: AuthedUser | null;
  body?: string;
  query?: Record<string, string>;
}): RouteRequest {
  return {
    method: partial.method,
    path: partial.path,
    query: (name) => partial.query?.[name] ?? null,
    body: async () => partial.body ?? "",
    auth: () => partial.auth ?? null,
    requestId: "test-req",
    t0: Date.now(),
  };
}

describe("shared route table", () => {
  let routes: Route[];
  beforeEach(() => {
    routes = createRoutes(makeDeps());
  });

  test("unknown path falls through to 404 in both servers' shared dispatch", async () => {
    const res = await dispatch(routes, makeReq({ method: "GET", path: "/nope" }));
    assert.deepEqual(res, { kind: "text", status: 404, body: "not found" });
  });

  test("known path with the wrong method is a 404, not a 405", async () => {
    const res = await dispatch(routes, makeReq({ method: "DELETE", path: "/hydrate" }));
    assert.equal(res.kind, "text");
    assert.equal((res as { status: number }).status, 404);
  });

  test("every auth-required route answers 401 before its handler runs", async () => {
    const id = "f".repeat(64);
    const requests = [
      { method: "POST", path: "/ingest" },
      { method: "GET", path: "/admin/data" },
      { method: "POST", path: `/drawings/${id}/like` },
      { method: "DELETE", path: `/drawings/${id}/like` },
      { method: "POST", path: `/drawings/${id}/bookmark` },
      { method: "DELETE", path: `/drawings/${id}/bookmark` },
      { method: "GET", path: "/me/bookmarks/feed" },
      { method: "POST", path: "/users/alice/follow" },
      { method: "DELETE", path: "/users/alice/follow" },
      { method: "GET", path: "/auth/profile" },
      { method: "POST", path: "/auth/profile-picture" },
      { method: "POST", path: "/auth/profile" },
    ];
    for (const r of requests) {
      const res = await dispatch(routes, makeReq({ ...r, auth: null, body: "{}" }));
      assert.equal(res.kind, "json", `${r.method} ${r.path}`);
      assert.equal((res as { status: number }).status, 401, `${r.method} ${r.path}`);
      assert.deepEqual(
        (res as { body: unknown }).body,
        { error: "authentication required" },
        `${r.method} ${r.path}`,
      );
    }
  });

  test("public pages render without a session", async () => {
    for (const path of ["/", "/feed/items", "/feed.rss", "/design", "/products", "/prompts"]) {
      const res = await dispatch(routes, makeReq({ method: "GET", path }));
      assert.equal(res.kind, "render", path);
    }
  });

  test("/gallery and /gallery/items 301 to their new homes", async () => {
    const home = await dispatch(routes, makeReq({ method: "GET", path: "/gallery" }));
    assert.deepEqual(home, { kind: "redirect301", location: "/" });
    const items = await dispatch(routes, makeReq({ method: "GET", path: "/gallery/items" }));
    assert.deepEqual(items, { kind: "redirect301", location: "/feed/items" });
  });

  test("path params reach the handler (like toggle on a missing drawing → 404)", async () => {
    const res = await dispatch(
      routes,
      makeReq({ method: "POST", path: `/drawings/${"e".repeat(64)}/like`, auth: VIEWER }),
    );
    assert.equal(res.kind, "json");
    assert.equal((res as { status: number }).status, 404);
  });

  test("method routing picks the right toggle handler (POST likes, DELETE unlikes)", async () => {
    const deps = makeDeps();
    const id = "d".repeat(64);
    await deps.renderConfig.drawingStore.put({
      drawing_id: id,
      size: 16,
      created_at: "2026-07-01T00:00:00.000Z",
      created_at_ms: Date.parse("2026-07-01T00:00:00.000Z"),
      user_id: "o".repeat(64),
      username: "owner",
      parent_id: null,
      frames: 1,
      gif_size_bytes: 100,
    });
    const table = createRoutes(deps);
    const like = await dispatch(
      table,
      makeReq({ method: "POST", path: `/drawings/${id}/like`, auth: VIEWER }),
    );
    assert.equal((like as { status: number }).status, 200);
    const unlike = await dispatch(
      table,
      makeReq({ method: "DELETE", path: `/drawings/${id}/like`, auth: VIEWER }),
    );
    assert.equal((unlike as { status: number }).status, 200);
  });

  test("/hydrate works without a session (viewer_* fields null)", async () => {
    const res = await dispatch(
      routes,
      makeReq({
        method: "GET",
        path: "/hydrate",
        query: { drawings: "f".repeat(64) },
      }),
    );
    assert.equal(res.kind, "json");
    assert.equal((res as { status: number }).status, 200);
  });

  test("/admin shell is public; /admin/data 403s a signed-in non-admin and 200s the admin", async () => {
    const shell = await dispatch(routes, makeReq({ method: "GET", path: "/admin" }));
    assert.equal(shell.kind, "render");
    const denied = await dispatch(
      routes,
      makeReq({ method: "GET", path: "/admin/data", auth: VIEWER }),
    );
    assert.equal((denied as { status: number }).status, 403);
    const allowed = await dispatch(
      routes,
      makeReq({ method: "GET", path: "/admin/data", auth: ADMIN }),
    );
    assert.equal(allowed.kind, "render");
  });

  test("unknown POST /auth/* subpath is a 404", async () => {
    const res = await dispatch(
      routes,
      makeReq({ method: "POST", path: "/auth/nope", body: "{}" }),
    );
    assert.equal(res.kind, "text");
    assert.equal((res as { status: number }).status, 404);
  });

  test("POST /auth/register round-trips through the shared table", async () => {
    const res = await dispatch(
      routes,
      makeReq({
        method: "POST",
        path: "/auth/register",
        body: JSON.stringify({ email: "a@b.com", username: "alice", password: "password123" }),
      }),
    );
    assert.equal(res.kind, "json");
    assert.equal((res as { status: number }).status, 201);
  });

  test("/users/{id}/stats is registered only when a stats store is wired", async () => {
    const hexUserId = "0ab1".repeat(16);
    // Dev server wires no stats store and has always 404ed this path.
    const withoutStore = await dispatch(
      routes,
      makeReq({ method: "GET", path: `/users/${hexUserId}/stats` }),
    );
    assert.equal(withoutStore.kind, "text");
    assert.equal((withoutStore as { status: number }).status, 404);

    const withStore = createRoutes(makeDeps({ userStats: true }));
    const res = await dispatch(
      withStore,
      makeReq({ method: "GET", path: `/users/${hexUserId}/stats` }),
    );
    assert.equal(res.kind, "json");
    assert.equal((res as { status: number }).status, 200);
  });

  test("bad JSON on POST /ingest is a 400, not a crash", async () => {
    const res = await dispatch(
      routes,
      makeReq({ method: "POST", path: "/ingest", auth: VIEWER, body: "{nope" }),
    );
    assert.equal((res as { status: number }).status, 400);
    assert.deepEqual((res as { body: unknown }).body, { error: "bad json body" });
  });
});

describe("authFromBearer", () => {
  const SECRET = "route-test-secret";

  test("accepts a valid session token", () => {
    const token = signJwt({ sub: VIEWER.user_id, un: VIEWER.username }, SECRET, 3600);
    assert.deepEqual(authFromBearer(`Bearer ${token}`, SECRET), VIEWER);
  });

  test("rejects missing/malformed headers and bad tokens as null", () => {
    assert.equal(authFromBearer(null, SECRET), null);
    assert.equal(authFromBearer("", SECRET), null);
    assert.equal(authFromBearer("Basic abc", SECRET), null);
    assert.equal(authFromBearer("Bearer not-a-jwt", SECRET), null);
    const wrongSecret = signJwt({ sub: "x", un: "y" }, "other", 3600);
    assert.equal(authFromBearer(`Bearer ${wrongSecret}`, SECRET), null);
  });

  test("rejects tokens whose claims lack sub/un strings", () => {
    const noClaims = signJwt({}, SECRET, 3600);
    assert.equal(authFromBearer(`Bearer ${noClaims}`, SECRET), null);
  });
});
