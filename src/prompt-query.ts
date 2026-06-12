// ?prompt=<slug> handling for /draw. Pure (no DOM) so node:test can cover
// the gating logic: only TODAY's ET prompt counts. A stale or garbage slug
// degrades to a plain editor — no chip, no tag, never an error.

import { PROMPT_SLUG_RE, promptForDate, type Prompt } from "../config/prompts.js";

export function promptFromQuery(search: string, now: Date): Prompt | null {
  const slug = new URLSearchParams(search).get("prompt");
  if (!slug || !PROMPT_SLUG_RE.test(slug)) return null;
  const today = promptForDate(now);
  return slug === today.slug ? today : null;
}

// Guidance copy only — the editor never enforces prompt rules.
export function promptGuidanceHint(p: Prompt): string | null {
  const parts: string[] = [];
  if (p.rules?.maxColors) parts.push(`try ≤${p.rules.maxColors} colors`);
  if (p.rules?.size) parts.push(`try ${p.rules.size}×${p.rules.size}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
