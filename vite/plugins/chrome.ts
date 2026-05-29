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
// Pages opt out of the chrome's "+" FAB with <meta name="drawbang:fab"
// content="off">. Only the editor uses this today (linking to itself
// would be redundant); other Vite SPAs leave it unset so the FAB shows.
const FAB_META = /<meta\s+name="drawbang:fab"\s+content="([^"]*)"\s*\/?>\s*\n?/i;
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
  const fabMatch = html.match(FAB_META);
  const fab = fabMatch?.[1] === "off" ? false : true;
  let out = activeMatch ? html.replace(ACTIVE_META, "") : html;
  if (fabMatch) out = out.replace(FAB_META, "");
  out = out.replace(HEADER_MARKER, renderHeader({ active }));
  out = out.replace(FOOTER_MARKER, renderFooter({ active, repoUrl, fab }));
  out = out.replace(ANALYTICS_MARKER, renderAnalytics());
  out = out.replace(META_PIXEL_MARKER, renderMetaPixel());
  return out;
}
