import {
  AlreadyLikedError,
  DrawingNotFoundError,
  NotLikedError,
  type LikesStore,
} from "./likes-store.js";

// POST   /drawings/{id}/like     | DELETE /drawings/{id}/like
// GET    /me/likes?ids=<csv>
//
// Identity comes from the verified session JWT (route extracts and passes
// `auth` in). Anonymous viewers get 401 before reaching here.

const DRAWING_ID_RE = /^[0-9a-f]{64}$/;
// BatchGetItem cap is 100; matches DynamoDB's limit so the route never
// surprises a caller that passed exactly 100 ids.
const MY_LIKES_MAX_IDS = 100;

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

export async function handleMyLikes(
  rawIds: string | null,
  auth: LikesAuth,
  cfg: LikesHandlerConfig,
): Promise<LikesResult> {
  const ids = parseIds(rawIds);
  if (ids === null) return err(400, "invalid ids");
  if (ids.length > MY_LIKES_MAX_IDS) {
    return err(400, `too many ids (max ${MY_LIKES_MAX_IDS})`);
  }
  const liked = await cfg.likesStore.listLikedDrawingIds(auth.user_id, ids);
  return {
    status: 200,
    body: { liked },
    // Per-user, ephemeral. Don't let CloudFront or the browser cache it.
    headers: { "Cache-Control": "no-store, private" },
  };
}

function parseIds(raw: string | null): string[] | null {
  if (raw === null || raw === "") return [];
  const parts = raw.split(",");
  const out: string[] = [];
  for (const p of parts) {
    if (!DRAWING_ID_RE.test(p)) return null;
    out.push(p);
  }
  return out;
}

function ok(): LikesResult {
  return { status: 200, body: { ok: true } };
}

function err(status: number, message: string): LikesResult {
  return { status, body: { error: message } };
}
