// Vendor wrapper for Google Analytics 4 (gtag.js). Internal to
// src/analytics/ — the rest of the app talks to GA exclusively through
// the public Tracker in ./analytics.ts. Centralises three things:
//
//   1. The window.gtag type (the global isn't in @types/web).
//   2. A no-op guard so pages that ship without the GA snippet (or
//      visitors with an ad blocker) don't throw.
//   3. A try/catch so analytics failures never break the page.
//
// Param schemas follow the GA4 reference:
//   https://developers.google.com/analytics/devguides/collection/ga4/reference/events

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

export function gtagEvent(
  name: string,
  params: Record<string, unknown> = {},
): void {
  if (typeof window === "undefined" || typeof window.gtag !== "function") return;
  try {
    window.gtag("event", name, params);
  } catch {
    // Analytics failures must never break the page.
  }
}
