import {
  INITIAL_STATE,
  ageSecondsBetween,
  contentHash,
  hashHex,
  leadingZeroBits,
  powHash,
  requiredBits,
} from "../src/pow.js";
import type { LastPublishState } from "../src/pow.js";
import {
  canonicalCanvasString,
  canvasIdFor,
  cellIndex,
  isCanvasShapeValid,
  isManifestValid,
  type CanvasManifest,
} from "../config/canvas.js";
import { validateGif } from "./gif-validate.js";
import { ogScale, stitchCompositePng } from "./stitch.js";
import renderCanvasPage from "../builder/templates/canvas-page.js";
import type { AuthedUser } from "./handler.js";
import type { Storage } from "./storage.js";

// POST /canvas — publish a personal multi-tile drawing. Body carries one 16×16
// gif per filled cell; the server stores each tile (content-addressed,
// deduped), checks ONE PoW over the canonical canvas manifest, writes the
// manifest + a static composite preview, and drops an inbox record for the
// builder. A plain 16×16 is just a 1×1 canvas.

export interface CanvasTileInput {
  x: number;
  y: number;
  gif: string; // base64
}

export interface CanvasPublishRequest {
  cols: number;
  rows: number;
  tiles: CanvasTileInput[];
  nonce: string;
  baseline: string;
  solve_ms?: number;
  bench_hps?: number;
  parent?: string;
}

export interface CanvasPublishConfig {
  storage: Storage;
  publicBaseUrl: string;
  auth: AuthedUser;
  repoUrl?: string;
  now?: () => Date;
  baselineHistory?: string[];
}

export interface CanvasPublishResult {
  status: number;
  body: unknown;
}

const defaultBaselineHistory: string[] = [];
const GIF_CC = "public, max-age=31536000, immutable";

