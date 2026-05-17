import {
  TILES_PER_CANVAS,
  TILES_PER_SIDE,
  canvasClosesAt,
  canvasIdForDate,
  canvasName,
  canvasOpensAt,
  isCanvasIdValid,
} from "../config/canvases.js";
import type { CanvasStore, TileRow } from "../ingest/canvas-store.js";
import type { Storage } from "../ingest/storage.js";
import renderCanvas, { type CanvasTileView } from "./templates/canvas.js";
import renderCanvasesArchive, {
  type CanvasCard,
} from "./templates/canvases-archive.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const CC_INTERNAL = "public, max-age=60";
const CC_IMMUTABLE = "public, max-age=31536000, immutable";

export interface CanvasManifest {
  id: string;
  name: string;
  opens_at: string;
  closes_at: string;
  rows: number;
  cols: number;
  locked: boolean;
}

export interface CurrentCanvasState {
  canvas_id: string;
  name: string;
  opens_at: string;
  closes_at: string;
  tiles_total: number;
  tiles_claimed: number;
  tiles_published: number;
}

export interface CanvasPassOptions {
  storage: Storage;
  canvasStore?: CanvasStore;
  // Reference "now" — defaults to wall-clock. Tests inject for determinism.
  now?: Date;
  // Repo URL for the footer. Defaults to the project default.
  repoUrl?: string;
  // Base URL of the API Gateway (e.g. https://X.execute-api.us-east-1...).
  // The canvas page hydrates from `${apiBaseUrl}/canvas/<id>/state`. CloudFront
  // can't proxy POSTs to API Gateway and its default behaviour returns 404 for
  // un-routed paths, so the hydration script must call API Gateway directly.
  // In dev this stays empty so relative URLs work through Vite's proxy.
  apiBaseUrl?: string;
}

export interface CanvasPassResult {
  current_canvas: string;
  locked_canvases: string[];
  // Manifests that exist after the pass (newly created + previously known).
  known_canvases: string[];
}

function manifestKey(id: string): string {
  return `public/canvases/${id}/manifest.json`;
}

const REGISTRY_KEY = "public/canvases/index.jsonl";
const CURRENT_STATE_KEY = "public/state/current-canvas.json";

async function readRegistry(storage: Storage): Promise<CanvasManifest[]> {
  const bytes = await storage.getBytes(REGISTRY_KEY);
  if (!bytes) return [];
  return dec
    .decode(bytes)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CanvasManifest);
}

async function writeRegistry(
  storage: Storage,
  entries: CanvasManifest[],
): Promise<void> {
  const sorted = [...entries].sort((a, b) =>
    a.opens_at.localeCompare(b.opens_at),
  );
  const body = sorted.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await storage.put(REGISTRY_KEY, enc.encode(body), "application/jsonl", CC_INTERNAL);
}

function newManifest(canvasId: string, locked: boolean): CanvasManifest {
  return {
    id: canvasId,
    name: canvasName(canvasId),
    opens_at: canvasOpensAt(canvasId).toISOString(),
    closes_at: canvasClosesAt(canvasId).toISOString(),
    rows: TILES_PER_SIDE,
    cols: TILES_PER_SIDE,
    locked,
  };
}

async function ensureManifest(
  storage: Storage,
  canvasId: string,
  locked: boolean,
): Promise<CanvasManifest> {
  const existing = await storage.getJSON<CanvasManifest>(manifestKey(canvasId));
  if (existing) {
    // Promote to locked if the existing one says active but we're past close.
    if (locked && !existing.locked) {
      const updated: CanvasManifest = { ...existing, locked: true };
      await storage.put(
        manifestKey(canvasId),
        enc.encode(JSON.stringify(updated)),
        "application/json",
        // Locked canvases are immutable from here on.
        CC_IMMUTABLE,
      );
      return updated;
    }
    return existing;
  }
  const m = newManifest(canvasId, locked);
  await storage.put(
    manifestKey(canvasId),
    enc.encode(JSON.stringify(m)),
    "application/json",
    locked ? CC_IMMUTABLE : CC_INTERNAL,
  );
  return m;
}

// Idempotent registry merge: ensure each manifest appears exactly once with
// its current locked state.
function mergeRegistry(
  prior: CanvasManifest[],
  upserts: CanvasManifest[],
): CanvasManifest[] {
  const byId = new Map<string, CanvasManifest>();
  for (const e of prior) byId.set(e.id, e);
  for (const e of upserts) byId.set(e.id, e);
  return [...byId.values()];
}

