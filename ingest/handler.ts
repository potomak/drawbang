import { INITIAL_STATE, ageSecondsBetween, contentHash, hashHex, leadingZeroBits, powHash, requiredBits } from "../src/pow.js";
import type { LastPublishState } from "../src/pow.js";
import renderDrawing, {
  type DrawingMuralMembership,
} from "../builder/templates/drawing.js";
import {
  PUBLISH_COOLDOWN_S,
  TILES_PER_SIDE,
  muralClosesAt,
  muralIdForDate,
  muralName,
  muralOpensAt,
  isMuralIdValid,
  tileKey,
} from "../config/murals.js";
import {
  CURRENT_STATE_KEY,
  type CurrentMuralState,
} from "../builder/mural-pass.js";
import { decodeGif } from "../src/editor/gif.js";
import { encodeShareGif } from "../src/editor/share-gif.js";
import { validateGif } from "./gif-validate.js";
import type { Storage } from "./storage.js";
import {
  AlreadyPublishedError,
  ClaimExpiredError,
  CooldownError,
  NotClaimerError,
  TileLockedError,
  type MuralStore,
} from "./mural-store.js";
import {
  appendMuralMembership,
  loadMurals,
} from "./murals-sidecar.js";
import type { UserStatsStore } from "./user-stats-store.js";

export interface MuralClaimRef {
  mural_id: string;
  x: number;
  y: number;
}

// The authenticated publisher, derived from the verified session JWT by the
// route (lambda.ts / dev-server.ts). The request body never carries identity.
export interface AuthedUser {
  user_id: string; // 64-hex stable account id
  username: string; // public handle, used in /u/<username>
}

export interface IngestRequest {
  gif: string; // base64
  nonce: string;
  baseline: string; // iso-8601
  solve_ms?: number;
  bench_hps?: number;
  parent?: string;
  // Present only when publishing into a weekly mural tile. The tile must
  // have been previously claimed by the same account via POST /mural/claim.
  mural_claim?: MuralClaimRef;
}

export interface IngestSuccess {
  status: 200 | 202;
  body: {
    id: string;
    share_url: string;
    required_bits: number;
    solve_ms: number;
    mural?: { mural_id: string; x: number; y: number };
  };
}
export interface IngestError {
  status: 400 | 403 | 409 | 413 | 429 | 500;
  body: { error: string; retry_after_s?: number };
}
export type IngestHandlerResult = IngestSuccess | IngestError;

export interface HandlerConfig {
  storage: Storage;
  publicBaseUrl: string; // e.g. https://drawbang.example
  // Authenticated publisher (from the verified session JWT). The route
  // returns 401 before reaching here when the token is missing/invalid.
  auth: AuthedUser;
  // GitHub repo URL for the footer link on the synchronous drawing page.
  repoUrl?: string;
  now?: () => Date;
  baselineHistory?: string[]; // optional: last N baselines to accept
  // Required only for mural-aware ingest. Non-mural publishes never touch it.
  muralStore?: MuralStore;
  // Per-pubkey streak / total counters (#115, #116). Optional so dev/tests
  // can omit it; when absent the publish proceeds without bumping counters.
  userStatsStore?: UserStatsStore;
}

export interface ChildEntry {
  id: string;
  id_short: string;
  user_id: string;
  username: string;
  created_at: string;
}

interface ChildrenFile {
  drawing_id: string;
  children: ChildEntry[];
}

function childrenFileKey(id: string): string {
  return `public/drawings/${id}.children.json`;
}

async function loadChildren(
  storage: Storage,
  id: string,
): Promise<ChildEntry[]> {
  const f = await storage.getJSON<ChildrenFile>(childrenFileKey(id));
  return f?.children ?? [];
}

async function appendChild(
  storage: Storage,
  parentId: string,
  entry: ChildEntry,
): Promise<ChildEntry[]> {
  const existing = await loadChildren(storage, parentId);
  // De-dupe by child id so a re-publish of the same fork doesn't grow the
  // parent's list. The drawing id is content-addressed, so byte-identical
  // re-forks collapse onto one entry.
  const filtered = existing.filter((e) => e.id !== entry.id);
  filtered.push(entry);
  const payload: ChildrenFile = { drawing_id: parentId, children: filtered };
  await storage.put(
    childrenFileKey(parentId),
    new TextEncoder().encode(JSON.stringify(payload)),
    "application/json",
    "no-store",
  );
  return filtered;
}

