import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MemoryUserStore, type UserRecord } from "../ingest/user-store.js";
import {
  AlreadyFollowingError,
  MemoryFollowsStore,
  NotFollowingError,
  type FollowParty,
} from "../ingest/follows-store.js";

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

function party(r: UserRecord): FollowParty {
  return { user_id: r.user_id, username: r.username, email: r.email };
}

async function seed() {
  const users = new MemoryUserStore();
  const alice = await users.register(rec({
    email: "alice@example.com", user_id: "a".repeat(64), username: "alice",
  }));
  const bob = await users.register(rec({
    email: "bob@example.com", user_id: "b".repeat(64), username: "bob",
  }));
  const carol = await users.register(rec({
    email: "carol@example.com", user_id: "c".repeat(64), username: "carol",
  }));
  return { users, alice, bob, carol };
}

describe("MemoryFollowsStore", () => {
  test("follow bumps following_count on follower and follower_count on followee", async () => {
    const { users, alice, bob } = await seed();
    const follows = new MemoryFollowsStore(users);
    await follows.follow({ follower: party(alice), followee: party(bob), created_at_ms: 1 });

    const a = await users.getByEmail("alice@example.com");
    const b = await users.getByEmail("bob@example.com");
    assert.equal(a?.following_count, 1);
    assert.equal(a?.follower_count, undefined);
    assert.equal(b?.follower_count, 1);
    assert.equal(b?.following_count, undefined);
  });

  test("a duplicate follow is rejected (AlreadyFollowingError)", async () => {
    const { users, alice, bob } = await seed();
    const follows = new MemoryFollowsStore(users);
    await follows.follow({ follower: party(alice), followee: party(bob), created_at_ms: 1 });
    await assert.rejects(
      follows.follow({ follower: party(alice), followee: party(bob), created_at_ms: 2 }),
      AlreadyFollowingError,
    );
    // The double-follow attempt must not bump the counters again.
    const b = await users.getByEmail("bob@example.com");
    assert.equal(b?.follower_count, 1);
  });

  test("unfollow without a prior follow rejects with NotFollowingError", async () => {
    const { users, alice, bob } = await seed();
    const follows = new MemoryFollowsStore(users);
    await assert.rejects(
      follows.unfollow({ follower: party(alice), followee: party(bob) }),
      NotFollowingError,
    );
  });

  test("unfollow → refollow leaves the counters consistent (count = 1)", async () => {
    const { users, alice, bob } = await seed();
    const follows = new MemoryFollowsStore(users);
    await follows.follow({ follower: party(alice), followee: party(bob), created_at_ms: 1 });
    await follows.unfollow({ follower: party(alice), followee: party(bob) });
    await follows.follow({ follower: party(alice), followee: party(bob), created_at_ms: 3 });

    const a = await users.getByEmail("alice@example.com");
    const b = await users.getByEmail("bob@example.com");
    assert.equal(a?.following_count, 1);
    assert.equal(b?.follower_count, 1);
  });

  test("counters clamp at 0 even with stray unfollows", async () => {
    const { users, alice, bob } = await seed();
    const follows = new MemoryFollowsStore(users);
    await follows.follow({ follower: party(alice), followee: party(bob), created_at_ms: 1 });
    await follows.unfollow({ follower: party(alice), followee: party(bob) });
    // A second unfollow throws — counters don't move.
    await assert.rejects(
      follows.unfollow({ follower: party(alice), followee: party(bob) }),
      NotFollowingError,
    );
    const a = await users.getByEmail("alice@example.com");
    assert.equal(a?.following_count, 0);
  });

  test("listFollowed returns only the subset the viewer follows", async () => {
    const { users, alice, bob, carol } = await seed();
    const follows = new MemoryFollowsStore(users);
    await follows.follow({ follower: party(alice), followee: party(bob), created_at_ms: 1 });
    await follows.follow({ follower: party(alice), followee: party(carol), created_at_ms: 2 });
    await follows.follow({ follower: party(bob), followee: party(carol), created_at_ms: 3 });

    const sub = await follows.listFollowed(alice.user_id, [bob.user_id, carol.user_id]);
    assert.deepEqual(sub.sort(), [bob.user_id, carol.user_id].sort());

    const notMine = await follows.listFollowed(carol.user_id, [bob.user_id, alice.user_id]);
    assert.deepEqual(notMine, []);
  });

  test("listFollowers returns newest-first edges keyed on the followee", async () => {
    const { users, alice, bob, carol } = await seed();
    const follows = new MemoryFollowsStore(users);
    await follows.follow({ follower: party(alice), followee: party(carol), created_at_ms: 10 });
    await follows.follow({ follower: party(bob), followee: party(carol), created_at_ms: 20 });

    const page = await follows.listFollowers(carol.user_id, { limit: 10 });
    assert.equal(page.items.length, 2);
    // Bob came in last → bob first.
    assert.equal(page.items[0].follower_username, "bob");
    assert.equal(page.items[1].follower_username, "alice");
  });

  test("listFollowing returns newest-first edges keyed on the follower", async () => {
    const { users, alice, bob, carol } = await seed();
    const follows = new MemoryFollowsStore(users);
    await follows.follow({ follower: party(alice), followee: party(bob), created_at_ms: 10 });
    await follows.follow({ follower: party(alice), followee: party(carol), created_at_ms: 20 });

    const page = await follows.listFollowing(alice.user_id, { limit: 10 });
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0].followee_username, "carol");
    assert.equal(page.items[1].followee_username, "bob");
  });

  test("listFollowing paginates with a cursor", async () => {
    const { users, alice, bob, carol } = await seed();
    const dan = await users.register(rec({
      email: "dan@example.com", user_id: "d".repeat(64), username: "dan",
    }));
    const follows = new MemoryFollowsStore(users);
    await follows.follow({ follower: party(alice), followee: party(bob), created_at_ms: 10 });
    await follows.follow({ follower: party(alice), followee: party(carol), created_at_ms: 20 });
    await follows.follow({ follower: party(alice), followee: party(dan), created_at_ms: 30 });

    const p1 = await follows.listFollowing(alice.user_id, { limit: 2 });
    assert.equal(p1.items.length, 2);
    assert.ok(p1.next_cursor, "page 1 must hand out a cursor");
    const p2 = await follows.listFollowing(alice.user_id, { limit: 2, cursor: p1.next_cursor! });
    assert.equal(p2.items.length, 1);
    assert.equal(p2.next_cursor, null);
    // No overlap between pages.
    const ids1 = p1.items.map((e) => e.followee_user_id).sort();
    const ids2 = p2.items.map((e) => e.followee_user_id).sort();
    for (const id of ids2) assert.ok(!ids1.includes(id));
  });
});
