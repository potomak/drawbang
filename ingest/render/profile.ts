import { CC_PROFILE, PER_PAGE } from "../../config/constants.js";
import { isAnonymousUsername } from "../../config/constants.js";
import renderOwner from "../../lib/templates/owner.js";
import type { RenderHandlersConfig, RenderResponse } from "./shared.js";
import {
  buildFragmentUrl,
  injectProfileSentinel,
  isProfileRoutable,
  itemFromRow,
  notFound,
  ownerStatsView,
} from "./shared.js";
import { decodeCursor } from "../drawing-store.js";
import { renderGalleryFragment } from "../../lib/templates/gallery.js";

export async function renderProfilePageHandler(
  cfg: RenderHandlersConfig,
  username: string
): Promise<RenderResponse> {
  if (!isProfileRoutable(username)) return notFound(cfg);
  const perPage = cfg.perPage ?? PER_PAGE;
  const page = await cfg.drawingStore.queryByUsername(username, { limit: perPage });
  const account =
    cfg.userStore && !isAnonymousUsername(username)
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
  const stats = cfg.userStatsStore ? await ownerStatsView(cfg.userStatsStore, userId) : undefined;
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

export async function renderProfileItemsHandler(
  cfg: RenderHandlersConfig,
  username: string,
  rawCursor: string | null
): Promise<RenderResponse> {
  if (!isProfileRoutable(username)) return notFound(cfg);
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
