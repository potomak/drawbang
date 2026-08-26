import { CC_DESIGN } from "../../config/constants.js";
import renderViewportDebug from "../../lib/templates/design-v2-viewport-debug.js";
import type { RenderHandlersConfig, RenderResponse } from "./shared.js";

export interface ViewportDebugQuery {
  fix?: string | null;
  variant?: string | null;
}

export async function renderViewportDebugPageHandler(
  cfg: RenderHandlersConfig,
  query: ViewportDebugQuery
): Promise<RenderResponse> {
  // ?variant=noscale tests font-size 22 directly without scale/bold
  // ?fix=0/1 is back-compat for original/fixed
  const variant = query.variant ?? (query.fix === "0" ? "original" : undefined);
  const body = renderViewportDebug({
    repo_url: cfg.repoUrl,
    variant: variant as "original" | "fixed" | "noscale" | undefined,
    useFix: query.fix ? query.fix !== "0" : undefined,
  });
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_DESIGN,
    body,
  };
}
