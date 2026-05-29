const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(v: unknown): string {
  if (v == null) return "";
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]!);
}
