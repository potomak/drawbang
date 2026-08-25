import {
  CC_DRAWING_PAGE,
  CC_EMBED,
  CC_NOT_FOUND,
  DRAWING_ID_RE,
  isAnonymousUsername,
  PER_PAGE,
} from "../../config/constants.js";
import renderEmbed from "../../lib/templates/embed.js";
import renderTilePage from "../../lib/templates/tile-page.js";
import type { RenderHandlersConfig, RenderResponse } from "./shared.js";
import { itemFromRow, notFound } from "./shared.js";
import type { DrawingRow, DrawingStore } from "../drawing-store.js";

const ANCESTOR_CHAIN_CAP = 8;

async function loadAncestorChain(
  store: DrawingStore,
  row: DrawingRow
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

export async function renderEmbedPageHandler(
  cfg: RenderHandlersConfig,
  drawing_id: string
): Promise<RenderResponse> {
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
  drawing_id: string
): Promise<RenderResponse> {
  if (!DRAWING_ID_RE.test(drawing_id)) return notFound(cfg);
  const row = await cfg.drawingStore.get(drawing_id);
  if (!row) return notFound(cfg);

  const forks = await cfg.drawingStore.queryForks(drawing_id, {
    limit: cfg.perPage ?? PER_PAGE,
  });
  const ancestors = await loadAncestorChain(cfg.drawingStore, row);
  const isAnonymous = isAnonymousUsername(row.username);
  const authorAccount =
    cfg.userStore && !isAnonymous ? await cfg.userStore.getByUsername(row.username) : null;
  const body = renderTilePage({
    drawing_id: row.drawing_id,
    id_short: row.drawing_id.slice(0, 8),
    created_at: row.created_at,
    frames: row.frames,
    parent: row.parent_id
      ? { parent: row.parent_id, parent_short: row.parent_id.slice(0, 8) }
      : null,
    author: isAnonymous
      ? null
      : {
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
