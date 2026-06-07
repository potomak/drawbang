import {
  AlreadyFollowingError,
  NotFollowingError,
  type FollowsStore,
} from "./follows-store.js";
import type { UserStore } from "./user-store.js";
import {
  type Auth,
  type BaseHandlerConfig,
  type Result,
  err,
  toggleAction,
} from "./handler-utils.js";
import { USERNAME_RE } from "../config/constants.js";

// POST   /users/{username}/follow    | DELETE /users/{username}/follow
//
// Identity comes from the verified session JWT (route extracts and passes
// `auth` in). The target's user_id + email are resolved server-side via
// the usernames table so the request body carries only a public handle.
// Read-side hydration (viewer_follows + counts) lives in /hydrate
// (hydrate-handler.ts).

export type FollowsAuth = Auth;
export type FollowsResult = Result;

export interface FollowsHandlerConfig extends BaseHandlerConfig {
  followsStore: FollowsStore;
  userStore: UserStore;
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
  return toggleAction(
    () =>
      cfg.followsStore.follow({
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
      }),
    [[AlreadyFollowingError, 409, "already following"]],
  );
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
  return toggleAction(
    () =>
      cfg.followsStore.unfollow({
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
      }),
    [[NotFollowingError, 409, "not following"]],
  );
}
