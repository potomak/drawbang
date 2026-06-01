import {
  AlreadyFollowingError,
  NotFollowingError,
  type FollowsStore,
} from "./follows-store.js";
import type { UserStore } from "./user-store.js";

// POST   /users/{username}/follow    | DELETE /users/{username}/follow
//
// Identity comes from the verified session JWT (route extracts and passes
// `auth` in). The target's user_id + email are resolved server-side via
// the usernames table so the request body carries only a public handle.
// Read-side hydration (viewer_follows + counts) lives in /hydrate
// (hydrate-handler.ts).

// Mirrors the username regex used by the rendering routes (USERNAME_RE in
// render-handlers.ts). Kept inline to avoid a cross-module cycle.
const USERNAME_RE = /^[a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_]$/;

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

function ok(): FollowsResult {
  return { status: 200, body: { ok: true } };
}

function err(status: number, message: string): FollowsResult {
  return { status, body: { error: message } };
}
