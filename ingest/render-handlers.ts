import { PER_PAGE } from "../config/constants.js";
import renderGallery, {
  renderGalleryFragment,
  type GalleryItem,
  type GalleryView,
} from "../lib/templates/gallery.js";
import renderTilePage from "../lib/templates/tile-page.js";
import renderFeed from "../lib/templates/feed.js";
import renderOwner from "../lib/templates/owner.js";
import renderNotFound from "../lib/templates/not-found.js";
import renderProducts from "../lib/templates/products.js";
import { productCardsFromCounters } from "../lib/products-cards.js";
import {
  decodeCursor,
  encodeCursor,
  type DrawingCursor,
  type DrawingRow,
  type DrawingStore,
} from "./drawing-store.js";
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
  // Test seam for the recency label on product cards. Defaults to wall-clock.
  now?: () => Date;
}

export interface RenderResponse {
  status: 200 | 404;
  contentType: string;
  cacheControl: string;
  body: string;
}

// Cache headers. CloudFront's `s-maxage` controls edge cache; the per-row
// `max-age` controls browser cache. Drawings are immutable (the ID is
// content-addressed) so they get the long cache; gallery + profile are
// mutable, so they ride a short edge cache + stale-while-revalidate that
// the publish path invalidates on write.
const CC_GALLERY = "public, s-maxage=86400, stale-while-revalidate=60";
// Drawing pages were immutable when the gif was the only content, but the
// author's avatar can change underneath us — drop to a day so avatar edits
// propagate within 24h without forcing a per-avatar CF invalidation across
// every /d/<id> the user has published.
const CC_DRAWING_PAGE = "public, max-age=300, s-maxage=86400, stale-while-revalidate=60";
const CC_PROFILE = "public, s-maxage=86400, stale-while-revalidate=60";
const CC_FEED = "public, s-maxage=3600";
const CC_NOT_FOUND = "public, max-age=60";

function itemFromRow(r: DrawingRow): GalleryItem {
  return {
    id: r.drawing_id,
    id_short: r.drawing_id.slice(0, 8),
    href: `/d/${r.drawing_id}`,
    thumb: `/drawings/${r.drawing_id}.gif`,
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

export async function renderDrawingPageHandler(
  cfg: RenderHandlersConfig,
  drawing_id: string,
): Promise<RenderResponse> {
  if (!/^[0-9a-f]{64}$/.test(drawing_id)) return notFound(cfg);
  const row = await cfg.drawingStore.get(drawing_id);
  if (!row) return notFound(cfg);

  // Forks: cap to the same per-page count; the page only renders the
  // first slice and accepts that "Forks · N" can lag if a drawing has
  // gone viral. A "see all forks" follow-up could add a fragment endpoint
  // similar to the gallery's.
  const forks = await cfg.drawingStore.queryForks(drawing_id, {
    limit: cfg.perPage ?? PER_PAGE,
  });
  // Author avatar: optional lookup so legacy "anonymous" / unregistered
  // usernames just render without an avatar.
  const authorAccount = cfg.userStore
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
      avatar_drawing_id: authorAccount?.avatar_drawing_id ?? null,
    },
    forks: forks.items.map(itemFromRow),
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

const USERNAME_RE = /^[a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_]$/;

export async function renderProfilePageHandler(
  cfg: RenderHandlersConfig,
  username: string,
): Promise<RenderResponse> {
  if (!USERNAME_RE.test(username)) return notFound(cfg);
  const perPage = cfg.perPage ?? PER_PAGE;
  const page = await cfg.drawingStore.queryByUsername(username, { limit: perPage });
  // user_id from the first drawing (denormalized in every row). Brand-new
  // accounts with no drawings yet render a 404 here in v1 — the static
  // builder used to backfill an empty profile from the users-table scan,
  // but rebuilding that with a per-pageload account lookup wastes a DDB
  // read on every miss. Revisit if it actually matters in practice.
  // Account exists but no published drawings yet: render an empty profile
  // instead of 404. Skips the lookup entirely when there are drawings (the
  // user_id is already denormalized on the first row).
  let userId: string;
  let avatarDrawingId: string | null = null;
  if (page.items.length === 0) {
    if (!cfg.userStore) return notFound(cfg);
    const account = await cfg.userStore.getByUsername(username);
    if (!account) return notFound(cfg);
    userId = account.user_id;
    avatarDrawingId = account.avatar_drawing_id ?? null;
  } else {
    userId = page.items[0].user_id;
    // Lookup the avatar separately when there are drawings (the avatar
    // isn't denormalized on the DrawingRow). Skipped when no userStore
    // is wired (dev/tests).
    if (cfg.userStore) {
      const account = await cfg.userStore.getByUsername(username);
      avatarDrawingId = account?.avatar_drawing_id ?? null;
    }
  }
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
    avatar_drawing_id: avatarDrawingId,
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

// Splices the gallery's infinite-scroll sentinel + observer script into the
// profile page just before </main>. The owner template renders into a
// `<ul class="img-grid">` already; the gallery sentinel + observer
// observe `[data-gallery-items]` and `[data-gallery-sentinel]`, so we
// tag the ul + append the sentinel.
function injectProfileSentinel(html: string, nextUrl: string): string {
  return html
    .replace(`<ul class="img-grid">`, `<ul class="img-grid" data-gallery-items>`)
    .replace(
      `    </main>`,
      `      <div class="gal-sentinel" data-gallery-sentinel data-next="${nextUrl}"></div>
      <script>
(function () {
  function wire(sentinel) {
    if (!sentinel || sentinel.dataset.wired) return;
    sentinel.dataset.wired = "1";
    var next = sentinel.dataset.next;
    if (!next) return;
    var io = new IntersectionObserver(async function (entries) {
      if (!entries.some(function (e) { return e.isIntersecting; })) return;
      io.disconnect();
      try {
        var res = await fetch(next);
        if (!res.ok) return;
        var html = await res.text();
        var list = document.querySelector("[data-gallery-items]");
        if (list) list.insertAdjacentHTML("beforeend", html);
        sentinel.remove();
        var nextSentinel = document.querySelector("[data-gallery-sentinel]:not([data-wired])");
        if (nextSentinel) wire(nextSentinel);
      } catch (e) {}
    }, { rootMargin: "200px" });
    io.observe(sentinel);
  }
  document.querySelectorAll("[data-gallery-sentinel]").forEach(wire);
})();
      </script>
    </main>`,
    );
}

// -- /products + /products/p/<N> --------------------------------------------

const CC_PRODUCTS = "public, s-maxage=86400, stale-while-revalidate=60";

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
      thumb: `/drawings/${r.drawing_id}.gif`,
    })),
  });
  return {
    status: 200,
    contentType: "application/rss+xml; charset=utf-8",
    cacheControl: CC_FEED,
    body,
  };
}
