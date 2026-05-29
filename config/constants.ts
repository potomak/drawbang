export const FPS = 5;
export const MAX_FRAMES = 16;
export const FRAME_DELAY_MS = Math.round(1000 / FPS);
export const PER_PAGE = 36;
export const ACTIVE_PALETTE_SIZE = 16;
export const BASE_PALETTE_SIZE = 256;

// Allowed drawing sizes. The editor publishes square GIFs at one of these
// dimensions; the validator + ingest accept any of them. Order matters for UI
// rendering (size picker).
export const DRAWING_SIZES: readonly number[] = [8, 16, 32, 64];
export const DEFAULT_SIZE = 16;

// Per-size byte caps for ingest. Scale roughly with pixel count so a 64x64
// 16-frame animation doesn't get rejected as too large.
const MAX_GIF_BYTES_BY_SIZE: Record<number, number> = {
  8: 4 * 1024,
  16: 16 * 1024,
  32: 64 * 1024,
  64: 256 * 1024,
};

export function isAllowedDrawingSize(n: number): boolean {
  return (DRAWING_SIZES as readonly number[]).includes(n);
}

export function maxGifBytesFor(size: number): number {
  const cap = MAX_GIF_BYTES_BY_SIZE[size];
  if (cap === undefined) throw new Error(`no byte cap for size ${size}`);
  return cap;
}

// Deprecated 16x16 defaults — kept as aliases for callers that haven't been
// migrated to pass an explicit drawing size yet. New code should accept a
// size parameter and not import these.
export const WIDTH = DEFAULT_SIZE;
export const HEIGHT = DEFAULT_SIZE;
export const MAX_GIF_BYTES = MAX_GIF_BYTES_BY_SIZE[DEFAULT_SIZE];

export const DRAWBANG_APP_IDENTIFIER = "DRAWBANG";
// GIF89a requires exactly 3 bytes for the authentication code. "1.0"
// identifies this as v1 of the Drawbang application extension.
export const DRAWBANG_APP_AUTH_CODE = new Uint8Array([0x31, 0x2e, 0x30]);
