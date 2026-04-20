import Mustache from "mustache";
import { PER_PAGE } from "../config/constants.js";
import type { Storage } from "../ingest/storage.js";
import { validateGif } from "../ingest/gif-validate.js";
import { hashHex, leadingZeroBits, powHash } from "../src/pow.js";
import dayGalleryTpl from "./templates/day-gallery.js";
import drawingTpl from "./templates/drawing.js";
import indexTpl from "./templates/index.js";
import feedTpl from "./templates/feed.js";

export interface BuildOptions {
  storage: Storage;
  today?: string; // YYYY-MM-DD, defaults to real today
  publicBaseUrl: string;
  logger?: (msg: string) => void;
  templates?: Templates;
  // Re-render every day's HTML from existing index.jsonl even if no new
  // drawings arrived. Used after template changes.
  forceRerender?: boolean;
}

export const DEFAULT_TEMPLATES: Templates = {
  dayGallery: dayGalleryTpl,
  drawing: drawingTpl,
  index: indexTpl,
  feed: feedTpl,
};

interface DrawingMetadata {
  id: string;
  created_at: string;
  required_bits: number;
  solve_ms: number | null;
  bench_hps: number | null;
  parent: string | null;
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

      // Defense in depth: re-verify PoW before publishing to the public tree.
      try {
        validateGif(gifBytes);
      } catch (err) {
        log(`  reject ${id}: ${(err as Error).message}`);
        continue;
      }
      const hash = await powHash(gifBytes, meta.baseline, meta.nonce);
      if (leadingZeroBits(hash) < meta.required_bits || hashHex(hash) !== meta.id) {
        log(`  reject ${id}: pow re-verification failed`);
        continue;
      }

      await opts.storage.put(`public/drawings/${id}.gif`, gifBytes, "image/gif");
      drawings.push({
        id,
        created_at: meta.created_at,
        required_bits: meta.required_bits,
        solve_ms: meta.solve_ms,
        bench_hps: meta.bench_hps,
        parent: meta.parent,
      });

      await opts.storage.remove(gifKey);
      await opts.storage.remove(metaKey);
      sweptCount++;
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
      const html = Mustache.render(templates.drawing, drawingViewModel(d));
      await opts.storage.put(`public/d/${d.id}.html`, enc.encode(html), "text/html");
    }

    // Render the day's paginated gallery. Sort newest-first.
    allForDay.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const totalPages = Math.max(1, Math.ceil(allForDay.length / PER_PAGE));
    for (let page = 1; page <= totalPages; page++) {
      const slice = allForDay.slice((page - 1) * PER_PAGE, page * PER_PAGE);
      const html = Mustache.render(templates.dayGallery, {
        date: day,
        page,
        total_pages: totalPages,
        drawings: slice.map((d) => ({ id: d.id, id_short: d.id.slice(0, 8) })),
        prev_page: page > 1 ? { prev_page: page - 1, date: day } : null,
        next_page: page < totalPages ? { next_page: page + 1, date: day } : null,
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

  // Rebuild rolling surfaces: landing page and RSS feed.
  await rebuildRolling(opts, templates, today);

  return { sweptDrawings: sweptCount, touchedDays };
}

export interface Templates {
  dayGallery: string;
  drawing: string;
  index: string;
  feed: string;
}

export function drawingViewModel(d: DrawingMetadata): Record<string, unknown> {
  return {
    id: d.id,
    id_short: d.id.slice(0, 8),
    created_at: d.created_at,
    required_bits: d.required_bits,
    solve_ms: d.solve_ms ?? "unknown",
    bench_hps: d.bench_hps ?? "unknown",
    parent: d.parent ? { parent: d.parent, parent_short: d.parent.slice(0, 8) } : null,
  };
}

function parseJsonl(text: string): DrawingMetadata[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DrawingMetadata);
}

async function rebuildRolling(
  opts: BuildOptions,
  templates: Templates,
  today: string,
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

  // Landing: latest 36 from today's page 1.
  const todayLine =
    (await opts.storage.getBytes(`public/days/${today}/index.jsonl`)) ?? new Uint8Array();
  const todayDrawings = parseJsonl(dec.decode(todayLine));
  todayDrawings.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const latest = todayDrawings.slice(0, PER_PAGE);

  const indexHtml = Mustache.render(templates.index, {
    today,
    drawings: latest.map((d) => ({ id: d.id, id_short: d.id.slice(0, 8) })),
    days,
  });
  await opts.storage.put("public/index.html", enc.encode(indexHtml), "text/html");

  // RSS: latest 100 across all days.
  const allRecent: DrawingMetadata[] = [];
  for (const d of days) {
    const body = await opts.storage.getBytes(`public/days/${d.date}/index.jsonl`);
    if (!body) continue;
    allRecent.push(...parseJsonl(dec.decode(body)));
    if (allRecent.length >= 200) break;
  }
  allRecent.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const feed = Mustache.render(templates.feed, {
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

// --- CLI entrypoint --------------------------------------------------------

async function cli(): Promise<void> {
  const path = await import("node:path");
  const { FsStorage } = await import("../ingest/storage.js");
  const root = process.env.DRAWBANG_BUCKET ?? path.join(process.cwd(), "dev-bucket");
  const publicBaseUrl = process.env.DRAWBANG_PUBLIC_BASE ?? "http://localhost:5173";
  const today = process.env.DRAWBANG_TODAY;
  const storage = new FsStorage(root);
  const result = await build({
    storage,
    publicBaseUrl,
    today,
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
