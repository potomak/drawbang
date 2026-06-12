// TODO (#split-render-handlers): this module is ~900 lines and handles
// every dynamic route (home/feed, tile, profile, follow-list, bookmarks,
// products, design, feed.rss, not-found). Split by domain:
// render-home.ts, render-tile.ts, render-profile.ts, render-follow-list.ts,
// render-products.ts, render-feed.ts, render-design.ts. Keep
// RenderHandlersConfig + the shared helpers (notFound, etc.) in a
// render-shared.ts and have lambda.ts route to per-domain modules.

import {
  PER_PAGE,
  DRAWING_ID_RE,
  USERNAME_RE,
  CC_GALLERY,
  CC_DRAWING_PAGE,
  CC_PROFILE,
  CC_FEED,
  CC_NOT_FOUND,
  CC_FOLLOW_LIST,
  CC_FOLLOW_THUMBS,
  CC_PRODUCTS,
  CC_DESIGN,
  CC_EMBED,
} from "../config/constants.js";
import renderEmbed from "../lib/templates/embed.js";
import renderGallery, {
  renderGalleryFragment,
  renderGallerySentinel,
  type GalleryItem,
  type GalleryView,
} from "../lib/templates/gallery.js";
import renderTilePage from "../lib/templates/tile-page.js";
import renderFeed from "../lib/templates/feed.js";
import renderHome, {
  renderFeedCard,
  renderFeedFragment,
  type FeedItem,
  type HomeView,
} from "../lib/templates/home.js";
import renderOwner from "../lib/templates/owner.js";
import renderStreak, {
  type DayCell,
  type MonthBlock,
  type StreakView,
} from "../lib/templates/streak.js";
import renderBookmarksPage from "../lib/templates/bookmarks.js";
import renderFollowList, {
  renderFollowListFragment,
  type FollowListItem,
  type FollowListKind,
} from "../lib/templates/follow-list.js";
import renderNotFound from "../lib/templates/not-found.js";
import renderProducts from "../lib/templates/products.js";
import { assetUrl } from "../src/layout/asset-version.js";
import {
  PROMPT_SLUG_RE,
  PROMPTS_EPOCH_ET,
  etDateString,
  promptBySlug,
  promptForDate,
} from "../config/prompts.js";
import {
  renderPromptArchive,
  renderPromptPage,
  type PromptArchiveEntry,
  type PromptPageView,
} from "../lib/templates/prompts.js";
import renderDesign from "../lib/templates/design.js";
import { renderDiscover } from "../lib/templates/discover.js";
import { loadDiscover } from "./discover-handler.js";
import { productCardsFromCounters } from "../lib/products-cards.js";
import {
  decodeCursor,
  encodeCursor,
  type DrawingCursor,
  type DrawingRow,
  type DrawingStore,
} from "./drawing-store.js";
import type { BookmarksStore } from "./bookmarks-store.js";
import {
  decodeFollowCursor,
  encodeFollowCursor,
  type FollowEdge,
  type FollowsStore,
} from "./follows-store.js";
import type { MerchCatalog } from "../merch/lambda.js";
import type { ProductCounter } from "../merch/product-counters.js";
import type { UserStatsStore } from "./user-stats-store.js";
import type { UserStore } from "./user-store.js";
import { earnedBadges } from "../config/badges.js";
import type { OwnerStats } from "../lib/templates/owner.js";

// Render handlers for the dynamic /gallery, /d/<id>, /u/<un>, /feed.rss
// surfaces. Each returns a complete HTML/XML body plus the cache header
// the route should ship. The Lambda adapter (or the dev-server in
// dev:all) takes care of HTTP framing.

export interface ProductCountersSource {
  listAll(): Promise<ProductCounter[]>;
}

export interface RenderHandlersConfig {
  drawingStore: DrawingStore;
  publicBaseUrl: string;
  repoUrl: string;
  // Items per page on the gallery + profile. Defaults to PER_PAGE.
  perPage?: number;
  // /products surface. Both must be set; missing either → /products 404s.
  // Dev environments without a merch counters table just leave them off.
  productCountersSource?: ProductCountersSource;
  merchCatalog?: MerchCatalog;
  // Per-account streak + total counters (#115/#116). When set, the profile
  // page renders the stats block server-side off this store; when absent
  // (dev/tests) the profile just shows the drawings grid.
  userStatsStore?: UserStatsStore;
  // Account lookup. When wired, /u/<username> renders an empty profile
  // page for accounts that exist but haven't published anything yet
  // (instead of 404'ing). Optional in dev/tests.
  userStore?: UserStore;
  // Per-user bookmarks. When wired, renderBookmarksPageHandler serves the
  // /u/<username>/bookmarks page; otherwise that route 404s. Optional so
  // tests/dev paths that don't exercise bookmarks can omit it.
  bookmarksStore?: BookmarksStore;
  // Per-user follows (#202). When wired, renderFollowers/Following handlers
  // serve the /u/<un>/followers + /u/<un>/following pages. Optional.
  followsStore?: FollowsStore;
  // Test seam for the recency label on product cards. Defaults to wall-clock.
  now?: () => Date;
}

