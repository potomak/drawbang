const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// TODO (#shared-escape): canonical copy; src/layout/chrome.ts and
// src/order.ts carry duplicates (docs/architecture-review-2026-06.md).
export function esc(v: unknown): string {
  if (v == null) return "";
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]!);
}
