// TODO: This function is not used anywhere and I think it can be deleted...

// Human-readable duration formatting for user-facing messages. Drops
// seconds when hours are present (an "8 minute and 12 second" precision
// tail next to "2 hours" reads as noise, not info).

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total === 0) return "0 seconds";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  const parts: string[] = [];
  if (h > 0) parts.push(plural(h, "hour"));
  if (m > 0) parts.push(plural(m, "minute"));
  if (s > 0 && h === 0) parts.push(plural(s, "second"));

  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}
