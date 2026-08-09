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
import { solvedPayload, testChallengeConfig } from "./support/challenge.js";
import type { Challenge } from "altcha-lib/types";

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
    deleteConfig: { drawingStore, storage: new NullStorage() },
    backfillConfig: {
      drawingStore,
      storage: new NullStorage(),
      enqueue: async () => {},
      runNow: async () => ({
        large_gif: { ok: true, ms: 1 },
        large_mp4: { ok: true, ms: 1 },
        invalidation: { ok: true, ms: 1 },
        duration_ms: 2,
      }),
    },
    authConfig: {
      userStore,
      email: new ConsoleEmailSender(),
      jwtSecret: "route-test-secret",
      publicBaseUrl: "https://example.test",
      drawingStore,
      storage: new NullStorage(),
      challenge: testChallengeConfig(),
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
  // Models "an Authorization header arrived but didn't verify". Defaults to
  // whether `auth` resolved, so an unauthenticated request looks like one
  // that simply sent no header.
  hasAuthHeader?: boolean;
}): RouteRequest {
  return {
    method: partial.method,
    path: partial.path,
    query: (name) => partial.query?.[name] ?? null,
    body: async () => partial.body ?? "",
    auth: () => partial.auth ?? null,
    hasAuthHeader: () => partial.hasAuthHeader ?? partial.auth != null,
    requestId: "test-req",
    t0: Date.now(),
  };
}

describe("shared route table", () => {
  let routes: Route[];
  let deps: RouteDeps;
  beforeEach(() => {
    deps = makeDeps();
    routes = createRoutes(deps);
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
      { method: "POST", path: "/auth/account/delete" },
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

  test("POST /ingest publishes without a session instead of 401ing", async () => {
    // Reaching the handler is the point: it 400s on the missing gif field,
    // which proves the route no longer gates the publish on a session.
    const res = await dispatch(
      routes,
      makeReq({ method: "POST", path: "/ingest", auth: null, body: "{}" }),
    );
    assert.equal(res.kind, "json");
    assert.equal((res as { status: number }).status, 400);
    assert.match((res as { body: { error: string } }).body.error, /gif/);
  });

  test("POST /ingest 401s when a token was sent but didn't verify", async () => {
    // An expired/forged token must not silently downgrade to an anonymous
    // publish — the caller thinks it's signed in.
    const res = await dispatch(
      routes,
      makeReq({
        method: "POST",
        path: "/ingest",
        auth: null,
        hasAuthHeader: true,
        body: "{}",
      }),
    );
    assert.equal(res.kind, "json");
    assert.equal((res as { status: number }).status, 401);
    assert.deepEqual((res as { body: unknown }).body, { error: "authentication required" });
  });

  test("DELETE /admin/users/{username} is refused for a non-operator", async () => {
    // The allowlist is the whole gate on this route — a signed-in ordinary
    // user must not be able to delete anyone.
    const res = await dispatch(
      routes,
      makeReq({ method: "DELETE", path: "/admin/users/someoneelse", auth: VIEWER }),
    );
    assert.equal((res as { status: number }).status, 403);
    assert.deepEqual((res as { body: unknown }).body, { error: "not authorised" });
  });

  test("DELETE /admin/users/{username} requires a session at all", async () => {
    const res = await dispatch(
      routes,
      makeReq({ method: "DELETE", path: "/admin/users/someoneelse" }),
    );
    assert.equal((res as { status: number }).status, 401);
  });

  test("DELETE /admin/users/{username} reaches the handler for an operator", async () => {
    // ADMIN is on the allowlist in makeDeps(); the account doesn't exist,
    // so a 404 from the handler proves the gate let the call through.
    const res = await dispatch(
      routes,
      makeReq({ method: "DELETE", path: "/admin/users/ghostuser", auth: ADMIN }),
    );
    assert.equal((res as { status: number }).status, 404);
  });

  test("DELETE /drawings/{id} requires a session", async () => {
    const res = await dispatch(
      routes,
      makeReq({ method: "DELETE", path: `/drawings/${"a".repeat(64)}` }),
    );
    assert.equal(res.kind, "json");
    assert.equal((res as { status: number }).status, 401);
  });

  test("DELETE /drawings/{id} does not shadow the like/bookmark toggles", async () => {
    // The bare-id pattern must not swallow /drawings/<id>/like — a
    // DELETE there is an unlike, not a drawing removal.
    const id = "a".repeat(64);
    const res = await dispatch(
      routes,
      makeReq({ method: "DELETE", path: `/drawings/${id}/like`, auth: VIEWER }),
    );
    assert.equal((res as { status: number }).status, 404, "unlike of a missing drawing");
    assert.deepEqual((res as { body: unknown }).body, { error: "drawing not found" });
  });

  test("DELETE /drawings/{id} refuses a non-owner who isn't on the allowlist", async () => {
    const deps = makeDeps();
    const id = "b".repeat(64);
    await deps.renderConfig.drawingStore.put({
      drawing_id: id,
      size: 16,
      created_at: "2026-07-01T00:00:00.000Z",
      created_at_ms: Date.parse("2026-07-01T00:00:00.000Z"),
      user_id: "o".repeat(64),
      username: "someoneelse",
      parent_id: null,
      frames: 1,
      gif_size_bytes: 100,
    });
    const res = await dispatch(createRoutes(deps), makeReq({
      method: "DELETE", path: `/drawings/${id}`, auth: VIEWER,
    }));
    assert.equal((res as { status: number }).status, 403);
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
        body: JSON.stringify({
          email: "a@b.com",
          username: "alice",
          password: "password123",
          altcha: await solvedPayload(deps.authConfig.challenge),
        }),
      }),
    );
    assert.equal(res.kind, "json");
    assert.equal((res as { status: number }).status, 201);
  });

  test("GET /auth/challenge mints a solvable, uncacheable challenge", async () => {
    const res = await dispatch(routes, makeReq({ method: "GET", path: "/auth/challenge" }));
    assert.equal(res.kind, "json");
    const r = res as { status: number; body: Challenge; headers?: Record<string, string> };
    assert.equal(r.status, 200);
    assert.equal(r.headers?.["Cache-Control"], "private, no-store");
    // The shape the widget needs to do any work at all.
    assert.equal(typeof r.body.parameters.nonce, "string");
    assert.equal(typeof r.body.signature, "string");
    assert.ok(r.body.parameters.cost > 0);
  });

  test("POST /auth/register without a solved challenge is refused", async () => {
    const res = await dispatch(
      routes,
      makeReq({
        method: "POST",
        path: "/auth/register",
        body: JSON.stringify({
          email: "nogate@b.com",
          username: "nogate",
          password: "password123",
        }),
      }),
    );
    // 400 rather than 403 so CloudFront does not rewrite it to /404.html.
    assert.equal((res as { status: number }).status, 400);
    assert.equal((res as { body: { code: string } }).body.code, "challenge_missing");
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
