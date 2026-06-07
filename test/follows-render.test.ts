import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MemoryUserStore, type UserRecord } from "../ingest/user-store.js";
import { MemoryFollowsStore } from "../ingest/follows-store.js";
import { MemoryDrawingStore } from "../ingest/drawing-store.js";
import {
  renderFollowersPageHandler,
  renderFollowingPageHandler,
  renderFollowThumbsHandler,
  renderProfilePageHandler,
  type RenderHandlersConfig,
} from "../ingest/render-handlers.js";

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
  cfg: RenderHandlersConfig;
  userStore: MemoryUserStore;
  followsStore: MemoryFollowsStore;
}> {
  const userStore = new MemoryUserStore();
  await userStore.register(rec({ email: "alice@example.com", user_id: "a".repeat(64), username: "alice" }));
  await userStore.register(rec({ email: "bob@example.com",   user_id: "b".repeat(64), username: "bob" }));
  await userStore.register(rec({ email: "carol@example.com", user_id: "c".repeat(64), username: "carol" }));
  const followsStore = new MemoryFollowsStore(userStore);
  const drawingStore = new MemoryDrawingStore();
  return {
    userStore,
    followsStore,
    cfg: {
      drawingStore,
      userStore,
      followsStore,
      publicBaseUrl: "https://draw.example",
      repoUrl: "https://github.com/test/test",
      perPage: 10,
    },
  };
}

describe("profile renders social block", () => {
  test("Follow button + zero counts when no follows yet", async () => {
    const { cfg } = await makeConfig();
    const res = await renderProfilePageHandler(cfg, "alice");
    assert.equal(res.status, 200);
    assert.match(res.body, /class="ow-social"/);
    assert.match(res.body, /data-follow-target="alice"/);
    assert.match(res.body, /data-follower-count>0</);
    assert.match(res.body, /data-following-count>0</);
  });

  test("counts reflect actual follow state", async () => {
    const { cfg, followsStore, userStore } = await makeConfig();
    const alice = await userStore.getByEmail("alice@example.com");
    const bob = await userStore.getByEmail("bob@example.com");
    const carol = await userStore.getByEmail("carol@example.com");
    await followsStore.follow({
      follower: { user_id: bob!.user_id, username: bob!.username, email: bob!.email },
      followee: { user_id: alice!.user_id, username: alice!.username, email: alice!.email },
      created_at_ms: 1,
    });
    await followsStore.follow({
      follower: { user_id: carol!.user_id, username: carol!.username, email: carol!.email },
      followee: { user_id: alice!.user_id, username: alice!.username, email: alice!.email },
      created_at_ms: 2,
    });
    await followsStore.follow({
      follower: { user_id: alice!.user_id, username: alice!.username, email: alice!.email },
      followee: { user_id: bob!.user_id, username: bob!.username, email: bob!.email },
      created_at_ms: 3,
    });
    const res = await renderProfilePageHandler(cfg, "alice");
    assert.match(res.body, /data-follower-count>2</);
    assert.match(res.body, /data-following-count>1</);
  });

  test("anonymous profile bucket suppresses the social block", async () => {
    const { cfg } = await makeConfig();
    // The drawing store is empty so /u/anonymous resolves only if there's
    // a registered account row. None exists → 404 expected. Re-check with
    // a registered "anonymous" account would still suppress, but that
    // user is reserved.
    const res = await renderProfilePageHandler(cfg, "anonymous");
    assert.equal(res.status, 404);
  });

  test("profile loads /follow.js so the button gets wired", async () => {
    const { cfg } = await makeConfig();
    const res = await renderProfilePageHandler(cfg, "alice");
    assert.match(res.body, /<script src="\/follow\.js"><\/script>/);
  });

  test("owner-only Bookmarks + Edit profile links live in a single row tagged for chrome-identity.js", async () => {
    const { cfg } = await makeConfig();
    const res = await renderProfilePageHandler(cfg, "alice");
    // Both owner-only links now share one wrapper so they wrap as a
    // unit on narrow viewports and ship/reveal together.
    assert.match(
      res.body,
      /<div class="ow-owner-actions" data-owner-only-for="alice" hidden>/,
    );
    assert.match(
      res.body,
      /<a class="ow-owner-link" href="\/u\/alice\/bookmarks">Bookmarks<\/a>/,
    );
    assert.match(
      res.body,
      /<a class="ow-owner-link" href="\/account">Edit profile<\/a>/,
    );
  });
});

