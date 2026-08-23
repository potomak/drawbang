import { renderHeader, renderFooter } from "../../src/layout/chrome.js";
import { esc } from "./_escape.js";
import { renderHtmlShell } from "./_html-shell.js";
import type { Order } from "../../merch/orders.js";

const ADMIN_STYLES = `<style>
  .adm-orders-main { max-width: 1100px; margin: 0 auto; padding: 24px var(--pad); display: grid; gap: 16px; }
  .adm-orders-table-wrap { overflow-x: auto; border: var(--border) solid var(--line); background: var(--paper-2); }
  .adm-orders-table { width: 100%; border-collapse: collapse; font-size: var(--t-xs); font-family: var(--font-mono); }
  .adm-orders-table th, .adm-orders-table td { padding: 8px 10px; text-align: left; border-bottom: var(--border) solid var(--line); white-space: nowrap; vertical-align: middle; }
  .adm-orders-table th { background: var(--paper-2); text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-muted); }
  .adm-orders-table tr:last-child td { border-bottom: 0; }
  .adm-orders-table select { font-size: var(--t-xs); padding: 4px 6px; }
  .adm-orders-table .btn { padding: 4px 8px; font-size: var(--t-xs); }
  .adm-env-prod { color: #087443; font-weight: bold; }
  .adm-env-sandbox { color: #b7791f; font-weight: bold; }
</style>`;

export function renderAdminOrdersShell(): string {
  return renderHtmlShell({
    title: "Admin Orders — Draw!",
    extraHead: `<meta name="robots" content="noindex,nofollow">\n    ${ADMIN_STYLES}`,
    bodyAttrs: "data-admin-orders-page",
    body: `    ${renderHeader()}
    <main class="adm-orders-main">
      <h1 class="adm-section-title">Admin — Orders</h1>
      <p class="adm-meta"><a href="/admin">← Back to overview</a> · <a href="/">Home</a></p>
      <div data-admin-orders-inner><div class="adm-empty">Loading orders…</div></div>
    </main>
    ${renderFooter({ repoUrl: "" })}
    ${renderAdminOrdersBootScript()}`,
  });
}

function renderAdminOrdersBootScript(): string {
  return `    <script>
(function () {
  var jwt = null;
  try { jwt = localStorage.getItem("drawbang:jwt"); } catch (e) {}
  if (!jwt) { location.replace("/login?next=" + encodeURIComponent(location.pathname)); return; }
  function load() {
    fetch("/admin/orders/data", { headers: { Authorization: "Bearer " + jwt } })
      .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status)); })
      .then(function (html) { var el = document.querySelector("[data-admin-orders-inner]"); if (el) el.innerHTML = html; })
      .catch(function () { var el = document.querySelector("[data-admin-orders-inner]"); if (el) el.innerHTML = '<div class="adm-empty">Could not load orders.</div>'; });
  }
  load();
  document.addEventListener("click", function (ev) {
    var btn = ev.target && ev.target.closest && ev.target.closest("[data-order-save]");
    if (!btn) return;
    ev.preventDefault();
    var row = btn.closest("tr");
    if (!row) return;
    var orderId = btn.getAttribute("data-order-save");
    var statusSel = row.querySelector("[data-order-status]");
    var envSel = row.querySelector("[data-order-env]");
    var status = statusSel ? statusSel.value : null;
    var env = envSel ? envSel.value : null;
    btn.disabled = true;
    btn.textContent = "Saving…";
    fetch("/admin/orders/" + encodeURIComponent(orderId) + "/status", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
      body: JSON.stringify({ status: status, env: env })
    }).then(function (r) { return r.text().then(function (t) { var b=null; try{ b=JSON.parse(t);}catch(e){} return {ok:r.ok,status:r.status,body:b}; }); })
      .then(function (r) {
        btn.disabled = false;
        btn.textContent = "Save";
        if (!r.ok) { alert("Failed: " + ((r.body && r.body.error) || r.status)); return; }
        load();
      }).catch(function () { btn.disabled=false; btn.textContent="Save"; alert("Network error"); });
  });
})();
    </script>
`;
}

export function renderAdminOrdersInner(orders: ReadonlyArray<Order>): string {
  if (orders.length === 0) {
    return `<div class="adm-orders-table-wrap"><div class="adm-empty">No orders yet.</div></div>`;
  }
  const rows = orders
    .map((o) => {
      const shortId = esc(o.order_id.slice(0, 8));
      const env = esc(o.env ?? "—");
      const envCls = o.env === "prod" ? "adm-env-prod" : o.env === "sandbox" ? "adm-env-sandbox" : "";
      const created = esc(formatDate(o.created_at));
      const amount = esc(o.retail_cents !== undefined ? "$" + (o.retail_cents / 100).toFixed(2) : "—");
      const product = esc(o.product_id);
      const variant = esc(String(o.variant_id));
      const email = esc(o.customer_email ?? "—");
      const statusOpts = allStatuses()
        .map((s) => `<option value="${esc(s)}"${s === o.status ? " selected" : ""}>${esc(s)}</option>`)
        .join("");
      const envOpts = (["prod", "sandbox"] as const)
        .map((e) => `<option value="${esc(e)}"${e === o.env ? " selected" : ""}>${esc(e)}</option>`)
        .join("");
      return `<tr>
        <td><code title="${esc(o.order_id)}">${shortId}…</code></td>
        <td class="${envCls}">${env}</td>
        <td><select data-order-status>${statusOpts}</select></td>
        <td>${created}</td>
        <td>${product} / ${variant}</td>
        <td>${amount}</td>
        <td title="${email}">${email}</td>
        <td>
          <select data-order-env>${envOpts}</select>
        </td>
        <td><button type="button" class="btn" data-order-save="${esc(o.order_id)}">Save</button></td>
        <td><a href="/merch/order/${esc(o.order_id)}" target="_blank">view</a></td>
      </tr>`;
    })
    .join("");
  return `<div class="adm-orders-table-wrap">
    <table class="adm-orders-table">
      <thead><tr><th>order</th><th>env</th><th>status</th><th>created</th><th>product</th><th>amount</th><th>email</th><th>env edit</th><th></th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function allStatuses(): string[] {
  return ["pending", "paid", "submitted", "in_production", "shipped", "delivered", "failed", "refunded"];
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}
