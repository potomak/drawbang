import { PER_PAGE } from "../config/constants.js";
import type { Storage } from "../ingest/storage.js";
import type { MuralStore } from "../ingest/mural-store.js";
import { loadMurals } from "../ingest/murals-sidecar.js";
import type { UserStatsRow } from "../ingest/user-stats-store.js";
import { muralPass } from "./mural-pass.js";
import { validateGif } from "../ingest/gif-validate.js";
import { earnedBadges } from "../config/badges.js";
import type { MerchCatalog } from "../merch/lambda.js";
import type { ProductCounter } from "../merch/product-counters.js";
import { contentHash, hashHex, leadingZeroBits, powHash } from "../src/pow.js";
import renderDayGallery from "./templates/day-gallery.js";
import renderDrawing from "./templates/drawing.js";
import renderGallery from "./templates/gallery.js";
import renderFeed from "./templates/feed.js";
import renderNotFound from "./templates/not-found.js";
import renderOwner from "./templates/owner.js";
import renderProducts from "./templates/products.js";
import renderCanvasPage, { type CanvasPageView } from "./templates/canvas-page.js";
import renderTilePage, { type TilePageView } from "./templates/tile-page.js";
import { ogScale, stitchCompositePng } from "../ingest/stitch.js";
import type { DayGalleryView } from "./templates/day-gallery.js";
import type { DrawingView } from "./templates/drawing.js";
import type { GalleryView } from "./templates/gallery.js";
import type { FeedView } from "./templates/feed.js";
import type { NotFoundView } from "./templates/not-found.js";
import type { OwnerView } from "./templates/owner.js";
import type { ProductCard, ProductsView } from "./templates/products.js";

export interface ProductCountersSource {
  listAll: () => Promise<ProductCounter[]>;
}

// Narrow read-only view over UserStatsStore.get(). The builder only needs
// to look up per-owner stats at render time — kept as its own interface so
// dev/test paths can supply a fixture without depending on the full
// streak-bumping write API.
export interface UserStatsSource {
  get(user_id: string): Promise<UserStatsRow | null>;
}

export interface BuildOptions {
  storage: Storage;
  today?: string; // YYYY-MM-DD, defaults to real today
  publicBaseUrl: string;
  // GitHub repo URL shown in the footer of every rendered page.
  repoUrl?: string;
  logger?: (msg: string) => void;
  templates?: Templates;
  // Re-render every day's HTML from existing index.jsonl even if no new
  // drawings arrived. Used after template changes.
  forceRerender?: boolean;
  // /products gallery inputs (epic #151). Both must be provided to render
  // the surface; absent or empty either, the builder skips it.
  productCountersSource?: ProductCountersSource;
  merchCatalog?: MerchCatalog;
  // For relative-time labels on product cards ("3 days ago"). Defaults to
  // wall-clock now; tests inject for determinism.
  now?: () => Date;
  // Optional: enables the mural pass to read live tile state. Without it,
  // /state/current-mural.json still gets a fresh manifest + zero counts.
  muralStore?: MuralStore;
  // Optional: per-account streak/total counters for /u/<username>.html
  // (#115/#116). Without it, profile pages render without the stats block.
  userStatsSource?: UserStatsSource;
  // Optional: API Gateway base URL for the mural page's state hydration.
  // See MuralPassOptions.apiBaseUrl for the why.
  apiBaseUrl?: string;
}

export const DEFAULT_TEMPLATES: Templates = {
  dayGallery: renderDayGallery,
  drawing: renderDrawing,
  gallery: renderGallery,
  feed: renderFeed,
  notFound: renderNotFound,
  owner: renderOwner,
  products: renderProducts,
  canvasPage: renderCanvasPage,
  tilePage: renderTilePage,
};

interface DrawingMetadata {
  id: string;
  pow: string;
  created_at: string;
  required_bits: number;
  solve_ms: number | null;
  bench_hps: number | null;
  parent: string | null;
  // Account fields land via the inbox JSON sidecar that ingest writes. null
  // only on legacy drawings published by the old anonymous keypair scheme —
  // those render as "anonymous" with no profile page.
  user_id: string | null;
  username: string | null;
}

