import { CC_GALLERY } from "../../config/constants.js";
import renderGalleryLab from "../../lib/templates/gallery-lab.js";
import type { RenderHandlersConfig, RenderResponse } from "./shared.js";

export async function renderGalleryLabPageHandler(
  cfg: RenderHandlersConfig
): Promise<RenderResponse> {
  const body = renderGalleryLab({ repo_url: cfg.repoUrl });
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_GALLERY,
    body,
  };
}
