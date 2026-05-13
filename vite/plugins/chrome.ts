import type { Plugin } from "vite";
import { renderFooter, renderHeader, type NavLink } from "../../src/layout/chrome.js";

// Vite plugin that injects the shared header/footer (#167) into every
// HTML entry at transformIndexHtml time. The page declares its active
// section via a <meta name="drawbang:active" content="..."> tag, which
// is stripped from the output once consumed.

export interface ChromePluginOptions {
  repoUrl?: string;
}

const ACTIVE_META = /<meta\s+name="drawbang:active"\s+content="([^"]*)"\s*\/?>\s*\n?/i;
const HEADER_MARKER = "<!--CHROME:HEADER-->";
const FOOTER_MARKER = "<!--CHROME:FOOTER-->";

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
  const match = html.match(ACTIVE_META);
  const active = match?.[1] as NavLink["id"] | undefined;
  let out = match ? html.replace(ACTIVE_META, "") : html;
  out = out.replace(HEADER_MARKER, renderHeader({ active }));
  out = out.replace(FOOTER_MARKER, renderFooter({ active, repoUrl }));
  return out;
}
