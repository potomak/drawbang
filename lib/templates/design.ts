// TODO (#shared-template-utils): HTML head/shell duplication — see
// home.ts for the lift-to-_html-shell plan.

import { assetUrl } from "../../src/layout/asset-version.js";
import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";
import { esc } from "./_escape.js";

// Visual reference for the shared design system. Renders every reusable
// component on one page so visual drift is caught immediately when a
// token or class changes. See docs/design-system.md for the written
// rules; the rule is token → markdown → kitchen-sink in that order.
//
// This page is not linked from the chrome — it's discovered via the
// docs and accessed by URL. Cheap to render, cheap to keep current.

export interface DesignView {
  repo_url: string;
}

const COLOR_TOKENS: ReadonlyArray<{ name: string; role: string }> = [
  { name: "--paper", role: "page background" },
  { name: "--paper-2", role: "recessed surfaces" },
  { name: "--ink", role: "primary text" },
  { name: "--fg-muted", role: "secondary text, labels" },
  { name: "--fg-dim", role: "tertiary text" },
  { name: "--line", role: "hairlines, borders" },
  { name: "--line-strong", role: "hover/focus borders" },
  { name: "--accent", role: "CTA, active states" },
  { name: "--accent-on", role: "text on accent" },
  { name: "--accent-dim", role: "tinted accent bg" },
];

const TYPE_SCALE: ReadonlyArray<{ token: string; sample: string }> = [
  { token: "--t-2xl", sample: "28 — hero numerals" },
  { token: "--t-xl", sample: "20 — section landmark" },
  { token: "--t-lg", sample: "16 — page title" },
  { token: "--t-md", sample: "14 — body default" },
  { token: "--t-sm", sample: "13 — secondary, button" },
  { token: "--t-xs", sample: "11 — micro-label" },
];

const SPACING_TOKENS: ReadonlyArray<{ token: string; value: string }> = [
  { token: "--tap", value: "40px — min interactive height" },
  { token: "--pad", value: "16px — default padding" },
  { token: "--pad-sm", value: "8px — tight padding" },
  { token: "--border", value: "1px — every visible rule" },
];

// Temporary font picker — curated Google Fonts that fit the modern
// art gallery aesthetic. Click a button to live-switch the body font;
// the choice persists in localStorage so navigation across the site
// keeps the trial font applied.
//
// Once a font is locked in, this picker block (and the GF <link>) gets
// stripped from /design and the choice is baked into chrome.css.
const FONT_OPTIONS: ReadonlyArray<{
  label: string;
  stack: string;
  note: string;
}> = [
  {
    label: "Inter",
    stack: '"Inter", system-ui, sans-serif',
    note: "current — clean grotesque",
  },
  {
    label: "Space Grotesk",
    stack: '"Space Grotesk", system-ui, sans-serif',
    note: "geometric grotesque with character",
  },
  {
    label: "DM Sans",
    stack: '"DM Sans", system-ui, sans-serif',
    note: "soft + clean, very gallery-y",
  },
  {
    label: "Manrope",
    stack: '"Manrope", system-ui, sans-serif',
    note: "modern with gentle warmth",
  },
  {
    label: "Work Sans",
    stack: '"Work Sans", system-ui, sans-serif',
    note: "humanist sans",
  },
  {
    label: "Plus Jakarta Sans",
    stack: '"Plus Jakarta Sans", system-ui, sans-serif',
    note: "clean modern",
  },
  {
    label: "EB Garamond",
    stack: '"EB Garamond", Georgia, serif',
    note: "classical serif — museum-label vibe",
  },
  {
    label: "Cormorant Garamond",
    stack: '"Cormorant Garamond", Georgia, serif',
    note: "elegant serif",
  },
  {
    label: "JetBrains Mono",
    stack: '"JetBrains Mono", ui-monospace, monospace',
    note: "the original mono — for comparison",
  },
];

const FONT_GF_HREF =
  "https://fonts.googleapis.com/css2?" +
  "family=Inter:wght@400;500;600;700&" +
  "family=Space+Grotesk:wght@400;500;600;700&" +
  "family=DM+Sans:wght@400;500;600;700&" +
  "family=Manrope:wght@400;500;600;700&" +
  "family=Work+Sans:wght@400;500;600;700&" +
  "family=Plus+Jakarta+Sans:wght@400;500;600;700&" +
  "family=EB+Garamond:wght@400;500;600;700&" +
  "family=Cormorant+Garamond:wght@400;500;600;700&" +
  "display=swap";

