import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MemoryUserStore, type UserRecord } from "../ingest/user-store.js";
import { MemoryFollowsStore } from "../ingest/follows-store.js";
import {
  handleFollow,
  handleMyFollows,
  handleUnfollow,
  type FollowsHandlerConfig,
} from "../ingest/follows-handler.js";

function rec(over: Partial<UserRecord> = {}): UserRecord {
  return {
    email: over.email ?? "alice@example.com",
    user_id: over.user_id ?? "a".repeat(64),
    username: over.username ?? "alice",
    password_hash: "scrypt$x$y",
    token_version: 0,
    created_at: "2026-05-01T00:00:00.000Z",
  };
}

async function makeConfig(): Promise<{
  cfg: FollowsHandlerConfig;
  userStore: MemoryUserStore;
  alice: UserRecord;
  bob: UserRecord;
  carol: UserRecord;
}> {
  const userStore = new MemoryUserStore();
  const alice = await userStore.register(rec({
    email: "alice@example.com", user_id: "a".repeat(64), username: "alice",
  }));
  const bob = await userStore.register(rec({
    email: "bob@example.com", user_id: "b".repeat(64), username: "bob",
  }));
  const carol = await userStore.register(rec({
    email: "carol@example.com", user_id: "c".repeat(64), username: "carol",
  }));
  const followsStore = new MemoryFollowsStore(userStore);
  return {
    cfg: { followsStore, userStore, now: () => new Date(1000) },
    userStore,
    alice, bob, carol,
  };
}

const AUTH_ALICE = { user_id: "a".repeat(64), username: "alice" };

describe("handleFollow", () => {
  test("happy path: 200 + counters bumped", async () => {
    const { cfg, userStore } = await makeConfig();
    const res = await handleFollow("bob", AUTH_ALICE, cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    const a = await userStore.getByEmail("alice@example.com");
    const b = await userStore.getByEmail("bob@example.com");
    assert.equal(a?.following_count, 1);
    assert.equal(b?.follower_count, 1);
  });

  test("self-follow is rejected with 400", async () => {
    const { cfg } = await makeConfig();
    const res = await handleFollow("alice", AUTH_ALICE, cfg);
    assert.equal(res.status, 400);
  });

  test("following a missing user returns 404", async () => {
    const { cfg } = await makeConfig();
    const res = await handleFollow("nobody", AUTH_ALICE, cfg);
    assert.equal(res.status, 404);
  });

  test("a double-follow returns 409", async () => {
    const { cfg } = await makeConfig();
    await handleFollow("bob", AUTH_ALICE, cfg);
    const res = await handleFollow("bob", AUTH_ALICE, cfg);
    assert.equal(res.status, 409);
  });

  test("invalid target username returns 400", async () => {
    const { cfg } = await makeConfig();
    const res = await handleFollow("BAD!user", AUTH_ALICE, cfg);
    assert.equal(res.status, 400);
  });

  test("stale JWT for a deleted account returns 401", async () => {
    const { cfg } = await makeConfig();
    const ghost = { user_id: "z".repeat(64), username: "ghost" };
    const res = await handleFollow("bob", ghost, cfg);
    assert.equal(res.status, 401);
  });
});

describe("handleUnfollow", () => {
  test("happy path: 200 + counters decremented", async () => {
    const { cfg, userStore } = await makeConfig();
    await handleFollow("bob", AUTH_ALICE, cfg);
    const res = await handleUnfollow("bob", AUTH_ALICE, cfg);
    assert.equal(res.status, 200);
    const a = await userStore.getByEmail("alice@example.com");
    const b = await userStore.getByEmail("bob@example.com");
    assert.equal(a?.following_count, 0);
    assert.equal(b?.follower_count, 0);
  });

  test("unfollow without a prior follow returns 409", async () => {
    const { cfg } = await makeConfig();
    const res = await handleUnfollow("bob", AUTH_ALICE, cfg);
    assert.equal(res.status, 409);
  });

  test("self-unfollow is rejected with 400", async () => {
    const { cfg } = await makeConfig();
    const res = await handleUnfollow("alice", AUTH_ALICE, cfg);
    assert.equal(res.status, 400);
  });

  test("unfollow → refollow round-trip leaves counts at 1", async () => {
    const { cfg, userStore } = await makeConfig();
    await handleFollow("bob", AUTH_ALICE, cfg);
    await handleUnfollow("bob", AUTH_ALICE, cfg);
    await handleFollow("bob", AUTH_ALICE, cfg);
    const a = await userStore.getByEmail("alice@example.com");
    const b = await userStore.getByEmail("bob@example.com");
    assert.equal(a?.following_count, 1);
    assert.equal(b?.follower_count, 1);
  });
});

describe("handleMyFollows", () => {
  test("returns only the targets the caller follows", async () => {
    const { cfg } = await makeConfig();
    await handleFollow("bob", AUTH_ALICE, cfg);
    const res = await handleMyFollows("bob,carol", AUTH_ALICE, cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { following: ["bob"] });
    assert.match(res.headers?.["Cache-Control"] ?? "", /no-store/);
  });

  test("empty targets returns empty array", async () => {
    const { cfg } = await makeConfig();
    const res = await handleMyFollows("", AUTH_ALICE, cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { following: [] });
  });

  test("missing targets returns empty array", async () => {
    const { cfg } = await makeConfig();
    const res = await handleMyFollows(null, AUTH_ALICE, cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { following: [] });
  });

  test("invalid username in csv returns 400", async () => {
    const { cfg } = await makeConfig();
    const res = await handleMyFollows("bob,BAD!user", AUTH_ALICE, cfg);
    assert.equal(res.status, 400);
  });

  test("unknown usernames are silently dropped from the response", async () => {
    const { cfg } = await makeConfig();
    await handleFollow("bob", AUTH_ALICE, cfg);
    const res = await handleMyFollows("bob,nobody", AUTH_ALICE, cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { following: ["bob"] });
  });

  test(">100 targets returns 400 (BatchGet cap)", async () => {
    const { cfg } = await makeConfig();
    const targets = Array.from({ length: 101 }, (_, i) => `user${i}`);
    const res = await handleMyFollows(targets.join(","), AUTH_ALICE, cfg);
    assert.equal(res.status, 400);
  });
});