export interface RenderResponse {
  status: 200 | 404;
  contentType: string;
  cacheControl: string;
  body: string;
}

function itemFromRow(r: DrawingRow): GalleryItem {
  return {
    id: r.drawing_id,
    id_short: r.drawing_id.slice(0, 8),
    href: `/d/${r.drawing_id}`,
    thumb: `/tiles/${r.drawing_id}.gif`,
    created_at: r.created_at,
  };
}

function notFound(cfg: RenderHandlersConfig): RenderResponse {
  return {
    status: 404,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_NOT_FOUND,
    body: renderNotFound({ repo_url: cfg.repoUrl }),
  };
}

function buildFragmentUrl(
  basePath: string,
  cursor: DrawingCursor | null,
): string | null {
  if (!cursor) return null;
  return `${basePath}?cursor=${encodeCursor(cursor)}`;
}

// -- / (feed home) + /feed/items ---------------------------------------------

async function loadFeedItems(
  cfg: RenderHandlersConfig,
  rows: DrawingRow[],
): Promise<FeedItem[]> {
  // Batch the author profile-picture lookups: gather unique non-anonymous
  // usernames, GetItem each once, attach to the matching rows. Without a
  // userStore (dev/tests) the profile pictures are simply null.
  const usernames = new Set<string>();
  for (const r of rows) {
    if (r.username !== "anonymous") usernames.add(r.username);
  }
  const pictures = new Map<string, string | null>();
  if (cfg.userStore && usernames.size > 0) {
    await Promise.all(
      [...usernames].map(async (un) => {
        const acct = await cfg.userStore!.getByUsername(un);
        pictures.set(un, acct?.profile_picture_drawing_id ?? null);
      }),
    );
  }
  return rows.map((r) => ({
    id: r.drawing_id,
    id_short: r.drawing_id.slice(0, 8),
    href: `/d/${r.drawing_id}`,
    thumb: `/tiles/${r.drawing_id}.gif`,
    created_at: r.created_at,
    like_count: r.like_count ?? 0,
    author:
      r.username === "anonymous"
        ? null
        : {
            username: r.username,
            profile_picture_drawing_id: pictures.get(r.username) ?? null,
          },
  }));
}

// "Top today" sort: scan the recent gallery window in memory, same
// approximation as the discover rail — no GSI, no precompute. The page
// is bounded (top 36, no pagination) and catches up at the 300s
// s-maxage like the like counts themselves.
const TOP_TODAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const TOP_TODAY_SCAN_LIMIT = 200;

async function renderTopTodayPage(
  cfg: RenderHandlersConfig,
  perPage: number,
): Promise<RenderResponse> {
  const [page, discover] = await Promise.all([
    cfg.drawingStore.queryGallery({ limit: TOP_TODAY_SCAN_LIMIT }),
    loadDiscover({ drawingStore: cfg.drawingStore, userStore: cfg.userStore, now: cfg.now }),
  ]);
  const now = cfg.now ? cfg.now() : new Date();
  const cutoff = now.getTime() - TOP_TODAY_WINDOW_MS;
  // Stable sort keeps queryGallery's newest-first order as the tiebreak
  // for equal like counts.
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
  rawSort: string | null = null,
): Promise<RenderResponse> {
  const perPage = cfg.perPage ?? PER_PAGE;
  if (rawSort === "top") return renderTopTodayPage(cfg, perPage);
  const cursor = decodeCursor(rawCursor) ?? undefined;
  // Load the feed page and the discover rail in parallel; both reads
  // share the s-maxage=300 edge cache so this is the only time per
  // 5-min window we hit DDB for either.
  const [page, discover] = await Promise.all([
    cfg.drawingStore.queryGallery({ limit: perPage, cursor }),
    // Only render the discover rail on the first page — subsequent
    // /feed/items fragments are appended below the existing rail and
    // don't repaint it.
    cursor
      ? Promise.resolve(null)
      : loadDiscover({ drawingStore: cfg.drawingStore, userStore: cfg.userStore, now: cfg.now }),
  ]);
  const items = await loadFeedItems(cfg, page.items);
  const next = buildFragmentUrl("/feed/items", page.next_cursor);
  const view: HomeView = { items, repo_url: cfg.repoUrl };
  if (next) view.next_fragment_url = next;
  if (discover) view.discover_rail_html = renderDiscover(discover);
  // Daily-prompt banner, first page only (same rule as the discover
  // rail — /feed/items appends must not repeat it). Computed at render
  // time: / is edge-cached with s-maxage=300, so the banner can flip up
  // to ~5 minutes late at ET midnight. Accepted trade-off — do not add
  // cache-busting or invalidation for this.
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
  rawCursor: string | null,
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

// -- /gallery + /gallery/items -----------------------------------------------

export async function renderGalleryPageHandler(
  cfg: RenderHandlersConfig,
  rawCursor: string | null,
): Promise<RenderResponse> {
  const perPage = cfg.perPage ?? PER_PAGE;
  const cursor = decodeCursor(rawCursor) ?? undefined;
  const page = await cfg.drawingStore.queryGallery({ limit: perPage, cursor });
  const next = buildFragmentUrl("/gallery/items", page.next_cursor);
  const view: GalleryView = {
    drawings: page.items.map(itemFromRow),
    repo_url: cfg.repoUrl,
  };
  if (next) view.next_fragment_url = next;
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_GALLERY,
    body: renderGallery(view),
  };
}

