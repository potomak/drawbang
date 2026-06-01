import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MemoryDrawingStore, type DrawingRow } from "../ingest/drawing-store.js";
import { MemoryLikesStore } from "../ingest/likes-store.js";
import { MemoryBookmarksStore } from "../ingest/bookmarks-store.js";
import { MemoryFollowsStore } from "../ingest/follows-store.js";
import { MemoryUserStore, type UserRecord } from "../ingest/user-store.js";
import {
  handleHydrate,
  type HydrateBody,
  type HydrateHandlerConfig,
} from "../ingest/hydrate-handler.js";

const D1 = "a".repeat(64);
const D2 = "b".repeat(64);
const D3 = "c".repeat(64);

function row(over: Partial<DrawingRow> = {}): DrawingRow {
  const ms = over.created_at_ms ?? Date.parse("2026-05-01T12:00:00.000Z");
  return {
    drawing_id: over.drawing_id ?? D1,
    size: 16,
    created_at: new Date(ms).toISOString(),
    created_at_ms: ms,
    user_id: over.user_id ?? "x".repeat(64),
    username: over.username ?? "bob",
    parent_id: null,
    frames: 1,
    gif_size_bytes: 1234,
    ...over,
  };
}

function rec(over: Partial<UserRecord> = {}): UserRecord {
  return {
    email: over.email ?? "alice@example.com",
    user_id: over.user_id ?? "u".repeat(64),
    username: over.username ?? "alice",
    password_hash: "scrypt$x$y",
    token_version: 0,
    created_at: "2026-05-01T00:00:00.000Z",
    ...over,
  };
}

async function makeConfig(): Promise<{
  cfg: HydrateHandlerConfig;
  drawingStore: MemoryDrawingStore;
  userStore: MemoryUserStore;
  likesStore: MemoryLikesStore;
  bookmarksStore: MemoryBookmarksStore;
  followsStore: MemoryFollowsStore;
}> {
  const drawingStore = new MemoryDrawingStore();
  const likesStore = new MemoryLikesStore(drawingStore);
  const bookmarksStore = new MemoryBookmarksStore(drawingStore);
  const userStore = new MemoryUserStore();
  const followsStore = new MemoryFollowsStore(userStore);
  return {
    cfg: { likesStore, bookmarksStore, followsStore, userStore },
    drawingStore,
    userStore,
    likesStore,
    bookmarksStore,
    followsStore,
  };
}

