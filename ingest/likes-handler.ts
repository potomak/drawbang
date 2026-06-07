// TODO (#shared-handler-utils): This module shares scaffolding with
// bookmarks-handler.ts and follows-handler.ts (Auth/Config/Result shapes,
// ok()/err() helpers, AlreadyXxx/NotXxx → 409 mapping, DRAWING_ID_RE).
// Extract into ingest/handler-utils.ts and import.

import {
  AlreadyLikedError,
  DrawingNotFoundError,
  NotLikedError,
  type LikesStore,
} from "./likes-store.js";

// POST   /drawings/{id}/like     | DELETE /drawings/{id}/like
//
// Identity comes from the verified session JWT (route extracts and passes
// `auth` in). Anonymous viewers get 401 before reaching here. Read-side
// hydration (counts + viewer_liked) lives in /hydrate (hydrate-handler.ts).

// TODO (#shared-handler-utils): DRAWING_ID_RE is duplicated in
// bookmarks-handler.ts and hydrate-handler.ts. Centralize in
// config/constants.ts or ingest/validators.ts.
const DRAWING_ID_RE = /^[0-9a-f]{64}$/;

export interface LikesAuth {
  user_id: string;
  username: string;
}

export interface LikesHandlerConfig {
  likesStore: LikesStore;
  now?: () => Date;
}

export interface LikesResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export async function handleLike(
  drawing_id: string,
  auth: LikesAuth,
  cfg: LikesHandlerConfig,
): Promise<LikesResult> {
  if (!DRAWING_ID_RE.test(drawing_id)) return err(400, "invalid drawing_id");
  const now = cfg.now ? cfg.now() : new Date();
  try {
    await cfg.likesStore.like({
      drawing_id,
      user_id: auth.user_id,
      created_at_ms: now.getTime(),
    });
  } catch (e) {
    if (e instanceof AlreadyLikedError) return err(409, "already liked");
    if (e instanceof DrawingNotFoundError) return err(404, "drawing not found");
    throw e;
  }
  return ok();
}

export async function handleUnlike(
  drawing_id: string,
  auth: LikesAuth,
  cfg: LikesHandlerConfig,
): Promise<LikesResult> {
  if (!DRAWING_ID_RE.test(drawing_id)) return err(400, "invalid drawing_id");
  try {
    await cfg.likesStore.unlike({ drawing_id, user_id: auth.user_id });
  } catch (e) {
    if (e instanceof NotLikedError) return err(409, "not liked");
    if (e instanceof DrawingNotFoundError) return err(404, "drawing not found");
    throw e;
  }
  return ok();
}

function ok(): LikesResult {
  return { status: 200, body: { ok: true } };
}

function err(status: number, message: string): LikesResult {
  return { status, body: { error: message } };
}
