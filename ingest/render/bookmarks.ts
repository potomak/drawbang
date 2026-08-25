import { PER_PAGE } from "../../config/constants.js";
import renderBookmarksPage from "../../lib/templates/bookmarks.js";
import { renderFeedCard } from "../../lib/templates/home.js";
import type { RenderHandlersConfig, RenderResponse } from "./shared.js";
import { isProfileRoutable, loadFeedItems, notFound } from "./shared.js";
import type { DrawingRow } from "../drawing-store.js";

export async function renderBookmarksPageHandler(
  cfg: RenderHandlersConfig,
  username: string
): Promise<RenderResponse> {
  if (!isProfileRoutable(username)) return notFound(cfg);
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: "private, no-store",
    body: renderBookmarksPage({
      username,
      items: [],
      repo_url: cfg.repoUrl,
    }),
  };
}

export async function renderMyBookmarksFeedHandler(
  cfg: RenderHandlersConfig,
  auth: { user_id: string; username: string }
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
  const rows = await Promise.all(page.items.map((b) => cfg.drawingStore.get(b.drawing_id)));
  const present = rows.filter((r): r is DrawingRow => r !== null);
  const items = await loadFeedItems(cfg, present);
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: "private, no-store",
    body: items.map(renderFeedCard).join("\n"),
  };
}
