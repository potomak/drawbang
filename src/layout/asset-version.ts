// Build-time identifier appended as `?v=<id>` to every reference to a
// non-hashed static asset (gallery-v2.css, like.js, share.js, flash.js,
// tile-page.js, chrome-*.js, …). Bumping it busts the browser cache on
// every Lambda deploy so template/CSS/JS changes are visible immediately
// instead of waiting for the static asset's max-age to expire.
//
// In production: esbuild inlines `process.env.DRAWBANG_ASSET_VERSION`
// at bundle time (see infra/aws/build-lambda.mjs) — set there to the
// short git SHA. The Vite chrome plugin (vite/plugins/chrome.ts) does
// the same on the editor SPAs.
//
// In dev/tests: the env var is absent and we fall back to an empty
// string, which makes assetUrl(path) a no-op. That keeps test snapshots
// stable and lets the dev server serve un-versioned URLs.

const VERSION: string =
  (typeof process !== "undefined" && process.env?.DRAWBANG_ASSET_VERSION) || "";

export function assetVersion(): string {
  return VERSION;
}

export function assetUrl(path: string): string {
  if (!VERSION) return path;
  return `${path}${path.includes("?") ? "&" : "?"}v=${VERSION}`;
}
