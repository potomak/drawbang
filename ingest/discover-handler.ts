// Discover-rail data loader. Returns the top-5 "Most Liked · 30D"
// drawings and the top-5 "Trending Artists" — both derived from the
// last ~200 rows in the gallery store. No new GSI or precompute
// table: queryGallery is already cheap (GSI1 chronological) and we
// fold to top-K in memory. Approximate by construction — a 31-day-old
// drawing with many likes won't appear — which is fine for the
// "discover" framing, and easy to upgrade to a precompute job later.

import type { DrawingStore } from "./drawing-store.js";
import type { UserStore } from "./user-store.js";

export interface DiscoverDrawing {
  drawing_id: string;
  thumb_url: string;
  drawing_url: string;
  author_username: string | null;
  like_count: number;
}

export interface DiscoverArtist {
  username: string;
  profile_picture_drawing_id: string | null;
  drawing_count_30d: number;
}

export interface DiscoverData {
  most_liked_30d: DiscoverDrawing[];
  trending_artists: DiscoverArtist[];
}

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SCAN_LIMIT = 200;
const TOP_K = 5;

export interface LoadDiscoverConfig {
  drawingStore: DrawingStore;
  userStore?: UserStore;
  now?: () => Date;
}

export async function loadDiscover(
  cfg: LoadDiscoverConfig,
): Promise<DiscoverData> {
  const page = await cfg.drawingStore.queryGallery({ limit: SCAN_LIMIT });
  const nowMs = (cfg.now ? cfg.now() : new Date()).getTime();
  const cutoff = nowMs - WINDOW_MS;
  const recent = page.items.filter((r) => r.created_at_ms >= cutoff);

  const mostLiked: DiscoverDrawing[] = recent
    .filter((r) => (r.like_count ?? 0) > 0)
    .sort((a, b) => (b.like_count ?? 0) - (a.like_count ?? 0))
    .slice(0, TOP_K)
    .map((r) => ({
      drawing_id: r.drawing_id,
      thumb_url: `/tiles/${r.drawing_id}.gif`,
      drawing_url: `/d/${r.drawing_id}`,
      author_username: r.username === "anonymous" ? null : r.username,
      like_count: r.like_count ?? 0,
    }));

  // Trending artists: most prolific non-anonymous authors over the
  // recent window. Tied counts keep their queryGallery order
  // (newest-first), which is a reasonable tiebreak.
  const counts = new Map<string, number>();
  for (const r of recent) {
    if (r.username === "anonymous") continue;
    counts.set(r.username, (counts.get(r.username) ?? 0) + 1);
  }
  const topPairs = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_K);

  const pictures = new Map<string, string | null>();
  if (cfg.userStore && topPairs.length > 0) {
    await Promise.all(
      topPairs.map(async ([un]) => {
        const acct = await cfg.userStore!.getByUsername(un);
        pictures.set(un, acct?.profile_picture_drawing_id ?? null);
      }),
    );
  }

  const trendingArtists: DiscoverArtist[] = topPairs.map(([un, count]) => ({
    username: un,
    profile_picture_drawing_id: pictures.get(un) ?? null,
    drawing_count_30d: count,
  }));

  return { most_liked_30d: mostLiked, trending_artists: trendingArtists };
}