export async function renderGalleryItemsHandler(
  cfg: RenderHandlersConfig,
  rawCursor: string | null,
): Promise<RenderResponse> {
  const perPage = cfg.perPage ?? PER_PAGE;
  const cursor = decodeCursor(rawCursor) ?? undefined;
  const page = await cfg.drawingStore.queryGallery({ limit: perPage, cursor });
  const next = buildFragmentUrl("/gallery/items", page.next_cursor);
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_GALLERY,
    body: renderGalleryFragment(page.items.map(itemFromRow), next),
  };
}

// -- /d/<id> -----------------------------------------------------------------

// Deepest remix lineage the page walks. Each hop is one GetItem; ≤8
// serial reads per render is acceptable behind the page's s-maxage.
const ANCESTOR_CHAIN_CAP = 8;

// Walks parent_id hops upward and returns the chain root-first
// (root → … → parent). The walk is defensive by design: it caps the
// depth, breaks on cycles, and treats a missing parent row as the end
// of the chain — lineage must never error the page.
async function loadAncestorChain(
  store: DrawingStore,
  row: DrawingRow,
): Promise<{ id: string; id_short: string }[]> {
  const chain: { id: string; id_short: string }[] = [];
  const visited = new Set<string>([row.drawing_id]);
  let parentId = row.parent_id;
  while (parentId && chain.length < ANCESTOR_CHAIN_CAP && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = await store.get(parentId);
    if (!parent) break;
    chain.push({ id: parent.drawing_id, id_short: parent.drawing_id.slice(0, 8) });
    parentId = parent.parent_id;
  }
  return chain.reverse();
}

// -- /embed/<id> ---------------------------------------------------------------

export async function renderEmbedPageHandler(
  cfg: RenderHandlersConfig,
  drawing_id: string,
): Promise<RenderResponse> {
  // 404s are plain text — the page lives inside a tiny iframe where the
  // chrome'd not-found shell makes no sense.
  const missing = !DRAWING_ID_RE.test(drawing_id) || !(await cfg.drawingStore.get(drawing_id));
  if (missing) {
    return {
      status: 404,
      contentType: "text/plain; charset=utf-8",
      cacheControl: CC_NOT_FOUND,
      body: "Not found",
    };
  }
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_EMBED,
    body: renderEmbed({ drawing_id }),
  };
}

export async function renderDrawingPageHandler(
  cfg: RenderHandlersConfig,
  drawing_id: string,
): Promise<RenderResponse> {
  if (!DRAWING_ID_RE.test(drawing_id)) return notFound(cfg);
  const row = await cfg.drawingStore.get(drawing_id);
  if (!row) return notFound(cfg);

  // Forks: cap to the same per-page count; the page only renders the
  // first slice and accepts that "Forks · N" can lag if a drawing has
  // gone viral. A "see all forks" follow-up could add a fragment endpoint
  // similar to the gallery's.
  const forks = await cfg.drawingStore.queryForks(drawing_id, {
    limit: cfg.perPage ?? PER_PAGE,
  });
  const ancestors = await loadAncestorChain(cfg.drawingStore, row);
  // Author profile picture: optional lookup so legacy "anonymous" /
  // unregistered usernames just render without one. Short-circuit for
  // the "anonymous" bucket since RESERVED_USERNAMES guarantees no real
  // account row exists for it.
  const authorAccount =
    cfg.userStore && row.username !== "anonymous"
      ? await cfg.userStore.getByUsername(row.username)
      : null;
  const body = renderTilePage({
    drawing_id: row.drawing_id,
    id_short: row.drawing_id.slice(0, 8),
    created_at: row.created_at,
    parent: row.parent_id
      ? { parent: row.parent_id, parent_short: row.parent_id.slice(0, 8) }
      : null,
    author: {
      user_id: row.user_id,
      username: row.username,
      profile_picture_drawing_id: authorAccount?.profile_picture_drawing_id ?? null,
    },
    forks: forks.items.map(itemFromRow),
    ancestors,
    like_count: row.like_count ?? 0,
    public_base_url: cfg.publicBaseUrl,
    repo_url: cfg.repoUrl,
  });
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_DRAWING_PAGE,
    body,
  };
}

