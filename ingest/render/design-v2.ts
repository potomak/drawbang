import { CC_DESIGN } from "../../config/constants.js";
import renderDesignV2 from "../../lib/templates/design-v2.js";
import type { RenderHandlersConfig, RenderResponse } from "./shared.js";

// Additive pilot for #1 — /v2/design uses React (renderToStaticMarkup)
// while /design stays on string templates. Lets agents compare the two
// side-by-side without breaking the existing route.
export async function renderDesignV2PageHandler(
  cfg: RenderHandlersConfig
): Promise<RenderResponse> {
  const body = renderDesignV2({ repo_url: cfg.repoUrl });
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_DESIGN,
    body,
  };
}
