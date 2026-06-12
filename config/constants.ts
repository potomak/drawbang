export const FPS = 5;
export const MAX_FRAMES = 16;
export const FRAME_DELAY_MS = Math.round(1000 / FPS);

// Per-frame delay bounds enforced at ingest, in GIF centiseconds
// (80–250 ms ≈ 12.5–4 fps). The editor's FPS slider stops all fall inside;
// the legacy fixed 5 fps (20 cs) sits in the middle. Single-frame GIFs are
// exempt — their delay never renders.
export const MIN_FRAME_DELAY_CS = 8;
export const MAX_FRAME_DELAY_CS = 25;
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

// =====================================================================
// Shared request-validation regexes. Every handler that takes a drawing
// id / username / email in the URL or body checks against one of these,
// so they live here as a single source of truth.
// =====================================================================

// drawing_id = sha256(gif_bytes) rendered as lowercase 64-hex.
export const DRAWING_ID_RE = /^[0-9a-f]{64}$/;
// Public handle. Rules: 3–20 chars, lowercase alphanumeric + underscore
// + hyphen, first/last char must be alphanumeric or underscore.
export const USERNAME_RE = /^[a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_]$/;
// Pragmatic "looks like an email" check — the real validation happens
// at SES send time; this is just a quick reject for obvious garbage.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// =====================================================================
// Cache-Control strings for the Lambda-rendered surfaces. CloudFront's
// `s-maxage` controls the edge cache; per-row `max-age` controls the
// browser cache. Publish-time invalidations live in
// ingest/cache-invalidation.ts; tweak the TTLs here.
// =====================================================================

export const CC_GALLERY = "public, s-maxage=300, stale-while-revalidate=60";
export const CC_DRAWING_PAGE =
  "public, max-age=60, s-maxage=300, stale-while-revalidate=60";
export const CC_PROFILE = "public, s-maxage=86400, stale-while-revalidate=60";
export const CC_FEED = "public, s-maxage=3600";
export const CC_NOT_FOUND = "public, max-age=60";
export const CC_FOLLOW_LIST = "public, s-maxage=60, stale-while-revalidate=60";
export const CC_FOLLOW_THUMBS = "public, s-maxage=60, stale-while-revalidate=30";
export const CC_PRODUCTS = "public, s-maxage=86400, stale-while-revalidate=60";
export const CC_DESIGN = "public, s-maxage=300, stale-while-revalidate=60";
