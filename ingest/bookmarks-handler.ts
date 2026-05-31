import {
  AlreadyBookmarkedError,
  BookmarkDrawingNotFoundError,
  NotBookmarkedError,
  type BookmarksStore,
} from "./bookmarks-store.js";

// POST   /drawings/{id}/bookmark    | DELETE /drawings/{id}/bookmark
// GET    /me/bookmarks?ids=<csv>
//
// Mirrors likes-handler.ts: identity comes from the route's verified JWT
// (`auth`), missing/invalid tokens are rejected with 401 before the
// handler runs. The /u/<username>/bookmarks rendering lives in
// render-handlers.ts so this module stays JSON-only.

const DRAWING_ID_RE = /^[0-9a-f]{64}$/;
// BatchGetItem cap is 100; matches DynamoDB's limit so the route never
// surprises a caller that passed exactly 100 ids.
const MY_BOOKMARKS_MAX_IDS = 100;

export interface BookmarksAuth {
  user_id: string;
  username: string;
}

export interface BookmarksHandlerConfig {
  bookmarksStore: BookmarksStore;
  now?: () => Date;
}

export interface BookmarksResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export async function handleBookmark(
  drawing_id: string,
  auth: BookmarksAuth,
  cfg: BookmarksHandlerConfig,
): Promise<BookmarksResult> {
  if (!DRAWING_ID_RE.test(drawing_id)) return err(400, "invalid drawing_id");
  const now = cfg.now ? cfg.now() : new Date();
  try {
    await cfg.bookmarksStore.bookmark({
      drawing_id,
      user_id: auth.user_id,
      created_at_ms: now.getTime(),
    });
  } catch (e) {
    if (e instanceof AlreadyBookmarkedError) return err(409, "already bookmarked");
    if (e instanceof BookmarkDrawingNotFoundError) {
      return err(404, "drawing not found");
    }
    throw e;
  }
  return ok();
}

export async function handleUnbookmark(
  drawing_id: string,
  auth: BookmarksAuth,
  cfg: BookmarksHandlerConfig,
): Promise<BookmarksResult> {
  if (!DRAWING_ID_RE.test(drawing_id)) return err(400, "invalid drawing_id");
  try {
    await cfg.bookmarksStore.unbookmark({ drawing_id, user_id: auth.user_id });
  } catch (e) {
    if (e instanceof NotBookmarkedError) return err(409, "not bookmarked");
    throw e;
  }
  return ok();
}

export async function handleMyBookmarks(
  rawIds: string | null,
  auth: BookmarksAuth,
  cfg: BookmarksHandlerConfig,
): Promise<BookmarksResult> {
  const ids = parseIds(rawIds);
  if (ids === null) return err(400, "invalid ids");
  if (ids.length > MY_BOOKMARKS_MAX_IDS) {
    return err(400, `too many ids (max ${MY_BOOKMARKS_MAX_IDS})`);
  }
  const bookmarked = await cfg.bookmarksStore.listBookmarkedDrawingIds(
    auth.user_id,
    ids,
  );
  return {
    status: 200,
    body: { bookmarked },
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

function ok(): BookmarksResult {
  return { status: 200, body: { ok: true } };
}

function err(status: number, message: string): BookmarksResult {
  return { status, body: { error: message } };
}
