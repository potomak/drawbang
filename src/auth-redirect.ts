// Resolve the post-login destination from ?next=, restricted to same-origin
// absolute paths so an attacker can't craft a login link that bounces the
// user to an external site.
export function safeNext(fallback = "/"): string {
  try {
    const next = new URLSearchParams(location.search).get("next");
    if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  } catch {
    // ignore malformed URLs
  }
  return fallback;
}
