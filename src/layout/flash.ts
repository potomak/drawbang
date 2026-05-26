// Module-level singleton flash slot. Pinned below the sticky header via
// position: fixed, replaces the per-page `<p id="status">` strips that
// users couldn't see after clicking Publish.
//
// Default behavior is sticky — callers explicitly opt in to auto-dismiss
// for trivial nudges by passing `autoDismissMs`. Each showFlash replaces
// the previous one in place, which means PoW progress that updates every
// few hundred ms just works without any extra API.
//
// The chrome footer (src/layout/chrome.ts) loads /flash.js on every surface,
// which installs window.drawbang{Show,Hide}Flash + the pending-flash
// auto-consumer. showFlash/hideFlash below delegate to those globals when
// present so the DOM is single-owner; the local impl is the fallback for
// environments where the chrome script hasn't loaded yet (or at all).

const PENDING_FLASH_KEY = "drawbang:pending-flash";

export type FlashKind = "info" | "success" | "error";

export interface FlashAction {
  label: string;
  href: string;
}

export interface FlashOptions {
  kind: FlashKind;
  message: string | Node | ReadonlyArray<string | Node>;
  action?: FlashAction;
  /**
   * Auto-dismiss timeout in ms. Undefined or non-finite → sticky (the user
   * must click X to dismiss). The timer is paused while the host is hovered
   * or contains focus, so a user reaching for a link can't lose it.
   */
  autoDismissMs?: number;
}

interface DismissTimer {
  remainingMs: number;
  startedAt: number;
  handle: ReturnType<typeof setTimeout>;
}

let host: HTMLDivElement | null = null;
let msgSlot: HTMLSpanElement | null = null;
let actionSlot: HTMLAnchorElement | null = null;
let timer: DismissTimer | null = null;

function ensureHost(): HTMLDivElement {
  if (host) return host;
  const el = document.createElement("div");
  el.className = "flash";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("data-kind", "info");
  el.hidden = true;

  const body = document.createElement("div");
  body.className = "flash-body";

  const msg = document.createElement("span");
  msg.className = "flash-msg";

  const action = document.createElement("a");
  action.className = "flash-action";
  action.target = "_blank";
  action.rel = "noopener";
  action.hidden = true;

  body.appendChild(msg);
  body.appendChild(action);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "flash-close";
  close.setAttribute("aria-label", "Dismiss message");
  close.textContent = "×"; // ×
  close.addEventListener("click", () => hideFlash());

  el.appendChild(body);
  el.appendChild(close);

  // Pause/resume the auto-dismiss timer on hover and keyboard focus so a
  // user reaching for the success link can't lose it.
  el.addEventListener("mouseenter", pauseTimer);
  el.addEventListener("mouseleave", resumeTimer);
  el.addEventListener("focusin", pauseTimer);
  el.addEventListener("focusout", resumeTimer);

  document.body.appendChild(el);
  host = el;
  msgSlot = msg;
  actionSlot = action;
  return el;
}

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer.handle);
    timer = null;
  }
}

function pauseTimer(): void {
  if (!timer || timer.startedAt === 0) return;
  const elapsed = Date.now() - timer.startedAt;
  const remaining = Math.max(0, timer.remainingMs - elapsed);
  clearTimeout(timer.handle);
  timer = { remainingMs: remaining, startedAt: 0, handle: 0 as unknown as ReturnType<typeof setTimeout> };
}

function resumeTimer(): void {
  if (!timer || timer.startedAt !== 0) return;
  const remaining = timer.remainingMs;
  if (remaining <= 0) {
    timer = null;
    hideFlash();
    return;
  }
  timer = {
    remainingMs: remaining,
    startedAt: Date.now(),
    handle: setTimeout(() => hideFlash(), remaining),
  };
}

interface FlashWindow extends Window {
  drawbangShowFlash?: (opts: FlashOptions) => void;
  drawbangHideFlash?: () => void;
}

function chromeFlash(): FlashWindow | null {
  return typeof window === "undefined" ? null : (window as FlashWindow);
}

export function showFlash(opts: FlashOptions): void {
  const w = chromeFlash();
  if (w && typeof w.drawbangShowFlash === "function") {
    w.drawbangShowFlash(opts);
    return;
  }
  showFlashLocal(opts);
}

/**
 * Queue a flash to render on the next page load. Used across navigations
 * (sign-in/up/out, password reset) where the page that triggers the action
 * isn't the page the user sees afterward. The receiving page's flash.js
 * auto-consumes this on init. JSON-serialized, so `message` must be a string
 * — no Node messages survive the trip.
 */
export interface PendingFlashOptions {
  kind: FlashKind;
  message: string;
  action?: FlashAction;
  autoDismissMs?: number;
}

export function setPendingFlash(opts: PendingFlashOptions): void {
  try {
    sessionStorage.setItem(PENDING_FLASH_KEY, JSON.stringify(opts));
  } catch {
    // private mode / storage unavailable — best effort.
  }
}

function showFlashLocal(opts: FlashOptions): void {
  const el = ensureHost();
  const msg = msgSlot!;
  const action = actionSlot!;

  clearTimer();

  el.setAttribute("data-kind", opts.kind);
  // Errors get role="alert" so screen readers announce them more
  // aggressively; info/success stay polite.
  el.setAttribute("role", opts.kind === "error" ? "alert" : "status");

  const children: Array<string | Node> = Array.isArray(opts.message)
    ? [...opts.message]
    : [opts.message as string | Node];
  const nodes = children.map((c) =>
    typeof c === "string" ? document.createTextNode(c) : c,
  );
  msg.replaceChildren(...nodes);

  if (opts.action) {
    action.textContent = opts.action.label;
    action.href = opts.action.href;
    action.hidden = false;
  } else {
    action.hidden = true;
    action.removeAttribute("href");
    action.textContent = "";
  }

  // Only run the slide-in animation when transitioning from hidden to
  // visible. Replacing text on a visible flash (e.g. PoW progress ticks)
  // must not re-animate or the bar flickers every few hundred ms.
  const wasHidden = el.hidden;
  el.hidden = false;
  if (wasHidden) {
    el.style.animation = "none";
    void el.offsetHeight; // reflow → restart the keyframe
    el.style.animation = "";
  }

  const ms = opts.autoDismissMs;
  if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
    timer = {
      remainingMs: ms,
      startedAt: Date.now(),
      handle: setTimeout(() => hideFlash(), ms),
    };
  }
}

export function hideFlash(): void {
  const w = chromeFlash();
  if (w && typeof w.drawbangHideFlash === "function") {
    w.drawbangHideFlash();
    return;
  }
  hideFlashLocal();
}

function hideFlashLocal(): void {
  clearTimer();
  if (!host) return;
  host.hidden = true;
  if (msgSlot) msgSlot.replaceChildren();
  if (actionSlot) {
    actionSlot.hidden = true;
    actionSlot.removeAttribute("href");
    actionSlot.textContent = "";
  }
}
