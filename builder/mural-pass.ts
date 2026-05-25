import {
  TILES_PER_MURAL,
  TILES_PER_SIDE,
  muralClosesAt,
  muralIdForDate,
  muralName,
  muralOpensAt,
  isMuralIdValid,
} from "../config/murals.js";
import type { MuralStore, TileRow } from "../ingest/mural-store.js";
import type { Storage } from "../ingest/storage.js";
import renderMural, { type MuralTileView } from "./templates/mural.js";
import renderMuralsArchive, {
  type MuralCard,
} from "./templates/murals-archive.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const CC_INTERNAL = "public, max-age=60";
const CC_IMMUTABLE = "public, max-age=31536000, immutable";

export interface MuralManifest {
  id: string;
  name: string;
  opens_at: string;
  closes_at: string;
  rows: number;
  cols: number;
  locked: boolean;
}

export interface CurrentMuralState {
  mural_id: string;
  name: string;
  opens_at: string;
  closes_at: string;
  tiles_total: number;
  tiles_claimed: number;
  tiles_published: number;
}

export interface MuralPassOptions {
  storage: Storage;
  muralStore?: MuralStore;
  // Reference "now" — defaults to wall-clock. Tests inject for determinism.
  now?: Date;
  // Repo URL for the footer. Defaults to the project default.
  repoUrl?: string;
  // Base URL of the API Gateway (e.g. https://X.execute-api.us-east-1...).
  // The mural page hydrates from `${apiBaseUrl}/mural/<id>/state`. CloudFront
  // can't proxy POSTs to API Gateway and its default behaviour returns 404 for
  // un-routed paths, so the hydration script must call API Gateway directly.
  // In dev this stays empty so relative URLs work through Vite's proxy.
  apiBaseUrl?: string;
}

export interface MuralPassResult {
  current_mural: string;
  locked_murals: string[];
  // Manifests that exist after the pass (newly created + previously known).
  known_murals: string[];
}

function manifestKey(id: string): string {
  return `public/murals/${id}/manifest.json`;
}

const REGISTRY_KEY = "public/murals/index.jsonl";
const CURRENT_STATE_KEY = "public/state/current-mural.json";

async function readRegistry(storage: Storage): Promise<MuralManifest[]> {
  const bytes = await storage.getBytes(REGISTRY_KEY);
  if (!bytes) return [];
  return dec
    .decode(bytes)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as MuralManifest);
}

async function writeRegistry(
  storage: Storage,
  entries: MuralManifest[],
): Promise<void> {
  const sorted = [...entries].sort((a, b) =>
    a.opens_at.localeCompare(b.opens_at),
  );
  const body = sorted.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await storage.put(REGISTRY_KEY, enc.encode(body), "application/jsonl", CC_INTERNAL);
}

function newManifest(muralId: string, locked: boolean): MuralManifest {
  return {
    id: muralId,
    name: muralName(muralId),
    opens_at: muralOpensAt(muralId).toISOString(),
    closes_at: muralClosesAt(muralId).toISOString(),
    rows: TILES_PER_SIDE,
    cols: TILES_PER_SIDE,
    locked,
  };
}

async function ensureManifest(
  storage: Storage,
  muralId: string,
  locked: boolean,
): Promise<MuralManifest> {
  const existing = await storage.getJSON<MuralManifest>(manifestKey(muralId));
  if (existing) {
    // Promote to locked if the existing one says active but we're past close.
    if (locked && !existing.locked) {
      const updated: MuralManifest = { ...existing, locked: true };
      await storage.put(
        manifestKey(muralId),
        enc.encode(JSON.stringify(updated)),
        "application/json",
        // Locked murals are immutable from here on.
        CC_IMMUTABLE,
      );
      return updated;
    }
    return existing;
  }
  const m = newManifest(muralId, locked);
  await storage.put(
    manifestKey(muralId),
    enc.encode(JSON.stringify(m)),
    "application/json",
    locked ? CC_IMMUTABLE : CC_INTERNAL,
  );
  return m;
}

// Idempotent registry merge: ensure each manifest appears exactly once with
// its current locked state.
function mergeRegistry(
  prior: MuralManifest[],
  upserts: MuralManifest[],
): MuralManifest[] {
  const byId = new Map<string, MuralManifest>();
  for (const e of prior) byId.set(e.id, e);
  for (const e of upserts) byId.set(e.id, e);
  return [...byId.values()];
}

