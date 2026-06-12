import type { Prompt } from "../../config/prompts.js";
import { DEFAULT_SIZE } from "../../config/constants.js";
import { assetUrl } from "../../src/layout/asset-version.js";
import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { esc } from "./_escape.js";
import { renderHtmlShell } from "./_html-shell.js";
import {
  renderGallerySentinel,
  renderItem,
  type GalleryItem,
} from "./gallery.js";
import { formatItemDate } from "./_time.js";

// /prompts — archive of every daily prompt from launch through today —
// and /prompts/<slug> — the submission grid for one prompt. Both double
// as SEO landing pages ("16×16 slime animation" searches), so each page
// carries its own meta description, canonical URL, and OG tags.

export interface PromptArchiveEntry {
  // ET calendar day ("YYYY-MM-DD") the prompt ran (or runs).
  date: string;
  prompt: Prompt;
  is_today: boolean;
}

export interface PromptArchiveView {
  // Newest-first. Built by the handler purely from config — no store
  // reads — so the list must never include dates after today.
  entries: PromptArchiveEntry[];
  public_base_url: string;
  repo_url: string;
}

export interface PromptPageView {
  prompt: Prompt;
  // True when this prompt is the live one for the current ET day. Gates
  // the "Draw this" CTA — stale prompts can't be drawn for, so those
  // pages point at the archive instead.
  is_today: boolean;
  // Newest-first submissions tagged with this prompt's slug.
  items: GalleryItem[];
  // When present, the grid renders an infinite-scroll sentinel pointing
  // at /prompts/<slug>/items?cursor=… — same pattern as the profile.
  next_fragment_url?: string;
  // drawing_id of the newest submission; its -large.gif becomes og:image.
  // Null (no submissions) falls back to the site logo.
  top_drawing_id: string | null;
  public_base_url: string;
  repo_url: string;
}

// "16×16 Slime bounce pixel art animation — Draw!" — the search phrase
// these pages are meant to land. Prompts with a size rule (e.g. the
// 8×8 UI cursor) advertise their own dimensions.
function promptSeoTitle(p: Prompt): string {
  const size = p.rules?.size ?? DEFAULT_SIZE;
  return `${size}×${size} ${p.title} pixel art animation — Draw!`;
}

function renderArchiveRow(e: PromptArchiveEntry): string {
  const badge = e.is_today
    ? `\n            <span class="badge accent">Today</span>`
    : "";
  return `        <li class="pm-row">
          <time class="pm-date" datetime="${esc(e.date)}">${esc(formatItemDate(e.date))}</time>
          <span class="pm-main">
            <a class="pm-title" href="/prompts/${esc(e.prompt.slug)}">${esc(e.prompt.title)}</a>${badge}
            <span class="pm-blurb">${esc(e.prompt.blurb)}</span>
          </span>
        </li>`;
}

export function renderPromptArchive(v: PromptArchiveView): string {
  const rows = v.entries.map(renderArchiveRow).join("\n");
  const head = `<meta name="description" content="A new pixel art animation prompt every day. Draw today&#39;s 16×16 challenge on Draw! or browse every past prompt and its community submissions." />
    <link rel="canonical" href="${esc(v.public_base_url)}/prompts" />`;
  return renderHtmlShell({
    title: "Daily pixel art prompts — Draw!",
    extraHead: head,
    body: `    ${renderHeader({ active: "home" })}
    <main>
      <h1 class="page-title">Daily prompts</h1>
      <p class="page-sub">One tiny animation challenge a day. Draw today's, browse the rest.</p>
      <ol class="pm-archive">
${rows}
      </ol>
    </main>
    ${renderFooter({ active: "home", repoUrl: v.repo_url })}`,
  });
}

export function renderPromptPage(v: PromptPageView): string {
  const p = v.prompt;
  const size = p.rules?.size ?? DEFAULT_SIZE;
  const seoTitle = promptSeoTitle(p);
  const pageUrl = `${v.public_base_url}/prompts/${p.slug}`;
  const og = v.top_drawing_id
    ? {
        url: `${v.public_base_url}/tiles/${v.top_drawing_id}-large.gif`,
        type: "image/gif",
        width: 960,
        height: 960,
      }
    : {
        url: `${v.public_base_url}/og-logo.png`,
        type: "image/png",
        width: 320,
        height: 320,
      };
  const description = `${p.blurb} Community pixel art for the "${p.title}" daily prompt — ${size}×${size} animated GIFs drawn on Draw!`;
  const head = `<meta name="description" content="${esc(description)}" />
    <link rel="canonical" href="${esc(pageUrl)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Draw!" />
    <meta property="og:title" content="${esc(seoTitle)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${esc(pageUrl)}" />
    <meta property="og:image" content="${esc(og.url)}" />
    <meta property="og:image:type" content="${og.type}" />
    <meta property="og:image:width" content="${og.width}" />
    <meta property="og:image:height" content="${og.height}" />
    <meta name="twitter:card" content="summary_large_image" />`;
  const badge = v.is_today ? ` <span class="badge accent">Today</span>` : "";
  const cta = v.is_today
    ? `      <p class="pm-cta"><a class="btn primary" href="/draw?prompt=${esc(p.slug)}">Draw this</a></p>\n`
    : "";
  const items = v.items.map(renderItem).join("\n");
  const grid = v.items.length
    ? `      <p class="panel-h">Submissions</p>
      <ul class="img-grid" data-gallery-items>
${items}
      </ul>${v.next_fragment_url ? `\n      ${renderGallerySentinel(v.next_fragment_url)}` : ""}`
    : v.is_today
      ? `      <p class="muted">No submissions yet — be the first to draw this one.</p>`
      : `      <p class="muted">This prompt's day has passed without submissions. Check <a href="/prompts">the archive</a> for today's challenge.</p>`;
  const infiniteScript = v.next_fragment_url
    ? `\n    <script src="${assetUrl("/infinite-scroll.js")}"></script>`
    : "";
  return renderHtmlShell({
    title: esc(seoTitle),
    extraHead: head,
    body: `    ${renderHeader({ active: "home" })}
    <main>
      <h1 class="page-title">${esc(p.title)}${badge}</h1>
      <p class="page-sub">${esc(p.blurb)} · <a href="/prompts">All prompts</a></p>
${cta}${grid}
    </main>
    ${renderFooter({ active: "home", repoUrl: v.repo_url })}${infiniteScript}`,
  });
}
