import { INITIAL_STATE, ageSecondsBetween, contentHash, hashHex, leadingZeroBits, powHash, requiredBits } from "../src/pow.js";
import type { LastPublishState } from "../src/pow.js";
import { verifyDrawingId } from "../src/identity.js";
import renderDrawing, {
  type DrawingCanvasMembership,
} from "../builder/templates/drawing.js";
import {
  PUBLISH_COOLDOWN_S,
  TILES_PER_SIDE,
  canvasClosesAt,
  canvasIdForDate,
  canvasName,
  canvasOpensAt,
  isCanvasIdValid,
  tileKey,
} from "../config/canvases.js";
import {
  CURRENT_STATE_KEY,
  type CurrentCanvasState,
} from "../builder/canvas-pass.js";
import { validateGif } from "./gif-validate.js";
import type { Storage } from "./storage.js";
import {
  AlreadyPublishedError,
  ClaimExpiredError,
  CooldownError,
  NotClaimerError,
  TileLockedError,
  type CanvasStore,
} from "./canvas-store.js";

export interface CanvasClaimRef {
  canvas_id: string;
  x: number;
  y: number;
}

export interface IngestRequest {
  gif: string; // base64
  nonce: string;
  baseline: string; // iso-8601
  solve_ms?: number;
  bench_hps?: number;
  parent?: string;
  pubkey: string;     // 64 hex (Ed25519 raw public key)
  signature: string;  // 128 hex (Ed25519 signature over hexToBytes(drawing_id))
  // Present only when publishing into a weekly canvas tile. The tile must
  // have been previously claimed by the same pubkey via POST /canvas/claim.
  canvas_claim?: CanvasClaimRef;
}

export interface IngestSuccess {
  status: 200 | 202;
  body: {
    id: string;
    share_url: string;
    required_bits: number;
    solve_ms: number;
    canvas?: { canvas_id: string; x: number; y: number };
  };
}
export interface IngestError {
  status: 400 | 403 | 409 | 413 | 429 | 500;
  body: { error: string; retry_after_s?: number };
}
export type IngestResult = IngestSuccess | IngestError;

export interface HandlerConfig {
  storage: Storage;
  publicBaseUrl: string; // e.g. https://drawbang.example
  // GitHub repo URL for the footer link on the synchronous drawing page.
  repoUrl?: string;
  now?: () => Date;
  baselineHistory?: string[]; // optional: last N baselines to accept
  // Required only for canvas-aware ingest. Non-canvas publishes never touch it.
  canvasStore?: CanvasStore;
}

interface CanvasesFile {
  drawing_id: string;
  canvases: DrawingCanvasMembership[];
}

function canvasesFileKey(id: string): string {
  return `public/drawings/${id}.canvases.json`;
}

async function loadCanvases(
  storage: Storage,
  id: string,
): Promise<DrawingCanvasMembership[]> {
  const f = await storage.getJSON<CanvasesFile>(canvasesFileKey(id));
  return f?.canvases ?? [];
}

async function appendCanvasMembership(
  storage: Storage,
  id: string,
  entry: DrawingCanvasMembership,
): Promise<DrawingCanvasMembership[]> {
  const existing = await loadCanvases(storage, id);
  // De-dupe by (canvas_id, x, y) so an idempotent re-publish doesn't grow
  // the list. Last writer wins on claimant attribution (which shouldn't
  // happen given DDB's drawing_id-set constraint, but be defensive).
  const filtered = existing.filter(
    (e) => !(e.id === entry.id && e.x === entry.x && e.y === entry.y),
  );
  filtered.push(entry);
  const payload: CanvasesFile = { drawing_id: id, canvases: filtered };
  await storage.put(
    canvasesFileKey(id),
    new TextEncoder().encode(JSON.stringify(payload)),
    "application/json",
    "no-store",
  );
  return filtered;
}