export async function muralPass(
  opts: MuralPassOptions,
): Promise<MuralPassResult> {
  const now = opts.now ?? new Date();
  const currentId = muralIdForDate(now);
  const repoUrl = opts.repoUrl ?? "https://github.com/potomak/drawbang";

  // 1) Ensure the current mural's manifest exists.
  const currentManifest = await ensureManifest(opts.storage, currentId, false);

  // 2) Walk the registry. Lock any murals whose closes_at is in the past.
  const prior = await readRegistry(opts.storage);
  const lockedNow: MuralManifest[] = [];
  for (const c of prior) {
    if (c.locked) continue;
    if (!isMuralIdValid(c.id)) continue;
    if (new Date(c.closes_at).getTime() <= now.getTime()) {
      lockedNow.push(await ensureManifest(opts.storage, c.id, true));
    }
  }

  // 3) Re-write the registry so it reflects: prior + currentManifest + locked
  //    transitions.
  const upserts: MuralManifest[] = [currentManifest, ...lockedNow];
  const merged = mergeRegistry(prior, upserts);
  await writeRegistry(opts.storage, merged);

  // 4) Update the current-mural state file (counts come from DDB when wired).
  let currentTiles: TileRow[] = [];
  if (opts.muralStore) {
    currentTiles = await opts.muralStore.getTiles(currentId);
  }
  const nowEpoch = Math.floor(now.getTime() / 1000);
  let tiles_claimed = 0;
  let tiles_published = 0;
  for (const t of currentTiles) {
    if (t.drawing_id) tiles_published++;
    else if (t.claim_expires_at && t.claim_expires_at > nowEpoch) tiles_claimed++;
  }
  const current: CurrentMuralState = {
    mural_id: currentId,
    name: currentManifest.name,
    opens_at: currentManifest.opens_at,
    closes_at: currentManifest.closes_at,
    tiles_total: TILES_PER_MURAL,
    tiles_claimed,
    tiles_published,
  };
  await opts.storage.put(
    CURRENT_STATE_KEY,
    enc.encode(JSON.stringify(current)),
    "application/json",
    "public, max-age=60",
  );

  // 5) Render the current mural page (live; hydrated client-side) and every
  //    locked mural. Locked DDB rows are immutable, so re-rendering every
  //    pass is byte-idempotent — and self-heals if any earlier pass wrote an
  //    empty page (e.g. ran without muralStore wired, as the builder CLI
  //    did before this was fixed).
  const currentTilesView = tilesToView(currentTiles);
  await opts.storage.put(
    `public/murals/${currentId}.html`,
    enc.encode(
      renderMural({
        id: currentId,
        name: currentManifest.name,
        opens_at: currentManifest.opens_at,
        closes_at: currentManifest.closes_at,
        locked: false,
        tiles: currentTilesView,
        state_url: `${opts.apiBaseUrl ?? ""}/mural/${currentId}/state`,
        repo_url: repoUrl,
      }),
    ),
    "text/html",
    "public, max-age=60",
  );

  // Iterate the post-merge registry so freshly-locked murals (in lockedNow)
  // and murals locked on a prior pass are both rendered. Without a
  // muralStore we can only honour the "transition" set with empty tiles,
  // matching the legacy behaviour; with a store, every locked mural is
  // rebuilt from current DDB state.
  const lockedNowIds = new Set(lockedNow.map((m) => m.id));
  for (const m of merged) {
    if (!m.locked) continue;
    if (!opts.muralStore && !lockedNowIds.has(m.id)) continue;
    const tiles = opts.muralStore ? await opts.muralStore.getTiles(m.id) : [];
    const view = tilesToView(tiles);
    await opts.storage.put(
      `public/murals/${m.id}.html`,
      enc.encode(
        renderMural({
          id: m.id,
          name: m.name,
          opens_at: m.opens_at,
          closes_at: m.closes_at,
          locked: true,
          tiles: view,
          state_url: `${opts.apiBaseUrl ?? ""}/mural/${m.id}/state`,
          repo_url: repoUrl,
        }),
      ),
      "text/html",
      "public, max-age=31536000, immutable",
    );
  }

  // 6) Render the /murals archive page.
  await renderArchive(opts, merged, currentId, repoUrl);

  return {
    current_mural: currentId,
    locked_murals: lockedNow.map((m) => m.id),
    known_murals: merged.map((m) => m.id),
  };
}

function tilesToView(tiles: TileRow[]): MuralTileView[] {
  return tiles
    .map((t) => {
      const v: MuralTileView = { x: t.x, y: t.y };
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
  opts: MuralPassOptions,
  registry: MuralManifest[],
  currentId: string,
  repoUrl: string,
): Promise<void> {
  const cards: MuralCard[] = [];
  for (const m of registry) {
    const tiles = opts.muralStore ? await opts.muralStore.getTiles(m.id) : [];
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
  const html = renderMuralsArchive({
    current,
    past,
    repo_url: repoUrl,
  });
  await opts.storage.put(
    "public/murals.html",
    enc.encode(html),
    "text/html",
    "public, max-age=60",
  );
}

export { REGISTRY_KEY, CURRENT_STATE_KEY };
