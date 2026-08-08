import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  handleDeleteAccount,
  handleLogin,
  handleRegister,
  type AuthHandlerConfig,
} from "../ingest/auth-handler.js";
import { MemoryUserStore } from "../ingest/user-store.js";
import { MemoryDrawingStore, type DrawingRow } from "../ingest/drawing-store.js";
import { NoopInvalidator } from "../ingest/cache-invalidation.js";
import { ConsoleEmailSender } from "../ingest/email.js";

const PASSWORD = "correct-horse-battery";

function makeConfig() {
  const userStore = new MemoryUserStore();
  const drawingStore = new MemoryDrawingStore();
  const inv = new NoopInvalidator();
  const cfg: AuthHandlerConfig = {
    userStore,
    drawingStore,
    cacheInvalidator: inv,
    email: new ConsoleEmailSender(),
    jwtSecret: "account-delete-test",
    publicBaseUrl: "https://example.test",
  };
  return { userStore, drawingStore, inv, cfg };
}

async function register(cfg: AuthHandlerConfig, username: string) {
  const res = await handleRegister(
    { email: `${username}@example.com`, username, password: PASSWORD },
    cfg,
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const body = res.body as { user_id: string; username: string };
  return { user_id: body.user_id, username: body.username };
}

function drawing(username: string, user_id: string): DrawingRow {
  const ms = Date.parse("2026-05-01T12:00:00.000Z");
  return {
    drawing_id: "a".repeat(64),
    size: 16,
    created_at: new Date(ms).toISOString(),
    created_at_ms: ms,
    user_id,
    username,
    parent_id: null,
    frames: 1,
    gif_size_bytes: 100,
  };
}

describe("handleDeleteAccount — only ever the caller's own account", () => {
  test("deletes the caller's account and frees the handle", async () => {
    const { userStore, cfg } = makeConfig();
    const alice = await register(cfg, "alice");
    const res = await handleDeleteAccount({ password: PASSWORD }, alice, cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { deleted: "alice" });
    assert.equal(await userStore.getByUsername("alice"), null);
    assert.equal(await userStore.getByEmail("alice@example.com"), null);
    // Handle is free again — follow edges key on user_id, so a new account
    // taking the name inherits nothing from the old one.
    const res2 = await handleRegister(
      { email: "someoneelse@example.com", username: "alice", password: PASSWORD },
      cfg,
    );
    assert.equal(res2.status, 201);
  });

  test("there is no parameter that points at another account", async () => {
    // The only identity input is the verified session; a body field named
    // like a target must be ignored entirely.
    const { userStore, cfg } = makeConfig();
    const alice = await register(cfg, "alice");
    await register(cfg, "bob");
    const res = await handleDeleteAccount(
      { password: PASSWORD, username: "bob", user_id: "b".repeat(64) } as never,
      alice,
      cfg,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { deleted: "alice" }, "must delete the CALLER");
    assert.ok(await userStore.getByUsername("bob"), "bob must be untouched");
    assert.equal(await userStore.getByUsername("alice"), null);
  });

  test("a session whose user_id no longer matches the handle is refused", async () => {
    // Models a stale JWT for a deleted-then-recreated username.
    const { cfg } = makeConfig();
    await register(cfg, "alice");
    const stale = { user_id: "f".repeat(64), username: "alice" };
    const res = await handleDeleteAccount({ password: PASSWORD }, stale, cfg);
    assert.equal(res.status, 401);
  });

  test("an unknown username is refused, not treated as already-deleted", async () => {
    const { cfg } = makeConfig();
    const res = await handleDeleteAccount(
      { password: PASSWORD },
      { user_id: "f".repeat(64), username: "ghost" },
      cfg,
    );
    assert.equal(res.status, 401);
  });
});

describe("handleDeleteAccount — password confirmation", () => {
  test("the wrong password is refused and the account survives", async () => {
    const { userStore, cfg } = makeConfig();
    const alice = await register(cfg, "alice");
    const res = await handleDeleteAccount({ password: "not-the-password" }, alice, cfg);
    assert.equal(res.status, 403);
    assert.ok(await userStore.getByUsername("alice"));
  });

  test("a missing or empty password is a 400 — a valid session alone isn't enough", async () => {
    const { userStore, cfg } = makeConfig();
    const alice = await register(cfg, "alice");
    assert.equal((await handleDeleteAccount({}, alice, cfg)).status, 400);
    assert.equal((await handleDeleteAccount({ password: "" }, alice, cfg)).status, 400);
    assert.equal((await handleDeleteAccount({ password: 42 }, alice, cfg)).status, 400);
    assert.ok(await userStore.getByUsername("alice"));
  });

  test("the deleted account can no longer log in", async () => {
    const { cfg } = makeConfig();
    const alice = await register(cfg, "alice");
    assert.equal((await handleDeleteAccount({ password: PASSWORD }, alice, cfg)).status, 200);
    const login = await handleLogin(
      { email: "alice@example.com", password: PASSWORD },
      cfg,
    );
    assert.equal(login.status, 401);
  });
});

describe("handleDeleteAccount — refuses while drawings remain", () => {
  test("409 when the account still owns a drawing, and nothing is deleted", async () => {
    const { userStore, drawingStore, cfg } = makeConfig();
    const alice = await register(cfg, "alice");
    await drawingStore.put(drawing("alice", alice.user_id));
    const res = await handleDeleteAccount({ password: PASSWORD }, alice, cfg);
    assert.equal(res.status, 409);
    assert.match((res.body as { error: string }).error, /drawings/);
    assert.ok(await userStore.getByUsername("alice"), "account must survive");
  });

  test("succeeds once the drawings are gone", async () => {
    const { userStore, drawingStore, cfg } = makeConfig();
    const alice = await register(cfg, "alice");
    await drawingStore.put(drawing("alice", alice.user_id));
    assert.equal((await handleDeleteAccount({ password: PASSWORD }, alice, cfg)).status, 409);
    await drawingStore.remove("a".repeat(64));
    assert.equal((await handleDeleteAccount({ password: PASSWORD }, alice, cfg)).status, 200);
    assert.equal(await userStore.getByUsername("alice"), null);
  });

  test("another user's drawings don't block the caller", async () => {
    const { drawingStore, cfg } = makeConfig();
    const alice = await register(cfg, "alice");
    const bob = await register(cfg, "bob");
    await drawingStore.put(drawing("bob", bob.user_id));
    assert.equal((await handleDeleteAccount({ password: PASSWORD }, alice, cfg)).status, 200);
  });
});

describe("handleDeleteAccount — cache", () => {
  test("flushes the profile so the edge stops serving it", async () => {
    const { inv, cfg } = makeConfig();
    const alice = await register(cfg, "alice");
    await handleDeleteAccount({ password: PASSWORD }, alice, cfg);
    assert.deepEqual(inv.calls, [["/u/alice*"]]);
  });

  test("no cache churn when the delete is refused", async () => {
    const { inv, cfg } = makeConfig();
    const alice = await register(cfg, "alice");
    await handleDeleteAccount({ password: "wrong" }, alice, cfg);
    assert.deepEqual(inv.calls, []);
  });
});
