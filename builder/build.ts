import { PER_PAGE } from "../config/constants.js";
import type { Storage } from "../ingest/storage.js";
import { validateGif } from "../ingest/gif-validate.js";
import type { MerchCatalog } from "../merch/lambda.js";
import type { ProductCounter } from "../merch/product-counters.js";
import { contentHash, hashHex, leadingZeroBits, powHash } from "../src/pow.js";
import renderDayGallery from "./templates/day-gallery.js";
import renderDrawing from "./templates/drawing.js";
import renderIndex from "./templates/index.js";
import renderFeed from "./templates/feed.js";
import renderOwner from "./templates/owner.js";
import renderProducts from "./templates/products.js";
import type { DayGalleryView } from "./templates/day-gallery.js";
import type { DrawingView } from "./templates/drawing.js";
import type { IndexView } from "./templates/index.js";
import type { FeedView } from "./templates/feed.js";
import type { OwnerView } from "./templates/owner.js";
import type { ProductCard, ProductsView } from "./templates/products.js";

export interface ProductCountersSource {
  listAll: () => Promise<ProductCounter[]>;
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
}

export const DEFAULT_TEMPLATES: Templates = {
  dayGallery: renderDayGallery,
  drawing: renderDrawing,
  index: renderIndex,
  feed: renderFeed,
  owner: renderOwner,
  products: renderProducts,
};

interface DrawingMetadata {
  id: string;
  pow: string;
  created_at: string;
  required_bits: number;
  solve_ms: number | null;
  bench_hps: number | null;
  parent: string | null;
  // Owner fields land via the inbox JSON sidecar that ingest writes (see #83).
  // null only for entries that predate the ownership feature; the operator
  // backfill (#90) signs them with the operator's keypair before re-rendering.
  pubkey: string | null;
  signature: string | null;
}

interface DayRollup {
  date: string;
  count: number;
  pages: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

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
  // Drawings swept this run, grouped by owner. Drives the per-owner sweep
  // after the day loop. Anonymous (legacy) drawings are skipped — the
  // operator backfill (#90) signs them so they pick up an owner.
  const newByOwner = new Map<string, DrawingMetadata[]>();

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

      await opts.storage.put(`public/drawings/${id}.gif`, gifBytes, "image/gif");
      drawings.push({
        id,
        pow: meta.pow,
        created_at: meta.created_at,
        required_bits: meta.required_bits,
        solve_ms: meta.solve_ms,
        bench_hps: meta.bench_hps,
        parent: meta.parent,
        pubkey: meta.pubkey ?? null,
        signature: meta.signature ?? null,
      });

      await opts.storage.remove(gifKey);
      await opts.storage.remove(metaKey);
      sweptCount++;
    }

    for (const d of drawings) {
      if (!d.pubkey) continue;
      let bucket = newByOwner.get(d.pubkey);
      if (!bucket) {
        bucket = [];
        newByOwner.set(d.pubkey, bucket);
      }
      bucket.push(d);
    }

    if (drawings.length === 0 && !opts.forceRerender) continue;

    // Append to the day's index.jsonl (preserving any prior lines).
    const existing = (await opts.storage.getBytes(`public/days/${day}/index.jsonl`)) ?? new Uint8Array();
    let merged = dec.decode(existing);
    for (const d of drawings) merged += JSON.stringify(d) + "\n";
    if (drawings.length > 0) {
      await opts.storage.put(`public/days/${day}/index.jsonl`, enc.encode(merged), "application/jsonl");
    }

    const allForDay = parseJsonl(merged);
    if (allForDay.length === 0) continue;

    // Render per-drawing pages. Normally only fresh drawings; on forceRerender,
    // every known drawing for the day so template changes propagate.
    const drawingsToRender = opts.forceRerender ? allForDay : drawings;
    for (const d of drawingsToRender) {
      const html = templates.drawing({
        ...drawingViewModel(d),
        repo_url: repoUrl,
      });
      await opts.storage.put(`public/d/${d.id}.html`, enc.encode(html), "text/html");
    }

    // Render the day's paginated gallery. Sort newest-first.
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
        repo_url: repoUrl,
      });
      await opts.storage.put(`public/days/${day}/p/${page}.html`, enc.encode(html), "text/html");
    }
    await opts.storage.put(
      `public/days/${day}/manifest.json`,
      enc.encode(JSON.stringify({ count: allForDay.length, pages: totalPages })),
      "application/json",
    );

    touchedDays.push(day);
  }

  // Rebuild per-owner galleries (mutable like /gallery.html, not immutable
  // like the day pages). New entries land via newByOwner; on forceRerender
  // every existing owner page is also re-rendered.
  await rebuildOwners(opts, templates, repoUrl, newByOwner);

  // Rebuild rolling surfaces: landing page and RSS feed.
  await rebuildRolling(opts, templates, today, repoUrl);

  // Rebuild /products gallery if a counter source is wired up.
  await rebuildProducts(opts, templates, repoUrl);

  return { sweptDrawings: sweptCount, touchedDays };
}