interface DayRollup {
  date: string;
  count: number;
  pages: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// Cache-Control headers stamped by S3Storage on every put. Builder output
// used to ship with no Cache-Control at all, which left browsers in
// heuristic-caching territory and trapped them on stale HTML between
// deploys. Now every served URL carries an explicit policy.
const CC_HTML = "public, max-age=60";
const CC_RSS = "public, max-age=60";
const CC_GIF_IMMUTABLE = "public, max-age=31536000, immutable";
// Internal JSON / JSONL — read by the builder, not served to users directly
// via clean URLs. Short cache so a force-rerender picks them up next run.
const CC_INTERNAL = "public, max-age=60";

export async function build(opts: BuildOptions): Promise<{
  sweptDrawings: number;
  touchedDays: string[];
}> {
  const log = opts.logger ?? (() => {});
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const templates = opts.templates ?? DEFAULT_TEMPLATES;
  const repoUrl = opts.repoUrl ?? "https://github.com/potomak/drawbang";

  const inboxPrefixes = await opts.storage.listPrefix("inbox");
  const inboxDays = new Set(
    inboxPrefixes
      .map((p) => p.split("/").pop()!)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
  );
  const existingDayDirs = opts.forceRerender
    ? (await opts.storage.listPrefix("public/days"))
        .map((p) => p.split("/").pop()!)
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    : [];
  const days = [...new Set([...inboxDays, ...existingDayDirs])].sort();

  const touchedDays: string[] = [];
  let sweptCount = 0;
  // Drawings swept this run, grouped by username. Drives the per-profile sweep
  // after the day loop. Legacy (account-less) drawings are skipped — they have
  // no profile page.
  const newByUsername = new Map<string, DrawingMetadata[]>();

  for (const day of days) {
    const dayFiles = await opts.storage.listPrefix(`inbox/${day}`);
    const gifs = dayFiles.filter((k) => k.endsWith(".gif"));
    if (gifs.length === 0 && !opts.forceRerender) continue;

    if (gifs.length > 0) log(`sweeping inbox/${day}: ${gifs.length} drawings`);
    const drawings: DrawingMetadata[] = [];

    for (const gifKey of gifs) {
      const id = gifKey.split("/").pop()!.replace(/\.gif$/, "");
      const metaKey = gifKey.replace(/\.gif$/, ".json");
      const gifBytes = await opts.storage.getBytes(gifKey);
      const meta = await opts.storage.getJSON<DrawingMetadata & { nonce: string; baseline: string }>(metaKey);
      if (!gifBytes || !meta) {
        log(`  skip ${id}: missing gif or metadata`);
        continue;
      }

      // Defense in depth: re-verify content id + PoW before publishing.
      try {
        validateGif(gifBytes);
      } catch (err) {
        log(`  reject ${id}: ${(err as Error).message}`);
        continue;
      }
      if (hashHex(await contentHash(gifBytes)) !== meta.id) {
        log(`  reject ${id}: content hash mismatch`);
        continue;
      }
      const pow = await powHash(gifBytes, meta.baseline, meta.nonce);
      if (leadingZeroBits(pow) < meta.required_bits || hashHex(pow) !== meta.pow) {
        log(`  reject ${id}: pow re-verification failed`);
        continue;
      }

      await opts.storage.put(`public/drawings/${id}.gif`, gifBytes, "image/gif", CC_GIF_IMMUTABLE);
      drawings.push({
        id,
        pow: meta.pow,
        created_at: meta.created_at,
        required_bits: meta.required_bits,
        solve_ms: meta.solve_ms,
        bench_hps: meta.bench_hps,
        parent: meta.parent,
        user_id: meta.user_id ?? null,
        username: meta.username ?? null,
      });

      await opts.storage.remove(gifKey);
      await opts.storage.remove(metaKey);
      sweptCount++;
    }

    for (const d of drawings) {
      if (!d.username) continue;
      let bucket = newByUsername.get(d.username);
      if (!bucket) {
        bucket = [];
        newByUsername.set(d.username, bucket);
      }
      bucket.push(d);
    }

    if (drawings.length === 0 && !opts.forceRerender) continue;

    // Append to the day's index.jsonl (preserving any prior lines).
    const existing = (await opts.storage.getBytes(`public/days/${day}/index.jsonl`)) ?? new Uint8Array();
    let merged = dec.decode(existing);
    for (const d of drawings) merged += JSON.stringify(d) + "\n";
    if (drawings.length > 0) {
      await opts.storage.put(`public/days/${day}/index.jsonl`, enc.encode(merged), "application/jsonl", CC_INTERNAL);
    }

    const allForDay = parseJsonl(merged);
    if (allForDay.length === 0) continue;

    // Render per-drawing pages. Normally only fresh drawings; on forceRerender,
    // every known drawing for the day so template changes propagate. Each
    // render reads the per-drawing .murals.json sidecar so the "Murals"
    // section that ingest wrote on publish survives a forced re-render.
    // Without this, every builder pass wipes mural membership off old
    // drawings.
    const drawingsToRender = opts.forceRerender ? allForDay : drawings;
    for (const d of drawingsToRender) {
      const murals = await loadMurals(opts.storage, d.id);
      const html = templates.drawing({
        ...drawingViewModel(d),
        murals,
        public_base_url: opts.publicBaseUrl,
        repo_url: repoUrl,
      });
      await opts.storage.put(`public/d/${d.id}.html`, enc.encode(html), "text/html", CC_HTML);
    }

    touchedDays.push(day);
  }

  // Render day-gallery pages with cross-day prev/next links. Done after the
  // main loop so the days list reflects this run's newly-touched days. We
  // also re-render the predecessor of each touched day so its next_day
  // link picks up the newcomer — without this the previous day would stay
  // frozen with next_day=null from whenever it was last rendered.
  await rebuildDayGalleries(opts, templates, repoUrl, touchedDays);

  // Sweep canvas (multi-tile drawing) inbox records → /c/<id>.html pages +
  // rolling canvas index. Runs before profiles/rolling so they can list them.
  const canvasUsernames = await rebuildCanvases(opts, templates, repoUrl);

  // Rebuild per-account profile galleries (mutable like /gallery.html, not
  // immutable like the day pages). New entries land via newByUsername; on
  // forceRerender every existing profile page is also re-rendered.
  await rebuildProfiles(opts, templates, repoUrl, newByUsername, canvasUsernames);

  // Rebuild rolling surfaces: landing page and RSS feed.
  await rebuildRolling(opts, templates, today, repoUrl);

  // Rebuild /products gallery if a counter source is wired up.
  await rebuildProducts(opts, templates, repoUrl);

  // Mural pass: rollover + lock + state pointer + mural/archive pages.
  await muralPass({
    storage: opts.storage,
    muralStore: opts.muralStore,
    now: opts.now ? opts.now() : new Date(),
    repoUrl,
    apiBaseUrl: opts.apiBaseUrl,
  });

  return { sweptDrawings: sweptCount, touchedDays };
}

export interface Templates {
  dayGallery: (v: DayGalleryView) => string;
  drawing: (v: DrawingView) => string;
  gallery: (v: GalleryView) => string;
  feed: (v: FeedView) => string;
  notFound: (v: NotFoundView) => string;
  owner: (v: OwnerView) => string;
  products: (v: ProductsView) => string;
  canvasPage: (v: CanvasPageView) => string;
  tilePage: (v: TilePageView) => string;
}

export function drawingViewModel(
  d: DrawingMetadata,
): Omit<DrawingView, "repo_url" | "public_base_url"> {
  return {
    id: d.id,
    id_short: d.id.slice(0, 8),
    created_at: d.created_at,
    parent: d.parent ? { parent: d.parent, parent_short: d.parent.slice(0, 8) } : null,
    author:
      d.user_id && d.username
        ? { user_id: d.user_id, username: d.username }
        : null,
  };
}

function parseJsonl(text: string): DrawingMetadata[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DrawingMetadata);
}

