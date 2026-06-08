import { assetUrl } from "../../src/layout/asset-version.js";
import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { esc } from "./_escape.js";
import { renderHtmlShell } from "./_html-shell.js";
import { formatItemDate } from "./_time.js";

export interface GalleryItem {
  id: string;
  id_short: string;
  // Default to the legacy single-drawing convention; canvases pass /c/ + composite.
  href?: string;
  thumb?: string;
  // ISO 8601 timestamp. Rendered under each thumbnail when present so each
  // item carries its own date (fixes the "all latest as today" bug from the
  // old gallery, where one date stamp covered the whole strip).
  created_at?: string;
}

export interface GalleryView {
  // Optional: "Latest" section header text. The legacy static gallery used
  // the most recent day's date here; the dynamic gallery omits it.
  today?: string;
  drawings: GalleryItem[];
  // Optional archive list. Legacy static gallery only — the dynamic gallery
  // is one infinite scroll, no archive sidebar.
  days?: { date: string; count: number; pages: number }[];
  // Optional: URL to fetch the next HTML fragment for infinite scroll.
  // When set, the template ships a sentinel + IntersectionObserver that
  // appends the fetched HTML to the items list. Set in the dynamic
  // renderer when the query returned a next_cursor.
  next_fragment_url?: string;
  repo_url: string;
}

export function renderItem(d: GalleryItem): string {
  const meta = d.created_at
    ? `<time class="gal-item-time" datetime="${esc(d.created_at)}">${esc(formatItemDate(d.created_at))}</time>`
    : "";
  return `<li>
  <a href="${esc(d.href ?? `/d/${d.id}`)}" aria-label="${esc(d.id_short)}">
    <img src="${esc(d.thumb ?? `/tiles/${d.id}.gif`)}" alt="" width="128" height="128" loading="lazy" />
  </a>
  ${meta}
</li>`;
}

// formatItemDate moved to ./_time.js; re-exported here for backward compat
// with anything that still imports it from gallery.
export { formatItemDate };

export default function renderGallery(v: GalleryView): string {
  const items = v.drawings.map(renderItem).join("\n");
  const archive = (v.days ?? [])
    .map(
      (d) => `        <li><a href="/days/${esc(d.date)}/p/1">${esc(d.date)}</a> <span class="gal-count">— ${esc(d.count)} ${d.count === 1 ? "drawing" : "drawings"}</span></li>`,
    )
    .join("\n");
  const heading = v.today ? `Latest · ${esc(v.today)}` : "Latest";
  const latestSection = v.drawings.length
    ? `      <p class="panel-h">${heading}</p>
      <ul class="img-grid" data-gallery-items>
${items}
      </ul>${v.next_fragment_url ? `\n      ${renderGallerySentinel(v.next_fragment_url)}` : ""}`
    : `      <p class="panel-h">${heading}</p>
      <p class="muted">No drawings published yet — open <a href="/draw">the editor</a> and mint the first one.</p>`;
  const archiveSection = (v.days ?? []).length
    ? `      <hr class="divider" />
      <p class="panel-h">Archive</p>
      <ul class="gal-archive-list">
${archive}
      </ul>`
    : "";
  const infiniteScript = v.next_fragment_url
    ? `    <script src="${assetUrl("/infinite-scroll.js")}"></script>\n`
    : "";
  return renderHtmlShell({
    title: "Draw! · Gallery",
    body: `    ${renderHeader({ active: "gallery" })}
    <main>
      <h1 class="page-title">Gallery</h1>
${latestSection}
${archiveSection}
    </main>
    ${renderFooter({ active: "gallery", repoUrl: v.repo_url })}
${infiniteScript}`,
  });
}

// Sentinel for the gallery's flat thumbnail grid. The sentinel is a
// sibling of the list (not a child), so the shared infinite-scroll
// script needs an explicit target selector.
export function renderGallerySentinel(nextUrl: string): string {
  return `<div class="gal-sentinel" data-gallery-sentinel data-infinite-sentinel data-infinite-target="[data-gallery-items]" data-next="${esc(nextUrl)}"></div>`;
}

// Items-only render (no chrome). Used by the fragment endpoint to return
// just the next page of <li> elements plus a sentinel for the page after.
export function renderGalleryFragment(items: GalleryItem[], next_fragment_url: string | null): string {
  const body = items.map(renderItem).join("\n");
  if (!next_fragment_url) return body;
  return `${body}
${renderGallerySentinel(next_fragment_url)}`;
}
