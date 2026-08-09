import type { UserRecord, UserStore } from "./user-store.js";
import { UserNotFoundError } from "./user-store.js";
import type { DrawingStore } from "./drawing-store.js";
import type { Storage } from "./storage.js";
import {
  pathsToInvalidateOnPublish,
  type CacheInvalidator,
} from "./cache-invalidation.js";

// The cascade behind both delete-account paths: the user's own
// POST /auth/account/delete and the operator's
// DELETE /admin/users/{username}. Both end up here so "what deleting an
// account means" has exactly one definition.
//
// **Deleting an account deletes its drawings**, gif/mp4 objects included.
// That's a product decision, not an implementation detail: it's the common
// reading of "delete my account", and for the moderation path a spam
// account's drawings are exactly what needs to go. The cost is that
// remixes of a deleted drawing lose their parent — which every read path
// already tolerates (loadAncestorChain stops at the first unresolvable
// parent), and that the public feed shrinks.
//
// What is deliberately NOT swept, matching DELETE /drawings/{id}:
//   - likes and bookmarks pointing at the deleted drawings. Inert once
//     nothing renders them, and sweeping would turn one delete into an
//     unbounded fan-out of writes.
//   - follow edges and the per-account stats row. Both key on user_id,
//     which is random and never reused, so a new account claiming the
//     freed username inherits nothing.

export interface AccountDeleteConfig {
  userStore: UserStore;
  drawingStore: DrawingStore;
  storage: Storage;
  cacheInvalidator?: CacheInvalidator;
}

export interface AccountDeleteReport {
  deleted: string;
  drawings_deleted: number;
  // Object deletes ISSUED, not objects that existed — S3 DeleteObject and
  // FsStorage.remove are both idempotent and report nothing about prior
  // presence (same semantics as DELETE /drawings/{id}).
  cleared_objects: number;
}

export type AccountDeleteOutcome =
  | { ok: true; report: AccountDeleteReport }
  | { ok: false; status: 404 | 409; error: string };

// One query + delete round per batch. Small enough to keep the concurrent
// S3 fan-out sane, big enough that a normal account clears in one pass.
const PAGE = 50;

// Hard ceiling on one request's work, so a pathological account can't run
// the Lambda past its timeout. Far above any real account (the whole
// gallery is ~100 drawings); if it ever trips, the account row is left
// intact and the caller is told to retry, which resumes where it stopped.
const MAX_DRAWINGS = 1_000;

// Per-drawing invalidation paths get folded into one batch, but each path
// costs money past the free tier. Past this many drawings it's cheaper to
// flush the whole drawing namespace with a single wildcard.
const MAX_DRAWING_PATHS = 50;

function objectKeys(drawing_id: string): string[] {
  return [
    `public/tiles/${drawing_id}.gif`,
    `public/tiles/${drawing_id}-large.gif`,
    `public/tiles/${drawing_id}-large.mp4`,
  ];
}

// Deletes every drawing the account owns. Re-queries the FIRST page each
// round rather than paginating with a cursor: we're deleting the very rows
// we're walking, and a cursor into a mutating index can skip records.
async function deleteOwnedDrawings(
  username: string,
  cfg: AccountDeleteConfig,
): Promise<{ ids: string[]; cleared: number; truncated: boolean }> {
  const ids: string[] = [];
  let cleared = 0;
  for (;;) {
    if (ids.length >= MAX_DRAWINGS) return { ids, cleared, truncated: true };
    const page = await cfg.drawingStore.queryByUsername(username, { limit: PAGE });
    if (page.items.length === 0) return { ids, cleared, truncated: false };

    for (const row of page.items) {
      // Row first, objects second — the row is what every dynamic page
      // reads, so dropping it is what makes the drawing disappear. The
      // reverse order would briefly leave a row pointing at a missing gif,
      // which renders as a broken image on the feed.
      await cfg.drawingStore.remove(row.drawing_id);
      ids.push(row.drawing_id);
    }

    const results = await Promise.all(
      page.items.flatMap((row) =>
        objectKeys(row.drawing_id).map(async (key) => {
          try {
            await cfg.storage.remove(key);
            return true;
          } catch (e) {
            // A failed object delete must not fail the request: the row is
            // already gone, so the drawing is gone from the site. What's
            // left is an unreferenced file.
            console.error(`[account-delete] failed to remove ${key}:`, e);
            return false;
          }
        }),
      ),
    );
    cleared += results.filter(Boolean).length;
  }
}

// Removes the account and everything it published. The caller is
// responsible for authorising — this function does not check passwords or
// allowlists, it just executes an authorised decision.
export async function deleteAccountAndDrawings(
  account: UserRecord,
  cfg: AccountDeleteConfig,
): Promise<AccountDeleteOutcome> {
  const { ids, cleared, truncated } = await deleteOwnedDrawings(
    account.username,
    cfg,
  );
  if (truncated) {
    // Account row intentionally left in place: the operation is resumable
    // (the drawings already removed stay removed) and an account whose
    // drawings are half-deleted is a worse state than one that still
    // exists.
    return {
      ok: false,
      status: 409,
      error: `deleted ${ids.length} drawings but more remain — run the delete again to continue`,
    };
  }

  try {
    await cfg.userStore.deleteAccount({
      email: account.email,
      username: account.username,
      user_id: account.user_id,
    });
  } catch (e) {
    if (e instanceof UserNotFoundError) {
      return { ok: false, status: 404, error: "account not found" };
    }
    throw e;
  }

  if (cfg.cacheInvalidator) {
    await cfg.cacheInvalidator.invalidate(
      pathsToInvalidateOnAccountDelete(account.username, ids),
    );
  }

  return {
    ok: true,
    report: {
      deleted: account.username,
      drawings_deleted: ids.length,
      cleared_objects: cleared,
    },
  };
}

// Exported for the same reason the other path builders are: so a test can
// pin the exact paths rather than infer them.
export function pathsToInvalidateOnAccountDelete(
  username: string,
  drawing_ids: string[],
): string[] {
  const base = pathsToInvalidateOnPublish(username);
  if (drawing_ids.length === 0) return base;
  if (drawing_ids.length > MAX_DRAWING_PATHS) return [...base, "/d/*"];
  return [...base, ...drawing_ids.map((id) => `/d/${id}*`)];
}

export { MAX_DRAWINGS, MAX_DRAWING_PATHS };