export default function renderDesign(v: DesignView): string {
  return `<!doctype html>
<html lang="en">
  <head>
    ${renderAnalytics()}
    ${renderMetaPixel()}
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · Design system</title>
    <link rel="stylesheet" href="${assetUrl("/gallery-v2.css")}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="${FONT_GF_HREF}" />
    <style>
      .ds-fonts {
        position: sticky;
        top: var(--hdr-h, 56px);
        z-index: 20;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 12px 0;
        background: var(--paper);
        border-bottom: var(--border) solid var(--line);
        margin-bottom: 24px;
      }
      .ds-font-btn {
        padding: 8px 12px;
        border: var(--border) solid var(--line);
        background: var(--paper);
        color: var(--ink);
        cursor: pointer;
        font-size: var(--t-sm);
        display: inline-flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        text-align: left;
        line-height: 1.2;
      }
      .ds-font-btn:hover { border-color: var(--ink); }
      .ds-font-btn[aria-pressed="true"] {
        border-color: var(--accent);
        background: var(--accent-dim);
      }
      .ds-font-btn small {
        font-family: var(--font-mono);
        font-size: 10px;
        color: var(--fg-muted);
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .ds-grid { display: grid; gap: 40px; }
      .ds-row { display: grid; gap: 16px; }
      .ds-swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
      .ds-swatch { border: var(--border) solid var(--line); padding: 12px; display: grid; gap: 8px; }
      .ds-swatch-chip { height: 40px; border: var(--border) solid var(--line); }
      .ds-swatch-name { font-family: var(--font); font-size: var(--t-xs); color: var(--fg-muted); }
      .ds-swatch-role { font-size: var(--t-xs); color: var(--fg-dim); }
      .ds-type-row { display: flex; align-items: baseline; gap: 16px; padding: 6px 0; border-bottom: var(--border) solid var(--line); }
      .ds-type-token { font-family: var(--font); font-size: var(--t-xs); color: var(--fg-muted); min-width: 90px; }
      .ds-spacing-row { display: flex; align-items: center; gap: 16px; padding: 6px 0; border-bottom: var(--border) solid var(--line); }
      .ds-spacing-bar { height: 10px; background: var(--accent); }
      .ds-buttons { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
      .ds-section-head { display: flex; align-items: baseline; gap: 16px; }
      .ds-section-head h2 { font-size: var(--t-lg); margin: 0; font-weight: 700; }
      .ds-section-head small { color: var(--fg-muted); font-size: var(--t-xs); }
      .ds-sample-card {
        display: grid; gap: 16px;
        border: var(--border) solid var(--line);
        padding: 16px;
        max-width: 480px;
      }
      .ds-sample-art {
        aspect-ratio: 1; background: var(--canvas-bg, #0a0a0a);
        display: grid; place-items: center; color: var(--fg-muted); font-size: var(--t-xs);
      }
    </style>
  </head>
  <body>
    ${renderHeader()}
    <main>
      <h1 class="page-title">Design system</h1>
      <p class="page-sub">Visual reference for tokens + components defined in <code>static/chrome.css</code> and described in <code>docs/design-system.md</code>.</p>

      <div class="ds-fonts" role="toolbar" aria-label="Font preview">
        ${FONT_OPTIONS.map(renderFontButton).join("\n        ")}
        <button class="ds-font-btn" data-font-reset>
          Reset
          <small>back to chrome.css default</small>
        </button>
      </div>

      <div class="ds-grid">

        ${section("Color tokens", "Single accent rationed to CTA + active. No additional brand colors.", `
          <div class="ds-swatches">
            ${COLOR_TOKENS.map(renderColorSwatch).join("\n")}
          </div>
        `)}

        ${section("Type scale", "Six steps. Sans for prose, mono for labels.", `
          <div class="ds-row">
            ${TYPE_SCALE.map(renderTypeRow).join("\n")}
          </div>
        `)}

        ${section("Spacing tokens", "Use these inline; never invent new step values.", `
          <div class="ds-row">
            ${SPACING_TOKENS.map(renderSpacingRow).join("\n")}
          </div>
        `)}

        ${section("Buttons", "Base + .primary + .ghost in chrome.css. Variants .icon/.sm/.xs live in src/style.css.", `
          <div class="ds-buttons">
            <button class="btn">Default</button>
            <button class="btn primary">Primary</button>
            <button class="btn ghost">Ghost</button>
            <a class="btn" href="#">Link as button</a>
            <button class="btn" disabled>Disabled</button>
          </div>
        `)}

        ${section("Follow button", ".follow-btn — filled accent when unfollowed (the action), outlined when followed (the state).", `
          <div class="ds-buttons">
            <button class="follow-btn" type="button" aria-pressed="false">
              <span class="follow-label">Follow</span>
            </button>
            <button class="follow-btn" type="button" aria-pressed="true">
              <span class="follow-label">Following</span>
            </button>
          </div>
        `)}

        ${section("Badge", ".badge — small inline label for accomplishments, statuses, counts. Hairline border + mono micro-label on paper-2 fill. Use .badge.accent for highlighted variants.", `
          <div class="ds-buttons">
            <span class="badge">Beta</span>
            <span class="badge">Daily streak</span>
            <span class="badge accent">New</span>
          </div>
        `)}

        ${section("Page chrome", ".page-title, .page-sub, .divider, .panel-h, .muted.", `
          <h2 class="page-title">Page title</h2>
          <p class="page-sub">Page subtitle — small muted note under the title.</p>
          <hr class="divider" />
          <h3 class="panel-h">Panel header label</h3>
          <p class="muted">Muted body copy for tertiary information.</p>
        `)}

        ${section("Feed card", "Single canonical card. Do not vary.", `
          <article class="ds-sample-card">
            <header class="feed-card-author">
              <a class="feed-card-author-link" href="#">@artist</a>
              <span class="feed-card-sep">·</span>
              <time class="feed-card-time">Jun 6, 2026</time>
            </header>
            <div class="ds-sample-art">16×16 GIF goes here</div>
            <div class="feed-card-actions">
              <button class="feed-action like-btn" aria-pressed="false">
                <span class="like-icon">♥</span><span class="like-count">42</span>
              </button>
              <button class="feed-action bookmark-btn" aria-pressed="false">
                <span class="bookmark-icon">🔖</span>
              </button>
            </div>
          </article>
        `)}

        ${section("Flash", "window.drawbangShowFlash(message, opts). Never inline-render error paragraphs.", `
          <div class="ds-buttons">
            <button class="btn" onclick="window.drawbangShowFlash &amp;&amp; window.drawbangShowFlash('Saved.', { kind: 'success' })">Trigger success</button>
            <button class="btn" onclick="window.drawbangShowFlash &amp;&amp; window.drawbangShowFlash('Something went wrong.', { kind: 'error' })">Trigger error</button>
          </div>
        `)}

      </div>
    </main>
    ${renderFooter({ repoUrl: v.repo_url })}
    <script>
${FONT_PICKER_SCRIPT}
    </script>
  </body>
</html>
`;
}

