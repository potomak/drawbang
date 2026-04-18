export const WIDTH = 16;
export const HEIGHT = 16;
export const FPS = 5;
export const MAX_FRAMES = 16;
export const FRAME_DELAY_MS = Math.round(1000 / FPS);
export const PER_PAGE = 36;
export const MAX_GIF_BYTES = 16 * 1024;
export const ACTIVE_PALETTE_SIZE = 16;
export const BASE_PALETTE_SIZE = 256;

export const DRAWBANG_APP_IDENTIFIER = "DRAWBANG";
// GIF89a requires exactly 3 bytes for the authentication code. "1.0"
// identifies this as v1 of the Drawbang application extension.
export const DRAWBANG_APP_AUTH_CODE = new Uint8Array([0x31, 0x2e, 0x30]);
