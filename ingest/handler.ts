import {
  ANONYMOUS_USER_ID,
  ANONYMOUS_USERNAME,
  DRAWING_ID_RE,
  MAX_LAYERS_JSON_BYTES,
} from "../config/constants.js";
import { contentHashHex } from "../src/content-hash.js";
import { PROMPT_SLUG_RE, promptForDate } from "../config/prompts.js";
import { decodeGif } from "../src/editor/gif.js";
import { encodeShareGif } from "../src/editor/share-gif.js";
import { encodeShareMp4 } from "./share-mp4.js";
import { shapeError } from "./handler-utils.js";
import { validateGif, type GifValidation } from "./gif-validate.js";
import type { Storage } from "./storage.js";
import type { UserStatsStore } from "./user-stats-store.js";
import type { DrawingStore } from "./drawing-store.js";
import {
  pathsToInvalidateOnPublish,
  pathsToInvalidateOnSidecarBackfill,
  type CacheInvalidator,
} from "./cache-invalidation.js";

// The authenticated publisher, derived from the verified session JWT by the
// route (lambda.ts / dev-server.ts). The request body never carries identity.
export interface AuthedUser {
  user_id: string; // 64-hex stable account id
  username: string; // public handle, used in /u/<username>
}

// Identity written on a publish that arrived with no session. Shaped like
// an AuthedUser so the row write is one code path, but it is a sentinel,
// not an account — see the ANONYMOUS_* block in config/constants.ts.
const ANONYMOUS_AUTHOR: AuthedUser = {
  user_id: ANONYMOUS_USER_ID,
  username: ANONYMOUS_USERNAME,
};

export interface IngestRequest {
  gif: string; // base64
  parent?: string;
  // Daily-prompt slug the client claims this drawing answers. Untrusted:
  // only stored when it matches today's ET prompt (see handleIngest).
  prompt?: string;
  // Optional layer hierarchy. JSON-encoded LayersPayload from the client
  // (see src/submit.ts). Stored verbatim on the DrawingRow so future
  // "fork & edit layers" flows can rehydrate the editor state; the
  // published GIF itself is the flattened result.
  layers_json?: string;
}

// MAX_LAYERS_JSON_BYTES (config/constants.ts) is the hard ceiling for the
// layers sidecar. Re-checked server-side because a payload can squeeze
// past the client soft cap (older client, attacker) — it still gets
// rejected here. The GIF publishes regardless — only the metadata is
// gated.
export { MAX_LAYERS_JSON_BYTES };

export interface IngestSuccess {
  status: 200 | 202;
  body: {
    id: string;
    share_url: string;
  };
}
export interface IngestError {
  status: 400;
  body: { error: string };
}
export type IngestHandlerResult = IngestSuccess | IngestError;

export interface HandlerConfig {
  storage: Storage;
  publicBaseUrl: string; // e.g. https://drawbang.example
  // Authenticated publisher (from the verified session JWT), or null when
  // the request carried no session — the publish is then attributed to the
  // anonymous sentinel. An *invalid* token is still a 401 at the route;
  // null here only ever means "no Authorization header".
  auth: AuthedUser | null;
  repoUrl?: string;
  now?: () => Date;
  // Per-account streak / total counters (#115, #116). Optional so dev/tests
  // can omit it; when absent the publish proceeds without bumping counters.
  userStatsStore?: UserStatsStore;
  // New dynamic-site source of truth for drawings. Optional so dev/tests
  // can omit it; when present, every new publish dual-writes the metadata
  // row alongside the inbox/S3 sidecar so the new gallery/profile/drawing
  // routes can serve from DDB without waiting for the builder.
  drawingStore?: DrawingStore;
  // CloudFront cache invalidator. Optional: when absent the publish path
  // still works, but the gallery + profile take up to s-maxage seconds
  // to show the new drawing.
  cacheInvalidator?: CacheInvalidator;
  // Hands the whole post-publish tail (share sidecars + CloudFront
  // invalidation) to an async self-invoke so none of it sits on the
  // response path. The Lambda wires this to PostPublishEvent; when absent
  // (dev server, tests) the work runs inline instead, so the local publish
  // loop still produces sidecars.
  deferPostPublish?: (job: PostPublishJob) => Promise<void>;
}

// What the post-publish tail needs to know. `username` is null for an
// anonymous publish (no /u/<username> page to flush).
export interface PostPublishJob {
  drawing_id: string;
  username: string | null;
  prompt_tagged: boolean;
  // What the job is for, which decides what gets invalidated.
  // "publish" (default) flushes the feed + profile set because a new
  // drawing appeared. "backfill" means the drawing is already live and
  // only its sidecar objects changed — those URLs previously 404'd and
  // the edge may have cached that, so just the two tile paths are flushed.
  // Optional so events queued before this field existed still validate.
  mode?: "publish" | "backfill";
}