// Rolling index of published canvases (not day-partitioned like drawings).
// Drives canvas listings on the gallery, feed, and per-account profiles.
const CANVAS_INDEX_KEY = "public/canvases-index.jsonl";

interface CanvasIndexEntry {
  canvas_id: string;
  created_at: string;
  thumb: string;
  username: string | null;
  user_id: string | null;
}

interface GalleryItemFull {
  id: string;
  id_short: string;
  href: string;
  thumb: string;
  created_at: string;
}

function parseCanvasIndex(text: string): CanvasIndexEntry[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CanvasIndexEntry);
}

async function loadCanvasIndex(opts: BuildOptions): Promise<CanvasIndexEntry[]> {
  const b = await opts.storage.getBytes(CANVAS_INDEX_KEY);
  return b ? parseCanvasIndex(dec.decode(b)) : [];
}

function drawingItem(d: DrawingMetadata): GalleryItemFull {
  return {
    id: d.id,
    id_short: d.id.slice(0, 8),
    href: `/d/${d.id}`,
    thumb: `/drawings/${d.id}.gif`,
    created_at: d.created_at,
  };
}

function canvasItem(e: CanvasIndexEntry): GalleryItemFull {
  return {
    id: e.canvas_id,
    id_short: e.canvas_id.slice(0, 8),
    href: `/c/${e.canvas_id}`,
    thumb: e.thumb,
    created_at: e.created_at,
  };
}