// Inline runtime for the font picker. Sets --font-sans (which both the
// body and most components inherit from) on <html>, and persists the
// pick to localStorage so navigating between /, /draw, /d/<id>, etc.
// keeps the trial font applied. Loading the same GF link tag on every
// surface would be wasteful; instead we stamp a <link> into <head> at
// runtime when a trial stack is active.
const FONT_PICKER_SCRIPT = `(function () {
  var STORAGE_KEY = "drawbang:design:font";
  var GF_HREF = "${FONT_GF_HREF}";

  function load() {
    try { return localStorage.getItem(STORAGE_KEY) || ""; } catch (e) { return ""; }
  }
  function save(stack) {
    try {
      if (stack) localStorage.setItem(STORAGE_KEY, stack);
      else localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
  }
  function ensureGoogleFonts() {
    if (document.querySelector('link[data-design-fonts]')) return;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = GF_HREF;
    link.setAttribute("data-design-fonts", "1");
    document.head.appendChild(link);
  }
  function apply(stack) {
    if (stack) {
      ensureGoogleFonts();
      document.documentElement.style.setProperty("--font-sans", stack);
      document.documentElement.style.setProperty("--font", stack);
    } else {
      document.documentElement.style.removeProperty("--font-sans");
      document.documentElement.style.removeProperty("--font");
    }
    markActive(stack);
  }
  function markActive(stack) {
    var btns = document.querySelectorAll("[data-font-stack]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute("aria-pressed", btns[i].getAttribute("data-font-stack") === stack ? "true" : "false");
    }
  }

  // Apply persisted choice immediately (the picker page sees its own toolbar
  // light up; other pages just inherit the font).
  apply(load());

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire, { once: true });
  } else {
    wire();
  }
  function wire() {
    var btns = document.querySelectorAll("[data-font-stack]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function (e) {
        var stack = e.currentTarget.getAttribute("data-font-stack") || "";
        save(stack);
        apply(stack);
      });
    }
    var reset = document.querySelector("[data-font-reset]");
    if (reset) {
      reset.addEventListener("click", function () {
        save("");
        apply("");
      });
    }
  }
})();`;

function section(title: string, lede: string, body: string): string {
  return `<section class="ds-row">
    <div class="ds-section-head">
      <h2>${esc(title)}</h2>
      <small>${esc(lede)}</small>
    </div>
    ${body}
  </section>`;
}

function renderFontButton(f: { label: string; stack: string; note: string }): string {
  return `<button class="ds-font-btn" data-font-stack="${esc(f.stack)}" style="font-family: ${f.stack};">
          ${esc(f.label)}
          <small>${esc(f.note)}</small>
        </button>`;
}

function renderColorSwatch(t: { name: string; role: string }): string {
  return `<div class="ds-swatch">
    <div class="ds-swatch-chip" style="background: var(${t.name});"></div>
    <div class="ds-swatch-name">${esc(t.name)}</div>
    <div class="ds-swatch-role">${esc(t.role)}</div>
  </div>`;
}

function renderTypeRow(t: { token: string; sample: string }): string {
  return `<div class="ds-type-row">
    <span class="ds-type-token">${esc(t.token)}</span>
    <span style="font-size: var(${t.token});">${esc(t.sample)}</span>
  </div>`;
}

function renderSpacingRow(t: { token: string; value: string }): string {
  return `<div class="ds-spacing-row">
    <span class="ds-type-token">${esc(t.token)}</span>
    <span class="ds-spacing-bar" style="width: var(${t.token});"></span>
    <span class="muted">${esc(t.value)}</span>
  </div>`;
}
