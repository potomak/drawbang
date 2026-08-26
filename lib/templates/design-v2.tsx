import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { renderHtmlShell } from "./_html-shell.js";

// React pilot for #1 — additive /v2/design. Existing /design stays on
// string templates (lib/templates/design.ts). This file is the same view
// as DesignView but rendered with React components and react-dom/server.
// Proves the component model on the most isolated route before touching
// /, /d/<id>, or /u/*.

export interface DesignV2View {
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

const DESIGN_STYLES = `<style>
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
    </style>`;

function Section({
  title,
  lede,
  children,
}: {
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <section className="ds-row">
      <div className="ds-section-head">
        <h2>{title}</h2>
        <small>{lede}</small>
      </div>
      {children}
    </section>
  );
}

function ColorSwatch({ name, role }: { name: string; role: string }) {
  return (
    <div className="ds-swatch">
      <div className="ds-swatch-chip" style={{ background: `var(${name})` }} />
      <div className="ds-swatch-name">{name}</div>
      <div className="ds-swatch-role">{role}</div>
    </div>
  );
}

function TypeRow({ token, sample }: { token: string; sample: string }) {
  return (
    <div className="ds-type-row">
      <span className="ds-type-token">{token}</span>
      <span style={{ fontSize: `var(${token})` }}>{sample}</span>
    </div>
  );
}

function SpacingRow({ token, value }: { token: string; value: string }) {
  return (
    <div className="ds-spacing-row">
      <span className="ds-type-token">{token}</span>
      <span className="ds-spacing-bar" style={{ width: `var(${token})` }} />
      <span className="muted">{value}</span>
    </div>
  );
}

function DesignGrid() {
  return (
    <div className="ds-grid">
      <Section
        title="Color tokens"
        lede="Single accent rationed to CTA + active. No additional brand colors."
      >
        <div className="ds-swatches">
          {COLOR_TOKENS.map((t) => (
            <ColorSwatch key={t.name} name={t.name} role={t.role} />
          ))}
        </div>
      </Section>

      <Section title="Type scale" lede="Six steps. Sans for prose, mono for labels.">
        <div className="ds-row">
          {TYPE_SCALE.map((t) => (
            <TypeRow key={t.token} token={t.token} sample={t.sample} />
          ))}
        </div>
      </Section>

      <Section title="Spacing tokens" lede="Use these inline; never invent new step values.">
        <div className="ds-row">
          {SPACING_TOKENS.map((t) => (
            <SpacingRow key={t.token} token={t.token} value={t.value} />
          ))}
        </div>
      </Section>

      <Section
        title="Buttons"
        lede="Base + .primary + .ghost + .danger in chrome.css. Variants .icon/.sm/.xs live in src/style.css."
      >
        <div className="ds-buttons">
          <button className="btn">Default</button>
          <button className="btn primary">Primary</button>
          <button className="btn ghost">Ghost</button>
          <button className="btn danger">Danger</button>
          <a className="btn" href="#">
            Link as button
          </a>
          <button className="btn" disabled>
            Disabled
          </button>
        </div>
      </Section>

      <Section
        title="Follow button"
        lede=".follow-btn — filled accent when unfollowed (the action), outlined when followed (the state)."
      >
        <div className="ds-buttons">
          <button className="follow-btn" type="button" aria-pressed="false">
            <span className="follow-label">Follow</span>
          </button>
          <button className="follow-btn" type="button" aria-pressed="true">
            <span className="follow-label">Following</span>
          </button>
        </div>
      </Section>

      <Section
        title="Badge"
        lede=".badge — small inline label for accomplishments, statuses, counts. Hairline border + mono micro-label on paper-2 fill. Use .badge.accent for highlighted variants."
      >
        <div className="ds-buttons">
          <span className="badge">Beta</span>
          <span className="badge">Daily streak</span>
          <span className="badge accent">New</span>
        </div>
      </Section>

      <Section title="Page chrome" lede=".page-title, .page-sub, .divider, .panel-h, .muted.">
        <h2 className="page-title">Page title</h2>
        <p className="page-sub">Page subtitle — small muted note under the title.</p>
        <hr className="divider" />
        <h3 className="panel-h">Panel header label</h3>
        <p className="muted">Muted body copy for tertiary information.</p>
      </Section>

      <Section title="Feed card" lede="Single canonical card. Do not vary.">
        <article className="ds-sample-card">
          <header className="feed-card-author">
            <a className="feed-card-author-link" href="#">
              @artist
            </a>
            <span className="feed-card-sep">·</span>
            <time className="feed-card-time">Jun 6, 2026</time>
          </header>
          <div className="ds-sample-art">16×16 GIF goes here</div>
          <div className="feed-card-actions">
            <button className="feed-action like-btn" aria-pressed="false">
              <span className="like-icon">♥</span>
              <span className="like-count">42</span>
            </button>
            <button className="feed-action bookmark-btn" aria-pressed="false">
              <span className="bookmark-icon">🔖</span>
            </button>
          </div>
        </article>
      </Section>

      <Section
        title="Flash"
        lede="window.drawbangShowFlash(message, opts). Never inline-render error paragraphs."
      >
        {/* Static onclick preserved via raw HTML so renderToStaticMarkup emits it — React synthetic onClick would be dropped */}
        <div
          className="ds-buttons"
          dangerouslySetInnerHTML={{
            __html: `<button class="btn" onclick="window.drawbangShowFlash && window.drawbangShowFlash('Saved.', { kind: 'success' })">Trigger success</button><button class="btn" onclick="window.drawbangShowFlash && window.drawbangShowFlash('Something went wrong.', { kind: 'error' })">Trigger error</button>`,
          }}
        />
      </Section>
    </div>
  );
}

export default function renderDesignV2(v: DesignV2View): string {
  // Keep shell + header/footer as string helpers for this pilot — only the
  // inner grid is React. Next step migrates _html-shell and chrome to JSX.
  const gridHtml = renderToStaticMarkup(<DesignGrid />);
  const body = `    ${renderHeader()}
    <main>
      <h1 class="page-title">Design system</h1>
      <p class="page-sub">Visual reference for tokens + components defined in <code>static/chrome.css</code> and described in <code>docs/design-system.md</code>.</p>
      ${gridHtml}
    </main>
    ${renderFooter({ repoUrl: v.repo_url })}`;
  return renderHtmlShell({
    title: "Draw! · Design system — v2 (React)",
    extraHead: DESIGN_STYLES,
    body,
  });
}
