import { CC_DESIGN } from "../../config/constants.js";
import renderViewportDebug from "../../lib/templates/design-v2-viewport-debug.js";
import type { RenderHandlersConfig, RenderResponse } from "./shared.js";

export interface ViewportDebugQuery {
  fix?: string | null;
}

export async function renderViewportDebugPageHandler(
  cfg: RenderHandlersConfig,
  query: ViewportDebugQuery
): Promise<RenderResponse> {
  // ?fix=0 reproduces the original overflow; ?fix=1 (default) shows the fix.
  // Default to fix=1 so the playground demonstrates the concise solution.
  const useFix = query.fix !== "0";
  const body = renderViewportDebug({ repo_url: cfg.repoUrl, useFix });
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_DESIGN,
    body,
  };
}
