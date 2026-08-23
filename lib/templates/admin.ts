import { renderHeader, renderFooter } from "../../src/layout/chrome.js";
import { esc } from "./_escape.js";
import { renderHtmlShell } from "./_html-shell.js";

// /admin overview. Hidden URL (no link in the chrome), gated by an
// allowlist enforced server-side on the data endpoint. Browser navs
// don't carry the Bearer JWT, so the shell page itself is
// unauthenticated and an inline boot script fetches the real data
// from /admin/data with Authorization: Bearer <jwt>. Same pattern as
// /u/<un>/bookmarks → /me/bookmarks/feed.
//
// Cards on top, a recent-failures table below. Inline styles only —
// this is the one page that uses them, no need to leak `.adm-*` rules
// into chrome.css.

export type AdminRange = "24h" | "7d" | "30d";

// One account as the operator sees it. `email` is rendered here and
// nowhere else in the app — see the note at the top of
// ingest/admin-handler.ts.
export interface AdminUserRow {
  username: string;
  email: string;
  created_at: string; // ISO-8601, "" on rows that predate the field
  // From UserStatsStore, keyed by user_id. An account that never published
  // has no stats row, which reads as 0 — not "unknown".
  drawings: number;
  streak: number;
  last_publish: string | null; // YYYY-MM-DD
  followers: number;
  following: number;
  has_profile_picture: boolean;
  bio: string;
  link: string;
}

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
  // Product KPIs computed server-side from a recent-drawings scan
  // (DrawingStore, not GA). null when the scan fails so the rest of
  // the page still renders.
  kpis: {
    scanned: number;
    remixes: number;
    remixRatePct: number | null;
    publishesPerDay: number | null;
  } | null;
  // The accounts roster, newest signup first. null when the listing fails
  // so the rest of the page still renders. `scanned` counts the rows read,
  // `shown` the ones in `rows` — the counters describe the scanned set.
  users: {
    scanned: number;
    shown: number;
    truncated: boolean;
    signupsInRange: number;
    withDrawings: number;
    rows: ReadonlyArray<AdminUserRow>;
  } | null;
  // Last 50 failures across all routes, newest first.
  failures: ReadonlyArray<{
    timestamp: string;
    route: string;
    status: number;
    error_code: string;
    error_message: string;
    username: string;
  }>;
  // Merch dry-run flag. null when the flags store is not wired (e.g. dev
  // before the table exists) or the query fails — card shows "—".
  merchFlags: {
    merch_dry_run: boolean;
    updated_at: string | null;
    updated_by: string | null;
  } | null;
}