// Async self-invoke event carrying a PostPublishJob. The Lambda detects
// this shape before HTTP routing (async-invoke events carry no
// requestContext.http) and runs runPostPublish.
export interface PostPublishEvent extends PostPublishJob {
  kind: "post-publish";
}

export function isPostPublishEvent(event: unknown): event is PostPublishEvent {
  const e = event as PostPublishEvent | null | undefined;
  if (e?.kind !== "post-publish") return false;
  return (
    typeof e.drawing_id === "string" &&
    DRAWING_ID_RE.test(e.drawing_id) &&
    (e.username === null || typeof e.username === "string") &&
    typeof e.prompt_tagged === "boolean" &&
    (e.mode === undefined || e.mode === "publish" || e.mode === "backfill")
  );
}

// Superseded by PostPublishEvent, still accepted so events queued by the
// previous version keep working through a deploy. Drop once no in-flight
// invocations can be carrying it.
export interface EncodeShareMp4Event {
  kind: "encode-share-mp4";
  drawing_id: string;
}

export function isEncodeShareMp4Event(event: unknown): event is EncodeShareMp4Event {
  const e = event as EncodeShareMp4Event | null | undefined;
  return (
    e?.kind === "encode-share-mp4" &&
    typeof e.drawing_id === "string" &&
    DRAWING_ID_RE.test(e.drawing_id)
  );
}

// Worker for the deferred encode: reads the already-written -large.gif,
// transcodes, writes the -large.mp4 sidecar. Failures are logged, never
// thrown — the async invocation has no caller to surface them to, and
// scripts/backfill-share-mp4.ts repairs any gaps. The encoder is
// injectable so tests don't spawn ffmpeg.
export async function encodeShareMp4FromStorage(
  storage: Storage,
  drawing_id: string,
  encode: (gif: Uint8Array) => Promise<Uint8Array> = encodeShareMp4,
): Promise<StepOutcome> {
  try {
    const large = await storage.getBytes(`public/tiles/${drawing_id}-large.gif`);
    if (!large) throw new Error("-large.gif not found in storage");
    const mp4 = await encode(large);
    await storage.put(
      `public/tiles/${drawing_id}-large.mp4`,
      mp4,
      "video/mp4",
      "public, max-age=31536000, immutable",
    );
    return { ok: true };
  } catch (e) {
    const error = errMsg(e);
    console.error(`[ingest] deferred -large.mp4 write failed for ${drawing_id}:`, e);
    return { ok: false, error };
  }
}

// Renders the 960x960 annotated share GIF (og:image on /d/<id>) from the
// published gif bytes. Extracted so both the deferred worker and
// scripts/backfill-large-gifs.ts describe the same transform.
// Outcome of one tail step. The tail still never throws — an async
// invocation has no caller to surface an error to — but it now REPORTS
// what happened, so a synchronous caller (the targeted backfill) can tell
// the difference between "repaired" and "silently failed again".
export interface StepOutcome {
  ok: boolean;
  error?: string;
}

export interface PostPublishOutcome {
  large_gif: StepOutcome;
  large_mp4: StepOutcome | { ok: false; error: "skipped: -large.gif step failed" };
  invalidation: StepOutcome;
}

export async function writeLargeGifFromStorage(
  storage: Storage,
  drawing_id: string,
): Promise<Uint8Array | null> {
  try {
    const gif = await storage.getBytes(`public/tiles/${drawing_id}.gif`);
    if (!gif) throw new Error("published gif not found in storage");
    const decoded = decodeGif(gif);
    if (!decoded.activePalette) throw new Error("decoded gif has no active palette");
    const large = encodeShareGif({
      frames: decoded.frames,
      activePalette: decoded.activePalette,
      delayMs: decoded.delayMs,
    });
    await storage.put(
      `public/tiles/${drawing_id}-large.gif`,
      large,
      "image/gif",
      "public, max-age=31536000, immutable",
    );
    return large;
  } catch (e) {
    lastLargeGifError = errMsg(e);
    console.error(`[ingest] -large.gif write failed for ${drawing_id}:`, e);
    return null;
  }
}

// Set by writeLargeGifFromStorage on failure so runPostPublish can report
// the reason without changing that function's Uint8Array|null contract,
// which scripts/backfill-large-gifs.ts also depends on.
let lastLargeGifError: string | null = null;

export interface PostPublishConfig {
  storage: Storage;
  cacheInvalidator?: CacheInvalidator;
  encodeMp4?: (gif: Uint8Array) => Promise<Uint8Array>;
}

