import { DRAWING_ID_RE, isAnonymousUsername } from "../config/constants.js";
import type { AuthedUser } from "./handler.js";
import type { DrawingStore } from "./drawing-store.js";
import type { Storage } from "./storage.js";
import {
  pathsToInvalidateOnDelete,
  type CacheInvalidator,
} from "./cache-invalidation.js";

// DELETE /drawings/{id} — the only path in the app that removes a drawing.
//
// Not linked from any UI and not routed through CloudFront (see the note in
// infra/aws/template.yaml): it's reachable on the API origin only. That is
// *obscurity, not security* — the real gate is the authorisation check
// below, and it must stay that way.
//
// Two callers are allowed:
//   - the drawing's author, deleting their own work;
//   - an operator on the ADMIN_USERNAMES allowlist, for moderation and for
//     cleaning up test publishes.
//
// Anonymous drawings have no author, so only the allowlist can remove them
// — otherwise anyone could delete anything published without a session.
//
// The delete is hard, not a tombstone. That's safe because every read path
// already copes with a missing row: the bookmarks feed filters nulls out
// (renderMyBookmarksFeedHandler) and remix chains stop at the first
// unresolvable parent (loadAncestorChain). Like/bookmark rows for the
// deleted id are left behind deliberately — they're inert once nothing
// renders the drawing, and sweeping them would turn a single delete into an
// unbounded fan-out of writes.

export interface DeleteHandlerConfig {
  drawingStore: DrawingStore;
  storage: Storage;
  cacheInvalidator?: CacheInvalidator;
  // Allowlist check, injected so the route keeps one source of truth for
  // who counts as an operator (RouteDeps.admin.isAllowed).
  isAdmin(username: string): boolean;
}

export type DeleteResult =
  // `cleared_objects` lists the keys a delete was ISSUED for, not keys that
  // existed: both S3's DeleteObject and FsStorage.remove are idempotent and
  // report nothing about prior presence. Confirming existence would cost a
  // HEAD per key for no operational gain.
  | { status: 200; body: { deleted: string; cleared_objects: string[] } }
  | { status: 400 | 403 | 404; body: { error: string } };

export async function handleDeleteDrawing(
  drawing_id: string,
  auth: AuthedUser,
  cfg: DeleteHandlerConfig,
): Promise<DeleteResult> {
  if (!DRAWING_ID_RE.test(drawing_id)) {
    return { status: 400, body: { error: "invalid drawing_id" } };
  }
  const row = await cfg.drawingStore.get(drawing_id);
  if (!row) return { status: 404, body: { error: "drawing not found" } };

  const isAdmin = cfg.isAdmin(auth.username);
  // isAnonymousUsername guard first: the sentinel is a byline, not an
  // account, so `row.username === auth.username` must never be reachable
  // for it (RESERVED_USERNAMES already blocks registering the handle —
  // this is the belt to that braces).
  const isOwner = !isAnonymousUsername(row.username) && row.username === auth.username;
  if (!isAdmin && !isOwner) {
    return { status: 403, body: { error: "not allowed to delete this drawing" } };
  }

  // Row first: it's what every dynamic page reads, so dropping it is what
  // actually makes the drawing disappear. If an object delete then fails,
  // the leftover S3 file is orphaned but unreferenced — the reverse order
  // would leave a row pointing at a missing gif, which renders as a broken
  // image on the feed.
  await cfg.drawingStore.remove(drawing_id);

  const keys = [
    `public/tiles/${drawing_id}.gif`,
    `public/tiles/${drawing_id}-large.gif`,
    `public/tiles/${drawing_id}-large.mp4`,
  ];
  const cleared: string[] = [];
  await Promise.all(
    keys.map(async (key) => {
      try {
        await cfg.storage.remove(key);
        cleared.push(key);
      } catch (e) {
        // A failed object delete must not fail the request — the row is
        // already gone, which is the part that makes the drawing disappear.
        // The leftover object is unreferenced.
        console.error(`[delete] failed to remove ${key}:`, e);
      }
    }),
  );

  if (cfg.cacheInvalidator) {
    await cfg.cacheInvalidator.invalidate(
      pathsToInvalidateOnDelete(
        isAnonymousUsername(row.username) ? null : row.username,
        drawing_id,
      ),
    );
  }

  return { status: 200, body: { deleted: drawing_id, cleared_objects: cleared.sort() } };
}