export async function canvasPass(
  opts: CanvasPassOptions,
): Promise<CanvasPassResult> {
  const now = opts.now ?? new Date();
  const currentId = canvasIdForDate(now);
  const repoUrl = opts.repoUrl ?? "https://github.com/potomak/drawbang";

  // 1) Ensure the current canvas's manifest exists.
  const currentManifest = await ensureManifest(opts.storage, currentId, false);

  // 2) Walk the registry. Lock any canvases whose closes_at is in the past.
  const prior = await readRegistry(opts.storage);
  const lockedNow: CanvasManifest[] = [];
  for (const c of prior) {
    if (c.locked) continue;
    if (!isCanvasIdValid(c.id)) continue;
    if (new Date(c.closes_at).getTime() <= now.getTime()) {
      lockedNow.push(await ensureManifest(opts.storage, c.id, true));
    }
  }

  // 3) Re-write the registry so it reflects: prior + currentManifest + locked
  //    transitions.
  const upserts: CanvasManifest[] = [currentManifest, ...lockedNow];
  const merged = mergeRegistry(prior, upserts);
  await writeRegistry(opts.storage, merged);

  // 4) Update the current-canvas state file (counts come from DDB when wired).
  let currentTiles: TileRow[] = [];
  if (opts.canvasStore) {
    currentTiles = await opts.canvasStore.getTiles(currentId);
  }
  const nowEpoch = Math.floor(now.getTime() / 1000);
  let tiles_claimed = 0;
  let tiles_published = 0;
  for (const t of currentTiles) {
    if (t.drawing_id) tiles_published++;
    else if (t.claim_expires_at && t.claim_expires_at > nowEpoch) tiles_claimed++;
  }
  const current: CurrentCanvasState = {
    canvas_id: currentId,
    name: currentManifest.name,
    opens_at: currentManifest.opens_at,
    closes_at: currentManifest.closes_at,
    tiles_total: TILES_PER_CANVAS,
    tiles_claimed,
    tiles_published,
  };
  await opts.storage.put(
    CURRENT_STATE_KEY,
    enc.encode(JSON.stringify(current)),
    "application/json",
    "public, max-age=60",
  );

  // 5) Render the current canvas page (live; hydrated client-side) and any
  //    canvases that just transitioned to locked (frozen forever).
  const currentTilesView = tilesToView(currentTiles);
  await opts.storage.put(
    `public/canvases/${currentId}.html`,
    enc.encode(
      renderCanvas({
        id: currentId,
        name: currentManifest.name,
        opens_at: currentManifest.opens_at,
        closes_at: currentManifest.closes_at,
        locked: false,
        tiles: currentTilesView,
        state_url: `${opts.apiBaseUrl ?? ""}/canvas/${currentId}/state`,
        repo_url: repoUrl,
      }),
    ),
    "text/html",
    "public, max-age=60",
  );

  for (const m of lockedNow) {
    const tiles = opts.canvasStore ? await opts.canvasStore.getTiles(m.id) : [];
    const view = tilesToView(tiles);
    await opts.storage.put(
      `public/canvases/${m.id}.html`,
      enc.encode(
        renderCanvas({
          id: m.id,
          name: m.name,
          opens_at: m.opens_at,
          closes_at: m.closes_at,
          locked: true,
          tiles: view,
          state_url: `${opts.apiBaseUrl ?? ""}/canvas/${m.id}/state`,
          repo_url: repoUrl,
        }),
      ),
      "text/html",
      "public, max-age=31536000, immutable",
    );
  }

  // 6) Render the /canvases archive page.
  await renderArchive(opts, merged, currentId, repoUrl);

  return {
    current_canvas: currentId,
    locked_canvases: lockedNow.map((m) => m.id),
    known_canvases: merged.map((m) => m.id),
  };
}

function tilesToView(tiles: TileRow[]): CanvasTileView[] {
  return tiles
    .map((t) => {
      const v: CanvasTileView = { x: t.x, y: t.y };
      if (t.drawing_id) {
        v.drawing_id = t.drawing_id;
        return v;
      }
      if (t.claimed_by) v.claimed_by = t.claimed_by;
      if (t.claim_expires_at) v.claim_expires_at = t.claim_expires_at;
      return v;
    });
}

async function renderArchive(
  opts: CanvasPassOptions,
  registry: CanvasManifest[],
  currentId: string,
  repoUrl: string,
): Promise<void> {
  const cards: CanvasCard[] = [];
  for (const m of registry) {
    const tiles = opts.canvasStore ? await opts.canvasStore.getTiles(m.id) : [];
    const publishedDrawings = tiles
      .filter((t) => t.drawing_id)
      .map((t) => t.drawing_id!)
      .slice(0, 9);
    cards.push({
      id: m.id,
      name: m.name,
      opens_at: m.opens_at,
      closes_at: m.closes_at,
      locked: m.locked,
      tiles_published: tiles.filter((t) => t.drawing_id).length,
      preview_thumbs: publishedDrawings,
    });
  }
  const current = cards.find((c) => c.id === currentId) ?? null;
  const past = cards
    .filter((c) => c.id !== currentId)
    .sort((a, b) => b.opens_at.localeCompare(a.opens_at));
  const html = renderCanvasesArchive({
    current,
    past,
    repo_url: repoUrl,
  });
  await opts.storage.put(
    "public/canvases.html",
    enc.encode(html),
    "text/html",
    "public, max-age=60",
  );
}

export { REGISTRY_KEY, CURRENT_STATE_KEY };
