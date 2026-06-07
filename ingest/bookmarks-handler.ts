import {
  AlreadyBookmarkedError,
  BookmarkDrawingNotFoundError,
  NotBookmarkedError,
  type BookmarksStore,
} from "./bookmarks-store.js";
import {
  type Auth,
  type BaseHandlerConfig,
  type Result,
  err,
  toggleAction,
} from "./handler-utils.js";
import { DRAWING_ID_RE } from "../config/constants.js";

// POST   /drawings/{id}/bookmark    | DELETE /drawings/{id}/bookmark
//
// Identity comes from the route's verified JWT (`auth`), missing/invalid
// tokens are rejected with 401 before the handler runs. Read-side
// hydration (viewer_bookmarked) lives in /hydrate (hydrate-handler.ts).
// /u/<un>/bookmarks rendering lives in render-handlers.ts.

export type BookmarksAuth = Auth;
export type BookmarksResult = Result;

export interface BookmarksHandlerConfig extends BaseHandlerConfig {
  bookmarksStore: BookmarksStore;
}

export async function handleBookmark(
  drawing_id: string,
  auth: BookmarksAuth,
  cfg: BookmarksHandlerConfig,
): Promise<BookmarksResult> {
  if (!DRAWING_ID_RE.test(drawing_id)) return err(400, "invalid drawing_id");
  const now = cfg.now ? cfg.now() : new Date();
  return toggleAction(
    () =>
      cfg.bookmarksStore.bookmark({
        drawing_id,
        user_id: auth.user_id,
        created_at_ms: now.getTime(),
      }),
    [
      [AlreadyBookmarkedError, 409, "already bookmarked"],
      [BookmarkDrawingNotFoundError, 404, "drawing not found"],
    ],
  );
}

export async function handleUnbookmark(
  drawing_id: string,
  auth: BookmarksAuth,
  cfg: BookmarksHandlerConfig,
): Promise<BookmarksResult> {
  if (!DRAWING_ID_RE.test(drawing_id)) return err(400, "invalid drawing_id");
  return toggleAction(
    () => cfg.bookmarksStore.unbookmark({ drawing_id, user_id: auth.user_id }),
    [[NotBookmarkedError, 409, "not bookmarked"]],
  );
}
