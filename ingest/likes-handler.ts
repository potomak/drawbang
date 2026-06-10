import {
  AlreadyLikedError,
  DrawingNotFoundError,
  NotLikedError,
  type LikesStore,
} from "./likes-store.js";
import {
  type Auth,
  type BaseHandlerConfig,
  type Result,
  err,
  toggleAction,
} from "./handler-utils.js";
import { DRAWING_ID_RE } from "../config/constants.js";

// POST   /drawings/{id}/like     | DELETE /drawings/{id}/like
//
// Identity comes from the verified session JWT (route extracts and passes
// `auth` in). Anonymous viewers get 401 before reaching here. Read-side
// hydration (counts + viewer_liked) lives in /hydrate (hydrate-handler.ts).

export type LikesAuth = Auth;
export type LikesResult = Result;

export interface LikesHandlerConfig extends BaseHandlerConfig {
  likesStore: LikesStore;
}

export async function handleLike(
  drawing_id: string,
  auth: LikesAuth,
  cfg: LikesHandlerConfig,
): Promise<LikesResult> {
  if (!DRAWING_ID_RE.test(drawing_id)) return err(400, "invalid drawing_id");
  // TODO (#now-idiom): standardise the now() seam idiom across handlers —
  // see docs/architecture-review-2026-06.md.
  const now = cfg.now ? cfg.now() : new Date();
  return toggleAction(
    () =>
      cfg.likesStore.like({
        drawing_id,
        user_id: auth.user_id,
        created_at_ms: now.getTime(),
      }),
    [
      [AlreadyLikedError, 409, "already liked"],
      [DrawingNotFoundError, 404, "drawing not found"],
    ],
  );
}

export async function handleUnlike(
  drawing_id: string,
  auth: LikesAuth,
  cfg: LikesHandlerConfig,
): Promise<LikesResult> {
  if (!DRAWING_ID_RE.test(drawing_id)) return err(400, "invalid drawing_id");
  return toggleAction(
    () => cfg.likesStore.unlike({ drawing_id, user_id: auth.user_id }),
    [
      [NotLikedError, 409, "not liked"],
      [DrawingNotFoundError, 404, "drawing not found"],
    ],
  );
}
