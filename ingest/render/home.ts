import { CC_GALLERY, PER_PAGE } from "../../config/constants.js";
import renderHome, { renderFeedFragment, type HomeView } from "../../lib/templates/home.js";
import { renderDiscover } from "../../lib/templates/discover.js";
import { loadDiscover } from "../discover-handler.js";
import { promptForDate } from "../../config/prompts.js";
import type { RenderHandlersConfig, RenderResponse } from "./shared.js";
import { buildFragmentUrl, loadFeedItems } from "./shared.js";
import { decodeCursor } from "../drawing-store.js";

const TOP_TODAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const TOP_TODAY_SCAN_LIMIT = 200;

async function renderTopTodayPage(
  cfg: RenderHandlersConfig,
  perPage: number
): Promise<RenderResponse> {
  const [page, discover] = await Promise.all([
    cfg.drawingStore.queryGallery({ limit: TOP_TODAY_SCAN_LIMIT }),
    loadDiscover({ drawingStore: cfg.drawingStore, userStore: cfg.userStore, now: cfg.now }),
  ]);
  const now = cfg.now ? cfg.now() : new Date();
  const cutoff = now.getTime() - TOP_TODAY_WINDOW_MS;
  const rows = page.items
    .filter((r) => r.created_at_ms >= cutoff)
    .sort((a, b) => (b.like_count ?? 0) - (a.like_count ?? 0))
    .slice(0, perPage);
  const items = await loadFeedItems(cfg, rows);
  const view: HomeView = {
    items,
    sort: "top",
    repo_url: cfg.repoUrl,
    discover_rail_html: renderDiscover(discover),
    prompt: promptForDate(now),
  };
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_GALLERY,
    body: renderHome(view),
  };
}

export async function renderHomePageHandler(
  cfg: RenderHandlersConfig,
  rawCursor: string | null,
  rawSort: string | null = null
): Promise<RenderResponse> {
  const perPage = cfg.perPage ?? PER_PAGE;
  if (rawSort === "top") return renderTopTodayPage(cfg, perPage);
  const cursor = decodeCursor(rawCursor) ?? undefined;
  const [page, discover] = await Promise.all([
    cfg.drawingStore.queryGallery({ limit: perPage, cursor }),
    cursor
      ? Promise.resolve(null)
      : loadDiscover({ drawingStore: cfg.drawingStore, userStore: cfg.userStore, now: cfg.now }),
  ]);
  const items = await loadFeedItems(cfg, page.items);
  const next = buildFragmentUrl("/feed/items", page.next_cursor);
  const view: HomeView = { items, repo_url: cfg.repoUrl };
  if (next) view.next_fragment_url = next;
  if (discover) view.discover_rail_html = renderDiscover(discover);
  if (!cursor) view.prompt = promptForDate(cfg.now ? cfg.now() : new Date());
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_GALLERY,
    body: renderHome(view),
  };
}

export async function renderFeedItemsHandler(
  cfg: RenderHandlersConfig,
  rawCursor: string | null
): Promise<RenderResponse> {
  const perPage = cfg.perPage ?? PER_PAGE;
  const cursor = decodeCursor(rawCursor) ?? undefined;
  const page = await cfg.drawingStore.queryGallery({ limit: perPage, cursor });
  const items = await loadFeedItems(cfg, page.items);
  const next = buildFragmentUrl("/feed/items", page.next_cursor);
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_GALLERY,
    body: renderFeedFragment(items, next),
  };
}
