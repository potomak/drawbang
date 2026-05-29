import { strict as assert } from "node:assert";
import { beforeEach, describe, test } from "node:test";
import {
  handleRegister,
  handleSetAvatar,
  type AuthHandlerConfig,
  type SetAvatarAuth,
} from "../ingest/auth-handler.js";
import { MemoryUserStore } from "../ingest/user-store.js";
import { MemoryDrawingStore } from "../ingest/drawing-store.js";
import { NoopInvalidator } from "../ingest/cache-invalidation.js";
import {
  renderDrawingPageHandler,
  renderProfilePageHandler,
  type RenderHandlersConfig,
} from "../ingest/render-handlers.js";
import type { EmailSender } from "../ingest/email.js";
import type { DrawingRow } from "../ingest/drawing-store.js";

class SilentEmail implements EmailSender {
  async sendPasswordReset(): Promise<void> {}
}

const SECRET = "avatar-test-secret";

function row(overrides: Partial<DrawingRow> = {}): DrawingRow {
  const ms = overrides.created_at_ms ?? Date.parse("2026-05-01T12:00:00.000Z");
  return {
    drawing_id: overrides.drawing_id ?? "a".repeat(64),
    size: overrides.size ?? 16,
    created_at: overrides.created_at ?? new Date(ms).toISOString(),
    created_at_ms: ms,
    user_id: overrides.user_id ?? "u".repeat(64),
    username: overrides.username ?? "alice",
    parent_id: overrides.parent_id ?? null,
    frames: overrides.frames ?? 1,
    gif_size_bytes: overrides.gif_size_bytes ?? 1234,
  };
}

async function registerAccount(
  cfg: AuthHandlerConfig,
  email: string,
  username: string,
): Promise<SetAvatarAuth> {
  const r = await handleRegister(
    { email, username, password: "password123" },
    cfg,
  );
  const body = r.body as { user_id: string; username: string };
  return { user_id: body.user_id, username: body.username };
}

interface Harness {
  authCfg: AuthHandlerConfig;
  renderCfg: RenderHandlersConfig;
  userStore: MemoryUserStore;
  drawingStore: MemoryDrawingStore;
  invalidator: NoopInvalidator;
}

function harness(): Harness {
  const userStore = new MemoryUserStore();
  const drawingStore = new MemoryDrawingStore();
  const invalidator = new NoopInvalidator();
  return {
    userStore,
    drawingStore,
    invalidator,
    authCfg: {
      userStore,
      email: new SilentEmail(),
      jwtSecret: SECRET,
      publicBaseUrl: "https://example.test",
      drawingStore,
      cacheInvalidator: invalidator,
    },
    renderCfg: {
      drawingStore,
      userStore,
      publicBaseUrl: "https://example.test",
      repoUrl: "https://github.com/test/test",
    },
  };
}

describe("handleSetAvatar", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  test("rejects when drawingStore is unconfigured", async () => {
    const cfg: AuthHandlerConfig = { ...h.authCfg, drawingStore: undefined };
    const auth = await registerAccount(h.authCfg, "a@b.com", "alice");
    const res = await handleSetAvatar({ drawing_id: "f".repeat(64) }, auth, cfg);
    assert.equal(res.status, 500);
  });

  test("400 when drawing_id field is missing", async () => {
    const auth = await registerAccount(h.authCfg, "a@b.com", "alice");
    const res = await handleSetAvatar({}, auth, h.authCfg);
    assert.equal(res.status, 400);
  });

  test("400 when drawing_id is malformed (not 64-hex / not null)", async () => {
    const auth = await registerAccount(h.authCfg, "a@b.com", "alice");
    const r1 = await handleSetAvatar({ drawing_id: "nope" }, auth, h.authCfg);
    assert.equal(r1.status, 400);
    const r2 = await handleSetAvatar({ drawing_id: 42 }, auth, h.authCfg);
    assert.equal(r2.status, 400);
  });

  test("401 when the JWT's username has no account row", async () => {
    const auth: SetAvatarAuth = { user_id: "u".repeat(64), username: "ghost" };
    const res = await handleSetAvatar(
      { drawing_id: "f".repeat(64) },
      auth,
      h.authCfg,
    );
    assert.equal(res.status, 401);
  });

  test("401 when the username's account user_id no longer matches the JWT", async () => {
    // Stale JWT scenario: defense-in-depth check against a freed-up handle.
    const auth = await registerAccount(h.authCfg, "a@b.com", "alice");
    const stale: SetAvatarAuth = { ...auth, user_id: "0".repeat(64) };
    const res = await handleSetAvatar(
      { drawing_id: "f".repeat(64) },
      stale,
      h.authCfg,
    );
    assert.equal(res.status, 401);
  });

  test("404 when the drawing doesn't exist", async () => {
    const auth = await registerAccount(h.authCfg, "a@b.com", "alice");
    const res = await handleSetAvatar(
      { drawing_id: "f".repeat(64) },
      auth,
      h.authCfg,
    );
    assert.equal(res.status, 404);
  });

  test("403 when the drawing belongs to someone else", async () => {
    const auth = await registerAccount(h.authCfg, "a@b.com", "alice");
    await h.drawingStore.put(row({ drawing_id: "1".repeat(64), username: "bob" }));
    const res = await handleSetAvatar(
      { drawing_id: "1".repeat(64) },
      auth,
      h.authCfg,
    );
    assert.equal(res.status, 403);
  });

  test("200 happy path + cache invalidation fires for /u/<username>*", async () => {
    const auth = await registerAccount(h.authCfg, "a@b.com", "alice");
    await h.drawingStore.put(row({ drawing_id: "1".repeat(64), username: "alice" }));
    const res = await handleSetAvatar(
      { drawing_id: "1".repeat(64) },
      auth,
      h.authCfg,
    );
    assert.equal(res.status, 200);
    const body = res.body as {
      username: string;
      avatar_drawing_id: string | null;
    };
    assert.equal(body.username, "alice");
    assert.equal(body.avatar_drawing_id, "1".repeat(64));
    // Invalidation is fire-and-forget; await a microtask so the void promise
    // chain settles.
    await Promise.resolve();
    assert.deepEqual(h.invalidator.calls, [["/u/alice*"]]);
  });

  test("200 clear path with drawing_id: null wipes the avatar", async () => {
    const auth = await registerAccount(h.authCfg, "a@b.com", "alice");
    await h.drawingStore.put(row({ drawing_id: "1".repeat(64), username: "alice" }));
    await handleSetAvatar({ drawing_id: "1".repeat(64) }, auth, h.authCfg);
    const cleared = await handleSetAvatar({ drawing_id: null }, auth, h.authCfg);
    assert.equal(cleared.status, 200);
    const body = cleared.body as { avatar_drawing_id: string | null };
    assert.equal(body.avatar_drawing_id, null);
    const account = await h.userStore.getByEmail("a@b.com");
    assert.equal(account?.avatar_drawing_id, undefined);
  });
});