// -- /u/<username> + /u/<username>/items -------------------------------------

export async function renderProfilePageHandler(
  cfg: RenderHandlersConfig,
  username: string,
): Promise<RenderResponse> {
  if (!USERNAME_RE.test(username)) return notFound(cfg);
  const perPage = cfg.perPage ?? PER_PAGE;
  const page = await cfg.drawingStore.queryByUsername(username, { limit: perPage });
  // Account lookup: needed for the profile-picture field on every render,
  // and for the empty-profile branch where it's the only way to resolve
  // user_id. The "anonymous" bucket has no real account row, so skip
  // the lookup.
  const account =
    cfg.userStore && username !== "anonymous"
      ? await cfg.userStore.getByUsername(username)
      : null;
  let userId: string;
  if (page.items.length === 0) {
    if (!account) return notFound(cfg);
    userId = account.user_id;
  } else {
    userId = page.items[0].user_id;
  }
  const profilePictureDrawingId = account?.profile_picture_drawing_id ?? null;
  const next = buildFragmentUrl(`/u/${username}/items`, page.next_cursor);
  const items = page.items.map(itemFromRow);
  const stats = cfg.userStatsStore
    ? await ownerStatsView(cfg.userStatsStore, userId)
    : undefined;
  // Wrap renderOwner with a tiny shim: it doesn't know about
  // next_fragment_url today. For Phase 3a we render just the first page
  // — the infinite-scroll behaviour for profiles is plumbed via the
  // same fragment-script pattern as the gallery, injected below if a
  // next page exists.
  let body = renderOwner({
    username,
    user_id: userId,
    drawings: items,
    stats,
    profile_picture_drawing_id: profilePictureDrawingId,
    follower_count: account?.follower_count,
    following_count: account?.following_count,
    bio: account?.bio ?? null,
    link: account?.link ?? null,
    repo_url: cfg.repoUrl,
  });
  if (next) body = injectProfileSentinel(body, next);
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_PROFILE,
    body,
  };
}

// -- /u/<username>/streak ----------------------------------------------------

// Page size for the GSI2 scan. The streak page needs the full per-user
// history (so it can frame "first publish to today" as a month grid), so
// we paginate until the cursor runs out. Caching at the edge
// (`CC_PROFILE`, 24h s-maxage) absorbs the repeated reads.
const STREAK_SCAN_PAGE_SIZE = 200;

export async function renderStreakPageHandler(
  cfg: RenderHandlersConfig,
  username: string,
): Promise<RenderResponse> {
  if (!USERNAME_RE.test(username)) return notFound(cfg);
  const account =
    cfg.userStore && username !== "anonymous"
      ? await cfg.userStore.getByUsername(username)
      : null;

  // Newest-first sweep through every drawing the user has published.
  // Unconditional set on a per-day key means the LAST write for that day
  // wins, which — because we're moving newest→oldest — is the chronologically
  // earliest drawing of that day. That's the "first drawing of the day"
  // semantic the visualization wants.
  const byDay = new Map<string, DrawingRow>();
  let userId: string | null = account?.user_id ?? null;
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  let cursor: DrawingCursor | undefined;
  for (;;) {
    const page = await cfg.drawingStore.queryByUsername(username, {
      limit: STREAK_SCAN_PAGE_SIZE,
      cursor,
    });
    for (const row of page.items) {
      if (!userId) userId = row.user_id;
      if (lastMs === null) lastMs = row.created_at_ms;
      firstMs = row.created_at_ms;
      const dayKey = row.created_at.slice(0, 10);
      byDay.set(dayKey, row);
    }
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }

  if (byDay.size === 0) {
    if (!account) return notFound(cfg);
    return {
      status: 200,
      contentType: "text/html; charset=utf-8",
      cacheControl: CC_PROFILE,
      body: renderStreak({
        username,
        profile_picture_drawing_id: account.profile_picture_drawing_id ?? null,
        daily_streak_current: 0,
        daily_streak_longest: 0,
        total_days_drawn: 0,
        months: [],
        repo_url: cfg.repoUrl,
      }),
    };
  }

  const stats =
    cfg.userStatsStore && userId
      ? await ownerStatsView(cfg.userStatsStore, userId)
      : undefined;
  const today = cfg.now ? cfg.now() : new Date();
  const todayKey = isoDayUtc(today);
  const firstKey = isoDayUtc(new Date(firstMs!));
  const months = buildMonthBlocks(firstKey, todayKey, byDay);
  const view: StreakView = {
    username,
    profile_picture_drawing_id: account?.profile_picture_drawing_id ?? null,
    daily_streak_current: stats?.daily_streak_current ?? 0,
    daily_streak_longest: stats?.daily_streak_longest ?? 0,
    total_days_drawn: byDay.size,
    months,
    repo_url: cfg.repoUrl,
  };
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_PROFILE,
    body: renderStreak(view),
  };
}

