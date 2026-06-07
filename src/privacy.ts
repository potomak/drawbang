// TODO (#shared-localstorage): the try/catch localStorage wrappers below
// duplicate the same pattern in auth.ts, order.ts, main.ts, and the three
// static/ JS files. Extract safeGet/safeSet/safeRemove into
// src/storage-utils.ts.

// /privacy page: opt-out toggle that flips the same localStorage key the
// pre-snippet gate in src/layout/tracking.ts reads on every page load.
// Status indicator reflects the current state; the toggle button writes
// (or removes) the key and prompts a reload — the gate runs before
// gtag.js loads, so a reload is required to actually apply the change.

import { ANALYTICS_OPT_OUT_KEY } from "./layout/tracking.js";

const statusEl = document.getElementById("pv-status") as HTMLDivElement;
const statusTextEl = document.getElementById("pv-status-text") as HTMLElement;
const toggleBtn = document.getElementById("pv-toggle") as HTMLButtonElement;
const reloadNoteEl = document.getElementById("pv-reload-note") as HTMLElement;

function readOptOut(): boolean {
  try {
    return localStorage.getItem(ANALYTICS_OPT_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOptOut(value: boolean): boolean {
  try {
    if (value) {
      localStorage.setItem(ANALYTICS_OPT_OUT_KEY, "1");
    } else {
      localStorage.removeItem(ANALYTICS_OPT_OUT_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

function render(state: "tracked" | "opted_out"): void {
  statusEl.dataset.state = state;
  if (state === "opted_out") {
    statusTextEl.textContent = "Opted out — analytics will not load on the next page.";
    toggleBtn.textContent = "Turn analytics back on";
  } else {
    statusTextEl.textContent = "Currently tracked — Google Analytics and Meta Pixel are active.";
    toggleBtn.textContent = "Opt out on this device";
  }
  toggleBtn.disabled = false;
}

function showReloadNote(): void {
  reloadNoteEl.hidden = false;
}

function boot(): void {
  if (!statusEl || !statusTextEl || !toggleBtn) return;
  render(readOptOut() ? "opted_out" : "tracked");
  toggleBtn.addEventListener("click", () => {
    const target = !readOptOut();
    const ok = writeOptOut(target);
    if (!ok) {
      statusTextEl.textContent =
        "Couldn't save the setting — localStorage is unavailable in this browser session.";
      return;
    }
    render(target ? "opted_out" : "tracked");
    showReloadNote();
  });
}

boot();
