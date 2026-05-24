import {
  CLAIM_TTL_S,
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
  INITIAL_STATE,
  ageSecondsBetween,
  requiredBits,
  verifyClaimPow,
} from "../src/pow.js";
import {
  AlreadyPublishedError,
  TileLockedError,
  type CanvasStore,
  type TileRow,
} from "./canvas-store.js";
import type { AuthedUser } from "./handler.js";
import type { Storage } from "./storage.js";

export interface CanvasClaimRequest {
  canvas_id: string;
  x: number;
  y: number;
  baseline: string;
  nonce: string;
}

export interface CanvasClaimResponseBody {
  claim_expires_at: number; // epoch seconds
  edit_url: string;
  required_bits: number;
}

export interface CanvasState {
  // ISO timestamp of the most recent successful claim on this canvas, OR
  // the sentinel from INITIAL_STATE if none yet.
  last_claim_at: string;
  last_difficulty_bits: number;
}

export interface CanvasManifest {
  id: string;
  name: string;
  opens_at: string;
  closes_at: string;
  rows: number;
  cols: number;
  locked: boolean;
}

export interface CanvasHandlerConfig {
  storage: Storage;
  canvasStore: CanvasStore;
  publicBaseUrl: string;
  // Authenticated claimer (from the verified session JWT). Required for
  // handleCanvasClaim; unused by handleCanvasState.
  auth?: AuthedUser;
  now?: () => Date;
  // Optional per-canvas baseline history (rolling grace window).
  baselineHistory?: Map<string, string[]>;
}

export interface CanvasHandlerResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const defaultBaselineHistory = new Map<string, string[]>();

function err(status: number, message: string): CanvasHandlerResult {
  return { status, body: { error: message } };
}

function canvasStateKey(canvasId: string): string {
  return `public/state/canvas/${canvasId}.json`;
}

function canvasManifestKey(canvasId: string): string {
  return `public/canvases/${canvasId}/manifest.json`;
}

async function loadOrInitState(
  storage: Storage,
  canvasId: string,
): Promise<{ state: CanvasState; firstEver: boolean }> {
  const stored = await storage.getJSON<CanvasState>(canvasStateKey(canvasId));
  if (stored) return { state: stored, firstEver: false };
  return {
    state: {
      last_claim_at: INITIAL_STATE.last_publish_at,
      last_difficulty_bits: INITIAL_STATE.last_difficulty_bits,
    },
    firstEver: true,
  };
}

async function ensureManifest(
  storage: Storage,
  canvasId: string,
): Promise<CanvasManifest> {
  const existing = await storage.getJSON<CanvasManifest>(
    canvasManifestKey(canvasId),
  );
  if (existing) return existing;
  const manifest: CanvasManifest = {
    id: canvasId,
    name: canvasName(canvasId),
    opens_at: canvasOpensAt(canvasId).toISOString(),
    closes_at: canvasClosesAt(canvasId).toISOString(),
    rows: TILES_PER_SIDE,
    cols: TILES_PER_SIDE,
    locked: false,
  };
  await storage.put(
    canvasManifestKey(canvasId),
    new TextEncoder().encode(JSON.stringify(manifest)),
    "application/json",
    "public, max-age=31536000, immutable",
  );
  return manifest;
}

