// Shared time formatters for the server-rendered templates. Lives outside
// any specific page template so home.ts + gallery.ts + tile-page.ts can
// import without dragging each other's page-level exports in.

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Compact date for thumbnails / feed cards: "May 28" if same year as the
// current UTC year, "May 28, 2025" otherwise. UTC-anchored so server +
// client renders agree on cached HTML.
export function formatItemDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const m = SHORT_MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  const y = d.getUTCFullYear();
  const sameYear = y === now.getUTCFullYear();
  return sameYear ? `${m} ${day}` : `${m} ${day}, ${y}`;
}
