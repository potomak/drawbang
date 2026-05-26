import {
  CLAIM_TTL_S,
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
  INITIAL_STATE,
  ageSecondsBetween,
  requiredBits,
  verifyClaimPow,
} from "../src/proof-of-work.js";
import {
  AlreadyPublishedError,
  TileLockedError,
  type MuralStore,
  type TileRow,
} from "./mural-store.js";
import type { AuthedUser } from "./handler.js";
import type { Storage } from "./storage.js";

export interface MuralClaimRequest {
  mural_id: string;
  x: number;
  y: number;
  baseline: string;
  nonce: string;
}

export interface MuralClaimResponseBody {
  claim_expires_at: number; // epoch seconds
  edit_url: string;
  required_bits: number;
}

export interface MuralState {
  // ISO timestamp of the most recent successful claim on this mural, OR
  // the sentinel from INITIAL_STATE if none yet.
  last_claim_at: string;
  last_difficulty_bits: number;
}

export interface MuralManifest {
  id: string;
  name: string;
  opens_at: string;
  closes_at: string;
  rows: number;
  cols: number;
  locked: boolean;
}

export interface MuralHandlerConfig {
  storage: Storage;
  muralStore: MuralStore;
  publicBaseUrl: string;
  // Authenticated claimer (from the verified session JWT). Required for
  // handleMuralClaim; unused by handleMuralState.
  auth?: AuthedUser;
  now?: () => Date;
  // Optional per-mural baseline history (rolling grace window).
  baselineHistory?: Map<string, string[]>;
}

export interface MuralHandlerResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const defaultBaselineHistory = new Map<string, string[]>();

function err(status: number, message: string): MuralHandlerResult {
  return { status, body: { error: message } };
}

function muralStateKey(muralId: string): string {
  return `public/state/mural/${muralId}.json`;
}

function muralManifestKey(muralId: string): string {
  return `public/murals/${muralId}/manifest.json`;
}

async function loadOrInitState(
  storage: Storage,
  muralId: string,
): Promise<{ state: MuralState; firstEver: boolean }> {
  const stored = await storage.getJSON<MuralState>(muralStateKey(muralId));
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
  muralId: string,
): Promise<MuralManifest> {
  const existing = await storage.getJSON<MuralManifest>(
    muralManifestKey(muralId),
  );
  if (existing) return existing;
  const manifest: MuralManifest = {
    id: muralId,
    name: muralName(muralId),
    opens_at: muralOpensAt(muralId).toISOString(),
    closes_at: muralClosesAt(muralId).toISOString(),
    rows: TILES_PER_SIDE,
    cols: TILES_PER_SIDE,
    locked: false,
  };
  await storage.put(
    muralManifestKey(muralId),
    new TextEncoder().encode(JSON.stringify(manifest)),
    "application/json",
    "public, max-age=31536000, immutable",
  );
  return manifest;
}

export async function handleMuralClaim(
  req: MuralClaimRequest,
  cfg: MuralHandlerConfig,
): Promise<MuralHandlerResult> {
  const now = cfg.now ? cfg.now() : new Date();
  const nowISO = now.toISOString();
  const nowEpoch = Math.floor(now.getTime() / 1000);

  if (!cfg.auth) return err(401, "not authenticated");
  const userId = cfg.auth.user_id;

  if (typeof req.mural_id !== "string" || !isMuralIdValid(req.mural_id)) {
    return err(400, "invalid mural_id");
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

  // -- Mural lock check -----------------------------------------------------
  const closesAt = muralClosesAt(req.mural_id);
  if (now.getTime() >= closesAt.getTime()) {
    return err(403, "mural is locked");
  }
  // Reject claims on murals that haven't opened yet (defensive).
  const opensAt = muralOpensAt(req.mural_id);
  if (now.getTime() < opensAt.getTime()) {
    return err(403, "mural has not opened yet");
  }

  // -- Baseline + PoW --------------------------------------------------------
  const { state, firstEver } = await loadOrInitState(cfg.storage, req.mural_id);
  const history =
    cfg.baselineHistory ?? defaultBaselineHistory;
  const muralHistory = history.get(req.mural_id) ?? [];

  if (ageSecondsBetween(nowISO, req.baseline) < -5) {
    return err(400, `baseline in the future: ${req.baseline}`);
  }
  const baselineOk =
    req.baseline === state.last_claim_at ||
    muralHistory.includes(req.baseline) ||
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
      muralId: req.mural_id,
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
  await ensureManifest(cfg.storage, req.mural_id);

  // -- Tile claim (DDB conditional write) ------------------------------------
  let claim_expires_at: number;
  try {
    const r = await cfg.muralStore.claimTile({
      mural_id: req.mural_id,
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

  // -- Update mural state ---------------------------------------------------
  const newState: MuralState = {
    last_claim_at: nowISO,
    last_difficulty_bits: bits,
  };
  await cfg.storage.put(
    muralStateKey(req.mural_id),
    new TextEncoder().encode(JSON.stringify(newState)),
    "application/json",
    "no-store",
  );
  // Roll the baseline history per mural.
  muralHistory.push(state.last_claim_at);
  while (muralHistory.length > 8) muralHistory.shift();
  history.set(req.mural_id, muralHistory);

  return {
    status: 201,
    body: {
      claim_expires_at,
      edit_url: `/?c=${req.mural_id}&x=${req.x}&y=${req.y}`,
      required_bits: bits,
    } satisfies MuralClaimResponseBody,
  };
}

// -- GET /mural/{id}/state ---------------------------------------------------

export interface MuralStateResponseBody {
  mural_id: string;
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

export async function handleMuralState(
  muralId: string,
  cfg: MuralHandlerConfig,
): Promise<MuralHandlerResult> {
  if (!isMuralIdValid(muralId)) {
    return err(404, "unknown mural");
  }
  const now = cfg.now ? cfg.now() : new Date();
  const closesAt = muralClosesAt(muralId);
  const opensAt = muralOpensAt(muralId);

  // Active murals get short cache; locked murals cache effectively
  // forever — once locked, state is frozen.
  const locked = now.getTime() >= closesAt.getTime();

  const rows: TileRow[] = await cfg.muralStore.getTiles(muralId);
  const tiles = rows.map((r) => {
    const t: MuralStateResponseBody["tiles"][number] = { x: r.x, y: r.y };
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

  const { state, firstEver } = await loadOrInitState(cfg.storage, muralId);

  // Report the bits the *next* claim would need given the current age of
  // last_claim_at — not the bits that satisfied the previous claim. Echoing
  // last_difficulty_bits caused clients to under-solve when more than a few
  // seconds had passed since the prior claim (the difficulty curve hardens
  // as age drops below the next bracket and softens as it grows past one).
  const baselineAge = firstEver
    ? Number.POSITIVE_INFINITY
    : Math.max(0, ageSecondsBetween(now.toISOString(), state.last_claim_at));

  const body: MuralStateResponseBody = {
    mural_id: muralId,
    name: muralName(muralId),
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

// Convenience: derive the current mural id at this moment.
export function currentMuralId(now: Date = new Date()): string {
  return muralIdForDate(now);
}

export { CLAIM_TTL_S, PUBLISH_COOLDOWN_S };
