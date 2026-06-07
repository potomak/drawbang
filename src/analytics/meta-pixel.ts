// Vendor wrapper for Meta (Facebook) Pixel (fbq). Internal to
// src/analytics/ — the rest of the app talks to Meta Pixel exclusively
// through the public Tracker in ./analytics.ts. Mirrors the structure
// of ./google-analytics.ts so callers can fan an event into either or
// both vendors without coupling the SDKs.
//
// Param shapes follow Meta's standard events reference:
//   https://developers.facebook.com/docs/meta-pixel/reference

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
  }
}

export function fbqEvent(
  name: string,
  params: Record<string, unknown> = {},
): void {
  if (typeof window === "undefined" || typeof window.fbq !== "function") return;
  try {
    window.fbq("track", name, params);
  } catch {
    // Pixel failures must never break the page.
  }
}