const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function isoDayUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function buildMonthBlocks(
  firstKey: string,
  todayKey: string,
  byDay: Map<string, DrawingRow>,
): MonthBlock[] {
  const [firstY, firstM] = parseYearMonth(firstKey);
  const [todayY, todayM] = parseYearMonth(todayKey);
  const months: MonthBlock[] = [];
  // Walk from (todayY, todayM) backward to (firstY, firstM) inclusive,
  // newest first.
  let y = todayY;
  let m = todayM;
  while (y > firstY || (y === firstY && m >= firstM)) {
    months.push(buildMonthBlock(y, m, byDay));
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return months;
}

function buildMonthBlock(
  year: number,
  month: number,
  byDay: Map<string, DrawingRow>,
): MonthBlock {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // Date.UTC month is 0-based; for day 1 of `month` (1-based) that's month-1.
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  // ISO Monday-first padding: shift Sunday (0) to the end of the row.
  const leadingPad = (firstWeekday + 6) % 7;
  const cells: DayCell[] = [];
  // Leading pad cells: not real days, just blank squares to push day 1
  // to the right weekday column. Only these stay out-of-range so the
  // grid still aligns.
  for (let i = 0; i < leadingPad; i += 1) {
    cells.push({ date: "", day: 0, kind: "out-of-range" });
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const row = byDay.get(dateKey);
    const cell: DayCell = {
      date: dateKey,
      day,
      kind: row ? "thumb" : "empty",
    };
    if (row) cell.drawing_id = row.drawing_id;
    cells.push(cell);
  }
  return {
    year,
    month,
    label: `${MONTH_LABELS[month - 1]} ${year}`,
    cells,
  };
}

function parseYearMonth(isoDay: string): [number, number] {
  const y = Number.parseInt(isoDay.slice(0, 4), 10);
  const m = Number.parseInt(isoDay.slice(5, 7), 10);
  return [y, m];
}

// -- /u/<username>/bookmarks (owner-only via client-side auth) ---------------

// The page itself is an empty shell — no per-user data ever lands in the
// SSR'd HTML, so the response is identical for every caller (signed in or
// not, regardless of whose URL they're hitting). An inline script then:
//   1. Reads the JWT from localStorage; redirects to /login if missing.
//   2. Compares the JWT's `un` claim to the URL's username; redirects to
//      the caller's own /u/<un>/bookmarks if they mismatch.
//   3. Fetches /me/bookmarks/feed (Bearer JWT, no-store) and swaps the
//      empty list for the rendered cards.
//
// This shape exists because browser navigations don't carry the
// Authorization header — the page can't be SSR-gated against the JWT.
// Going through the shell + fetch dance keeps the data path behind a
// Bearer-auth'd endpoint while letting the canonical /u/<un>/bookmarks
// URL still resolve from the address bar.
export async function renderBookmarksPageHandler(
  cfg: RenderHandlersConfig,
  username: string,
): Promise<RenderResponse> {
  if (!USERNAME_RE.test(username)) return notFound(cfg);
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    // No data on the page, but mark it uncacheable so future
    // personalisation never leaks across viewers via the edge.
    cacheControl: "private, no-store",
    body: renderBookmarksPage({
      username,
      items: [],
      repo_url: cfg.repoUrl,
    }),
  };
}

// HTML fragment of the caller's bookmarks, newest-first. Auth-gated; the
// route is responsible for verifying the JWT and passing `auth` here.
export async function renderMyBookmarksFeedHandler(
  cfg: RenderHandlersConfig,
  auth: { user_id: string; username: string },
): Promise<RenderResponse> {
  if (!cfg.bookmarksStore) {
    return {
      status: 200,
      contentType: "text/html; charset=utf-8",
      cacheControl: "private, no-store",
      body: "",
    };
  }
  const perPage = cfg.perPage ?? PER_PAGE;
  const page = await cfg.bookmarksStore.listByUser(auth.user_id, {
    limit: perPage,
  });
  const rows = await Promise.all(
    page.items.map((b) => cfg.drawingStore.get(b.drawing_id)),
  );
  const present = rows.filter((r): r is DrawingRow => r !== null);
  const items = await loadFeedItems(cfg, present);
  // Empty list → empty body. The inline script on the bookmarks page
  // renders an empty-state message in that case.
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: "private, no-store",
    body: items.map(renderFeedCard).join("\n"),
  };
}