export interface AdminShellOptions {
  range: AdminRange;
  repo_url: string;
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
      .adm-inner { display: grid; gap: 24px; }
      .adm-del { padding: 2px 8px; font-size: var(--t-xs); line-height: 1.6; }
      .adm-row-gone td { opacity: 0.4; text-decoration: line-through; }
      .adm-flag-dry { color: #b7791f; font-weight: bold; }
      .adm-flag-live { color: #087443; font-weight: bold; }
      .adm-flag-card { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .adm-flag-btn { padding: 8px 16px; font-size: var(--t-sm); cursor: pointer; }
    </style>`;

export function renderAdminShell(opts: AdminShellOptions): string {
  return renderHtmlShell({
    title: "Admin — Draw!",
    extraHead: `<meta name="robots" content="noindex,nofollow">\n    ${ADMIN_STYLES}`,
    bodyAttrs: "data-admin-page",
    body: `    ${renderHeader()}
    <main class="adm-main">
      <div class="adm-bar">
        <div>
          <h1 class="adm-section-title">Admin — overview</h1>
        </div>
        <nav class="adm-range" aria-label="Range">${renderRangeLinks(opts.range)}</nav>
      </div>
      <div class="adm-inner" data-admin-inner>
        <div class="adm-empty" data-admin-loading>Loading admin data…</div>
      </div>
    </main>
    ${renderFooter({ repoUrl: opts.repo_url })}
    ${renderBootScript()}`,
  });
}

// Inline auth + fetch dance. Plain JS so the admin page can ship as a
// single Lambda response without a separate bundle. Mirrors the
// bookmarks shell's renderBootScript() for the same reason: browser
// navigations don't carry the Bearer JWT, so the data has to be
// pulled by the page itself after it loads.
function renderBootScript(): string {
  return `    <script>
(function () {
  var jwt = null;
  try { jwt = localStorage.getItem("drawbang:jwt"); } catch (e) {}
  if (!jwt) {
    var next = encodeURIComponent(location.pathname + location.search);
    location.replace("/login?next=" + next);
    return;
  }
  var url = "/admin/data" + location.search;
  fetch(url, { headers: { Authorization: "Bearer " + jwt } })
    .then(function (res) {
      if (res.status === 401) {
        var next = encodeURIComponent(location.pathname + location.search);
        location.replace("/login?next=" + next);
        return null;
      }
      if (res.status === 403) return "__forbidden__";
      return res.ok ? res.text() : null;
    })
    .then(function (html) {
      var inner = document.querySelector("[data-admin-inner]");
      if (!inner) return;
      if (html === "__forbidden__") {
        inner.innerHTML = '<div class="adm-empty">Not authorised. Your account isn\\'t on the admin allowlist.</div>';
        return;
      }
      if (html === null) {
        inner.innerHTML = '<div class="adm-empty">Couldn\\'t load admin data.</div>';
        return;
      }
      inner.innerHTML = html;
    })
    .catch(function () {
      var inner = document.querySelector("[data-admin-inner]");
      if (inner) inner.innerHTML = '<div class="adm-empty">Couldn\\'t load admin data.</div>';
    });

  // Account deletion, delegated on the container so it survives the
  // innerHTML swap above (and any later re-render). Deleting an account
  // also deletes every drawing it published, so the operator has to type
  // the username out — a plain confirm() is too easy to click through on a
  // table of look-alike rows.
  document.addEventListener("click", function (ev) {
    var btn = ev.target && ev.target.closest && ev.target.closest("[data-delete-user]");
    if (!btn) return;
    ev.preventDefault();
    var username = btn.getAttribute("data-delete-user");
    var drawings = btn.getAttribute("data-drawings") || "0";
    var typed = window.prompt(
      // Newlines in this prompt must be double-escaped: the whole script
      // lives inside a TS template literal, so a single-escaped one is
      // emitted as a real newline and breaks the JS string.
      "Delete @" + username + " and " + drawings + " drawing(s)?\\n\\nThis is permanent. Type the username to confirm:"
    );
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== username) {
      window.alert("That did not match - nothing was deleted.");
      return;
    }
    btn.disabled = true;
    btn.textContent = "Deleting...";
    fetch("/admin/users/" + encodeURIComponent(username), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + jwt }
    })
      .then(function (res) {
        return res.text().then(function (text) {
          var body = null;
          try { body = JSON.parse(text); } catch (e) {}
          return { ok: res.ok, status: res.status, body: body };
        });
      })
      .then(function (r) {
        var row = btn.closest("tr");
        if (r.ok) {
          if (row) row.className = "adm-row-gone";
          btn.textContent = "Deleted";
          return;
        }
        btn.disabled = false;
        btn.textContent = "Delete";
        window.alert("Could not delete @" + username + ": " + ((r.body && r.body.error) || ("HTTP " + r.status)));
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = "Delete";
        window.alert("Could not delete @" + username + ": network error");
      });
  });

  // Merch dry-run toggle — same delegation trick so it survives innerHTML swap.
  document.addEventListener("click", function (ev) {
    var btn = ev.target && ev.target.closest && ev.target.closest("[data-merch-toggle]");
    if (!btn) return;
    ev.preventDefault();
    var current = btn.getAttribute("data-merch-toggle");
    var next = current === "true" ? false : true;
    btn.disabled = true;
    var origText = btn.textContent;
    btn.textContent = "Saving...";
    fetch("/admin/merch/flags", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
      body: JSON.stringify({ merch_dry_run: next })
    })
      .then(function (res) {
        return res.text().then(function (text) {
          var body = null;
          try { body = JSON.parse(text); } catch (e) {}
          return { ok: res.ok, status: res.status, body: body };
        });
      })
      .then(function (r) {
        if (r.ok && r.body && typeof r.body.merch_dry_run === "boolean") {
          var isDry = r.body.merch_dry_run;
          var label = document.querySelector("[data-merch-flag-label]");
          var sub = document.querySelector("[data-merch-flag-sub]");
          if (label) {
            label.textContent = isDry ? "Dry-run" : "Live";
            label.className = isDry ? "adm-flag-dry" : "adm-flag-live";
          }
          if (sub) {
            var when = r.body.updated_at ? new Date(r.body.updated_at).toLocaleString() : "just now";
            var by = r.body.updated_by ? " by " + r.body.updated_by : "";
            sub.textContent = "updated " + when + by;
          }
          btn.setAttribute("data-merch-toggle", String(isDry));
          btn.textContent = isDry ? "Go Live" : "Enable dry-run";
          btn.disabled = false;
          return;
        }
        btn.disabled = false;
        btn.textContent = origText;
        window.alert("Could not toggle merch flag: " + ((r.body && r.body.error) || ("HTTP " + r.status)));
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = origText;
        window.alert("Could not toggle merch flag: network error");
      });
  });
})();
    </script>