// The post-publish tail, off the response path.
//
// Everything here is derived data: the share sidecars can be rebuilt by
// scripts/backfill-*.ts and a skipped invalidation self-heals when the
// edge TTL expires. None of it is worth making a publisher wait on —
// encodeShareGif alone is ~0.5s for a 16-frame drawing, which was the
// single largest term in the publish response time.
//
// The invalidation runs CONCURRENTLY with the encodes rather than after
// them: it's what makes the new drawing appear on the feed, so it should
// not queue behind ~2s of image and video work.
//
// Never throws — an async invocation has no caller to surface errors to.
export async function runPostPublish(
  job: PostPublishJob,
  cfg: PostPublishConfig,
): Promise<PostPublishOutcome> {
  const invalidate = async (): Promise<StepOutcome> => {
    if (!cfg.cacheInvalidator) return { ok: true };
    try {
      const paths =
        job.mode === "backfill"
          ? pathsToInvalidateOnSidecarBackfill(job.drawing_id)
          : pathsToInvalidateOnPublish(job.username, { promptTagged: job.prompt_tagged });
      await cfg.cacheInvalidator.invalidate(paths);
      return { ok: true };
    } catch (e) {
      console.error(`[ingest] invalidation failed for ${job.drawing_id}:`, e);
      return { ok: false, error: errMsg(e) };
    }
  };
  const sidecars = async (): Promise<Pick<PostPublishOutcome, "large_gif" | "large_mp4">> => {
    // Sequential by necessity: ffmpeg transcodes the gif this step renders.
    lastLargeGifError = null;
    const large = await writeLargeGifFromStorage(cfg.storage, job.drawing_id);
    if (!large) {
      return {
        large_gif: { ok: false, error: lastLargeGifError ?? "unknown" },
        large_mp4: { ok: false, error: "skipped: -large.gif step failed" },
      };
    }
    const mp4 = await encodeShareMp4FromStorage(cfg.storage, job.drawing_id, cfg.encodeMp4);
    return { large_gif: { ok: true }, large_mp4: mp4 };
  };
  const [invalidation, both] = await Promise.all([invalidate(), sidecars()]);
  return { ...both, invalidation };
}

