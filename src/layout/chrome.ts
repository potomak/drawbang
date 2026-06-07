// Single source of truth for the site's header + left/right rails (#102).
// Pure: no DOM, no fetch, no module-level side effects. Consumed at build
// time by the Vite plugin (#168) and the Lambda-rendered templates.
//
// Layout target (see docs/design-system.md):
//
//   <header class="hdr">                  logo · auth slot
//   <div class="app-shell">
//     <aside class="rail-left">           CTA · primary nav · secondary
//     {template renders <main> here}
//     <aside class="rail-right">          discover modules (Phase 3)
//   </div>
//   <scripts>
//
// renderHeader() emits the header + opens the shell + emits rail-left.
// renderFooter() emits rail-right + closes the shell + ships the scripts.
// Templates render their own <main> in between, unchanged.
//
// Surfaces that need the full viewport (e.g. the editor /draw) opt out
// of the rails with `rails: false`; the page then sits directly in the
// body without the grid wrapper.

import { assetUrl } from "./asset-version.js";
import { LOGO_SVG } from "./logo.js";

export interface NavLink {
  href: string;
  label: string;
  id: "home" | "gallery" | "identity" | "products" | string;
}

export interface ChromeOptions {
  /** id of the link to mark active (aria-current="page"). */
  active?: NavLink["id"];
  /**
   * Wrap the page in the .app-shell grid + emit the rails. Default true.
   * Surfaces that need the full viewport (e.g. the editor) pass false.
   */
  rails?: boolean;
  /**
   * Render the right "discover" rail. Default false — only the feed
   * (`/`) opts in. Other pages stay 2-column (rail-left + main).
   */
  rightRail?: boolean;
}

export interface FooterOptions extends ChromeOptions {
  repoUrl: string;
  /**
   * Pre-rendered HTML to inject into the .rail-right <aside>. Set when
   * the calling template wants to SSR content into the discover rail
   * (the feed passes the output of lib/templates/discover.ts here).
   * Implies rightRail: true.
   */
  rightRailContent?: string;
}

/**
 * Canonical href the identity link falls back to for logged-out viewers.
 * The client patcher (/chrome-identity.js) swaps the slot to a
 * profile-picture + username link once a session is present in
 * localStorage.
 */
export const IDENTITY_FALLBACK_HREF = "/login";

/**
 * Primary nav rendered in the left rail. Adding a new top-level section
 * is a one-line change here.
 */
export const NAV_LINKS: readonly NavLink[] = [
  { href: "/products", label: "Products", id: "products" },
];

export function renderHeader(opts: ChromeOptions = {}): string {
  const rails = opts.rails !== false;
  const right = opts.rightRail === true;
  const shellClass = right ? "app-shell has-rail-right" : "app-shell";
  const shell = rails
    ? `\n<div class="${shellClass}">\n  <aside class="rail-left" id="rail-left">\n    ${renderLeftRail(opts)}\n  </aside>`
    : "";
  return `${FONT_PREVIEW_SCRIPT}<header class="hdr">
  <button class="hdr-menu" aria-controls="rail-left" aria-expanded="false" aria-label="Menu" hidden>${MENU_ICON_SVG}</button>
  <a class="hdr-logo" href="/" aria-label="Draw! home">${LOGO_SVG}</a>
  <div class="hdr-auth">
    <a class="hdr-signin" href="${IDENTITY_FALLBACK_HREF}" data-identity-link="1" data-auth-state="signed-out">Sign in</a>
    <a class="hdr-profile" href="#" data-identity-link="1" data-auth-state="signed-in" hidden>
      <img class="profile-picture hdr-profile-pic" alt="" width="24" height="24" />
      <span class="hdr-profile-name"></span>
    </a>
  </div>
</header>${shell}`;
}

export function renderFooter(opts: FooterOptions): string {
  const rails = opts.rails !== false;
  const right = opts.rightRail === true || typeof opts.rightRailContent === "string";
  const railContent = opts.rightRailContent ?? "";
  const shellClose = rails
    ? (right
        ? `  <aside class="rail-right" data-rail-right>${railContent}</aside>\n</div>\n`
        : `</div>\n`)
    : "";
  return `${shellClose}<script src="${assetUrl("/flash.js")}"></script>
<script src="${assetUrl("/chrome-toggle.js")}"></script>
<script src="${assetUrl("/chrome-identity.js")}"></script>
<script src="${assetUrl("/hydrate.js")}"></script>`;
}