export async function renderProfileItemsHandler(
  cfg: RenderHandlersConfig,
  username: string,
  rawCursor: string | null,
): Promise<RenderResponse> {
  if (!USERNAME_RE.test(username)) return notFound(cfg);
  const perPage = cfg.perPage ?? PER_PAGE;
  const cursor = decodeCursor(rawCursor) ?? undefined;
  const page = await cfg.drawingStore.queryByUsername(username, { limit: perPage, cursor });
  const next = buildFragmentUrl(`/u/${username}/items`, page.next_cursor);
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_PROFILE,
    body: renderGalleryFragment(page.items.map(itemFromRow), next),
  };
}

// -- /u/<username>/followers + /u/<username>/following ----------------------

// CC_FOLLOW_LIST: short edge cache so the list reflects new follows
// within minutes (the follower/followee sees their own change instantly
// via optimistic JS; other viewers depend on the next miss).

async function renderFollowListPage(
  cfg: RenderHandlersConfig,
  ownerUsername: string,
  kind: FollowListKind,
  rawCursor: string | null,
): Promise<RenderResponse> {
  if (!USERNAME_RE.test(ownerUsername)) return notFound(cfg);
  if (!cfg.followsStore || !cfg.userStore) return notFound(cfg);
  const owner = await cfg.userStore.getByUsername(ownerUsername);
  if (!owner) return notFound(cfg);
  const cursor = decodeFollowCursor(rawCursor) ?? undefined;
  const perPage = cfg.perPage ?? PER_PAGE;
  const page =
    kind === "followers"
      ? await cfg.followsStore.listFollowers(owner.user_id, { limit: perPage, cursor })
      : await cfg.followsStore.listFollowing(owner.user_id, { limit: perPage, cursor });
  const items = await hydrateFollowListProfilePictures(cfg, page.items.map((e) => followListItem(e, kind)));
  const next = page.next_cursor
    ? `/u/${ownerUsername}/${kind}/items?cursor=${encodeFollowCursor(page.next_cursor)}`
    : null;
  const view = {
    owner_username: ownerUsername,
    kind,
    items,
    repo_url: cfg.repoUrl,
    ...(next ? { next_fragment_url: next } : {}),
  };
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_FOLLOW_LIST,
    body: renderFollowList(view),
  };
}

async function renderFollowListItems(
  cfg: RenderHandlersConfig,
  ownerUsername: string,
  kind: FollowListKind,
  rawCursor: string | null,
): Promise<RenderResponse> {
  if (!USERNAME_RE.test(ownerUsername)) return notFound(cfg);
  if (!cfg.followsStore || !cfg.userStore) return notFound(cfg);
  const owner = await cfg.userStore.getByUsername(ownerUsername);
  if (!owner) return notFound(cfg);
  const cursor = decodeFollowCursor(rawCursor) ?? undefined;
  const perPage = cfg.perPage ?? PER_PAGE;
  const page =
    kind === "followers"
      ? await cfg.followsStore.listFollowers(owner.user_id, { limit: perPage, cursor })
      : await cfg.followsStore.listFollowing(owner.user_id, { limit: perPage, cursor });
  const items = await hydrateFollowListProfilePictures(cfg, page.items.map((e) => followListItem(e, kind)));
  const next = page.next_cursor
    ? `/u/${ownerUsername}/${kind}/items?cursor=${encodeFollowCursor(page.next_cursor)}`
    : null;
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_FOLLOW_LIST,
    body: renderFollowListFragment(items, next),
  };
}

// Batch the per-item profile-picture lookups: GetItem userStore once per
// unique username, attach profile_picture_drawing_id to the matching items.
// Same shape as loadFeedItems' picture batching on the home feed.
async function hydrateFollowListProfilePictures(
  cfg: RenderHandlersConfig,
  items: FollowListItem[],
): Promise<FollowListItem[]> {
  if (!cfg.userStore || items.length === 0) return items;
  const usernames = new Set<string>();
  for (const it of items) usernames.add(it.username);
  const pictures = new Map<string, string | null>();
  await Promise.all(
    [...usernames].map(async (un) => {
      const acct = await cfg.userStore!.getByUsername(un);
      pictures.set(un, acct?.profile_picture_drawing_id ?? null);
    }),
  );
  return items.map((it) => ({
    ...it,
    profile_picture_drawing_id: pictures.get(it.username) ?? null,
  }));
}