describe("renderProfilePageHandler — avatar plumbing", () => {
  test("populated profile renders the avatar img when one is set", async () => {
    const h = harness();
    const auth = await registerAccount(h.authCfg, "a@b.com", "alice");
    await h.drawingStore.put(
      row({ drawing_id: "a".repeat(64), username: "alice", user_id: auth.user_id }),
    );
    await handleSetAvatar({ drawing_id: "a".repeat(64) }, auth, h.authCfg);
    const res = await renderProfilePageHandler(h.renderCfg, "alice");
    assert.equal(res.status, 200);
    assert.match(
      res.body,
      new RegExp(`<img class="avatar" src="/tiles/${"a".repeat(64)}\\.gif"`),
    );
  });

  test("populated profile omits the avatar img when none is set", async () => {
    const h = harness();
    const auth = await registerAccount(h.authCfg, "a@b.com", "alice");
    await h.drawingStore.put(
      row({ drawing_id: "a".repeat(64), username: "alice", user_id: auth.user_id }),
    );
    const res = await renderProfilePageHandler(h.renderCfg, "alice");
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.body, /<img class="avatar"/);
  });

  test("empty profile (registered, no drawings) still renders + carries the avatar", async () => {
    const h = harness();
    // Set the avatar via the store directly so we can decouple from the
    // ownership rule (the publish would put a drawing row, which would
    // make the profile non-empty).
    await registerAccount(h.authCfg, "a@b.com", "alice");
    const account = await h.userStore.getByEmail("a@b.com");
    await h.userStore.setAvatar(account!.email, "a".repeat(64));
    const res = await renderProfilePageHandler(h.renderCfg, "alice");
    assert.equal(res.status, 200);
    assert.match(res.body, /No drawings published by this account yet/);
    assert.match(
      res.body,
      new RegExp(`<img class="avatar" src="/tiles/${"a".repeat(64)}\\.gif"`),
    );
  });

  test("404 for an empty profile when the account doesn't exist", async () => {
    const h = harness();
    const res = await renderProfilePageHandler(h.renderCfg, "ghost_user");
    assert.equal(res.status, 404);
  });
});

describe("renderDrawingPageHandler — avatar plumbing", () => {
  test("drawing-page renders the author avatar when the account has one", async () => {
    const h = harness();
    const auth = await registerAccount(h.authCfg, "a@b.com", "alice");
    const drawingId = "a".repeat(64);
    await h.drawingStore.put(
      row({ drawing_id: drawingId, username: "alice", user_id: auth.user_id }),
    );
    await handleSetAvatar({ drawing_id: drawingId }, auth, h.authCfg);
    const res = await renderDrawingPageHandler(h.renderCfg, drawingId);
    assert.equal(res.status, 200);
    assert.match(
      res.body,
      new RegExp(`<img class="avatar" src="/tiles/${drawingId}\\.gif"`),
    );
  });

  test("anonymous-bucketed drawings skip the avatar lookup entirely", async () => {
    const h = harness();
    const drawingId = "b".repeat(64);
    await h.drawingStore.put(
      row({ drawing_id: drawingId, username: "anonymous" }),
    );
    const res = await renderDrawingPageHandler(h.renderCfg, drawingId);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.body, /<img class="avatar"/);
  });
});
