import { renderHeader, renderFooter } from "../../src/layout/chrome.js";
import { esc } from "./_escape.js";
import { renderHtmlShell } from "./_html-shell.js";

// /admin overview. Hidden URL (no link in the chrome), gated by an
// allowlist in lambda.ts before this template runs. Cards on top, a
// recent-failures table below. Inline styles only — this is the one
// page that uses them, no need to leak `.adm-*` rules into chrome.css.

export type AdminRange = "24h" | "7d" | "30d";

export interface AdminView {
  adminUsername: string;
  range: AdminRange;
  generatedAtISO: string;
  // Both counts come from DescribeTable.ItemCount, which is sampled
  // every ~6h. null when the call fails — the card shows "—" instead.
  totalUsers: number | null;
  totalDrawings: number | null;
  // Aggregate publish + register outcomes inside the selected range.
  // null when the Insights query fails so a transient log-group hiccup
  // doesn't 500 the whole page.
  publish: { succ: number; fail: number; total: number } | null;
  register: { succ: number; fail: number; total: number } | null;
  // Last 50 failures across all routes, newest first.
  failures: ReadonlyArray<{
    timestamp: string;
    route: string;
    status: number;
    error_code: string;
    error_message: string;
    username: string;
  }>;
}

const RANGES: ReadonlyArray<AdminRange> = ["24h", "7d", "30d"];

const ADMIN_STYLES = `<style>
      .adm-main { display: grid; gap: 24px; padding: 24px var(--pad); max-width: 1100px; margin: 0 auto; }
      .adm-bar { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
      .adm-range { display: flex; gap: 8px; }
      .adm-range a { padding: 6px 12px; border: var(--border) solid var(--line); text-decoration: none; color: var(--ink); font-size: var(--t-sm); }
      .adm-range a[aria-current="page"] { background: var(--accent); color: var(--accent-on); border-color: var(--accent); }
      .adm-meta { color: var(--fg-muted); font-size: var(--t-xs); }
      .adm-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
      .adm-card { border: var(--border) solid var(--line); padding: 16px; display: grid; gap: 6px; background: var(--paper-2); }
      .adm-card-label { font-size: var(--t-xs); color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; }
      .adm-num { font-size: var(--t-2xl); font-family: var(--font-mono); }
      .adm-sub { font-size: var(--t-xs); color: var(--fg-muted); }
      .adm-section-title { font-size: var(--t-lg); margin: 0; }
      .adm-table-wrap { overflow-x: auto; border: var(--border) solid var(--line); }
      .adm-table { width: 100%; border-collapse: collapse; font-size: var(--t-xs); font-family: var(--font-mono); }
      .adm-table th, .adm-table td { padding: 6px 10px; text-align: left; border-bottom: var(--border) solid var(--line); white-space: nowrap; }
      .adm-table tr:last-child td { border-bottom: 0; }
      .adm-table th { background: var(--paper-2); font-size: var(--t-xs); text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-muted); }
      .adm-table td.adm-msg { white-space: normal; max-width: 360px; }
      .adm-status-4xx { color: var(--ink); }
      .adm-status-5xx { color: #b00020; font-weight: bold; }
      .adm-empty { padding: 24px; text-align: center; color: var(--fg-muted); }
    </style>`;

export function renderAdmin(v: AdminView): string {
  return renderHtmlShell({
    title: "Admin — Draw!",
    extraHead: `<meta name="robots" content="noindex,nofollow">\n    ${ADMIN_STYLES}`,
    body: `    ${renderHeader()}
    <main class="adm-main">
      ${renderBar(v)}
      <div class="adm-grid" aria-label="Site totals + window stats">
        ${renderCard("Total users", numberOrDash(v.totalUsers), "all time, sampled ~6h")}
        ${renderCard("Total drawings", numberOrDash(v.totalDrawings), "all time, sampled ~6h")}
        ${renderCard("New users", outcomeSucc(v.register), `in last ${v.range}`)}
        ${renderCard("New drawings", outcomeSucc(v.publish), `in last ${v.range}`)}
        ${renderCard("Publish success", successRate(v.publish), publishSub(v.publish))}
        ${renderCard("Register success", successRate(v.register), registerSub(v.register))}
      </div>
      <section aria-labelledby="adm-failures-title">
        <h2 id="adm-failures-title" class="adm-section-title">Recent failures (last 50)</h2>
        ${renderFailuresTable(v.failures)}
      </section>
    </main>
    ${renderFooter({ repoUrl: "https://github.com/potomak/drawbang" })}`,
  });
}

function renderBar(v: AdminView): string {
  const links = RANGES.map((r) => {
    const current = r === v.range ? ' aria-current="page"' : "";
    return `<a href="/admin?range=${r}"${current}>${r}</a>`;
  }).join("");
  return `<div class="adm-bar">
        <div>
          <h1 class="adm-section-title">Admin — overview</h1>
          <div class="adm-meta">signed in as ${esc(v.adminUsername)} · generated ${esc(v.generatedAtISO)}</div>
        </div>
        <nav class="adm-range" aria-label="Range">${links}</nav>
      </div>`;
}

function renderCard(label: string, num: string, sub: string): string {
  return `<div class="adm-card">
          <span class="adm-card-label">${esc(label)}</span>
          <span class="adm-num">${esc(num)}</span>
          <span class="adm-sub">${esc(sub)}</span>
        </div>`;
}

function renderFailuresTable(
  rows: AdminView["failures"],
): string {
  if (rows.length === 0) {
    return `<div class="adm-table-wrap"><div class="adm-empty">No failures in the selected range — site is healthy.</div></div>`;
  }
  const body = rows
    .map(
      (r) => `<tr>
            <td>${esc(formatTimestamp(r.timestamp))}</td>
            <td>${esc(r.route)}</td>
            <td class="${statusClass(r.status)}">${esc(r.status)}</td>
            <td>${esc(r.error_code)}</td>
            <td class="adm-msg">${esc(r.error_message)}</td>
            <td>${esc(r.username)}</td>
          </tr>`,
    )
    .join("");
  return `<div class="adm-table-wrap">
        <table class="adm-table">
          <thead>
            <tr>
              <th>time</th>
              <th>route</th>
              <th>status</th>
              <th>error_code</th>
              <th>error_message</th>
              <th>username</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
}

function numberOrDash(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("en-US");
}

function outcomeSucc(o: AdminView["publish"] | AdminView["register"]): string {
  return o == null ? "—" : o.succ.toLocaleString("en-US");
}

function successRate(
  o: AdminView["publish"] | AdminView["register"],
): string {
  if (o == null) return "—";
  if (o.total === 0) return "—";
  const pct = (o.succ / o.total) * 100;
  return `${pct.toFixed(1)}%`;
}

function publishSub(
  o: AdminView["publish"],
): string {
  if (o == null || o.total === 0) return "no /ingest traffic";
  return `${o.succ.toLocaleString("en-US")} of ${o.total.toLocaleString("en-US")}`;
}

function registerSub(
  o: AdminView["register"],
): string {
  if (o == null || o.total === 0) return "no /auth/register traffic";
  return `${o.succ.toLocaleString("en-US")} of ${o.total.toLocaleString("en-US")}`;
}

function statusClass(status: number): string {
  if (status >= 500) return "adm-status-5xx";
  return "adm-status-4xx";
}

function formatTimestamp(ts: string): string {
  // CWLogs Insights gives us @timestamp like "2026-06-08 17:24:17.149".
  // Strip the milliseconds for the table; show date + HH:MM:SS UTC.
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(ts);
  return m ? `${m[1]} ${m[2]}` : ts;
}
