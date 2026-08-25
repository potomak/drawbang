import { CC_DESIGN } from "../../config/constants.js";
import renderDesign from "../../lib/templates/design.js";
import type { RenderHandlersConfig, RenderResponse } from "./shared.js";

export async function renderDesignPageHandler(cfg: RenderHandlersConfig): Promise<RenderResponse> {
  const body = renderDesign({ repo_url: cfg.repoUrl });
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_DESIGN,
    body,
  };
}