export interface Templates {
  dayGallery: (v: DayGalleryView) => string;
  drawing: (v: DrawingView) => string;
  index: (v: IndexView) => string;
  feed: (v: FeedView) => string;
  owner: (v: OwnerView) => string;
  products: (v: ProductsView) => string;
}

export function drawingViewModel(d: DrawingMetadata): Omit<DrawingView, "repo_url"> {
  return {
    id: d.id,
    id_short: d.id.slice(0, 8),
    created_at: d.created_at,
    required_bits: d.required_bits,
    solve_ms: d.solve_ms ?? "unknown",
    bench_hps: d.bench_hps ?? "unknown",
    parent: d.parent ? { parent: d.parent, parent_short: d.parent.slice(0, 8) } : null,
    owner: d.pubkey ? { pubkey: d.pubkey, pubkey_short: d.pubkey.slice(0, 8) } : null,
  };
}

function parseJsonl(text: string): DrawingMetadata[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DrawingMetadata);
}

async function rebuildOwners(
  opts: BuildOptions,
  templates: Templates,
  repoUrl: string,
  newByOwner: Map<string, DrawingMetadata[]>,
): Promise<void> {
  // Append fresh entries to each owner's append-only index.
  for (const [pubkey, fresh] of newByOwner) {
    const existing = (await opts.storage.getBytes(`public/keys/${pubkey}/index.jsonl`)) ?? new Uint8Array();
    let merged = dec.decode(existing);
    for (const d of fresh) merged += JSON.stringify(d) + "\n";
    await opts.storage.put(
      `public/keys/${pubkey}/index.jsonl`,
      enc.encode(merged),
      "application/jsonl",
    );
  }

  // Owners to (re-)render: anyone who got new entries this run; on
  // forceRerender, every owner whose index already exists.
  const ownersToRender = new Set<string>(newByOwner.keys());
  if (opts.forceRerender) {
    const ownerKeys = await opts.storage.listPrefix("public/keys");
    for (const k of ownerKeys) {
      const last = k.split("/").pop()!;
      // Only the per-owner subdirs (which are 64-hex). Files like
      // <pk>.html are skipped by the regex (extra suffix).
      if (/^[0-9a-f]{64}$/.test(last)) ownersToRender.add(last);
    }
  }

  for (const pubkey of ownersToRender) {
    const indexBytes = await opts.storage.getBytes(`public/keys/${pubkey}/index.jsonl`);
    if (!indexBytes) continue;
    const all = parseJsonl(dec.decode(indexBytes));
    all.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const html = templates.owner({
      pubkey,
      pubkey_short: pubkey.slice(0, 8),
      drawings: all.map((d) => ({ id: d.id, id_short: d.id.slice(0, 8) })),
      repo_url: repoUrl,
    });
    await opts.storage.put(`public/keys/${pubkey}.html`, enc.encode(html), "text/html");
  }
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
  latestDrawings.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const latest = latestDrawings.slice(0, PER_PAGE);

  const indexHtml = templates.index({
    today: latestDay,
    drawings: latest.map((d) => ({ id: d.id, id_short: d.id.slice(0, 8) })),
    days: days.filter((d) => d.date !== latestDay),
    repo_url: repoUrl,
  });
  // Gallery landing lives at /gallery.html (CloudFront rewrites /gallery ->
  // /gallery.html) so it doesn't shadow the editor's index.html at "/".
  await opts.storage.put("public/gallery.html", enc.encode(indexHtml), "text/html");

  // RSS: latest 100 across all days.
  const allRecent: DrawingMetadata[] = [];
  for (const d of days) {
    const body = await opts.storage.getBytes(`public/days/${d.date}/index.jsonl`);
    if (!body) continue;
    allRecent.push(...parseJsonl(dec.decode(body)));
    if (allRecent.length >= 200) break;
  }
  allRecent.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const feed = templates.feed({
    base_url: opts.publicBaseUrl,
    build_date: new Date().toUTCString(),
    drawings: allRecent.slice(0, 100).map((d) => ({
      id: d.id,
      id_short: d.id.slice(0, 8),
      pub_date: new Date(d.created_at).toUTCString(),
    })),
  });
  await opts.storage.put("public/feed.rss", enc.encode(feed), "application/rss+xml");
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
    await opts.storage.put(key, enc.encode(html), "text/html");
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
  if (s3Bucket) {
    const { ProductCountersStore } = await import("../merch/product-counters.js");
    const store = new ProductCountersStore({ tableName: countersTable });
    productCountersSource = { listAll: () => store.listAll() };
    const catalogModule = await import("../config/merch.json", { with: { type: "json" } });
    merchCatalog = catalogModule.default as MerchCatalog;
  }

  const result = await build({
    storage,
    publicBaseUrl,
    repoUrl,
    today,
    forceRerender,
    productCountersSource,
    merchCatalog,
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
