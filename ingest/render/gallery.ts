import { CC_GALLERY, PER_PAGE } from "../../config/constants.js";
import renderGallery, {
  renderGalleryFragment,
  type GalleryView,
} from "../../lib/templates/gallery.js";
import type { RenderHandlersConfig, RenderResponse } from "./shared.js";
import { buildFragmentUrl, itemFromRow } from "./shared.js";
import { decodeCursor } from "../drawing-store.js";

export async function renderGalleryPageHandler(
  cfg: RenderHandlersConfig,
  rawCursor: string | null
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
  rawCursor: string | null
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