describe("renderFollowersPageHandler", () => {
  test("empty list renders the empty-state copy", async () => {
    const { cfg } = await makeConfig();
    const res = await renderFollowersPageHandler(cfg, "alice");
    assert.equal(res.status, 200);
    assert.match(res.body, /No followers yet/);
  });

  test("renders one card per follower, newest-first", async () => {
    const { cfg, followsStore, userStore } = await makeConfig();
    const alice = await userStore.getByEmail("alice@example.com");
    const bob = await userStore.getByEmail("bob@example.com");
    const carol = await userStore.getByEmail("carol@example.com");
    await followsStore.follow({
      follower: { user_id: bob!.user_id, username: bob!.username, email: bob!.email },
      followee: { user_id: alice!.user_id, username: alice!.username, email: alice!.email },
      created_at_ms: 10,
    });
    await followsStore.follow({
      follower: { user_id: carol!.user_id, username: carol!.username, email: carol!.email },
      followee: { user_id: alice!.user_id, username: alice!.username, email: alice!.email },
      created_at_ms: 20,
    });
    const res = await renderFollowersPageHandler(cfg, "alice");
    assert.equal(res.status, 200);
    assert.match(res.body, /class="follow-card"/);
    // Carol followed last → carol's card before bob's.
    const c = res.body.indexOf(">carol<");
    const b = res.body.indexOf(">bob<");
    assert.ok(c > -1 && b > -1 && c < b, "carol's card must come before bob's");
  });

  test("renders the profile picture gif when the account has one, placeholder when not", async () => {
    const { cfg, followsStore, userStore } = await makeConfig();
    const alice = await userStore.getByEmail("alice@example.com");
    const bob = await userStore.getByEmail("bob@example.com");
    const carol = await userStore.getByEmail("carol@example.com");
    const bobProfilePicture = "b".repeat(64);
    await userStore.setProfilePicture(bob!.email, bobProfilePicture);
    await followsStore.follow({
      follower: { user_id: bob!.user_id, username: bob!.username, email: bob!.email },
      followee: { user_id: alice!.user_id, username: alice!.username, email: alice!.email },
      created_at_ms: 10,
    });
    await followsStore.follow({
      follower: { user_id: carol!.user_id, username: carol!.username, email: carol!.email },
      followee: { user_id: alice!.user_id, username: alice!.username, email: alice!.email },
      created_at_ms: 20,
    });
    const res = await renderFollowersPageHandler(cfg, "alice");
    assert.equal(res.status, 200);
    // Bob has a profile picture → real <img>, not the placeholder span.
    assert.match(
      res.body,
      new RegExp(`<img class="profile-picture" src="/tiles/${bobProfilePicture}\\.gif"`),
    );
    // Carol has no profile picture → placeholder with her initial, tagged
    // for /hydrate.js so it can swap in a real <img> if she sets one later.
    assert.match(
      res.body,
      /<span class="profile-picture profile-picture-placeholder" aria-hidden="true" data-profile-picture-username="carol" data-profile-picture-size="44">C<\/span>/,
    );
  });

  test("invalid username gets a 404", async () => {
    const { cfg } = await makeConfig();
    const res = await renderFollowersPageHandler(cfg, "BAD!user");
    assert.equal(res.status, 404);
  });

  test("unknown account gets a 404", async () => {
    const { cfg } = await makeConfig();
    const res = await renderFollowersPageHandler(cfg, "ghost");
    assert.equal(res.status, 404);
  });

  test("a missing followsStore in the config falls through to 404", async () => {
    const drawingStore = new MemoryDrawingStore();
    const userStore = new MemoryUserStore();
    await userStore.register(rec());
    const cfg: RenderHandlersConfig = {
      drawingStore, userStore,
      publicBaseUrl: "https://draw.example",
      repoUrl: "https://github.com/test/test",
    };
    const res = await renderFollowersPageHandler(cfg, "alice");
    assert.equal(res.status, 404);
  });
});

