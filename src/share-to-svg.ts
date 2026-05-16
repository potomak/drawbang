import { TRANSPARENT } from "./editor/bitmap.js";
import { activePaletteToHex } from "./editor/palette.js";
import { decodeShare } from "./share.js";

export interface ShareToSvgOptions {
  /** SVG width/height in CSS pixels. Defaults to the bitmap width (1:1). */
  size?: number;
  /** Fill for transparent pixels. Omit for a transparent background. */
  background?: string | null;
}

/**
 * Converts a drawbang share link (or bare encoded code) into an SVG string.
 * Always renders the first frame; the codec carries up to 16. Each colored
 * pixel becomes a 1×1 <rect> in the 16×16 viewBox — the dumb approach, but
 * the output is tiny enough that smarter merging is not worth it.
 */
export function shareToSvg(input: string, opts: ShareToSvgOptions = {}): string {
  const code = extractShareCode(input);
  const { frames, activePalette } = decodeShare(code);
  const frame = frames[0];
  const hex = activePaletteToHex(activePalette);
  const size = opts.size ?? frame.width;

  const parts: string[] = [];
  if (opts.background != null) {
    parts.push(
      `<rect width="${frame.width}" height="${frame.height}" fill="${opts.background}"/>`,
    );
  }
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const v = frame.get(x, y);
      if (v === TRANSPARENT) continue;
      parts.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${hex[v]}"/>`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg"` +
    ` viewBox="0 0 ${frame.width} ${frame.height}"` +
    ` width="${size}" height="${size}"` +
    ` shape-rendering="crispEdges">${parts.join("")}</svg>`
  );
}

// Accepts a full share URL ("…#d=<code>" or "…?d=<code>"), a fragment
// ("#d=<code>" / "d=<code>"), or the bare base64url code.
function extractShareCode(s: string): string {
  const fromUrl = s.match(/[#?&]d=([A-Za-z0-9_-]+)/);
  if (fromUrl) return fromUrl[1];
  if (/^[A-Za-z0-9_-]+$/.test(s.trim())) return s.trim();
  throw new Error(`shareToSvg: could not extract share code from ${JSON.stringify(s)}`);
}