export interface ChildEntry {
  id: string;
  id_short: string;
  pubkey: string;
  pubkey_short: string;
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

export async function handleIngest(req: IngestRequest, cfg: HandlerConfig): Promise<IngestResult> {
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

  // -- 4b. Ownership signature -----------------------------------------------
  if (typeof req.pubkey !== "string" || !/^[0-9a-f]{64}$/.test(req.pubkey)) {
    return err400("missing or malformed pubkey");
  }
  if (typeof req.signature !== "string" || !/^[0-9a-f]{128}$/.test(req.signature)) {
    return err400("missing or malformed signature");
  }
  if (!(await verifyDrawingId(req.pubkey, id, req.signature))) {
    return err400("signature does not verify against pubkey");
  }

  // -- 5. Canvas-claim pre-checks --------------------------------------------
  // Run *before* the idempotency check: content-addressed ids mean the same
  // gif can legitimately appear in multiple canvases, so we can't early-return
  // on existing-gif when canvas_claim is present.
  if (req.canvas_claim) {
    if (!cfg.canvasStore) {
      return err500("canvas store not configured");
    }
    const cc = req.canvas_claim;
    if (typeof cc.canvas_id !== "string" || !isCanvasIdValid(cc.canvas_id)) {
      return err400("invalid canvas_claim.canvas_id");
    }
    if (
      !Number.isInteger(cc.x) ||
      !Number.isInteger(cc.y) ||
      cc.x < 0 ||
      cc.x >= TILES_PER_SIDE ||
      cc.y < 0 ||
      cc.y >= TILES_PER_SIDE
    ) {
      return err400("invalid canvas_claim coordinates");
    }
    const opensAt = canvasOpensAt(cc.canvas_id).getTime();
    const closesAt = canvasClosesAt(cc.canvas_id).getTime();
    if (now.getTime() < opensAt) return err403("canvas not opened yet");
    if (now.getTime() >= closesAt) return err403("canvas is locked");
  }

  // -- 6. Idempotency check (non-canvas only) --------------------------------
  const powHex = hashHex(pow);
  const day = nowISO.slice(0, 10);
  const gifKey = `inbox/${day}/${id}.gif`;
  const jsonKey = `inbox/${day}/${id}.json`;
  const publishedKey = `public/drawings/${id}.gif`;

  const alreadyHere =
    (await cfg.storage.exists(publishedKey)) ||
    (await cfg.storage.exists(gifKey));

  if (alreadyHere && !req.canvas_claim) {
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
      pubkey: req.pubkey,
      signature: req.signature,
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
      pubkey: req.pubkey,
      pubkey_short: req.pubkey.slice(0, 8),
      created_at: nowISO,
    });
  }

  // -- 8. Canvas publish (atomic tile + cooldown) ----------------------------
  let appendedMembership: DrawingCanvasMembership | null = null;
  if (req.canvas_claim) {
    const cc = req.canvas_claim;
    const tk = tileKey(cc.x, cc.y);
    try {
      await cfg.canvasStore!.publishTile({
        canvas_id: cc.canvas_id,
        tile_key: tk,
        pubkey: req.pubkey,
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
      id: cc.canvas_id,
      name: canvasName(cc.canvas_id),
      x: cc.x,
      y: cc.y,
      claimed_by: req.pubkey,
      claimed_by_short: req.pubkey.slice(0, 8),
    };
    await appendCanvasMembership(cfg.storage, id, appendedMembership);

    // Refresh the home-banner snapshot so /state/current-canvas.json picks up
    // the new tile within ~60s of edge cache, without making every home-page
    // visit pay for a Lambda+DDB hit on /canvas/<id>/state. Gated on the
    // canvas being the *current* one (canvasIdForDate(now)) — publishing into
    // a not-yet-rolled-over canvas during builder lag must not overwrite the
    // "current" pointer with a stale canvas. Wrapped in try/catch because the
    // publish has already committed and a snapshot write failure must not
    // bubble out as a publish failure.
    if (cc.canvas_id === canvasIdForDate(now)) {
      try {
        const tiles = await cfg.canvasStore!.getTiles(cc.canvas_id);
        const nowEpoch = Math.floor(now.getTime() / 1000);
        let tiles_claimed = 0;
        let tiles_published = 0;
        for (const t of tiles) {
          if (t.drawing_id) tiles_published++;
          else if (t.claim_expires_at && t.claim_expires_at > nowEpoch) tiles_claimed++;
        }
        const current: CurrentCanvasState = {
          canvas_id: cc.canvas_id,
          name: canvasName(cc.canvas_id),
          opens_at: canvasOpensAt(cc.canvas_id).toISOString(),
          closes_at: canvasClosesAt(cc.canvas_id).toISOString(),
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
        console.error("[ingest] failed to refresh current-canvas snapshot", e);
      }
    }
  }

  // -- 9. (Re-)render drawing page with the canvases[] in scope --------------
  const canvases = appendedMembership
    ? await loadCanvases(cfg.storage, id)
    : alreadyHere
      ? await loadCanvases(cfg.storage, id)
      : [];
  const drawingHtml = renderDrawing({
    id,
    id_short: id.slice(0, 8),
    created_at: nowISO,
    parent: req.parent
      ? { parent: req.parent, parent_short: req.parent.slice(0, 8) }
      : null,
    author: { pubkey: req.pubkey, pubkey_short: req.pubkey.slice(0, 8) },
    canvases,
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
            canvas: {
              canvas_id: appendedMembership.id,
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