export async function handleIngest(req: IngestRequest, cfg: HandlerConfig): Promise<IngestHandlerResult> {
  const now = cfg.now ? cfg.now() : new Date();
  const nowISO = now.toISOString();
  const shareUrlFor = (id: string): string => `${cfg.publicBaseUrl}/d/${id}`;

  // -- 0. Shape check ---------------------------------------------------------
  // The routes hand over parsed JSON with a compile-time-only cast, so
  // nothing upstream guarantees the field types. Reject wrong-typed fields
  // here, before any of them can reach storage (e.g. a numeric `parent`
  // would otherwise land on the DDB row as-is).
  const badField = shapeError(req, {
    gif: "required",
    parent: "optional",
    prompt: "optional",
    layers_json: "optional",
  });
  if (badField !== null) return err400(`invalid field: ${badField}`);

  // -- 1. Parse gif from base64 and validate structure -----------------------
  let gif: Uint8Array;
  try {
    gif = base64Decode(req.gif);
  } catch (err) {
    return err400(`bad base64: ${errMsg(err)}`);
  }
  let validation: GifValidation;
  try {
    validation = validateGif(gif);
  } catch (err) {
    return err400(`invalid gif: ${errMsg(err)}`);
  }

  // -- 2. Content-addressed id -----------------------------------------------
  // id is derived from the gif bytes alone: same drawing => same id.
  const id = await contentHashHex(gif);
  const author = cfg.auth ?? ANONYMOUS_AUTHOR;
  const isAnonymous = cfg.auth === null;

  // Daily-prompt tag: stored ONLY when the submitted slug is well-formed
  // AND equals today's ET prompt. Anything else (stale slug, garbage, a
  // future theme) is silently dropped — a bad prompt must never fail or
  // alter an otherwise-valid publish.
  const promptId =
    req.prompt !== undefined &&
    PROMPT_SLUG_RE.test(req.prompt) &&
    req.prompt === promptForDate(now).slug
      ? req.prompt
      : undefined;

  // Dual-write to the dynamic DDB store so /, /d/<id>, /u/<username>,
  // /feed.rss can serve the drawing immediately. Wrapped in try/catch —
  // the gif is already persisted to S3 (or was on a previous publish),
  // and a DDB write failure shouldn't surface as a publish error; a
  // re-publish of the same bytes self-heals the row (see the idempotency
  // branch below).
  const writeDrawingRow = async (): Promise<void> => {
    if (!cfg.drawingStore) return;
    try {
      const layersJson =
        typeof req.layers_json === "string" && req.layers_json.length <= MAX_LAYERS_JSON_BYTES
          ? req.layers_json
          : undefined;
      await cfg.drawingStore.put({
        drawing_id: id,
        // size + frames come from the validateGif scan — no LZW decode
        // needed for the metadata row, and the row can't diverge from
        // what validation checked.
        size: validation.size,
        created_at: nowISO,
        created_at_ms: now.getTime(),
        user_id: author.user_id,
        username: author.username,
        parent_id: req.parent ?? null,
        // Optional-absent (never null) so GSI4 stays sparse.
        ...(promptId !== undefined ? { prompt_id: promptId } : {}),
        frames: validation.frameCount,
        gif_size_bytes: gif.length,
        ...(layersJson !== undefined ? { layers_json: layersJson } : {}),
      });
    } catch (e) {
      console.error("[ingest] failed to write drawing row to DDB", e);
    }
  };

  // -- 3. Idempotency check --------------------------------------------------
  // Tiles are content-addressed (id = sha256(gif_bytes)), so the same drawing
  // always produces the same id. Re-publishes short-circuit on existing —
  // but first self-heal a missing DDB row: the original publish's row write
  // is non-fatal, so a gif can exist in S3 with no row and stay invisible
  // on the site forever (nothing sweeps). Sidecars and stats are NOT
  // regenerated here — the -large.gif/-large.mp4 gaps have dedicated
  // backfill scripts, and re-running stats would double-count.
  const publishedKey = `public/tiles/${id}.gif`;
  const alreadyHere = await cfg.storage.exists(publishedKey);
  if (alreadyHere) {
    if (cfg.drawingStore) {
      try {
        const existing = await cfg.drawingStore.get(id);
        if (!existing) await writeDrawingRow();
      } catch (e) {
        console.error(`[ingest] self-heal row check failed for ${id}:`, e);
      }
    }
    return {
      status: 200,
      body: { id, share_url: shareUrlFor(id) },
    };
  }

  // -- 4. Persist the gif -----------------------------------------------------
  // Stored as public/tiles/<id>.gif. Templates link to /tiles/<id>.gif
  // directly; the legacy /drawings/<id>.gif path still resolves via the
  // CloudFront rewrite for any stragglers in third-party caches.
  await cfg.storage.put(
    publishedKey,
    gif,
    "image/gif",
    "public, max-age=31536000, immutable",
  );

  // Post-publish tail: share sidecars + CloudFront invalidation. All of it
  // is derived data (rebuildable by scripts/backfill-*.ts, and a skipped
  // invalidation self-heals at the edge TTL), so none of it belongs on the
  // response path — encodeShareGif alone is ~0.5s for a 16-frame drawing.
  //
  // The Event-type self-invoke resolves as soon as Lambda queues the
  // payload. If queueing fails we fall back to running the work inline:
  // slow, but a rare error path, and better than silently dropping the
  // OG image and the cache flush.
  const job: PostPublishJob = {
    drawing_id: id,
    username: isAnonymous ? null : author.username,
    prompt_tagged: promptId !== undefined,
  };
  const postPublish = async (): Promise<void> => {
    if (cfg.deferPostPublish) {
      try {
        await cfg.deferPostPublish(job);
        return;
      } catch (e) {
        console.error(`[ingest] deferring post-publish failed for ${id}, running inline:`, e);
      }
    }
    await runPostPublish(job, {
      storage: cfg.storage,
      cacheInvalidator: cfg.cacheInvalidator,
    });
  };

  // Streak / total counters (#115). Wrapped in try/catch because the gif
  // has already been persisted and a stats failure must not surface as a
  // publish failure.
  const recordStats = async (): Promise<void> => {
    // Anonymous publishes have no account to credit, and the sentinel
    // user_id is shared by every one of them — recording against it would
    // build a meaningless streak nobody can see.
    if (!cfg.userStatsStore || isAnonymous) return;
    try {
      await cfg.userStatsStore.recordDailyDrawing({
        user_id: author.user_id,
        date_utc: nowISO.slice(0, 10),
        now_iso: nowISO,
      });
    } catch (e) {
      console.error("[ingest] failed to record daily drawing stats", e);
    }
  };

  // The three post-commit branches are mutually independent — nothing
  // reads another's output — so they run concurrently and the response
  // latency is their max, not their sum. Each branch swallows its own
  // errors (Promise.all can't reject), and all are awaited before return
  // because Lambda freezes pending work at handler exit — including the
  // self-invoke that queues the post-publish tail. The dynamic /d/<id>
  // page is served by render-handlers.ts off the drawing-store row — no
  // need to sync-render anything here.
  await Promise.all([writeDrawingRow(), recordStats(), postPublish()]);

  return {
    status: 202,
    body: { id, share_url: shareUrlFor(id) },
  };
}

function err400(message: string): IngestError {
  return { status: 400, body: { error: message } };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function base64Decode(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
