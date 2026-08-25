import { CC_FEED } from "../../config/constants.js";
import renderFeed from "../../lib/templates/feed.js";
import type { RenderHandlersConfig, RenderResponse } from "./shared.js";

export async function renderFeedHandler(cfg: RenderHandlersConfig): Promise<RenderResponse> {
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