// Stateful per-instance list of accepted baselines, used as a rolling grace
// window so concurrent solvers racing on the same baseline both succeed.
const defaultBaselineHistory: string[] = [];

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
  try {
    validateGif(gif);
  } catch (err) {
    return err400(`invalid gif: ${errMsg(err)}`);
  }

  // -- 2. Load state and validate baseline -----------------------------------
  const state = (await cfg.storage.getJSON<LastPublishState>("public/state/last-publish.json")) ?? INITIAL_STATE;
  const history = cfg.baselineHistory ?? defaultBaselineHistory;
  if (ageSecondsBetween(nowISO, req.baseline) < -5) {
    return err400(`baseline in the future: ${req.baseline}`);
  }

  // Virgin state: accept any baseline that matches the initial sentinel.
  const firstEver = state.last_publish_at === INITIAL_STATE.last_publish_at;
  const baselineOk =
    req.baseline === state.last_publish_at ||
    history.includes(req.baseline) ||
    (firstEver && req.baseline === INITIAL_STATE.last_publish_at);

  if (!baselineOk) {
    return err400(`baseline stale: does not match current or recent history (${req.baseline})`);
  }

  // Difficulty is computed relative to the baseline the client used, not the
  // (possibly newer) current state. This keeps concurrent solvers fair — they
  // grind against the same bits they computed at fetch time — while the
  // baseline-grace window above bounds how long a stale baseline is valid.
  const baselineAge = firstEver
    ? Number.POSITIVE_INFINITY
    : Math.max(0, ageSecondsBetween(nowISO, req.baseline));

  // -- 3. Compute required bits and verify PoW -------------------------------
  const bits = requiredBits(baselineAge);
  const pow = await powHash(gif, req.baseline, req.nonce);
  const actualBits = leadingZeroBits(pow);
  if (actualBits < bits) {
    return err400(`pow insufficient: ${actualBits} < ${bits}`);
  }

  // Benchmark sanity (log-only, not rejected).
  if (req.solve_ms && req.bench_hps) {
    const expected = Math.pow(2, bits);
    const claimed = (req.solve_ms / 1000) * req.bench_hps;
    const ratio = claimed / expected;
    if (ratio < 0.01 || ratio > 100) {
      // eslint-disable-next-line no-console
      console.warn(`pow benchmark mismatch: claimed=${claimed.toFixed(0)} expected=${expected.toFixed(0)} ratio=${ratio.toFixed(2)}`);
    }
  }

  // -- 4. Content-addressed id ------------------------------------------------
  // id is derived from the gif bytes alone: same drawing => same id, regardless
  // of how many times someone grinds a fresh PoW for it.
  const id = hashHex(await contentHash(gif));
  const author = cfg.auth;

  // -- 5. Mural-claim pre-checks --------------------------------------------
  // Run *before* the idempotency check: content-addressed ids mean the same
  // gif can legitimately appear in multiple murals, so we can't early-return
  // on existing-gif when mural_claim is present.
  if (req.mural_claim) {
    if (!cfg.muralStore) {
      return err500("mural store not configured");
    }
    const cc = req.mural_claim;
    if (typeof cc.mural_id !== "string" || !isMuralIdValid(cc.mural_id)) {
      return err400("invalid mural_claim.mural_id");
    }
    if (
      !Number.isInteger(cc.x) ||
      !Number.isInteger(cc.y) ||
      cc.x < 0 ||
      cc.x >= TILES_PER_SIDE ||
      cc.y < 0 ||
      cc.y >= TILES_PER_SIDE
    ) {
      return err400("invalid mural_claim coordinates");
    }
    const opensAt = muralOpensAt(cc.mural_id).getTime();
    const closesAt = muralClosesAt(cc.mural_id).getTime();
    if (now.getTime() < opensAt) return err403("mural not opened yet");
    if (now.getTime() >= closesAt) return err403("mural is locked");
  }

  // -- 6. Idempotency check (non-mural only) --------------------------------
  const powHex = hashHex(pow);
  const day = nowISO.slice(0, 10);
  const gifKey = `inbox/${day}/${id}.gif`;
  const jsonKey = `inbox/${day}/${id}.json`;
  const publishedKey = `public/drawings/${id}.gif`;

  const alreadyHere =
    (await cfg.storage.exists(publishedKey)) ||
    (await cfg.storage.exists(gifKey));

  if (alreadyHere && !req.mural_claim) {
    return {
      status: 200,
      body: {
        id,
        share_url: shareUrlFor(id),
        required_bits: bits,
        solve_ms: req.solve_ms ?? 0,
      },
    };
  }

  // -- 7. Persist gif + sidecar (skip if already present) --------------------
  const enc = new TextEncoder();
  if (!alreadyHere) {
    const metadata = {
      id,
      pow: powHex,
      nonce: req.nonce,
      baseline: req.baseline,
      solve_ms: req.solve_ms ?? null,
      bench_hps: req.bench_hps ?? null,
      required_bits: bits,
      created_at: nowISO,
      parent: req.parent ?? null,
      user_id: author.user_id,
      username: author.username,
    };
    await Promise.all([
      cfg.storage.put(gifKey, gif, "image/gif"),
      cfg.storage.put(
        jsonKey,
        enc.encode(JSON.stringify(metadata)),
        "application/json",
      ),
      cfg.storage.put(
        publishedKey,
        gif,
        "image/gif",
        "public, max-age=31536000, immutable",
      ),
    ]);

    // 320×320 annotated share image written next to the original at
    // public/drawings/<id>-large.gif. Used as og:image on the drawing page;
    // crawlers (Reddit, X, Slack, Discord, …) hit this URL when they
    // resolve the OG tags. Adds a used-colors swatch and the Drawbang
    // wordmark (#195). Wrapped in try/catch — the original gif is already
    // committed and a share-image failure must not surface as a publish
    // error.
    try {
      const decoded = decodeGif(gif);
      // validateGif (section 1) already rejects gifs missing the DRAWBANG
      // application extension, so activePalette must be non-null here.
      // Guard defensively in case the validator's contract loosens.
      if (!decoded.activePalette) {
        throw new Error("decoded gif has no active palette");
      }
      const large = encodeShareGif({
        frames: decoded.frames,
        activePalette: decoded.activePalette,
        delayMs: decoded.delayMs,
      });
      await cfg.storage.put(
        `public/drawings/${id}-large.gif`,
        large,
        "image/gif",
        "public, max-age=31536000, immutable",
      );
    } catch (e) {
      console.error("[ingest] failed to write 320x320 og gif", e);
    }

    // Streak / total counters (#115). Bump only when this branch fires —
    // i.e. a brand-new gif. The early-return at section 6 already filters
    // out re-publishes of an existing gif without mural_claim; the mural
    // branch below handles same-gif-into-new-mural separately. Wrapped in
    // try/catch because the gif has already been persisted and a stats
    // failure must not surface as a publish failure.
    if (cfg.userStatsStore) {
      try {
        await cfg.userStatsStore.recordDailyDrawing({
          user_id: author.user_id,
          date_utc: nowISO.slice(0, 10),
          now_iso: nowISO,
        });
      } catch (e) {
        console.error("[ingest] failed to record daily drawing stats", e);
      }
    }
  }

  // -- 7b. Fork lineage: append this drawing to the parent's children list.
  // Hidden by default in the parent page; hydrated client-side from the
  // sidecar so the frozen, server-rendered parent HTML never needs to be
  // re-written when a new fork lands.
  if (
    typeof req.parent === "string" &&
    /^[0-9a-f]{64}$/.test(req.parent) &&
    req.parent !== id
  ) {
    await appendChild(cfg.storage, req.parent, {
      id,
      id_short: id.slice(0, 8),
      user_id: author.user_id,
      username: author.username,
      created_at: nowISO,
    });
  }

  // -- 8. Mural publish (atomic tile + cooldown) ----------------------------
  let appendedMembership: DrawingMuralMembership | null = null;
  if (req.mural_claim) {
    const cc = req.mural_claim;
    const tk = tileKey(cc.x, cc.y);
    try {
      await cfg.muralStore!.publishTile({
        mural_id: cc.mural_id,
        tile_key: tk,
        user_id: author.user_id,
        drawing_id: id,
        now_epoch: Math.floor(now.getTime() / 1000),
        cooldown_s: PUBLISH_COOLDOWN_S,
        cooldown_ttl_s: 7 * 86_400,
      });
    } catch (e: unknown) {
      if (e instanceof CooldownError) {
        return { status: 429, body: { error: "cooldown active", retry_after_s: e.retry_after_s } };
      }
      if (e instanceof ClaimExpiredError) return err403("claim expired");
      if (e instanceof NotClaimerError) return err403("you are not the tile claimer");
      if (e instanceof AlreadyPublishedError) return err409("tile already published");
      if (e instanceof TileLockedError) return err409("tile already claimed by another");
      throw e;
    }
    appendedMembership = {
      id: cc.mural_id,
      name: muralName(cc.mural_id),
      x: cc.x,
      y: cc.y,
      claimed_by: author.user_id,
      claimed_by_username: author.username,
    };
    await appendMuralMembership(cfg.storage, id, appendedMembership);

    // Mural-participation streak (#115). First publish into mural_id by
    // this pubkey bumps mural_total + advances the consecutive-weeks
    // streak; same-mural re-publishes are no-ops at the store layer. Same
    // try/catch policy as the daily hook above and the snapshot refresh
    // below — stats failures must not surface as publish failures.
    if (cfg.userStatsStore) {
      try {
        await cfg.userStatsStore.recordMuralParticipation({
          user_id: author.user_id,
          mural_id: cc.mural_id,
          now_iso: nowISO,
        });
      } catch (e) {
        console.error("[ingest] failed to record mural participation stats", e);
      }
    }

    // Refresh the home-banner snapshot so /state/current-mural.json picks up
    // the new tile within ~60s of edge cache, without making every home-page
    // visit pay for a Lambda+DDB hit on /mural/<id>/state. Gated on the
    // mural being the *current* one (muralIdForDate(now)) — publishing into
    // a not-yet-rolled-over mural during builder lag must not overwrite the
    // "current" pointer with a stale mural. Wrapped in try/catch because the
    // publish has already committed and a snapshot write failure must not
    // bubble out as a publish failure.
    if (cc.mural_id === muralIdForDate(now)) {
      try {
        const tiles = await cfg.muralStore!.getTiles(cc.mural_id);
        const nowEpoch = Math.floor(now.getTime() / 1000);
        let tiles_claimed = 0;
        let tiles_published = 0;
        for (const t of tiles) {
          if (t.drawing_id) tiles_published++;
          else if (t.claim_expires_at && t.claim_expires_at > nowEpoch) tiles_claimed++;
        }
        const current: CurrentMuralState = {
          mural_id: cc.mural_id,
          name: muralName(cc.mural_id),
          opens_at: muralOpensAt(cc.mural_id).toISOString(),
          closes_at: muralClosesAt(cc.mural_id).toISOString(),
          tiles_total: TILES_PER_SIDE * TILES_PER_SIDE,
          tiles_claimed,
          tiles_published,
        };
        await cfg.storage.put(
          CURRENT_STATE_KEY,
          enc.encode(JSON.stringify(current)),
          "application/json",
          "public, max-age=60",
        );
      } catch (e) {
        console.error("[ingest] failed to refresh current-mural snapshot", e);
      }
    }
  }

  // -- 9. (Re-)render drawing page with the murals[] in scope --------------
  const murals = appendedMembership
    ? await loadMurals(cfg.storage, id)
    : alreadyHere
      ? await loadMurals(cfg.storage, id)
      : [];
  const drawingHtml = renderDrawing({
    id,
    id_short: id.slice(0, 8),
    created_at: nowISO,
    parent: req.parent
      ? { parent: req.parent, parent_short: req.parent.slice(0, 8) }
      : null,
    author: { user_id: author.user_id, username: author.username },
    murals,
    public_base_url: cfg.publicBaseUrl,
    repo_url: cfg.repoUrl ?? "https://github.com/potomak/drawbang",
  });
  await cfg.storage.put(
    `public/d/${id}.html`,
    enc.encode(drawingHtml),
    "text/html",
    "public, max-age=60",
  );

  // -- 10. Update last-publish.json (and keep baseline history window) -------
  const newState: LastPublishState = {
    last_publish_at: nowISO,
    last_difficulty_bits: bits,
  };
  await cfg.storage.put(
    "public/state/last-publish.json",
    enc.encode(JSON.stringify(newState)),
    "application/json",
    "no-store",
  );
  history.push(state.last_publish_at);
  while (history.length > 8) history.shift();

  return {
    status: 202,
    body: {
      id,
      share_url: shareUrlFor(id),
      required_bits: bits,
      solve_ms: req.solve_ms ?? 0,
      ...(appendedMembership
        ? {
            mural: {
              mural_id: appendedMembership.id,
              x: appendedMembership.x,
              y: appendedMembership.y,
            },
          }
        : {}),
    },
  };
}

function err400(message: string): IngestError {
  return { status: 400, body: { error: message } };
}

function err403(message: string): IngestError {
  return { status: 403, body: { error: message } };
}

function err409(message: string): IngestError {
  return { status: 409, body: { error: message } };
}

function err500(message: string): IngestError {
  return { status: 500, body: { error: message } };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function base64Decode(s: string): Uint8Array {
  // Works in both Node (Buffer) and browser (atob).
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
