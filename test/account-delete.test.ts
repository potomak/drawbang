import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleAdminDeleteAccount,
  handleDeleteAccount,
  handleLogin,
  handleRegister,
  type AuthHandlerConfig,
} from "../ingest/auth-handler.js";
import { MemoryUserStore } from "../ingest/user-store.js";
import { MemoryDrawingStore, type DrawingRow } from "../ingest/drawing-store.js";
import { NoopInvalidator } from "../ingest/cache-invalidation.js";
import { FsStorage } from "../ingest/storage.js";
import { ConsoleEmailSender } from "../ingest/email.js";
import { solvedPayload, testChallengeConfig } from "./support/challenge.js";

const PASSWORD = "correct-horse-battery";

async function makeConfig() {
  const dir = await mkdtemp(join(tmpdir(), "drawbang-acct-"));
  const storage = new FsStorage(dir);
  const userStore = new MemoryUserStore();
  const drawingStore = new MemoryDrawingStore();
  const inv = new NoopInvalidator();
  const cfg: AuthHandlerConfig = {
    userStore,
    drawingStore,
    storage,
    cacheInvalidator: inv,
    email: new ConsoleEmailSender(),
    jwtSecret: "account-delete-test",
    publicBaseUrl: "https://example.test",
    challenge: testChallengeConfig(),
  };
  return { dir, storage, userStore, drawingStore, inv, cfg };
}

