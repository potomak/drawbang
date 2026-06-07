import type { LikesStore } from "./likes-store.js";
import type { BookmarksStore } from "./bookmarks-store.js";
import type { FollowsStore } from "./follows-store.js";
import type { UserStore } from "./user-store.js";
import { DRAWING_ID_RE, USERNAME_RE } from "../config/constants.js";

// GET /hydrate?drawings=<csv>&users=<csv>
//
// One endpoint, one round trip. The shape any Lambda-rendered page that
// shows user/drawing-level state hits on load to overlay fresh values on
// the edge-cached SSR markup.
//
// Public, no auth required. When the caller sends a valid Bearer JWT,
// the viewer_* fields populate; otherwise they're null. Same response
// shape either way so the client doesn't need branching.

const MAX_DRAWINGS = 100;
const MAX_USERS = 100;

export interface HydrateAuth {
  user_id: string;
  username: string;
}

export interface HydrateHandlerConfig {
  likesStore: LikesStore;
  bookmarksStore: BookmarksStore;
  followsStore: FollowsStore;
  userStore: UserStore;
}

export interface HydrateResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface DrawingHydration {
  like_count: number;
  viewer_liked: boolean | null;
  viewer_bookmarked: boolean | null;
}

export interface UserHydration {
  profile_picture_drawing_id: string | null;
  follower_count: number;
  following_count: number;
  viewer_follows: boolean | null;
}

export interface HydrateBody {
  drawings: Record<string, DrawingHydration>;
  users: Record<string, UserHydration>;
}

export async function handleHydrate(
  rawDrawings: string | null,
  rawUsers: string | null,
  auth: HydrateAuth | null,
  cfg: HydrateHandlerConfig,
): Promise<HydrateResult> {
  const drawing_ids = parseCsv(rawDrawings, DRAWING_ID_RE);
  if (drawing_ids === null) return err(400, "invalid drawings");
  if (drawing_ids.length > MAX_DRAWINGS) {
    return err(400, `too many drawings (max ${MAX_DRAWINGS})`);
  }
  const usernames = parseCsv(rawUsers, USERNAME_RE);
  if (usernames === null) return err(400, "invalid users");
  if (usernames.length > MAX_USERS) {
    return err(400, `too many users (max ${MAX_USERS})`);
  }

  // Fan out every store read in parallel. The auth-gated viewer_* calls
  // resolve to empty arrays when no session is present so the assembly
  // step below stays branchless.
  const [counts, liked, bookmarked, userRecords] = await Promise.all([
    drawing_ids.length > 0
      ? cfg.likesStore.listLikeCounts(drawing_ids)
      : Promise.resolve<Record<string, number>>({}),
    drawing_ids.length > 0 && auth
      ? cfg.likesStore.listLikedDrawingIds(auth.user_id, drawing_ids)
      : Promise.resolve<string[]>([]),
    drawing_ids.length > 0 && auth
      ? cfg.bookmarksStore.listBookmarkedDrawingIds(auth.user_id, drawing_ids)
      : Promise.resolve<string[]>([]),
    Promise.all(usernames.map((un) => cfg.userStore.getByUsername(un))),
  ]);

  // Follows hydration requires user_ids (the store is user_id-keyed), so
  // it depends on the userRecords resolving first. One more parallel
  // batch after the user lookups land.
  const target_user_ids: string[] = [];
  for (const rec of userRecords) {
    if (rec) target_user_ids.push(rec.user_id);
  }
  const followed = target_user_ids.length > 0 && auth
    ? await cfg.followsStore.listFollowed(auth.user_id, target_user_ids)
    : [];

  const likedSet = new Set(liked);
  const bookmarkedSet = new Set(bookmarked);
  const followedSet = new Set(followed);

  const drawings: Record<string, DrawingHydration> = {};
  for (const id of drawing_ids) {
    drawings[id] = {
      like_count: counts[id] ?? 0,
      viewer_liked: auth ? likedSet.has(id) : null,
      viewer_bookmarked: auth ? bookmarkedSet.has(id) : null,
    };
  }

  const users: Record<string, UserHydration> = {};
  for (let i = 0; i < usernames.length; i++) {
    const rec = userRecords[i];
    users[usernames[i]] = {
      profile_picture_drawing_id: rec?.profile_picture_drawing_id ?? null,
      follower_count: rec?.follower_count ?? 0,
      following_count: rec?.following_count ?? 0,
      viewer_follows: auth
        ? rec
          ? followedSet.has(rec.user_id)
          : false
        : null,
    };
  }

  const body: HydrateBody = { drawings, users };
  return {
    status: 200,
    body,
    headers: { "Cache-Control": "no-store" },
  };
}

function parseCsv(raw: string | null, re: RegExp): string[] | null {
  if (raw === null || raw === "") return [];
  const parts = raw.split(",");
  const out: string[] = [];
  for (const p of parts) {
    if (!re.test(p)) return null;
    out.push(p);
  }
  return out;
}

function err(status: number, message: string): HydrateResult {
  return { status, body: { error: message } };
}
