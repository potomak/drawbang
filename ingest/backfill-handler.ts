import { DRAWING_ID_RE, isAnonymousUsername } from "../config/constants.js";
import type { AuthedUser, PostPublishJob, PostPublishOutcome } from "./handler.js";
import type { DrawingCursor, DrawingRow, DrawingStore } from "./drawing-store.js";
import type { Storage } from "./storage.js";

// POST /backfill/sidecars — regenerate missing share sidecars
// (`-large.gif` / `-large.mp4`) for drawings that don't have them.
//
// This is the endpoint form of scripts/backfill-large-gifs.ts +
// scripts/backfill-share-mp4.ts, so gaps can be repaired without AWS
// credentials. It does NOT re-implement the encoders: it finds drawings
// with a missing sidecar and enqueues the ordinary post-publish tail
// (PostPublishEvent → runPostPublish) for each, in "backfill" mode so only
// the two tile URLs get invalidated rather than the whole feed set.
//
// Scope is the security boundary:
//   - `?drawing=<id>`: exactly one drawing, any signed-in caller. See the
//     note on why that's safe below.
//   - default: the CALLER'S OWN drawings. Anyone signed in can repair
//     their own work; it can only ever create derived data that should
//     already exist, and it's bounded by what they published.
//   - `scope=all`: the whole gallery. Operators on ADMIN_USERNAMES only,
//     because it can fan out across everyone's drawings unattended.
//
// Why targeting one drawing needs no ownership check: the operation can
// only CREATE derived data that should already exist — it never deletes,
// mutates, or discloses anything (the report says which sidecar is
// missing, which anyone can already learn with two HEAD requests). It is
// idempotent, so a healthy drawing produces no work at all, and its total
// capacity across the whole gallery is bounded by the number of genuinely
// broken drawings — once repaired, further calls do nothing. Decisively:
// it is strictly LESS powerful than publishing, which is open to
// anonymous callers and runs the very same encode pipeline on demand.
//
// Anonymous drawings have no owner, so they're only reachable via
// scope=all — same rule as the drawing delete.
//
// Reachable on the API origin only (no CloudFront behaviour), like
// DELETE /drawings/{id}. That's not the gate; the auth check below is.

export type BackfillScope = "mine" | "all";

export interface BackfillHandlerConfig {
  drawingStore: DrawingStore;
  storage: Storage;
  // Hands one drawing to the post-publish tail. The Lambda wires this to
  // the same async self-invoke a publish uses; the dev server runs it
  // inline so the local loop works end to end.
  enqueue(job: PostPublishJob): Promise<void>;
  // Runs the tail INLINE and reports what actually happened. Used only by
  // the single-drawing path, where the work is bounded (~2-3s) and the
  // caller deserves a real answer instead of "queued, good luck".
  runNow(job: PostPublishJob): Promise<PostPublishOutcome>;
  isAdmin(username: string): boolean;
}

export interface BackfillOptions {
  // When set, repair just this drawing and ignore `scope` entirely.
  target: string | null;
  scope: BackfillScope;
  // Cap on drawings actually enqueued, so one call can't fan out across
  // the whole gallery by accident.
  limit: number;
  // Cap on rows examined. Bounds the S3 HEAD count (2 per row) so the
  // request can't run past the Lambda timeout.
  scanLimit: number;
  // Report what would be repaired without enqueuing anything.
  dryRun: boolean;
}

export interface BackfillReport {
  scope: BackfillScope | "one";
  scanned: number;
  // `username` is null for anonymous drawings — matches what gets put on
  // the enqueued job.
  missing: { drawing_id: string; username: string | null; needs: string[] }[];
  enqueued: string[];
  // Only set for ?drawing=<id>, which runs synchronously. Bulk scans
  // enqueue and can't know the result.
  outcome?: PostPublishOutcome;
  dry_run: boolean;
  // True when the scan stopped at scanLimit — there may be more to do, so
  // the caller should run again.
  truncated: boolean;
}

export type BackfillResult =
  | { status: 200; body: BackfillReport }
  | { status: 400 | 403 | 404; body: { error: string } };

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const DEFAULT_SCAN_LIMIT = 200;
export const MAX_SCAN_LIMIT = 1000;