function followListItem(e: FollowEdge, kind: FollowListKind): FollowListItem {
  return kind === "followers"
    ? { username: e.follower_username, user_id: e.follower_user_id }
    : { username: e.followee_username, user_id: e.followee_user_id };
}

export function renderFollowersPageHandler(
  cfg: RenderHandlersConfig,
  ownerUsername: string,
  rawCursor: string | null = null,
): Promise<RenderResponse> {
  return renderFollowListPage(cfg, ownerUsername, "followers", rawCursor);
}

export function renderFollowingPageHandler(
  cfg: RenderHandlersConfig,
  ownerUsername: string,
  rawCursor: string | null = null,
): Promise<RenderResponse> {
  return renderFollowListPage(cfg, ownerUsername, "following", rawCursor);
}

export function renderFollowersItemsHandler(
  cfg: RenderHandlersConfig,
  ownerUsername: string,
  rawCursor: string | null,
): Promise<RenderResponse> {
  return renderFollowListItems(cfg, ownerUsername, "followers", rawCursor);
}

export function renderFollowingItemsHandler(
  cfg: RenderHandlersConfig,
  ownerUsername: string,
  rawCursor: string | null,
): Promise<RenderResponse> {
  return renderFollowListItems(cfg, ownerUsername, "following", rawCursor);
}

// JSON endpoint that returns the first N usernames in each direction
// for a given user — feeds the left-rail follower/following thumb
// grids on every page (chrome-identity.js fetches it once on init
// for the signed-in viewer). Public read; viewer auth is unnecessary
// because the follow graph is already public via /u/<un>/followers.

export async function renderFollowThumbsHandler(
  cfg: RenderHandlersConfig,
  ownerUsername: string,
  rawLimit: string | null,
): Promise<RenderResponse> {
  if (!USERNAME_RE.test(ownerUsername)) return notFound(cfg);
  if (!cfg.followsStore || !cfg.userStore) return notFound(cfg);
  const owner = await cfg.userStore.getByUsername(ownerUsername);
  if (!owner) return notFound(cfg);
  const limit = Math.min(20, Math.max(1, parseInt(rawLimit ?? "6", 10) || 6));
  const [followers, following] = await Promise.all([
    cfg.followsStore.listFollowers(owner.user_id, { limit }),
    cfg.followsStore.listFollowing(owner.user_id, { limit }),
  ]);
  const body = JSON.stringify({
    followers: followers.items.map((e) => e.follower_username),
    following: following.items.map((e) => e.followee_username),
  });
  return {
    status: 200,
    contentType: "application/json; charset=utf-8",
    cacheControl: CC_FOLLOW_THUMBS,
    body,
  };
}

async function ownerStatsView(
  store: UserStatsStore,
  user_id: string,
): Promise<OwnerStats> {
  const row = await store.get(user_id);
  const totals = { daily_total: row?.daily_total ?? 0 };
  const badges = earnedBadges(totals);
  return {
    daily_total: totals.daily_total,
    daily_streak_current: row?.daily_streak_current ?? 0,
    daily_streak_longest: row?.daily_streak_longest ?? 0,
    daily_badges: badges.daily,
  };
}

// Splices the gallery's infinite-scroll sentinel into the profile page
// just before </main>. The owner template renders into a
// `<ul class="img-grid">` already; tagging it with data-gallery-items
// gives the shared /infinite-scroll.js script a list target to find.
function injectProfileSentinel(html: string, nextUrl: string): string {
  const sentinel = renderGallerySentinel(nextUrl);
  return html
    .replace(`<ul class="img-grid">`, `<ul class="img-grid" data-gallery-items>`)
    .replace(
      `    </main>`,
      `      ${sentinel}
    </main>
    <script src="${assetUrl("/infinite-scroll.js")}"></script>`,
    );
}

// -- /products + /products/p/<N> --------------------------------------------

export async function renderProductsPageHandler(
  cfg: RenderHandlersConfig,
  rawPage: string | null,
): Promise<RenderResponse> {
  if (!cfg.productCountersSource || !cfg.merchCatalog) return notFound(cfg);
  const perPage = cfg.perPage ?? PER_PAGE;
  const page = rawPage ? Math.max(1, Number.parseInt(rawPage, 10)) : 1;
  if (!Number.isFinite(page) || page < 1) return notFound(cfg);

  const counters = await cfg.productCountersSource.listAll();
  const now = cfg.now ? cfg.now() : new Date();
  const cards = productCardsFromCounters(counters, cfg.merchCatalog, now);
  const totalPages = Math.max(1, Math.ceil(cards.length / perPage));
  if (page > totalPages) return notFound(cfg);
  const slice = cards.slice((page - 1) * perPage, page * perPage);
  const body = renderProducts({
    page,
    total_pages: totalPages,
    cards: slice,
    prev_page: page > 1 ? { prev_page: page - 1 } : null,
    next_page: page < totalPages ? { next_page: page + 1 } : null,
    repo_url: cfg.repoUrl,
  });
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_PRODUCTS,
    body,
  };
}

