import {
  AlreadyFollowingError,
  NotFollowingError,
  type FollowsStore,
} from "./follows-store.js";
import type { UserStore } from "./user-store.js";

// POST   /users/{username}/follow    | DELETE /users/{username}/follow
// GET    /me/follows?targets=<csv>
//
// Identity comes from the verified session JWT (route extracts and passes
// `auth` in). The target's user_id + email are resolved server-side via
// the usernames table so the request body carries only a public handle.

// Mirrors the username regex used by the rendering routes (USERNAME_RE in
// render-handlers.ts). Kept inline to avoid a cross-module cycle.
const USERNAME_RE = /^[a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_]$/;
// BatchGetItem cap; mirrors /me/likes + /me/bookmarks.
const MY_FOLLOWS_MAX_TARGETS = 100;

export interface FollowsAuth {
  user_id: string;
  username: string;
}

export interface FollowsHandlerConfig {
  followsStore: FollowsStore;
  userStore: UserStore;
  now?: () => Date;
}

export interface FollowsResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export async function handleFollow(
  target_username: string,
  auth: FollowsAuth,
  cfg: FollowsHandlerConfig,
): Promise<FollowsResult> {
  if (!USERNAME_RE.test(target_username)) return err(400, "invalid username");
  if (target_username === auth.username) {
    return err(400, "cannot follow yourself");
  }
  const followee = await cfg.userStore.getByUsername(target_username);
  if (!followee) return err(404, "user not found");
  // Defence in depth: even if the JWT's `un` claim somehow drifts from
  // the DB, a self-follow by user_id is the real invariant to enforce.
  if (followee.user_id === auth.user_id) {
    return err(400, "cannot follow yourself");
  }
  const follower = await cfg.userStore.getByUsername(auth.username);
  if (!follower) {
    // The JWT references an account that no longer exists. Tell the
    // client to clear its session.
    return err(401, "stale session");
  }
  const now = cfg.now ? cfg.now() : new Date();
  try {
    await cfg.followsStore.follow({
      follower: {
        user_id: follower.user_id,
        username: follower.username,
        email: follower.email,
      },
      followee: {
        user_id: followee.user_id,
        username: followee.username,
        email: followee.email,
      },
      created_at_ms: now.getTime(),
    });
  } catch (e) {
    if (e instanceof AlreadyFollowingError) return err(409, "already following");
    throw e;
  }
  return ok();
}

export async function handleUnfollow(
  target_username: string,
  auth: FollowsAuth,
  cfg: FollowsHandlerConfig,
): Promise<FollowsResult> {
  if (!USERNAME_RE.test(target_username)) return err(400, "invalid username");
  if (target_username === auth.username) {
    return err(400, "cannot unfollow yourself");
  }
  const followee = await cfg.userStore.getByUsername(target_username);
  if (!followee) return err(404, "user not found");
  const follower = await cfg.userStore.getByUsername(auth.username);
  if (!follower) return err(401, "stale session");
  try {
    await cfg.followsStore.unfollow({
      follower: {
        user_id: follower.user_id,
        username: follower.username,
        email: follower.email,
      },
      followee: {
        user_id: followee.user_id,
        username: followee.username,
        email: followee.email,
      },
    });
  } catch (e) {
    if (e instanceof NotFollowingError) return err(409, "not following");
    throw e;
  }
  return ok();
}

// Returns the subset of `targets` (usernames) the caller currently
// follows. Used to hydrate the filled state of Follow buttons on the
// profile + follower/following list pages.
export async function handleMyFollows(
  rawTargets: string | null,
  auth: FollowsAuth,
  cfg: FollowsHandlerConfig,
): Promise<FollowsResult> {
  const targets = parseUsernames(rawTargets);
  if (targets === null) return err(400, "invalid targets");
  if (targets.length > MY_FOLLOWS_MAX_TARGETS) {
    return err(400, `too many targets (max ${MY_FOLLOWS_MAX_TARGETS})`);
  }
  if (targets.length === 0) {
    return {
      status: 200,
      body: { following: [] },
      headers: { "Cache-Control": "no-store, private" },
    };
  }
  // username → user_id resolution. The hydration endpoint takes
  // usernames because that's what data-follow-target carries on the
  // page. Resolving them is cheap (parallel GetItems) and only runs on
  // the page-load hydration request, not on each follow click.
  const records = await Promise.all(
    targets.map((un) => cfg.userStore.getByUsername(un)),
  );
  const userIdToUsername = new Map<string, string>();
  const userIds: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    userIds.push(rec.user_id);
    userIdToUsername.set(rec.user_id, targets[i]);
  }
  const followedIds = await cfg.followsStore.listFollowed(auth.user_id, userIds);
  const following = followedIds
    .map((id) => userIdToUsername.get(id))
    .filter((un): un is string => typeof un === "string");
  return {
    status: 200,
    body: { following },
    headers: { "Cache-Control": "no-store, private" },
  };
}

// Public — no auth. Returns the fresh denormalised follower_count +
// following_count for each requested username so the profile-page JS can
// overwrite the SSR'd values that have been edge-cached for up to
// CC_PROFILE (1 day).
//
// `no-store` mirrors `/likes/counts`: at our volume the BatchGetItem
// behind getByUsername is cheap, and any edge caching would defeat the
// freshness point (the follower who just bumped the count would still
// see the pre-follow value on reload).
export async function handleFollowCounts(
  rawTargets: string | null,
  cfg: FollowsHandlerConfig,
): Promise<FollowsResult> {
  const targets = parseUsernames(rawTargets);
  if (targets === null) return err(400, "invalid targets");
  if (targets.length > MY_FOLLOWS_MAX_TARGETS) {
    return err(400, `too many targets (max ${MY_FOLLOWS_MAX_TARGETS})`);
  }
  // Empty list → empty object. Treat as a no-op rather than 400 so the
  // client can call this unconditionally on pages with no buttons.
  if (targets.length === 0) {
    return {
      status: 200,
      body: { counts: {} },
      headers: { "Cache-Control": "no-store" },
    };
  }
  const records = await Promise.all(
    targets.map((un) => cfg.userStore.getByUsername(un)),
  );
  const counts: Record<string, { followers: number; following: number }> = {};
  for (let i = 0; i < targets.length; i++) {
    const rec = records[i];
    // Missing users get 0/0 so the client can render them uniformly.
    counts[targets[i]] = {
      followers: rec?.follower_count ?? 0,
      following: rec?.following_count ?? 0,
    };
  }
  return {
    status: 200,
    body: { counts },
    headers: { "Cache-Control": "no-store" },
  };
}

function parseUsernames(raw: string | null): string[] | null {
  if (raw === null || raw === "") return [];
  const parts = raw.split(",");
  const out: string[] = [];
  for (const p of parts) {
    if (!USERNAME_RE.test(p)) return null;
    out.push(p);
  }
  return out;
}

function ok(): FollowsResult {
  return { status: 200, body: { ok: true } };
}

function err(status: number, message: string): FollowsResult {
  return { status, body: { error: message } };
}