function byCreatedDesc(a: GalleryItemFull, b: GalleryItemFull): number {
  return b.created_at.localeCompare(a.created_at);
}

async function rebuildDayGalleries(
  opts: BuildOptions,
  templates: Templates,
  repoUrl: string,
  touchedDays: string[],
): Promise<void> {
  if (touchedDays.length === 0) return;

  // Full sorted day list (ascending) — used to look up neighbors.
  const dayDirs = await opts.storage.listPrefix("public/days");
  const allDays = [...new Set(
    dayDirs
      .map((k) => k.split("/").pop()!)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
  )].sort();

  const touchedSet = new Set(touchedDays);
  // Re-render predecessors so their next_day link picks up the newcomer.
  const toRender = new Set<string>(touchedDays);
  for (const day of touchedDays) {
    const idx = allDays.indexOf(day);
    if (idx > 0) toRender.add(allDays[idx - 1]);
  }

  for (const day of toRender) {
    const idx = allDays.indexOf(day);
    const prevDay = idx > 0 ? allDays[idx - 1] : null;
    const nextDay = idx >= 0 && idx < allDays.length - 1 ? allDays[idx + 1] : null;

    // Touched days have their drawings already in index.jsonl from the main
    // loop; predecessor re-renders need to re-load and re-sort.
    const indexBytes = await opts.storage.getBytes(`public/days/${day}/index.jsonl`);
    if (!indexBytes) continue;
    const allForDay = parseJsonl(dec.decode(indexBytes));
    if (allForDay.length === 0) continue;
    allForDay.sort((a, b) => b.created_at.localeCompare(a.created_at));

    const totalPages = Math.max(1, Math.ceil(allForDay.length / PER_PAGE));
    for (let page = 1; page <= totalPages; page++) {
      const slice = allForDay.slice((page - 1) * PER_PAGE, page * PER_PAGE);
      const html = templates.dayGallery({
        date: day,
        page,
        total_pages: totalPages,
        drawings: slice.map((d) => ({ id: d.id, id_short: d.id.slice(0, 8) })),
        prev_page: page > 1 ? { prev_page: page - 1, date: day } : null,
        next_page: page < totalPages ? { next_page: page + 1, date: day } : null,
        prev_day: prevDay,
        next_day: nextDay,
        repo_url: repoUrl,
      });
      await opts.storage.put(`public/days/${day}/p/${page}.html`, enc.encode(html), "text/html", CC_HTML);
    }

    // Only touched days rewrite the manifest — predecessor re-renders only
    // update the HTML; their count/pages haven't changed.
    if (touchedSet.has(day)) {
      await opts.storage.put(
        `public/days/${day}/manifest.json`,
        enc.encode(JSON.stringify({ count: allForDay.length, pages: totalPages })),
        "application/json",
        CC_INTERNAL,
      );
    }
  }
}