async function register(cfg: AuthHandlerConfig, username: string) {
  const res = await handleRegister(
    {
      email: `${username}@example.com`,
      username,
      password: PASSWORD,
      altcha: await solvedPayload(cfg.challenge),
    },
    cfg,
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const body = res.body as { user_id: string; username: string };
  return { user_id: body.user_id, username: body.username };
}

function drawing(
  username: string,
  user_id: string,
  drawing_id: string,
): DrawingRow {
  const ms = Date.parse("2026-05-01T12:00:00.000Z");
  return {
    drawing_id,
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

// Seeds a drawing row plus the three objects a real publish would have
// written, so the cascade has something to actually remove.
async function seedDrawing(
  h: Awaited<ReturnType<typeof makeConfig>>,
  who: { username: string; user_id: string },
  drawing_id: string,
): Promise<void> {
  await h.drawingStore.put(drawing(who.username, who.user_id, drawing_id));
  for (const suffix of [".gif", "-large.gif", "-large.mp4"]) {
    await h.storage.put(
      `public/tiles/${drawing_id}${suffix}`,
      Buffer.from("x"),
      "application/octet-stream",
    );
  }
}

function id(n: number): string {
  return String(n).repeat(64).slice(0, 64);
}

describe("handleDeleteAccount — only ever the caller's own account", () => {
  test("deletes the caller's account and frees the handle", async () => {
    const h = await makeConfig();
    const alice = await register(h.cfg, "alice");
    const res = await handleDeleteAccount({ password: PASSWORD }, alice, h.cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      deleted: "alice",
      drawings_deleted: 0,
      cleared_objects: 0,
    });
    assert.equal(await h.userStore.getByUsername("alice"), null);
    assert.equal(await h.userStore.getByEmail("alice@example.com"), null);
    // Handle is free again — follow edges key on user_id, so a new account
    // taking the name inherits nothing from the old one.
    const res2 = await handleRegister(
      {
        email: "someoneelse@example.com",
        username: "alice",
        password: PASSWORD,
        altcha: await solvedPayload(h.cfg.challenge),
      },
      h.cfg,
    );
    assert.equal(res2.status, 201);
    await rm(h.dir, { recursive: true, force: true });
  });

  test("there is no parameter that points at another account", async () => {
    // The only identity input is the verified session; a body field named
    // like a target must be ignored entirely.
    const h = await makeConfig();
    const alice = await register(h.cfg, "alice");
    await register(h.cfg, "bob");
    const res = await handleDeleteAccount(
      { password: PASSWORD, username: "bob", user_id: "b".repeat(64) } as never,
      alice,
      h.cfg,
    );
    assert.equal(res.status, 200);
    assert.equal((res.body as { deleted: string }).deleted, "alice", "must delete the CALLER");
    assert.ok(await h.userStore.getByUsername("bob"), "bob must be untouched");
    assert.equal(await h.userStore.getByUsername("alice"), null);
    await rm(h.dir, { recursive: true, force: true });
  });

  test("a session whose user_id no longer matches the handle is refused", async () => {
    // Models a stale JWT for a deleted-then-recreated username.
    const h = await makeConfig();
    await register(h.cfg, "alice");
    const stale = { user_id: "f".repeat(64), username: "alice" };
    const res = await handleDeleteAccount({ password: PASSWORD }, stale, h.cfg);
    assert.equal(res.status, 401);
    await rm(h.dir, { recursive: true, force: true });
  });

  test("an unknown username is refused, not treated as already-deleted", async () => {
    const h = await makeConfig();
    const res = await handleDeleteAccount(
      { password: PASSWORD },
      { user_id: "f".repeat(64), username: "ghost" },
      h.cfg,
    );
    assert.equal(res.status, 401);
    await rm(h.dir, { recursive: true, force: true });
  });
});

describe("handleDeleteAccount — password confirmation", () => {
  test("the wrong password is refused and the account survives", async () => {
    const h = await makeConfig();
    const alice = await register(h.cfg, "alice");
    const res = await handleDeleteAccount({ password: "not-the-password" }, alice, h.cfg);
    assert.equal(res.status, 403);
    assert.ok(await h.userStore.getByUsername("alice"));
    await rm(h.dir, { recursive: true, force: true });
  });

  test("a missing or empty password is a 400 — a valid session alone isn't enough", async () => {
    const h = await makeConfig();
    const alice = await register(h.cfg, "alice");
    assert.equal((await handleDeleteAccount({}, alice, h.cfg)).status, 400);
    assert.equal((await handleDeleteAccount({ password: "" }, alice, h.cfg)).status, 400);
    assert.equal((await handleDeleteAccount({ password: 42 }, alice, h.cfg)).status, 400);
    assert.ok(await h.userStore.getByUsername("alice"));
    await rm(h.dir, { recursive: true, force: true });
  });

  test("the deleted account can no longer log in", async () => {
    const h = await makeConfig();
    const alice = await register(h.cfg, "alice");
    assert.equal((await handleDeleteAccount({ password: PASSWORD }, alice, h.cfg)).status, 200);
    const login = await handleLogin(
      { email: "alice@example.com", password: PASSWORD },
      h.cfg,
    );
    assert.equal(login.status, 401);
    await rm(h.dir, { recursive: true, force: true });
  });
});

describe("handleDeleteAccount — the drawings go too", () => {
  test("removes every drawing the account published, rows and objects", async () => {
    const h = await makeConfig();
    const alice = await register(h.cfg, "alice");
    await seedDrawing(h, alice, id(1));
    await seedDrawing(h, alice, id(2));

    const res = await handleDeleteAccount({ password: PASSWORD }, alice, h.cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      deleted: "alice",
      drawings_deleted: 2,
      cleared_objects: 6,
    });
    assert.equal(await h.drawingStore.get(id(1)), null);
    assert.equal(await h.drawingStore.get(id(2)), null);
    assert.equal(await h.storage.exists(`public/tiles/${id(1)}.gif`), false);
    assert.equal(await h.storage.exists(`public/tiles/${id(2)}-large.mp4`), false);
    await rm(h.dir, { recursive: true, force: true });
  });

  test("another account's drawings are untouched", async () => {
    const h = await makeConfig();
    const alice = await register(h.cfg, "alice");
    const bob = await register(h.cfg, "bob");
    await seedDrawing(h, alice, id(1));
    await seedDrawing(h, bob, id(2));

    assert.equal(
      (await handleDeleteAccount({ password: PASSWORD }, alice, h.cfg)).status,
      200,
    );
    assert.equal(await h.drawingStore.get(id(1)), null);
    assert.ok(await h.drawingStore.get(id(2)), "bob's drawing must survive");
    assert.equal(await h.storage.exists(`public/tiles/${id(2)}.gif`), true);
    await rm(h.dir, { recursive: true, force: true });
  });

  test("a refused delete removes nothing", async () => {
    const h = await makeConfig();
    const alice = await register(h.cfg, "alice");
    await seedDrawing(h, alice, id(1));
    assert.equal(
      (await handleDeleteAccount({ password: "wrong" }, alice, h.cfg)).status,
      403,
    );
    assert.ok(await h.drawingStore.get(id(1)));
    assert.equal(await h.storage.exists(`public/tiles/${id(1)}.gif`), true);
    await rm(h.dir, { recursive: true, force: true });
  });
});

describe("handleAdminDeleteAccount — operators can remove any account", () => {
  test("deletes the target account and its drawings", async () => {
    const h = await makeConfig();
    const bob = await register(h.cfg, "bob");
    await seedDrawing(h, bob, id(3));

    const res = await handleAdminDeleteAccount("bob", h.cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      deleted: "bob",
      drawings_deleted: 1,
      cleared_objects: 3,
    });
    assert.equal(await h.userStore.getByUsername("bob"), null);
    assert.equal(await h.drawingStore.get(id(3)), null);
    await rm(h.dir, { recursive: true, force: true });
  });

  test("no password is required — the allowlist is the gate", async () => {
    // The route-level allowlist check is what authorises this; the handler
    // deliberately takes no credential for the target, because an operator
    // doesn't have one.
    const h = await makeConfig();
    await register(h.cfg, "bob");
    assert.equal((await handleAdminDeleteAccount("bob", h.cfg)).status, 200);
    await rm(h.dir, { recursive: true, force: true });
  });

  test("unknown account is a 404", async () => {
    const h = await makeConfig();
    const res = await handleAdminDeleteAccount("ghost", h.cfg);
    assert.equal(res.status, 404);
    await rm(h.dir, { recursive: true, force: true });
  });

  test("an invalid username is a 400, not a lookup", async () => {
    const h = await makeConfig();
    assert.equal((await handleAdminDeleteAccount("A", h.cfg)).status, 400);
    assert.equal((await handleAdminDeleteAccount("has space", h.cfg)).status, 400);
    await rm(h.dir, { recursive: true, force: true });
  });

  test("the anonymous sentinel can't be deleted — it isn't an account", async () => {
    const h = await makeConfig();
    const res = await handleAdminDeleteAccount("anonymous", h.cfg);
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /byline/);
    await rm(h.dir, { recursive: true, force: true });
  });
});

describe("account delete — cache", () => {
  test("flushes the feed, the profile and each deleted drawing", async () => {
    const h = await makeConfig();
    const alice = await register(h.cfg, "alice");
    await seedDrawing(h, alice, id(1));
    await handleDeleteAccount({ password: PASSWORD }, alice, h.cfg);
    assert.equal(h.inv.calls.length, 1);
    const paths = h.inv.calls[0];
    assert.ok(paths.includes("/u/alice*"));
    assert.ok(paths.includes("/"));
    assert.ok(paths.includes("/feed.rss"));
    assert.ok(paths.includes(`/d/${id(1)}*`));
    await rm(h.dir, { recursive: true, force: true });
  });

  test("no cache churn when the delete is refused", async () => {
    const h = await makeConfig();
    const alice = await register(h.cfg, "alice");
    await handleDeleteAccount({ password: "wrong" }, alice, h.cfg);
    assert.deepEqual(h.inv.calls, []);
    await rm(h.dir, { recursive: true, force: true });
  });
});
