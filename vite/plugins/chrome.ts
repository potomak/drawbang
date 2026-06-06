import type { Plugin } from "vite";
import {
  renderFooter,
  renderHeader,
  type NavLink,
} from "../../src/layout/chrome.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";

// Vite plugin that injects the shared header/footer (#167) into every
// HTML entry at transformIndexHtml time. The page declares its active
// section via a <meta name="drawbang:active" content="..."> tag, which
// is stripped from the output once consumed.

export interface ChromePluginOptions {
  repoUrl?: string;
}

const ACTIVE_META = /<meta\s+name="drawbang:active"\s+content="([^"]*)"\s*\/?>\s*\n?/i;
// Pages opt out of the .app-shell wrapper + rails with
// <meta name="drawbang:rails" content="off">. The editor uses this so
// the canvas gets the full viewport; smaller surfaces (auth pages,
// merch picker) leave it set so the rails carry the site nav.
const RAILS_META = /<meta\s+name="drawbang:rails"\s+content="([^"]*)"\s*\/?>\s*\n?/i;
const HEADER_MARKER = "<!--CHROME:HEADER-->";
const FOOTER_MARKER = "<!--CHROME:FOOTER-->";
const ANALYTICS_MARKER = "<!--CHROME:ANALYTICS-->";
const META_PIXEL_MARKER = "<!--CHROME:META-PIXEL-->";

export function chromePlugin(opts: ChromePluginOptions = {}): Plugin {
  const repoUrl = opts.repoUrl ?? "https://github.com/potomak/drawbang";
  return {
    name: "drawbang-chrome",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return injectChrome(html, repoUrl);
      },
    },
  };
}

export function injectChrome(html: string, repoUrl: string): string {
  const activeMatch = html.match(ACTIVE_META);
  const active = activeMatch?.[1]
    ? (activeMatch[1] as NavLink["id"])
    : undefined;
  const railsMatch = html.match(RAILS_META);
  const rails = railsMatch?.[1] === "off" ? false : true;
  let out = activeMatch ? html.replace(ACTIVE_META, "") : html;
  if (railsMatch) out = out.replace(RAILS_META, "");
  out = out.replace(HEADER_MARKER, renderHeader({ active, rails }));
  out = out.replace(FOOTER_MARKER, renderFooter({ active, repoUrl, rails }));
  out = out.replace(ANALYTICS_MARKER, renderAnalytics());
  out = out.replace(META_PIXEL_MARKER, renderMetaPixel());
  return out;
}