describe("handleHydrate — input validation", () => {
  test("empty query → 200 with empty maps", async () => {
    const { cfg } = await makeConfig();
    const res = await handleHydrate(null, null, null, cfg);
    assert.equal(res.status, 200);
    const body = res.body as HydrateBody;
    assert.deepEqual(body, { drawings: {}, users: {} });
    assert.equal(res.headers?.["Cache-Control"], "no-store");
  });

  test("malformed drawing id → 400", async () => {
    const { cfg } = await makeConfig();
    const res = await handleHydrate("not-hex", null, null, cfg);
    assert.equal(res.status, 400);
  });

  test("malformed username → 400", async () => {
    const { cfg } = await makeConfig();
    const res = await handleHydrate(null, "Bad!User", null, cfg);
    assert.equal(res.status, 400);
  });

  test(">100 drawings → 400", async () => {
    const { cfg } = await makeConfig();
    const csv = Array.from({ length: 101 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    ).join(",");
    const res = await handleHydrate(csv, null, null, cfg);
    assert.equal(res.status, 400);
  });

  test(">100 usernames → 400", async () => {
    const { cfg } = await makeConfig();
    const csv = Array.from({ length: 101 }, (_, i) => `user_${i}`).join(",");
    const res = await handleHydrate(null, csv, null, cfg);
    assert.equal(res.status, 400);
  });
});

describe("handleHydrate — public mode (no JWT)", () => {
  test("drawings: returns like_count, viewer_* fields null", async () => {
    const { cfg, drawingStore, likesStore } = await makeConfig();
    await drawingStore.put(row({ drawing_id: D1 }));
    await drawingStore.put(row({ drawing_id: D2 }));
    await likesStore.like({
      drawing_id: D1,
      user_id: "v".repeat(64),
      created_at_ms: 1,
    });
    await likesStore.like({
      drawing_id: D1,
      user_id: "w".repeat(64),
      created_at_ms: 2,
    });

    const res = await handleHydrate(`${D1},${D2}`, null, null, cfg);
    assert.equal(res.status, 200);
    const body = res.body as HydrateBody;
    assert.equal(body.drawings[D1].like_count, 2);
    assert.equal(body.drawings[D1].viewer_liked, null);
    assert.equal(body.drawings[D1].viewer_bookmarked, null);
    assert.equal(body.drawings[D2].like_count, 0);
  });

  test("users: returns counts + profile picture, viewer_follows null", async () => {
    const { cfg, userStore, followsStore } = await makeConfig();
    await userStore.register(rec({ user_id: "a".repeat(64), username: "alice" }));
    await userStore.register(rec({ email: "bob@x", user_id: "b".repeat(64), username: "bob" }));
    await userStore.setProfilePicture("alice@example.com", D1);
    const alice = await userStore.getByUsername("alice");
    const bob = await userStore.getByUsername("bob");
    await followsStore.follow({
      follower: { user_id: bob!.user_id, username: bob!.username, email: bob!.email },
      followee: { user_id: alice!.user_id, username: alice!.username, email: alice!.email },
      created_at_ms: 1,
    });

    const res = await handleHydrate(null, "alice,bob", null, cfg);
    const body = res.body as HydrateBody;
    assert.equal(body.users.alice.profile_picture_drawing_id, D1);
    assert.equal(body.users.alice.follower_count, 1);
    assert.equal(body.users.alice.following_count, 0);
    assert.equal(body.users.alice.viewer_follows, null);
    assert.equal(body.users.bob.profile_picture_drawing_id, null);
    assert.equal(body.users.bob.follower_count, 0);
    assert.equal(body.users.bob.following_count, 1);
  });

  test("unknown drawing id → like_count 0, no error", async () => {
    const { cfg } = await makeConfig();
    const res = await handleHydrate(D1, null, null, cfg);
    const body = res.body as HydrateBody;
    assert.equal(body.drawings[D1].like_count, 0);
  });

  test("unknown username → zeros + null picture, no error", async () => {
    const { cfg } = await makeConfig();
    const res = await handleHydrate(null, "ghost", null, cfg);
    const body = res.body as HydrateBody;
    assert.deepEqual(body.users.ghost, {
      profile_picture_drawing_id: null,
      follower_count: 0,
      following_count: 0,
      viewer_follows: null,
    });
  });
});

describe("handleHydrate — auth mode", () => {
  test("viewer_liked + viewer_bookmarked reflect actual state", async () => {
    const { cfg, drawingStore, likesStore, bookmarksStore } = await makeConfig();
    const viewer = { user_id: "v".repeat(64), username: "alice" };
    await drawingStore.put(row({ drawing_id: D1 }));
    await drawingStore.put(row({ drawing_id: D2 }));
    await drawingStore.put(row({ drawing_id: D3 }));
    await likesStore.like({ drawing_id: D1, user_id: viewer.user_id, created_at_ms: 1 });
    await bookmarksStore.bookmark({
      drawing_id: D2,
      user_id: viewer.user_id,
      created_at_ms: 1,
    });

    const res = await handleHydrate(
      `${D1},${D2},${D3}`,
      null,
      viewer,
      cfg,
    );
    const body = res.body as HydrateBody;
    assert.equal(body.drawings[D1].viewer_liked, true);
    assert.equal(body.drawings[D1].viewer_bookmarked, false);
    assert.equal(body.drawings[D2].viewer_liked, false);
    assert.equal(body.drawings[D2].viewer_bookmarked, true);
    assert.equal(body.drawings[D3].viewer_liked, false);
    assert.equal(body.drawings[D3].viewer_bookmarked, false);
  });

  test("viewer_follows reflects actual state", async () => {
    const { cfg, userStore, followsStore } = await makeConfig();
    await userStore.register(rec({ user_id: "a".repeat(64), username: "alice" }));
    await userStore.register(rec({ email: "bob@x", user_id: "b".repeat(64), username: "bob" }));
    await userStore.register(rec({ email: "carol@x", user_id: "c".repeat(64), username: "carol" }));
    const alice = (await userStore.getByUsername("alice"))!;
    const bob = (await userStore.getByUsername("bob"))!;
    await followsStore.follow({
      follower: { user_id: alice.user_id, username: alice.username, email: alice.email },
      followee: { user_id: bob.user_id, username: bob.username, email: bob.email },
      created_at_ms: 1,
    });

    const viewer = { user_id: alice.user_id, username: "alice" };
    const res = await handleHydrate(null, "bob,carol", viewer, cfg);
    const body = res.body as HydrateBody;
    assert.equal(body.users.bob.viewer_follows, true);
    assert.equal(body.users.carol.viewer_follows, false);
  });

  test("viewer_follows on unknown username is false (not null)", async () => {
    const { cfg } = await makeConfig();
    const viewer = { user_id: "v".repeat(64), username: "alice" };
    const res = await handleHydrate(null, "ghost", viewer, cfg);
    const body = res.body as HydrateBody;
    assert.equal(body.users.ghost.viewer_follows, false);
  });
});
