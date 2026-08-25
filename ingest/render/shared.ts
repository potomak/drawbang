import {
  PER_PAGE,
  DRAWING_ID_RE,
  USERNAME_RE,
  isAnonymousUsername,
  CC_NOT_FOUND,
} from "../../config/constants.js";
import renderNotFound from "../../lib/templates/not-found.js";
import type { GalleryItem } from "../../lib/templates/gallery.js";
import type { FeedItem } from "../../lib/templates/home.js";
import { assetUrl } from "../../src/layout/asset-version.js";
import { renderGallerySentinel } from "../../lib/templates/gallery.js";
import { earnedBadges } from "../../config/badges.js";
import type { OwnerStats } from "../../lib/templates/owner.js";
import {
  encodeCursor,
  type DrawingCursor,
  type DrawingRow,
  type DrawingStore,
} from "../drawing-store.js";
import type { BookmarksStore } from "../bookmarks-store.js";
import type { FollowsStore } from "../follows-store.js";
import type { MerchCatalog } from "../../merch/lambda.js";
import type { ProductCounter } from "../../merch/product-counters.js";
import type { UserStatsStore } from "../user-stats-store.js";
import type { UserStore } from "../user-store.js";

export interface ProductCountersSource {
  listAll(): Promise<ProductCounter[]>;
}

export interface RenderHandlersConfig {
  drawingStore: DrawingStore;
  publicBaseUrl: string;
  repoUrl: string;
  perPage?: number;
  productCountersSource?: ProductCountersSource;
  merchCatalog?: MerchCatalog;
  userStatsStore?: UserStatsStore;
  userStore?: UserStore;
  bookmarksStore?: BookmarksStore;
  followsStore?: FollowsStore;
  now?: () => Date;
}

export interface RenderResponse {
  status: 200 | 404;
  contentType: string;
  cacheControl: string;
  body: string;
}

export function itemFromRow(r: DrawingRow): GalleryItem {
  return {
    id: r.drawing_id,
    id_short: r.drawing_id.slice(0, 8),
    href: `/d/${r.drawing_id}`,
    thumb: `/tiles/${r.drawing_id}.gif`,
    created_at: r.created_at,
  };
}

export function notFound(cfg: RenderHandlersConfig): RenderResponse {
  return {
    status: 404,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_NOT_FOUND,
    body: renderNotFound({ repo_url: cfg.repoUrl }),
  };
}

export function buildFragmentUrl(basePath: string, cursor: DrawingCursor | null): string | null {
  if (!cursor) return null;
  return `${basePath}?cursor=${encodeCursor(cursor)}`;
}

export function isProfileRoutable(username: string): boolean {
  return USERNAME_RE.test(username) && !isAnonymousUsername(username);
}

export async function loadFeedItems(
  cfg: RenderHandlersConfig,
  rows: DrawingRow[]
): Promise<FeedItem[]> {
  const usernames = new Set<string>();
  for (const r of rows) {
    if (!isAnonymousUsername(r.username)) usernames.add(r.username);
  }
  const pictures = new Map<string, string | null>();
  if (cfg.userStore && usernames.size > 0) {
    await Promise.all(
      [...usernames].map(async (un) => {
        const acct = await cfg.userStore!.getByUsername(un);
        pictures.set(un, acct?.profile_picture_drawing_id ?? null);
      })
    );
  }
  return rows.map((r) => ({
    id: r.drawing_id,
    id_short: r.drawing_id.slice(0, 8),
    href: `/d/${r.drawing_id}`,
    thumb: `/tiles/${r.drawing_id}.gif`,
    created_at: r.created_at,
    like_count: r.like_count ?? 0,
    author: isAnonymousUsername(r.username)
      ? null
      : {
          username: r.username,
          profile_picture_drawing_id: pictures.get(r.username) ?? null,
        },
  }));
}

export async function ownerStatsView(store: UserStatsStore, user_id: string): Promise<OwnerStats> {
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

export function injectProfileSentinel(html: string, nextUrl: string): string {
  const sentinel = renderGallerySentinel(nextUrl);
  return html.replace(`<ul class="img-grid">`, `<ul class="img-grid" data-gallery-items>`).replace(
    `    </main>`,
    `      ${sentinel}
    </main>
    <script src="${assetUrl("/infinite-scroll.js")}"></script>`
  );
}

// Re-export for convenience so domain modules can import from shared
export { PER_PAGE, DRAWING_ID_RE };