async function rebuildProfiles(
  opts: BuildOptions,
  templates: Templates,
  repoUrl: string,
  newByUsername: Map<string, DrawingMetadata[]>,
  canvasUsernames: Set<string>,
): Promise<void> {
  // Append fresh entries to each account's append-only drawing index.
  for (const [username, fresh] of newByUsername) {
    const existing = (await opts.storage.getBytes(`public/u/${username}/index.jsonl`)) ?? new Uint8Array();
    let merged = dec.decode(existing);
    for (const d of fresh) merged += JSON.stringify(d) + "\n";
    await opts.storage.put(
      `public/u/${username}/index.jsonl`,
      enc.encode(merged),
      "application/jsonl",
      CC_INTERNAL,
    );
  }

  // Canvases this account authored come from the rolling canvas index.
  const canvasIndex = await loadCanvasIndex(opts);
  const canvasByUser = new Map<string, CanvasIndexEntry[]>();
  for (const e of canvasIndex) {
    if (!e.username) continue;
    const list = canvasByUser.get(e.username) ?? [];
    list.push(e);
    canvasByUser.set(e.username, list);
  }

  // Profiles to (re-)render: anyone who got new drawings or canvases this run;
  // on forceRerender, every account with an existing index or canvases.
  const profilesToRender = new Set<string>([...newByUsername.keys(), ...canvasUsernames]);
  if (opts.forceRerender) {
    const keys = await opts.storage.listPrefix("public/u");
    for (const k of keys) {
      const m = k.match(/^public\/u\/([a-z0-9_-]{3,20})\/index\.jsonl$/);
      if (m) profilesToRender.add(m[1]);
    }
    for (const u of canvasByUser.keys()) profilesToRender.add(u);
  }

  for (const username of profilesToRender) {
    const indexBytes = await opts.storage.getBytes(`public/u/${username}/index.jsonl`);
    const drawings = indexBytes ? parseJsonl(dec.decode(indexBytes)) : [];
    const canvases = canvasByUser.get(username) ?? [];
    if (drawings.length === 0 && canvases.length === 0) continue;

    const items: GalleryItemFull[] = [
      ...drawings.map(drawingItem),
      ...canvases.map(canvasItem),
    ].sort(byCreatedDesc);

    const userId =
      drawings.find((d) => d.user_id)?.user_id ??
      canvases.find((c) => c.user_id)?.user_id ??
      "";
    const stats = opts.userStatsSource && userId
      ? await ownerStatsViewModel(opts.userStatsSource, userId)
      : undefined;
    // Only emit the client-hydration script when the stats endpoint is
    // reachable (i.e. apiBaseUrl is wired). Dev/test runs with no
    // apiBaseUrl keep the page free of hydration to avoid 404s on the
    // local proxy.
    const stats_url = stats && opts.apiBaseUrl && userId
      ? `${opts.apiBaseUrl}/users/${userId}/stats`
      : undefined;
    const html = templates.owner({
      username,
      user_id: userId,
      drawings: items,
      stats,
      stats_url,
      repo_url: repoUrl,
    });
    await opts.storage.put(`public/u/${username}.html`, enc.encode(html), "text/html", CC_HTML);
  }
}

async function ownerStatsViewModel(
  source: UserStatsSource,
  user_id: string,
): Promise<import("./templates/owner.js").OwnerStats> {
  const row = await source.get(user_id);
  const totals = {
    daily_total: row?.daily_total ?? 0,
    mural_total: row?.mural_total ?? 0,
  };
  const badges = earnedBadges(totals);
  return {
    daily_total: totals.daily_total,
    daily_streak_current: row?.daily_streak_current ?? 0,
    daily_streak_longest: row?.daily_streak_longest ?? 0,
    mural_total: totals.mural_total,
    mural_streak_current: row?.mural_streak_current ?? 0,
    mural_streak_longest: row?.mural_streak_longest ?? 0,
    daily_badges: badges.daily,
    mural_badges: badges.mural,
  };
}

interface CanvasRecord {
  canvas_id: string;
  cols: number;
  rows: number;
  tiles: (string | null)[];
  user_id: string | null;
  username: string | null;
  parent: string | null;
  created_at: string;
}

async function rebuildCanvases(
  opts: BuildOptions,
  templates: Templates,
  repoUrl: string,
): Promise<Set<string>> {
  const fresh: CanvasRecord[] = [];
  const rerender: CanvasRecord[] = [];

  // Freshly published canvases land as inbox/<day>/<id>.canvas.json.
  const inboxDirs = await opts.storage.listPrefix("inbox");
  for (const dir of inboxDirs) {
    const day = dir.split("/").pop()!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const files = await opts.storage.listPrefix(`inbox/${day}`);
    for (const f of files) {
      if (!f.endsWith(".canvas.json")) continue;
      const rec = await opts.storage.getJSON<CanvasRecord>(f);
      if (rec?.canvas_id) fresh.push(rec);
      await opts.storage.remove(f);
    }
  }

  // forceRerender re-renders every already-published canvas from its manifest
  // (HTML/composite only — the rolling index is not re-appended).
  if (opts.forceRerender) {
    const cKeys = await opts.storage.listPrefix("public/c");
    for (const k of cKeys) {
      if (!k.endsWith(".json")) continue;
      const rec = await opts.storage.getJSON<CanvasRecord>(k);
      if (rec?.canvas_id) rerender.push(rec);
    }
  }

  const usernames = new Set<string>();
  const newEntries: CanvasIndexEntry[] = [];
  for (const rec of fresh) {
    const thumb = await renderCanvasOne(opts, templates, repoUrl, rec);
    if (rec.username) usernames.add(rec.username);
    newEntries.push({
      canvas_id: rec.canvas_id,
      created_at: rec.created_at,
      thumb,
      username: rec.username,
      user_id: rec.user_id,
    });
  }
  for (const rec of rerender) {
    await renderCanvasOne(opts, templates, repoUrl, rec);
  }

  if (newEntries.length > 0) {
    const existing = (await opts.storage.getBytes(CANVAS_INDEX_KEY)) ?? new Uint8Array();
    let merged = dec.decode(existing);
    for (const e of newEntries) merged += JSON.stringify(e) + "\n";
    await opts.storage.put(CANVAS_INDEX_KEY, enc.encode(merged), "application/jsonl", CC_INTERNAL);
  }

  return usernames;
}

