import { MAX_LAYERS_JSON_BYTES } from "../config/constants.js";
import { contentHashHex } from "../src/content-hash.js";
import { PROMPT_SLUG_RE, promptForDate } from "../config/prompts.js";
import { decodeGif } from "../src/editor/gif.js";
import { encodeShareGif } from "../src/editor/share-gif.js";
import { encodeShareMp4 } from "./share-mp4.js";
import { validateGif, type GifValidation } from "./gif-validate.js";
import type { Storage } from "./storage.js";
import type { UserStatsStore } from "./user-stats-store.js";
import type { DrawingStore } from "./drawing-store.js";
import {
  pathsToInvalidateOnPublish,
  type CacheInvalidator,
} from "./cache-invalidation.js";

// The authenticated publisher, derived from the verified session JWT by the
// route (lambda.ts / dev-server.ts). The request body never carries identity.
export interface AuthedUser {
  user_id: string; // 64-hex stable account id
  username: string; // public handle, used in /u/<username>
}

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
  // Authenticated publisher (from the verified session JWT). The route
  // returns 401 before reaching here when the token is missing/invalid.
  auth: AuthedUser;
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
}

export async function handleIngest(req: IngestRequest, cfg: HandlerConfig): Promise<IngestHandlerResult> {
  const now = cfg.now ? cfg.now() : new Date();
  const nowISO = now.toISOString();
  const shareUrlFor = (id: string): string => `${cfg.publicBaseUrl}/d/${id}`;

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
  const author = cfg.auth;

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

  // Sidecar chain: the 960×960 annotated share image at
  // public/tiles/<id>-large.gif (og:image on the tile page), then the
  // Instagram-shareable MP4 at public/tiles/<id>-large.mp4 — sequential
  // within this branch because ffmpeg consumes the just-rendered gif
  // bytes. Each step wrapped in try/catch — the original gif is already
  // committed and a sidecar failure must not surface as a publish error.
  // Log with the tile id so operators can backfill via
  // scripts/backfill-large-gifs.ts / scripts/backfill-share-mp4.ts.
  const writeSidecars = async (): Promise<void> => {
    let large: Uint8Array | null = null;
    try {
      const decoded = decodeGif(gif);
      if (!decoded.activePalette) {
        throw new Error("decoded gif has no active palette");
      }
      large = encodeShareGif({
        frames: decoded.frames,
        activePalette: decoded.activePalette,
        delayMs: decoded.delayMs,
      });
      await cfg.storage.put(
        `public/tiles/${id}-large.gif`,
        large,
        "image/gif",
        "public, max-age=31536000, immutable",
      );
    } catch (e) {
      console.error(`[ingest] -large.gif write failed for ${id}:`, e);
    }
    if (large) {
      try {
        const mp4 = await encodeShareMp4(large);
        await cfg.storage.put(
          `public/tiles/${id}-large.mp4`,
          mp4,
          "video/mp4",
          "public, max-age=31536000, immutable",
        );
      } catch (e) {
        console.error(`[ingest] -large.mp4 write failed for ${id}:`, e);
      }
    }
  };

  // Streak / total counters (#115). Wrapped in try/catch because the gif
  // has already been persisted and a stats failure must not surface as a
  // publish failure.
  const recordStats = async (): Promise<void> => {
    if (!cfg.userStatsStore) return;
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
  // because Lambda freezes pending work at handler exit. The dynamic
  // /d/<id> page is served by render-handlers.ts off the drawing-store
  // row — no need to sync-render anything here.
  await Promise.all([writeDrawingRow(), writeSidecars(), recordStats()]);

  // CloudFront invalidation, awaited because Lambda freezes the execution
  // environment as soon as the handler returns — a fire-and-forget request
  // may never be sent. Failures are logged inside the invalidator; the
  // publish has already committed so we return 202 regardless of whether
  // the cache flush succeeded.
  if (cfg.cacheInvalidator) {
    await cfg.cacheInvalidator.invalidate(
      pathsToInvalidateOnPublish(author.username, { promptTagged: promptId !== undefined }),
    );
  }

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
