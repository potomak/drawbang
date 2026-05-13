// Single source of truth for the site's header + footer chrome (#102).
// Pure: no DOM, no fetch, no module-level side effects. Consumed at build
// time by the Vite plugin (#168) and the builder templates (#169).

export interface NavLink {
  href: string;
  label: string;
  id: "home" | "gallery" | "identity" | "products" | string;
}

export interface ChromeOptions {
  /** id of the link to mark active (aria-current="page"). */
  active?: NavLink["id"];
  /** True when localStorage carries a known pubkey. */
  hasIdentity?: boolean;
  /** Pubkey for the identity deep-link. Pair with hasIdentity = true. */
  identityPubkey?: string | null;
}

export interface FooterOptions extends ChromeOptions {
  repoUrl: string;
}

/**
 * Canonical href the identity link falls back to when no pubkey is known.
 * Concrete behaviour (open the in-page #identityDialog vs. navigate)
 * is wired in #171; for now both consumers agree on this href so the
 * markup is identical across surfaces.
 */
export const IDENTITY_FALLBACK_HREF = "/identity";

/**
 * Fixed nav entries. The identity link is dynamic (its href depends on
 * whether the viewer has a pubkey), so it's appended at render time.
 * Adding a new top-level section is a one-line change here.
 */
export const NAV_LINKS: readonly NavLink[] = [
  { href: "/gallery", label: "gallery", id: "gallery" },
  { href: "/products", label: "products", id: "products" },
];

function identityLink(opts: ChromeOptions): NavLink {
  const href =
    opts.hasIdentity && opts.identityPubkey
      ? `/keys/${opts.identityPubkey}`
      : IDENTITY_FALLBACK_HREF;
  return { href, label: "identity", id: "identity" };
}

function allLinks(opts: ChromeOptions): readonly NavLink[] {
  return [...NAV_LINKS, identityLink(opts)];
}

function renderLink(link: NavLink, active: NavLink["id"] | undefined): string {
  const ariaCurrent = link.id === active ? ' aria-current="page"' : "";
  // The identity link is rewritten on the client by /chrome-identity.js
  // (#171) when the viewer has a pubkey in localStorage. The marker
  // attribute lets the patcher find it without depending on label or
  // href shape.
  const identityFlag = link.id === "identity" ? ' data-identity-link="1"' : "";
  return `<a href="${esc(link.href)}" data-nav="${esc(link.id)}"${ariaCurrent}${identityFlag}>${esc(link.label)}</a>`;
}

export function renderHeader(opts: ChromeOptions = {}): string {
  const items = allLinks(opts).map((l) => renderLink(l, opts.active)).join("\n      ");
  return `<header class="chrome-header">
  <a class="chrome-logo" href="/" aria-label="Draw! — home">Draw!</a>
  <button class="chrome-menu-toggle" aria-controls="chrome-nav" aria-expanded="false" hidden>menu</button>
  <nav id="chrome-nav" class="chrome-nav" aria-label="Primary">
      ${items}
  </nav>
</header>`;
}

export function renderFooter(opts: FooterOptions): string {
  const items = allLinks(opts).map((l) => renderLink(l, opts.active)).join("\n      ");
  // The hamburger toggle (#170) and the identity-link patcher (#171)
  // both ship as plain JS at stable URLs, so every surface — Vite-built
  // or builder-rendered — loads them from the same place without bundle
  // hash plumbing.
  return `<footer class="chrome-footer">
  <nav class="chrome-footer-nav" aria-label="Footer">
      ${items}
  </nav>
  <a class="chrome-footer-repo" href="${esc(opts.repoUrl)}" target="_blank" rel="noopener">source on github</a>
</footer>
<script src="/chrome-toggle.js"></script>
<script src="/chrome-identity.js"></script>`;
}

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