// Renders /c/<id>.html, ensures the small composite (multi-tile gallery thumb)
// + the ~960px -large.png (OG), and returns the gallery thumb URL.
async function renderCanvasOne(
  opts: BuildOptions,
  templates: Templates,
  repoUrl: string,
  rec: CanvasRecord,
): Promise<string> {
  const multi = rec.cols * rec.rows > 1;
  const smallKey = `public/c/${rec.canvas_id}.png`;
  const largeKey = `public/c/${rec.canvas_id}-large.png`;
  const needSmall = multi && !(await opts.storage.exists(smallKey));
  const needLarge = !(await opts.storage.exists(largeKey));

  if (needSmall || needLarge) {
    const tiles: { x: number; y: number; gif: Uint8Array }[] = [];
    for (let y = 0; y < rec.rows; y++) {
      for (let x = 0; x < rec.cols; x++) {
        const tid = rec.tiles[y * rec.cols + x];
        if (!tid) continue;
        const gif = await opts.storage.getBytes(`public/tiles/${tid}.gif`);
        if (gif) tiles.push({ x, y, gif });
      }
    }
    try {
      if (needSmall) {
        const png = await stitchCompositePng(tiles, rec.cols, rec.rows);
        await opts.storage.put(smallKey, png, "image/png", CC_GIF_IMMUTABLE);
      }
      if (needLarge) {
        const large = await stitchCompositePng(tiles, rec.cols, rec.rows, ogScale(rec.cols, rec.rows));
        await opts.storage.put(largeKey, large, "image/png", CC_GIF_IMMUTABLE);
      }
    } catch (e) {
      opts.logger?.(`  canvas ${rec.canvas_id}: composite stitch failed: ${(e as Error).message}`);
    }
  }

  // Gallery/feed thumbnail: small composite for multi-tile, the animated tile
  // gif for a 1×1. OG always uses the upscaled -large.png.
  const thumb = multi
    ? `/c/${rec.canvas_id}.png`
    : `/tiles/${rec.tiles.find((t): t is string => t !== null) ?? ""}.gif`;

  const html = templates.canvasPage({
    canvas_id: rec.canvas_id,
    id_short: rec.canvas_id.slice(0, 8),
    cols: rec.cols,
    rows: rec.rows,
    tiles: rec.tiles,
    author: rec.username ? { username: rec.username } : null,
    created_at: rec.created_at,
    preview_url: `/c/${rec.canvas_id}-large.png`,
    public_base_url: opts.publicBaseUrl,
    repo_url: repoUrl,
  });
  await opts.storage.put(`public/c/${rec.canvas_id}.html`, enc.encode(html), "text/html", CC_HTML);

  // Tile pages (the atom is addressable at /t/<id>).
  for (const tid of new Set(rec.tiles.filter((t): t is string => t !== null))) {
    const tileHtml = templates.tilePage({
      tile_id: tid,
      id_short: tid.slice(0, 8),
      public_base_url: opts.publicBaseUrl,
      repo_url: repoUrl,
    });
    await opts.storage.put(`public/t/${tid}.html`, enc.encode(tileHtml), "text/html", CC_HTML);
  }

  return thumb;
}