`;
}

export function renderAdminInner(v: AdminView): string {
  return `<div class="adm-meta">signed in as ${esc(v.adminUsername)} · generated ${esc(v.generatedAtISO)}</div>
      ${renderMerchFlagCard(v.merchFlags)}
      <div class="adm-grid" aria-label="Site totals + window stats">
        ${renderCard("Total users", numberOrDash(v.totalUsers), "all time, sampled ~6h")}
        ${renderCard("Total drawings", numberOrDash(v.totalDrawings), "all time, sampled ~6h")}
        ${renderCard("New users", outcomeSucc(v.register), `in last ${v.range}`)}
        ${renderCard("New drawings", outcomeSucc(v.publish), `in last ${v.range}`)}
        ${renderCard("Publish success", successRate(v.publish), publishSub(v.publish))}
        ${renderCard("Register success", successRate(v.register), registerSub(v.register))}
      </div>
      ${renderKpisSection(v.kpis)}
      ${renderUsersSection(v.users, v.range)}
      <section aria-labelledby="adm-failures-title">
        <h2 id="adm-failures-title" class="adm-section-title">Recent failures (last 50)</h2>
        ${renderFailuresTable(v.failures)}
      </section>`;
}

function renderMerchFlagCard(flags: AdminView["merchFlags"]): string {
  if (flags == null) {
    return `<section aria-labelledby="adm-merch-title">
        <h2 id="adm-merch-title" class="adm-section-title">Merch</h2>
        <div class="adm-card"><span class="adm-card-label">Merch dry-run</span><span class="adm-num">—</span><span class="adm-sub">flag store not wired</span></div>
      </section>`;
  }
  const isDry = flags.merch_dry_run;
  const labelClass = isDry ? "adm-flag-dry" : "adm-flag-live";
  const labelText = isDry ? "Dry-run" : "Live";
  const when = flags.updated_at ? esc(formatDate(flags.updated_at)) : "never";
  const by = flags.updated_by ? ` by ${esc(flags.updated_by)}` : "";
  const btnText = isDry ? "Go Live" : "Enable dry-run";
  const nextVal = String(isDry);
  return `<section aria-labelledby="adm-merch-title">
        <h2 id="adm-merch-title" class="adm-section-title">Merch</h2>
        <div class="adm-card adm-flag-card">
          <div style="display:grid;gap:4px">
            <span class="adm-card-label">Merch mode</span>
            <span class="adm-num ${labelClass}" data-merch-flag-label>${esc(labelText)}</span>
            <span class="adm-sub" data-merch-flag-sub>updated ${when}${by}</span>
          </div>
          <button type="button" class="btn adm-flag-btn" data-merch-toggle="${esc(nextVal)}">${esc(btnText)}</button>
        </div>
      </section>`;
}

function renderRangeLinks(range: AdminRange): string {
  return RANGES.map((r) => {
    const current = r === range ? ' aria-current="page"' : "";
    return `<a href="/admin?range=${r}"${current}>${r}</a>`;
  }).join("");
}

function renderKpisSection(k: AdminView["kpis"]): string {
  const title =
    k == null ? "Product KPIs" : `Product KPIs (last ${k.scanned} drawings)`;
  return `<section aria-labelledby="adm-kpis-title">
        <h2 id="adm-kpis-title" class="adm-section-title">${esc(title)}</h2>
        <div class="adm-grid">
          ${renderCard("Remix rate", kpiRemixRate(k), kpiRemixSub(k))}
          ${renderCard("Publishes / day", kpiPerDay(k), kpiPerDaySub(k))}
        </div>
      </section>`;
}

function kpiRemixRate(k: AdminView["kpis"]): string {
  if (k == null || k.remixRatePct == null) return "—";
  return `${k.remixRatePct.toFixed(1)}%`;
}

function kpiRemixSub(k: AdminView["kpis"]): string {
  if (k == null) return "drawings query failed";
  if (k.scanned === 0) return "no drawings scanned";
  return `${k.remixes.toLocaleString("en-US")} of ${k.scanned.toLocaleString("en-US")} are remixes`;
}

function kpiPerDay(k: AdminView["kpis"]): string {
  if (k == null || k.publishesPerDay == null) return "—";
  const n = k.publishesPerDay;
  return n >= 1 ? n.toFixed(1) : n.toFixed(2);
}

function kpiPerDaySub(k: AdminView["kpis"]): string {
  if (k == null) return "drawings query failed";
  if (k.publishesPerDay == null) return "needs ≥ 2 drawings";
  return "across the scanned window";
}

function renderUsersSection(u: AdminView["users"], range: AdminRange): string {
  const title = u == null ? "Users" : `Users (${u.scanned.toLocaleString("en-US")})`;
  return `<section aria-labelledby="adm-users-title">
        <h2 id="adm-users-title" class="adm-section-title">${esc(title)}</h2>
        <div class="adm-grid">
          ${renderCard("Signups", usersNum(u, (x) => x.signupsInRange), `in last ${range}`)}
          ${renderCard("Have published", usersNum(u, (x) => x.withDrawings), usersPublishedSub(u))}
          ${renderCard("Never published", usersNum(u, (x) => x.shown - x.withDrawings), "no drawings yet")}
        </div>
        ${renderUsersTable(u)}
      </section>`;
}

function usersNum(
  u: AdminView["users"],
  pick: (x: NonNullable<AdminView["users"]>) => number,
): string {
  return u == null ? "—" : pick(u).toLocaleString("en-US");
}

function usersPublishedSub(u: AdminView["users"]): string {
  if (u == null) return "accounts query failed";
  if (u.shown === 0) return "no accounts yet";
  return `of ${u.shown.toLocaleString("en-US")} listed`;
}

function renderUsersTable(u: AdminView["users"]): string {
  if (u == null) {
    return `<div class="adm-table-wrap"><div class="adm-empty">Couldn't list accounts.</div></div>`;
  }
  if (u.rows.length === 0) {
    return `<div class="adm-table-wrap"><div class="adm-empty">No accounts yet.</div></div>`;
  }
  const body = u.rows
    .map(
      (r) => `<tr>
            <td><a href="/u/${encodeURIComponent(r.username)}">${esc(r.username)}</a>${r.has_profile_picture ? ' <span title="has a profile picture">★</span>' : ""}</td>
            <td>${esc(r.email)}</td>
            <td>${esc(formatDate(r.created_at))}</td>
            <td>${esc(r.drawings)}</td>
            <td>${esc(r.streak)}</td>
            <td>${esc(r.last_publish ?? "—")}</td>
            <td>${esc(r.followers)} / ${esc(r.following)}</td>
            <td class="adm-msg">${esc(truncate(r.bio, 80))}</td>
            <td class="adm-msg">${esc(truncate(r.link, 40))}</td>
            <td><button type="button" class="btn danger adm-del" data-delete-user="${esc(r.username)}" data-drawings="${esc(r.drawings)}">Delete</button></td>
          </tr>`,
    )
    .join("");
  const note = u.truncated
    ? `<div class="adm-sub">Listing capped — more accounts exist than were scanned.</div>`
    : u.shown < u.scanned
      ? `<div class="adm-sub">Showing the ${u.shown.toLocaleString("en-US")} newest of ${u.scanned.toLocaleString("en-US")} accounts.</div>`
      : "";
  return `<div class="adm-table-wrap">
        <table class="adm-table">
          <thead>
            <tr>
              <th>username</th>
              <th>email</th>
              <th>registered</th>
              <th>drawings</th>
              <th>streak</th>
              <th>last publish</th>
              <th>followers / following</th>
              <th>bio</th>
              <th>link</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>${note}`;
}

// The bio/link cells are the only free-text a user controls on this page.
// esc() handles the markup side; this keeps one long bio from stretching
// the table past the viewport.
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
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