// Parses + clamps the query string. Exported so the bounds are testable
// without standing up a store.
export function parseBackfillOptions(q: {
  drawing: string | null;
  scope: string | null;
  limit: string | null;
  scan: string | null;
  dry: string | null;
}): BackfillOptions {
  const scope: BackfillScope = q.scope === "all" ? "all" : "mine";
  const target = q.drawing !== null && DRAWING_ID_RE.test(q.drawing) ? q.drawing : null;
  return {
    target,
    scope,
    limit: clamp(q.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    scanLimit: clamp(q.scan, DEFAULT_SCAN_LIMIT, 1, MAX_SCAN_LIMIT),
    // Any non-empty value other than "0"/"false" enables the dry run —
    // the safe direction to resolve an ambiguous flag.
    dryRun: q.dry !== null && q.dry !== "" && q.dry !== "0" && q.dry !== "false",
  };
}

function clamp(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const PAGE = 100;

export async function handleBackfillSidecars(
  opts: BackfillOptions,
  auth: AuthedUser,
  cfg: BackfillHandlerConfig,
): Promise<BackfillResult> {
  // Single-drawing repair: no ownership check, for the reasons in the
  // header comment. Bounded to one job by construction.
  if (opts.target !== null) {
    const row = await cfg.drawingStore.get(opts.target);
    if (!row) return { status: 404, body: { error: "drawing not found" } };
    const entry = await needsFor(cfg.storage, row);
    const enqueuedOne: string[] = [];
    let outcome: PostPublishOutcome | undefined;
    if (entry.needs.length > 0 && !opts.dryRun) {
      // Synchronous on purpose. The tail swallows its own errors (an async
      // invocation has no caller), which meant a queued repair could fail
      // silently while this endpoint reported success. One drawing is
      // small enough to just do the work and report the truth.
      outcome = await cfg.runNow({
        drawing_id: entry.drawing_id,
        username: entry.username,
        prompt_tagged: false,
        mode: "backfill",
      });
    }
    if (entry.needs.length > 0) enqueuedOne.push(entry.drawing_id);
    return {
      status: 200,
      body: {
        scope: "one",
        scanned: 1,
        missing: entry.needs.length > 0 ? [entry] : [],
        enqueued: enqueuedOne,
        ...(outcome ? { outcome } : {}),
        dry_run: opts.dryRun,
        truncated: false,
      },
    };
  }

  if (opts.scope === "all" && !cfg.isAdmin(auth.username)) {
    return { status: 403, body: { error: "scope=all requires an operator account" } };
  }
  if (opts.scope === "mine" && isAnonymousUsername(auth.username)) {
    // Can't happen (the handle is reserved) but the sentinel must never be
    // treated as an owner anywhere.
    return { status: 403, body: { error: "the anonymous sentinel owns nothing" } };
  }

  const missing: BackfillReport["missing"] = [];
  const enqueued: string[] = [];
  let scanned = 0;
  let cursor: DrawingCursor | undefined;
  let truncated = false;

  outer: for (;;) {
    const page =
      opts.scope === "all"
        ? await cfg.drawingStore.queryGallery({ limit: PAGE, cursor })
        : await cfg.drawingStore.queryByUsername(auth.username, { limit: PAGE, cursor });

    // HEAD both sidecars for the page at once — sequential would make a
    // 200-row scan hundreds of round trips deep.
    const checked = await Promise.all(page.items.map((row) => needsFor(cfg.storage, row)));

    for (let i = 0; i < checked.length; i++) {
      const entry = checked[i];
      scanned += 1;
      if (entry.needs.length > 0) {
        missing.push(entry);
        if (enqueued.length < opts.limit) {
          if (!opts.dryRun) {
            await cfg.enqueue({
              drawing_id: entry.drawing_id,
              username: entry.username,
              prompt_tagged: false,
              mode: "backfill",
            });
          }
          enqueued.push(entry.drawing_id);
        }
      }
      if (scanned >= opts.scanLimit) {
        // More to do if this page still has unexamined rows OR another
        // page follows. Checking only next_cursor would under-report
        // whenever the scan stops mid-page.
        truncated = i + 1 < checked.length || page.next_cursor !== null;
        break outer;
      }
    }

    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }

  return {
    status: 200,
    body: {
      scope: opts.scope,
      scanned,
      missing,
      enqueued,
      dry_run: opts.dryRun,
      truncated,
    },
  };
}

async function needsFor(
  storage: Storage,
  row: DrawingRow,
): Promise<{ drawing_id: string; username: string | null; needs: string[] }> {
  const [hasGif, hasMp4] = await Promise.all([
    storage.exists(`public/tiles/${row.drawing_id}-large.gif`),
    storage.exists(`public/tiles/${row.drawing_id}-large.mp4`),
  ]);
  const needs: string[] = [];
  if (!hasGif) needs.push("-large.gif");
  if (!hasMp4) needs.push("-large.mp4");
  return {
    drawing_id: row.drawing_id,
    username: isAnonymousUsername(row.username) ? null : row.username,
    needs,
  };
}