async function rebuildRolling(
  opts: BuildOptions,
  templates: Templates,
  today: string,
  repoUrl: string,
): Promise<void> {
  const days: DayRollup[] = [];
  const dayKeys = await opts.storage.listPrefix("public/days");
  for (const key of dayKeys) {
    const date = key.split("/").pop()!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const manifest = await opts.storage.getJSON<{ count: number; pages: number }>(
      `public/days/${date}/manifest.json`,
    );
    if (!manifest) continue;
    days.push({ date, count: manifest.count, pages: manifest.pages });
  }
  days.sort((a, b) => b.date.localeCompare(a.date));

  // Landing shows the most recent day that has drawings. Fall back to today
  // so the page still renders cleanly on a brand-new bucket.
  const latestDay = days[0]?.date ?? today;
  const latestLine =
    (await opts.storage.getBytes(`public/days/${latestDay}/index.jsonl`)) ?? new Uint8Array();
  const latestDrawings = parseJsonl(dec.decode(latestLine));

  // Canvases are rolling (not day-partitioned); merge the recent ones into the
  // landing "Latest" strip and the feed.
  const canvasIdx = await loadCanvasIndex(opts);
  const latest = [
    ...latestDrawings.map(drawingItem),
    ...canvasIdx.map(canvasItem),
  ]
    .sort(byCreatedDesc)
    .slice(0, PER_PAGE);

  const galleryHtml = templates.gallery({
    today: latestDay,
    drawings: latest,
    days: days.filter((d) => d.date !== latestDay),
    repo_url: repoUrl,
  });
  // Gallery landing lives at /gallery.html (CloudFront rewrites /gallery ->
  // /gallery.html) so it doesn't shadow the editor's index.html at "/".
  await opts.storage.put("public/gallery.html", enc.encode(galleryHtml), "text/html", CC_HTML);

  // RSS: latest 100 across all days.
  const allRecent: DrawingMetadata[] = [];
  for (const d of days) {
    const body = await opts.storage.getBytes(`public/days/${d.date}/index.jsonl`);
    if (!body) continue;
    allRecent.push(...parseJsonl(dec.decode(body)));
    if (allRecent.length >= 200) break;
  }
  const recentFeed = [
    ...allRecent.map(drawingItem),
    ...canvasIdx.map(canvasItem),
  ]
    .sort(byCreatedDesc)
    .slice(0, 100);
  const feed = templates.feed({
    base_url: opts.publicBaseUrl,
    build_date: new Date().toUTCString(),
    drawings: recentFeed.map((it) => ({
      id: it.id,
      id_short: it.id_short,
      pub_date: new Date(it.created_at).toUTCString(),
      href: it.href,
      thumb: it.thumb,
    })),
  });
  await opts.storage.put("public/feed.rss", enc.encode(feed), "application/rss+xml", CC_RSS);

  // Site-wide 404 page. CloudFront's CustomErrorResponses (infra/aws/template.yaml)
  // serve this body whenever S3 returns 404 / 403 (the latter happens for keys
  // outside the public/* prefix under OAC).
  const notFoundHtml = templates.notFound({ repo_url: repoUrl });
  await opts.storage.put("public/404.html", enc.encode(notFoundHtml), "text/html", CC_HTML);
}

async function rebuildProducts(
  opts: BuildOptions,
  templates: Templates,
  repoUrl: string,
): Promise<void> {
  // No data source wired up (e.g. local dev with FsStorage) → skip
  // entirely; otherwise the surface always emits at least page 1, even
  // when it's empty, so `/products` returns 200 on every deploy.
  if (!opts.productCountersSource || !opts.merchCatalog) return;
  const counters = await opts.productCountersSource.listAll();
  const cards = productCardsFromCounters(
    counters,
    opts.merchCatalog,
    opts.now ? opts.now() : new Date(),
  );

  const totalPages = Math.max(1, Math.ceil(cards.length / PER_PAGE));
  for (let page = 1; page <= totalPages; page++) {
    const slice = cards.slice((page - 1) * PER_PAGE, page * PER_PAGE);
    const html = templates.products({
      page,
      total_pages: totalPages,
      cards: slice,
      prev_page: page > 1 ? { prev_page: page - 1 } : null,
      next_page: page < totalPages ? { next_page: page + 1 } : null,
      repo_url: repoUrl,
    });
    const key = page === 1 ? "public/products.html" : `public/products/p/${page}.html`;
    await opts.storage.put(key, enc.encode(html), "text/html", CC_HTML);
  }
}

export function productCardsFromCounters(
  counters: readonly ProductCounter[],
  catalog: MerchCatalog,
  now: Date,
): ProductCard[] {
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  const enriched: Array<{ card: ProductCard; last_ordered_at: string }> = [];
  for (const c of counters) {
    if (c.count <= 0) continue;
    const product = byId.get(c.product_id);
    if (!product) continue;
    const cheapestCents = product.variants.reduce(
      (acc, v) => (v.retail_cents < acc ? v.retail_cents : acc),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(cheapestCents)) continue;
    enriched.push({
      card: {
        drawing_id: c.drawing_id,
        drawing_id_short: c.drawing_id.slice(0, 8),
        product_id: c.product_id,
        product_name: product.name,
        from_dollars: (cheapestCents / 100).toFixed(2),
        count: c.count,
        recency_label: relativeTimeLabel(c.last_ordered_at, now),
      },
      last_ordered_at: c.last_ordered_at,
    });
  }
  enriched.sort((a, b) => {
    if (b.card.count !== a.card.count) return b.card.count - a.card.count;
    return b.last_ordered_at.localeCompare(a.last_ordered_at);
  });
  return enriched.map((e) => e.card);
}