// -- /prompts + /prompts/<slug> + /prompts/<slug>/items -----------------------

const MS_PER_DAY = 86_400_000;

function etDayToUtcMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

// Archive entries, newest first, built purely from config — every ET day
// from the prompts epoch through today inclusive. Days after today must
// never appear (no future-prompt leaks); before launch (today < epoch)
// the list degrades to just today's prompt so the page is never empty.
function buildPromptArchiveEntries(now: Date): PromptArchiveEntry[] {
  const today = etDateString(now);
  // ISO date strings compare correctly as plain strings.
  const first = today < PROMPTS_EPOCH_ET ? today : PROMPTS_EPOCH_ET;
  const entries: PromptArchiveEntry[] = [];
  for (let ms = etDayToUtcMs(today); ms >= etDayToUtcMs(first); ms -= MS_PER_DAY) {
    const date = new Date(ms).toISOString().slice(0, 10);
    entries.push({
      date,
      // Noon UTC is always the same calendar day in ET (UTC-4/-5), so
      // this resolves the prompt for `date` — OVERRIDES included.
      prompt: promptForDate(new Date(ms + MS_PER_DAY / 2)),
      is_today: date === today,
    });
  }
  return entries;
}

export async function renderPromptsArchiveHandler(
  cfg: RenderHandlersConfig,
): Promise<RenderResponse> {
  const entries = buildPromptArchiveEntries(cfg.now ? cfg.now() : new Date());
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_GALLERY,
    body: renderPromptArchive({
      entries,
      public_base_url: cfg.publicBaseUrl,
      repo_url: cfg.repoUrl,
    }),
  };
}

export async function renderPromptPageHandler(
  cfg: RenderHandlersConfig,
  slug: string,
): Promise<RenderResponse> {
  if (!PROMPT_SLUG_RE.test(slug)) return notFound(cfg);
  const prompt = promptBySlug(slug);
  if (!prompt) return notFound(cfg);
  const perPage = cfg.perPage ?? PER_PAGE;
  const page = await cfg.drawingStore.queryByPrompt(slug, { limit: perPage });
  const next = buildFragmentUrl(`/prompts/${slug}/items`, page.next_cursor);
  const view: PromptPageView = {
    prompt,
    is_today: promptForDate(cfg.now ? cfg.now() : new Date()).slug === slug,
    items: page.items.map(itemFromRow),
    top_drawing_id: page.items[0]?.drawing_id ?? null,
    public_base_url: cfg.publicBaseUrl,
    repo_url: cfg.repoUrl,
  };
  if (next) view.next_fragment_url = next;
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_GALLERY,
    body: renderPromptPage(view),
  };
}

export async function renderPromptItemsHandler(
  cfg: RenderHandlersConfig,
  slug: string,
  rawCursor: string | null,
): Promise<RenderResponse> {
  if (!PROMPT_SLUG_RE.test(slug) || !promptBySlug(slug)) return notFound(cfg);
  const perPage = cfg.perPage ?? PER_PAGE;
  const cursor = decodeCursor(rawCursor) ?? undefined;
  const page = await cfg.drawingStore.queryByPrompt(slug, { limit: perPage, cursor });
  const next = buildFragmentUrl(`/prompts/${slug}/items`, page.next_cursor);
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_GALLERY,
    body: renderGalleryFragment(page.items.map(itemFromRow), next),
  };
}

// -- /design -----------------------------------------------------------------

export async function renderDesignPageHandler(
  cfg: RenderHandlersConfig,
): Promise<RenderResponse> {
  const body = renderDesign({ repo_url: cfg.repoUrl });
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_DESIGN,
    body,
  };
}

// -- /feed.rss ---------------------------------------------------------------

export async function renderFeedHandler(
  cfg: RenderHandlersConfig,
): Promise<RenderResponse> {
  const page = await cfg.drawingStore.queryGallery({ limit: 100 });
  const body = renderFeed({
    base_url: cfg.publicBaseUrl,
    build_date: new Date().toUTCString(),
    drawings: page.items.map((r) => ({
      id: r.drawing_id,
      id_short: r.drawing_id.slice(0, 8),
      pub_date: new Date(r.created_at_ms).toUTCString(),
      href: `/d/${r.drawing_id}`,
      thumb: `/tiles/${r.drawing_id}.gif`,
    })),
  });
  return {
    status: 200,
    contentType: "application/rss+xml; charset=utf-8",
    cacheControl: CC_FEED,
    body,
  };
}