describe("renderFollowingPageHandler", () => {
  test("renders newest-followed-first", async () => {
    const { cfg, followsStore, userStore } = await makeConfig();
    const alice = await userStore.getByEmail("alice@example.com");
    const bob = await userStore.getByEmail("bob@example.com");
    const carol = await userStore.getByEmail("carol@example.com");
    await followsStore.follow({
      follower: { user_id: alice!.user_id, username: alice!.username, email: alice!.email },
      followee: { user_id: bob!.user_id, username: bob!.username, email: bob!.email },
      created_at_ms: 10,
    });
    await followsStore.follow({
      follower: { user_id: alice!.user_id, username: alice!.username, email: alice!.email },
      followee: { user_id: carol!.user_id, username: carol!.username, email: carol!.email },
      created_at_ms: 20,
    });
    const res = await renderFollowingPageHandler(cfg, "alice");
    assert.equal(res.status, 200);
    const c = res.body.indexOf(">carol<");
    const b = res.body.indexOf(">bob<");
    assert.ok(c > -1 && b > -1 && c < b);
  });

  test("empty list renders 'Not following anyone yet.'", async () => {
    const { cfg } = await makeConfig();
    const res = await renderFollowingPageHandler(cfg, "alice");
    assert.equal(res.status, 200);
    assert.match(res.body, /Not following anyone yet/);
  });
});

describe("renderFollowThumbsHandler", () => {
  test("returns JSON with followers + following usernames", async () => {
    const { cfg, followsStore, userStore } = await makeConfig();
    const alice = (await userStore.getByEmail("alice@example.com"))!;
    const bob = (await userStore.getByEmail("bob@example.com"))!;
    const carol = (await userStore.getByEmail("carol@example.com"))!;
    await followsStore.follow({
      follower: { user_id: bob.user_id, username: bob.username, email: bob.email },
      followee: { user_id: alice.user_id, username: alice.username, email: alice.email },
      created_at_ms: 10,
    });
    await followsStore.follow({
      follower: { user_id: carol.user_id, username: carol.username, email: carol.email },
      followee: { user_id: alice.user_id, username: alice.username, email: alice.email },
      created_at_ms: 20,
    });
    await followsStore.follow({
      follower: { user_id: alice.user_id, username: alice.username, email: alice.email },
      followee: { user_id: bob.user_id, username: bob.username, email: bob.email },
      created_at_ms: 30,
    });
    const res = await renderFollowThumbsHandler(cfg, "alice", "6");
    assert.equal(res.status, 200);
    assert.equal(res.contentType, "application/json; charset=utf-8");
    const body = JSON.parse(res.body);
    assert.deepEqual(body.followers.sort(), ["bob", "carol"]);
    assert.deepEqual(body.following, ["bob"]);
  });

  test("limit caps the number of usernames per direction", async () => {
    const { cfg, followsStore, userStore } = await makeConfig();
    const alice = (await userStore.getByEmail("alice@example.com"))!;
    for (let i = 0; i < 5; i++) {
      const un = `user${i}`;
      const email = `${un}@example.com`;
      const uid = String(i).repeat(64).slice(0, 64);
      await userStore.register(rec({ email, user_id: uid, username: un }));
      const u = (await userStore.getByEmail(email))!;
      await followsStore.follow({
        follower: { user_id: u.user_id, username: u.username, email: u.email },
        followee: { user_id: alice.user_id, username: alice.username, email: alice.email },
        created_at_ms: 100 + i,
      });
    }
    const res = await renderFollowThumbsHandler(cfg, "alice", "3");
    const body = JSON.parse(res.body);
    assert.equal(body.followers.length, 3);
  });

  test("404 for an unknown user", async () => {
    const { cfg } = await makeConfig();
    const res = await renderFollowThumbsHandler(cfg, "nobody", "6");
    assert.equal(res.status, 404);
  });

  test("defaults to 6 when limit is missing", async () => {
    const { cfg, followsStore, userStore } = await makeConfig();
    const alice = (await userStore.getByEmail("alice@example.com"))!;
    for (let i = 0; i < 10; i++) {
      const un = `user${i}`;
      const email = `${un}@example.com`;
      const uid = String(i).repeat(64).slice(0, 64);
      await userStore.register(rec({ email, user_id: uid, username: un }));
      const u = (await userStore.getByEmail(email))!;
      await followsStore.follow({
        follower: { user_id: u.user_id, username: u.username, email: u.email },
        followee: { user_id: alice.user_id, username: alice.username, email: alice.email },
        created_at_ms: 100 + i,
      });
    }
    const res = await renderFollowThumbsHandler(cfg, "alice", null);
    const body = JSON.parse(res.body);
    assert.equal(body.followers.length, 6);
  });
});