// Left rail markup. Two groups stacked vertically: the primary group
// (CTA + nav, top) and the secondary group (social + privacy + feedback,
// bottom; pushed down by `.rail-foot { margin-top: auto }`). Owner-only
// blocks ship hidden and are revealed client-side by chrome-identity.js
// once a session is present.
export function renderLeftRail(opts: ChromeOptions): string {
  const active = opts.active;
  const isActive = (id: NavLink["id"]) =>
    id === active ? ' aria-current="page"' : "";

  const primary = NAV_LINKS.map(
    (l) => `<a class="rail-link" href="${esc(l.href)}" data-nav="${esc(l.id)}"${isActive(l.id)}>${esc(l.label)}</a>`,
  ).join("\n      ");

  const social = SOCIAL_LINKS.map(
    (s) =>
      `<a class="rail-social-link" href="${esc(s.href)}" target="_blank" rel="noopener" aria-label="${esc(s.label)}">${esc(s.label)}</a>`,
  ).join("\n        ");

  return `<a class="rail-cta" href="/draw" data-nav="draw">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"/></svg>
      <span>New drawing</span>
    </a>
    <nav class="rail-nav" aria-label="Primary">
      ${primary}
      <div class="rail-follow" data-profile-username="" data-rail-follow="followers" hidden>
        <a class="rail-link rail-follow-link" data-rail-follow-link="followers" href="#">
          Followers · <span data-follower-count>0</span>
        </a>
        <div class="rail-thumbs" data-rail-thumbs="followers"></div>
      </div>
      <div class="rail-follow" data-profile-username="" data-rail-follow="following" hidden>
        <a class="rail-link rail-follow-link" data-rail-follow-link="following" href="#">
          Following · <span data-following-count>0</span>
        </a>
        <div class="rail-thumbs" data-rail-thumbs="following"></div>
      </div>
      <a class="rail-link" data-rail-bookmarks href="#" hidden>Bookmarks</a>
      <a class="rail-link" data-rail-account href="/account" hidden>Account</a>
      <a class="rail-link rail-logout" href="/" data-logout-link="1" hidden>Sign out</a>
    </nav>
    <div class="rail-foot">
      <div class="rail-social" aria-label="Social">
        ${social}
      </div>
      <nav class="rail-foot-links" aria-label="Secondary">
        <a class="rail-link rail-foot-link" href="/privacy">Privacy</a>
        <a class="rail-link rail-foot-link" href="${esc(FEEDBACK_URL)}" target="_blank" rel="noopener">Feedback</a>
      </nav>
    </div>`;
}

const SOCIAL_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "X", href: "https://x.com/drawbang" },
  { label: "Discord", href: "https://discord.gg/mXA4NQjcxg" },
  { label: "Facebook", href: "https://facebook.com/drawbang" },
  { label: "Instagram", href: "https://instagram.com/drawbang256" },
  { label: "Threads", href: "https://www.threads.net/@drawbang256" },
];

const FEEDBACK_URL =
  "https://github.com/potomak/drawbang/issues/new?labels=feedback";

const MENU_ICON_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="M3 6h18M3 12h18M3 18h18"/></svg>`;

// Temporary: applies the font picked on /design to every page so the
// trial choice persists across navigation. Reads localStorage early
// (before first paint), sets --font-sans + --font, and loads the GF
// stylesheet only if a choice is active. Strip this and the design
// page's picker once a font is locked in.
const FONT_PREVIEW_SCRIPT = `<script>(function(){try{var s=localStorage.getItem("drawbang:design:font");if(!s)return;var d=document.documentElement;d.style.setProperty("--font-sans",s);d.style.setProperty("--font",s);var l=document.createElement("link");l.rel="stylesheet";l.href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@400;500;600;700&family=Work+Sans:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=EB+Garamond:wght@400;500;600;700&family=Cormorant+Garamond:wght@400;500;600;700&display=swap";document.head.appendChild(l);}catch(e){}})();</script>`;

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function esc(v: unknown): string {
  if (v == null) return "";
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]!);
}