export async function handleCanvasPublish(
  req: CanvasPublishRequest,
  cfg: CanvasPublishConfig,
): Promise<CanvasPublishResult> {
  const now = cfg.now ? cfg.now() : new Date();
  const nowISO = now.toISOString();
  const author = cfg.auth;
  const shareUrl = (id: string): string => `${cfg.publicBaseUrl}/c/${id}`;

  // -- 1. Validate shape + tiles, build the manifest grid --------------------
  if (!isCanvasShapeValid(req.cols, req.rows)) return err(400, "invalid canvas shape");
  if (!Array.isArray(req.tiles) || req.tiles.length === 0) return err(400, "no tiles");
  if (req.tiles.length > req.cols * req.rows) return err(400, "too many tiles");

  const grid: (string | null)[] = Array(req.cols * req.rows).fill(null);
  const tileBytes = new Map<string, Uint8Array>(); // tile_id -> bytes (dedup)
  const stitchTiles: { x: number; y: number; gif: Uint8Array }[] = [];

  for (const t of req.tiles) {
    if (
      !Number.isInteger(t.x) ||
      !Number.isInteger(t.y) ||
      t.x < 0 ||
      t.x >= req.cols ||
      t.y < 0 ||
      t.y >= req.rows
    ) {
      return err(400, "tile coordinate out of range");
    }
    let gif: Uint8Array;
    try {
      gif = base64Decode(t.gif);
    } catch (e) {
      return err(400, `bad tile base64: ${errMsg(e)}`);
    }
    try {
      validateGif(gif);
    } catch (e) {
      return err(400, `invalid tile gif: ${errMsg(e)}`);
    }
    const idx = cellIndex(t.x, t.y, req.cols);
    if (grid[idx] !== null) return err(400, "duplicate tile position");
    const tileId = hashHex(await contentHash(gif));
    grid[idx] = tileId;
    tileBytes.set(tileId, gif);
    stitchTiles.push({ x: t.x, y: t.y, gif });
  }

  const manifest: CanvasManifest = { cols: req.cols, rows: req.rows, tiles: grid };
  if (!isManifestValid(manifest)) return err(400, "invalid manifest");

  // -- 2. Baseline + ONE PoW over the canonical canvas bytes -----------------
  const state =
    (await cfg.storage.getJSON<LastPublishState>("public/state/last-publish.json")) ??
    INITIAL_STATE;
  const history = cfg.baselineHistory ?? defaultBaselineHistory;
  if (ageSecondsBetween(nowISO, req.baseline) < -5) {
    return err(400, `baseline in the future: ${req.baseline}`);
  }
  const firstEver = state.last_publish_at === INITIAL_STATE.last_publish_at;
  const baselineOk =
    req.baseline === state.last_publish_at ||
    history.includes(req.baseline) ||
    (firstEver && req.baseline === INITIAL_STATE.last_publish_at);
  if (!baselineOk) return err(400, `baseline stale (${req.baseline})`);

  const baselineAge = firstEver
    ? Number.POSITIVE_INFINITY
    : Math.max(0, ageSecondsBetween(nowISO, req.baseline));
  const bits = requiredBits(baselineAge);
  const canonical = new TextEncoder().encode(canonicalCanvasString(manifest));
  const pow = await powHash(canonical, req.baseline, req.nonce);
  if (leadingZeroBits(pow) < bits) {
    return err(400, `pow insufficient: ${leadingZeroBits(pow)} < ${bits}`);
  }

  const canvasId = await canvasIdFor(manifest);
  const manifestKey = `public/c/${canvasId}.json`;
  const tileIds = [...new Set(grid.filter((t): t is string => t !== null))];

  // -- 3. Idempotency: same content → same canvas_id -------------------------
  if (await cfg.storage.exists(manifestKey)) {
    return { status: 200, body: { canvas_id: canvasId, tile_ids: tileIds, share_url: shareUrl(canvasId) } };
  }

  // -- 4. Persist tiles (content-addressed, deduped) -------------------------
  for (const [tileId, gif] of tileBytes) {
    await cfg.storage.put(`public/tiles/${tileId}.gif`, gif, "image/gif", GIF_CC);
  }

  // -- 5. Composites + sync-rendered page (parity with /d/ — live immediately) --
  const enc = new TextEncoder();
  const multi = req.cols * req.rows > 1;
  if (multi) {
    try {
      const png = await stitchCompositePng(stitchTiles, req.cols, req.rows);
      await cfg.storage.put(`public/c/${canvasId}.png`, png, "image/png", GIF_CC);
    } catch (e) {
      console.error("[canvas] composite stitch failed", e);
    }
  }
  // ~960px OG/share image (also covers 1×1).
  try {
    const large = await stitchCompositePng(
      stitchTiles,
      req.cols,
      req.rows,
      ogScale(req.cols, req.rows),
    );
    await cfg.storage.put(`public/c/${canvasId}-large.png`, large, "image/png", GIF_CC);
  } catch (e) {
    console.error("[canvas] og stitch failed", e);
  }
  try {
    const html = renderCanvasPage({
      canvas_id: canvasId,
      id_short: canvasId.slice(0, 8),
      cols: req.cols,
      rows: req.rows,
      tiles: grid,
      author: { username: author.username },
      created_at: nowISO,
      preview_url: `/c/${canvasId}-large.png`,
      public_base_url: cfg.publicBaseUrl,
      repo_url: cfg.repoUrl ?? "https://github.com/potomak/drawbang",
    });
    await cfg.storage.put(`public/c/${canvasId}.html`, enc.encode(html), "text/html", "public, max-age=60");
  } catch (e) {
    console.error("[canvas] page render failed", e);
  }

  // -- 6. Manifest + inbox record (builder finalizes galleries/index) --------
  const doc = {
    canvas_id: canvasId,
    cols: req.cols,
    rows: req.rows,
    tiles: grid,
    user_id: author.user_id,
    username: author.username,
    parent: req.parent ?? null,
    created_at: nowISO,
  };
  const docBytes = enc.encode(JSON.stringify(doc));
  await cfg.storage.put(manifestKey, docBytes, "application/json", "no-store");
  await cfg.storage.put(
    `inbox/${nowISO.slice(0, 10)}/${canvasId}.canvas.json`,
    docBytes,
    "application/json",
  );

  // -- 7. Advance the publish baseline (shared with /ingest) -----------------
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

  return { status: 202, body: { canvas_id: canvasId, tile_ids: tileIds, share_url: shareUrl(canvasId) } };
}

function err(status: number, message: string): CanvasPublishResult {
  return { status, body: { error: message } };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function base64Decode(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
