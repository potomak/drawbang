// Backward-compatible barrel — implementation now lives in ingest/render/*.
// See ingest/render/shared.ts for RenderHandlersConfig / RenderResponse.
// This re-export keeps `import { ... } from "./render-handlers.js"` working
// for routes.ts, lambda.ts, dev-server.ts, and tests while the split lands in one PR.

export type {
  RenderHandlersConfig,
  RenderResponse,
  ProductCountersSource,
} from "./render/shared.js";

export { renderHomePageHandler, renderFeedItemsHandler } from "./render/home.js";
export { renderGalleryPageHandler, renderGalleryItemsHandler } from "./render/gallery.js";
export { renderDrawingPageHandler, renderEmbedPageHandler } from "./render/drawing.js";
export { renderProfilePageHandler, renderProfileItemsHandler } from "./render/profile.js";
export { renderStreakPageHandler } from "./render/streak.js";
export { renderBookmarksPageHandler, renderMyBookmarksFeedHandler } from "./render/bookmarks.js";
export {
  renderFollowersPageHandler,
  renderFollowingPageHandler,
  renderFollowersItemsHandler,
  renderFollowingItemsHandler,
  renderFollowThumbsHandler,
} from "./render/follows.js";
export { renderProductsPageHandler } from "./render/products.js";
export {
  renderPromptsArchiveHandler,
  renderPromptPageHandler,
  renderPromptItemsHandler,
} from "./render/prompts.js";
export { renderDesignPageHandler } from "./render/design.js";
export { renderDrawingV2PageHandler } from "./render/drawing-v2.js";
export { renderFeedHandler } from "./render/feed.js";