export async function handleCanvasClaim(
  req: CanvasClaimRequest,
  cfg: CanvasHandlerConfig,
): Promise<CanvasHandlerResult> {
  const now = cfg.now ? cfg.now() : new Date();
  const nowISO = now.toISOString();
  const nowEpoch = Math.floor(now.getTime() / 1000);

  if (!cfg.auth) return err(401, "not authenticated");
  const userId = cfg.auth.user_id;

  if (typeof req.canvas_id !== "string" || !isCanvasIdValid(req.canvas_id)) {
    return err(400, "invalid canvas_id");
  }
  if (
    !Number.isInteger(req.x) ||
    !Number.isInteger(req.y) ||
    req.x < 0 ||
    req.x >= TILES_PER_SIDE ||
    req.y < 0 ||
    req.y >= TILES_PER_SIDE
  ) {
    return err(400, "invalid tile coordinates");
  }
  if (typeof req.baseline !== "string" || typeof req.nonce !== "string") {
    return err(400, "missing baseline or nonce");
  }

  // -- Canvas lock check -----------------------------------------------------
  const closesAt = canvasClosesAt(req.canvas_id);
  if (now.getTime() >= closesAt.getTime()) {
    return err(403, "canvas is locked");
  }
  // Reject claims on canvases that haven't opened yet (defensive).
  const opensAt = canvasOpensAt(req.canvas_id);
  if (now.getTime() < opensAt.getTime()) {
    return err(403, "canvas has not opened yet");
  }

  // -- Baseline + PoW --------------------------------------------------------
  const { state, firstEver } = await loadOrInitState(cfg.storage, req.canvas_id);
  const history =
    cfg.baselineHistory ?? defaultBaselineHistory;
  const canvasHistory = history.get(req.canvas_id) ?? [];

  if (ageSecondsBetween(nowISO, req.baseline) < -5) {
    return err(400, `baseline in the future: ${req.baseline}`);
  }
  const baselineOk =
    req.baseline === state.last_claim_at ||
    canvasHistory.includes(req.baseline) ||
    (firstEver && req.baseline === INITIAL_STATE.last_publish_at);
  if (!baselineOk) {
    return err(400, `baseline stale (${req.baseline})`);
  }

  const baselineAge = firstEver
    ? Number.POSITIVE_INFINITY
    : Math.max(0, ageSecondsBetween(nowISO, req.baseline));
  const bits = requiredBits(baselineAge);

  const powOk = await verifyClaimPow(
    {
      canvasId: req.canvas_id,
      x: req.x,
      y: req.y,
      userId,
    },
    req.baseline,
    req.nonce,
    bits,
  );
  if (!powOk) {
    return err(400, `pow insufficient: required ${bits} leading-zero bits`);
  }

  // -- Manifest self-heal (lazy creation) ------------------------------------
  await ensureManifest(cfg.storage, req.canvas_id);

  // -- Tile claim (DDB conditional write) ------------------------------------
  let claim_expires_at: number;
  try {
    const r = await cfg.canvasStore.claimTile({
      canvas_id: req.canvas_id,
      tile_key: tileKey(req.x, req.y),
      user_id: userId,
      now_epoch: nowEpoch,
      ttl_s: CLAIM_TTL_S,
    });
    claim_expires_at = r.claim_expires_at;
  } catch (e: unknown) {
    if (e instanceof AlreadyPublishedError) {
      return err(409, "tile already published");
    }
    if (e instanceof TileLockedError) {
      return err(409, "tile already claimed");
    }
    throw e;
  }

  // -- Update canvas state ---------------------------------------------------
  const newState: CanvasState = {
    last_claim_at: nowISO,
    last_difficulty_bits: bits,
  };
  await cfg.storage.put(
    canvasStateKey(req.canvas_id),
    new TextEncoder().encode(JSON.stringify(newState)),
    "application/json",
    "no-store",
  );
  // Roll the baseline history per canvas.
  canvasHistory.push(state.last_claim_at);
  while (canvasHistory.length > 8) canvasHistory.shift();
  history.set(req.canvas_id, canvasHistory);

  return {
    status: 201,
    body: {
      claim_expires_at,
      edit_url: `/?c=${req.canvas_id}&x=${req.x}&y=${req.y}`,
      required_bits: bits,
    } satisfies CanvasClaimResponseBody,
  };
}

// -- GET /canvas/{id}/state ---------------------------------------------------

export interface CanvasStateResponseBody {
  canvas_id: string;
  name: string;
  opens_at: string;
  closes_at: string;
  locked: boolean;
  required_bits: number;
  last_claim_at: string;
  tiles: Array<{
    x: number;
    y: number;
    drawing_id?: string;
    claimed_by?: string;
    claim_expires_at?: number;
    published_at?: number;
  }>;
}

export async function handleCanvasState(
  canvasId: string,
  cfg: CanvasHandlerConfig,
): Promise<CanvasHandlerResult> {
  if (!isCanvasIdValid(canvasId)) {
    return err(404, "unknown canvas");
  }
  const now = cfg.now ? cfg.now() : new Date();
  const closesAt = canvasClosesAt(canvasId);
  const opensAt = canvasOpensAt(canvasId);

  // Active canvases get short cache; locked canvases cache effectively
  // forever — once locked, state is frozen.
  const locked = now.getTime() >= closesAt.getTime();

  const rows: TileRow[] = await cfg.canvasStore.getTiles(canvasId);
  const tiles = rows.map((r) => {
    const t: CanvasStateResponseBody["tiles"][number] = { x: r.x, y: r.y };
    if (r.drawing_id) {
      t.drawing_id = r.drawing_id;
      if (r.published_at) t.published_at = r.published_at;
    } else if (
      r.claimed_by &&
      r.claim_expires_at &&
      r.claim_expires_at > Math.floor(now.getTime() / 1000)
    ) {
      t.claimed_by = r.claimed_by;
      t.claim_expires_at = r.claim_expires_at;
    } else {
      return null;
    }
    return t;
  });

  const { state, firstEver } = await loadOrInitState(cfg.storage, canvasId);

  // Report the bits the *next* claim would need given the current age of
  // last_claim_at — not the bits that satisfied the previous claim. Echoing
  // last_difficulty_bits caused clients to under-solve when more than a few
  // seconds had passed since the prior claim (the difficulty curve hardens
  // as age drops below the next bracket and softens as it grows past one).
  const baselineAge = firstEver
    ? Number.POSITIVE_INFINITY
    : Math.max(0, ageSecondsBetween(now.toISOString(), state.last_claim_at));

  const body: CanvasStateResponseBody = {
    canvas_id: canvasId,
    name: canvasName(canvasId),
    opens_at: opensAt.toISOString(),
    closes_at: closesAt.toISOString(),
    locked,
    required_bits: requiredBits(baselineAge),
    last_claim_at: state.last_claim_at,
    tiles: tiles.filter((t): t is NonNullable<typeof t> => t !== null),
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": locked
      ? "public, max-age=31536000, immutable"
      : "public, max-age=15",
  };

  return { status: 200, body, headers };
}

// Convenience: derive the current canvas id at this moment.
export function currentCanvasId(now: Date = new Date()): string {
  return canvasIdForDate(now);
}

export { CLAIM_TTL_S, PUBLISH_COOLDOWN_S };
