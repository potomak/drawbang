// Lospec palette import. One flexible text input accepts a palette slug
// ("sweetie-16"), a full lospec.com palette URL, or a pasted hex list —
// parsing is pure so the fetch stays at the call site.

export type ImportRequest =
  | { kind: "slug"; slug: string }
  | { kind: "colors"; colors: readonly string[] };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LOSPEC_URL_RE = /lospec\.com\/palette-list\/([a-z0-9][a-z0-9-]*)/i;

// Accepts "#rrggbb", "rrggbb", "#rgb", "rgb" → canonical "#rrggbb".
export function normalizeHex(token: string): string | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(token.trim());
  if (!m) return null;
  let hex = m[1].toLowerCase();
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  return `#${hex}`;
}

export function parseImportInput(raw: string): ImportRequest | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const urlMatch = LOSPEC_URL_RE.exec(trimmed);
  if (urlMatch) return { kind: "slug", slug: urlMatch[1].toLowerCase() };
  const tokens = trimmed.split(/[\s,;]+/).filter((t) => t.length > 0);
  const hexes = tokens.map(normalizeHex);
  // A single bare token reads as a slug even when its six chars are all hex
  // ("fabada" is a plausible palette name); prefix "#" to force the color
  // reading.
  if (hexes.every((h) => h !== null) && (tokens.length > 1 || tokens[0].startsWith("#"))) {
    return { kind: "colors", colors: hexes as string[] };
  }
  if (tokens.length === 1) {
    const slug = tokens[0].toLowerCase();
    if (SLUG_RE.test(slug)) return { kind: "slug", slug };
  }
  return null;
}

export function lospecPaletteUrl(slug: string): string {
  return `https://lospec.com/palette-list/${slug}.json`;
}

// Response shape: {"name": "Sweetie 16", "author": "…", "colors": ["1a1c2c", …]}
// — hex entries come WITHOUT the leading "#".
export function parseLospecJson(
  data: unknown,
  fallbackName: string,
): { name: string; colors: readonly string[] } {
  if (typeof data !== "object" || data === null) {
    throw new Error("unexpected Lospec response");
  }
  const { name, colors } = data as { name?: unknown; colors?: unknown };
  if (!Array.isArray(colors) || colors.length === 0) {
    throw new Error("unexpected Lospec response");
  }
  const normalized = colors.map((c) => (typeof c === "string" ? normalizeHex(c) : null));
  if (normalized.some((c) => c === null)) {
    throw new Error("unexpected Lospec response");
  }
  return {
    name: typeof name === "string" && name.trim() !== "" ? name.trim() : fallbackName,
    colors: normalized as string[],
  };
}
