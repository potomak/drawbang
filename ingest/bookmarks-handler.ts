// TODO (#shared-handler-utils): This module shares scaffolding with
// likes-handler.ts and follows-handler.ts (Auth/Config/Result shapes,
// ok()/err() helpers, AlreadyXxx/NotXxx → 409 mapping, DRAWING_ID_RE).
// Extract into ingest/handler-utils.ts and import.

import {
  AlreadyBookmarkedError,
  BookmarkDrawingNotFoundError,
  NotBookmarkedError,
  type BookmarksStore,
} from "./bookmarks-store.js";

// POST   /drawings/{id}/bookmark    | DELETE /drawings/{id}/bookmark
//
// Identity comes from the route's verified JWT (`auth`), missing/invalid
// tokens are rejected with 401 before the handler runs. Read-side
// hydration (viewer_bookmarked) lives in /hydrate (hydrate-handler.ts).
// /u/<un>/bookmarks rendering lives in render-handlers.ts.

// TODO (#shared-handler-utils): DRAWING_ID_RE is duplicated in
// likes-handler.ts and hydrate-handler.ts. Centralize in
// config/constants.ts or ingest/validators.ts.
const DRAWING_ID_RE = /^[0-9a-f]{64}$/;

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

function ok(): BookmarksResult {
  return { status: 200, body: { ok: true } };
}

function err(status: number, message: string): BookmarksResult {
  return { status, body: { error: message } };
}
