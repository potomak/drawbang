import { CC_FOLLOW_LIST, CC_FOLLOW_THUMBS, PER_PAGE } from "../../config/constants.js";
import renderFollowList, {
  renderFollowListFragment,
  type FollowListItem,
  type FollowListKind,
} from "../../lib/templates/follow-list.js";
import type { RenderHandlersConfig, RenderResponse } from "./shared.js";
import { isProfileRoutable, notFound } from "./shared.js";
import { decodeFollowCursor, encodeFollowCursor, type FollowEdge } from "../follows-store.js";

async function renderFollowListPage(
  cfg: RenderHandlersConfig,
  ownerUsername: string,
  kind: FollowListKind,
  rawCursor: string | null
): Promise<RenderResponse> {
  if (!isProfileRoutable(ownerUsername)) return notFound(cfg);
  if (!cfg.followsStore || !cfg.userStore) return notFound(cfg);
  const owner = await cfg.userStore.getByUsername(ownerUsername);
  if (!owner) return notFound(cfg);
  const cursor = decodeFollowCursor(rawCursor) ?? undefined;
  const perPage = cfg.perPage ?? PER_PAGE;
  const page =
    kind === "followers"
      ? await cfg.followsStore.listFollowers(owner.user_id, { limit: perPage, cursor })
      : await cfg.followsStore.listFollowing(owner.user_id, { limit: perPage, cursor });
  const items = await hydrateFollowListProfilePictures(
    cfg,
    page.items.map((e) => followListItem(e, kind))
  );
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
  rawCursor: string | null
): Promise<RenderResponse> {
  if (!isProfileRoutable(ownerUsername)) return notFound(cfg);
  if (!cfg.followsStore || !cfg.userStore) return notFound(cfg);
  const owner = await cfg.userStore.getByUsername(ownerUsername);
  if (!owner) return notFound(cfg);
  const cursor = decodeFollowCursor(rawCursor) ?? undefined;
  const perPage = cfg.perPage ?? PER_PAGE;
  const page =
    kind === "followers"
      ? await cfg.followsStore.listFollowers(owner.user_id, { limit: perPage, cursor })
      : await cfg.followsStore.listFollowing(owner.user_id, { limit: perPage, cursor });
  const items = await hydrateFollowListProfilePictures(
    cfg,
    page.items.map((e) => followListItem(e, kind))
  );
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

async function hydrateFollowListProfilePictures(
  cfg: RenderHandlersConfig,
  items: FollowListItem[]
): Promise<FollowListItem[]> {
  if (!cfg.userStore || items.length === 0) return items;
  const usernames = new Set<string>();
  for (const it of items) usernames.add(it.username);
  const pictures = new Map<string, string | null>();
  await Promise.all(
    [...usernames].map(async (un) => {
      const acct = await cfg.userStore!.getByUsername(un);
      pictures.set(un, acct?.profile_picture_drawing_id ?? null);
    })
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
  rawCursor: string | null = null
): Promise<RenderResponse> {
  return renderFollowListPage(cfg, ownerUsername, "followers", rawCursor);
}

export function renderFollowingPageHandler(
  cfg: RenderHandlersConfig,
  ownerUsername: string,
  rawCursor: string | null = null
): Promise<RenderResponse> {
  return renderFollowListPage(cfg, ownerUsername, "following", rawCursor);
}

export function renderFollowersItemsHandler(
  cfg: RenderHandlersConfig,
  ownerUsername: string,
  rawCursor: string | null
): Promise<RenderResponse> {
  return renderFollowListItems(cfg, ownerUsername, "followers", rawCursor);
}

export function renderFollowingItemsHandler(
  cfg: RenderHandlersConfig,
  ownerUsername: string,
  rawCursor: string | null
): Promise<RenderResponse> {
  return renderFollowListItems(cfg, ownerUsername, "following", rawCursor);
}

export async function renderFollowThumbsHandler(
  cfg: RenderHandlersConfig,
  ownerUsername: string,
  rawLimit: string | null
): Promise<RenderResponse> {
  if (!isProfileRoutable(ownerUsername)) return notFound(cfg);
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