export function relativeTimeLabel(iso: string, now: Date): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const diffMs = now.getTime() - t;
  if (diffMs < 0) return null;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

// --- CLI entrypoint --------------------------------------------------------

async function cli(): Promise<void> {
  const path = await import("node:path");
  const s3Bucket = process.env.DRAWBANG_S3_BUCKET;
  const publicBaseUrl = process.env.DRAWBANG_PUBLIC_BASE ?? "http://localhost:5173";
  const repoUrl = process.env.DRAWBANG_REPO_URL ?? undefined;
  const today = process.env.DRAWBANG_TODAY;
  const forceRerender = process.env.DRAWBANG_FORCE_RERENDER === "1";
  const countersTable = process.env.DRAWBANG_PRODUCT_COUNTERS_TABLE ?? "drawbang-product-counters";
  // Strip /ingest suffix if present so the mural page hydration script can
  // hit https://<api>/mural/<id>/state directly (CloudFront blocks POSTs to
  // un-routed paths). Empty string in dev → relative URLs.
  const ingestUrl = process.env.DRAWBANG_INGEST_URL ?? "";
  const apiBaseUrl = ingestUrl.replace(/\/ingest$/, "");

  let storage: Storage;
  if (s3Bucket) {
    const { S3Storage } = await import("../ingest/s3-storage.js");
    storage = new S3Storage({ bucket: s3Bucket });
  } else {
    const { FsStorage } = await import("../ingest/storage.js");
    const root = process.env.DRAWBANG_BUCKET ?? path.join(process.cwd(), "dev-bucket");
    storage = new FsStorage(root);
  }

  // Only wire up the /products surface when running against S3 — the
  // counter source-of-truth is DynamoDB. Local dev (FsStorage) gets a
  // no-op so `npm run builder` against ./dev-bucket stays self-contained.
  let productCountersSource: ProductCountersSource | undefined;
  let merchCatalog: MerchCatalog | undefined;
  let muralStore: MuralStore | undefined;
  let userStatsSource: UserStatsSource | undefined;
  if (s3Bucket) {
    const { ProductCountersStore } = await import("../merch/product-counters.js");
    const store = new ProductCountersStore({ tableName: countersTable });
    productCountersSource = { listAll: () => store.listAll() };
    const catalogModule = await import("../config/merch.json", { with: { type: "json" } });
    merchCatalog = catalogModule.default as MerchCatalog;
    // Mural tile state lives in DDB; without this, muralPass renders the
    // current mural + every locked mural with empty tile arrays, and the
    // immutable cache-control on locked-mural HTML pins the wiped state.
    const { DynamoMuralStore } = await import("../ingest/mural-store.js");
    muralStore = new DynamoMuralStore({
      tilesTable: process.env.DRAWBANG_MURAL_TILES_TABLE ?? "drawbang-mural-tiles",
      cooldownsTable: process.env.DRAWBANG_MURAL_COOLDOWNS_TABLE ?? "drawbang-mural-cooldowns",
    });
    // Per-account streak + total counters drive the stats block on
    // /u/<username>.html. Builder reads only; ingest is the writer.
    const { DynamoUserStatsStore } = await import("../ingest/user-stats-store.js");
    userStatsSource = new DynamoUserStatsStore({
      tableName: process.env.DRAWBANG_USER_STATS_TABLE ?? "drawbang-user-stats",
    });
  }

  const result = await build({
    storage,
    publicBaseUrl,
    repoUrl,
    today,
    forceRerender,
    productCountersSource,
    merchCatalog,
    muralStore,
    userStatsSource,
    apiBaseUrl,
    logger: (m) => console.log(m),
  });
  console.log(`swept ${result.sweptDrawings} drawings, touched days: ${result.touchedDays.join(", ") || "(none)"}`);
}

const invokedFromCli =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;
if (invokedFromCli) {
  void cli();
}

export type { DrawingMetadata, DayRollup };
