import { MAX_FRAMES } from "../config/constants.js";
import { tracker } from "./analytics/analytics.js";
import { Bitmap, TRANSPARENT } from "./editor/bitmap.js";
import { PixelCanvas } from "./editor/canvas.js";
import { decodeGif, encodeGif } from "./editor/gif.js";
import { History } from "./editor/history.js";
import {
  addFrame as addFrameOp,
  type FrameState,
} from "./editor/frames.js";
import {
  BASE_PALETTE,
  DEFAULT_ACTIVE_PALETTE,
  activePaletteToHex,
  activePaletteToRgb,
  hexToRgb,
  nearestBaseIndex,
} from "./editor/palette.js";
import { RETRO_PALETTES, type RetroPalette } from "../config/palettes.js";
import {
  drawPixel,
  fillArea,
  flipHorizontal,
  flipVertical,
  rotateLeft,
  shiftRight,
  shiftUp,
} from "./editor/tools.js";
import { decodeShare, encodeShare } from "./share.js";
import * as local from "./local.js";
import { isLoggedIn } from "./auth.js";
import {
  MissingSessionError,
  submit,
} from "./submit.js";
import { showFlash } from "./layout/flash.js";
import { DEFAULT_SIZE, DRAWING_SIZES } from "../config/constants.js";

// Target physical canvas: ~560 backing pixels per side, matched to the v2
// editor wrap. Per-size pixelSize keeps the visible canvas the same physical
// dimension across the four sizes (8→70, 16→35, 32→17, 64→8).
const MAIN_CANVAS_TARGET = 560;
function pixelSizeFor(size: number): number {
  return Math.max(1, Math.floor(MAIN_CANVAS_TARGET / size));
}
const FRAME_THUMB_PIXEL_SIZE = 5;

const INGEST_URL = import.meta.env.VITE_INGEST_URL ?? "/ingest";
const DRAWING_BASE_URL = import.meta.env.VITE_DRAWING_BASE_URL ?? "/tiles";

// -- Editor state -----------------------------------------------------------

let currentSize = DEFAULT_SIZE;
const state: FrameState = { frames: [new Bitmap(currentSize, currentSize)], current: 0 };
let activePalette: Uint8Array = new Uint8Array(DEFAULT_ACTIVE_PALETTE);
// RetroPalette.id of the currently-applied palette. Persisted to localStorage and applied
// on boot + on every editor reset so the user's last pick survives a
// publish or Clear.
let currentPaletteId = "ega";
let selectedSlot = 1;
let tool: "pixel" | "erase" | "fill" = "pixel";
let painting = false;
let strokeSnapshot: Bitmap | null = null;
let strokeDirty = false;
let playing = false;
let playTimer: ReturnType<typeof setInterval> | null = null;
let frameBeforePlay = 0;
let clipboard: Bitmap | null = null;
const history = new History();
let localId: string | null = null;
let lastPublishedId: string | null = null;
// Set when the editor boots with ?fork=<id>. Forwarded to ingest as
// `parent` on the next publish so the new drawing records its lineage.
// Cleared on every reset — a blank canvas isn't a fork of anything.
let parentId: string | null = null;
let onion = false;
// GIF playback is locked at 5 fps (200 ms/frame) — matches the encoded
// delay, so previewing in the editor looks the same as the rendered GIF.
const FPS = 5;
const PLAY_DELAY_MS = 1000 / FPS;

// -- Tool icon SVGs (placeholder — will be replaced) ------------------------
// 16×16 viewBox, fill=currentColor. The user plans to swap these later;
// they live inline so the editor doesn't add a sprite-sheet asset request.
const ICON = {
  pencil: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="9" y="2" width="1" height="1"/><rect x="10" y="2" width="1" height="1"/><rect x="9" y="3" width="1" height="1"/><rect x="10" y="3" width="1" height="1"/><rect x="11" y="3" width="1" height="1"/><rect x="8" y="4" width="1" height="1"/><rect x="10" y="4" width="1" height="1"/><rect x="11" y="4" width="1" height="1"/><rect x="12" y="4" width="1" height="1"/><rect x="8" y="5" width="1" height="1"/><rect x="11" y="5" width="1" height="1"/><rect x="7" y="6" width="1" height="1"/><rect x="10" y="6" width="1" height="1"/><rect x="7" y="7" width="1" height="1"/><rect x="10" y="7" width="1" height="1"/><rect x="6" y="8" width="1" height="1"/><rect x="9" y="8" width="1" height="1"/><rect x="6" y="9" width="1" height="1"/><rect x="9" y="9" width="1" height="1"/><rect x="5" y="10" width="1" height="1"/><rect x="8" y="10" width="1" height="1"/><rect x="5" y="11" width="1" height="1"/><rect x="8" y="11" width="1" height="1"/><rect x="4" y="12" width="1" height="1"/><rect x="7" y="12" width="1" height="1"/><rect x="4" y="13" width="1" height="1"/><rect x="5" y="13" width="1" height="1"/><rect x="6" y="13" width="1" height="1"/><rect x="4" y="14" width="1" height="1"/><rect x="5" y="14" width="1" height="1"/></g></svg>`,
  eraser: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="7" y="5" width="1" height="1"/><rect x="8" y="5" width="1" height="1"/><rect x="9" y="5" width="1" height="1"/><rect x="10" y="5" width="1" height="1"/><rect x="11" y="5" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/><rect x="12" y="6" width="1" height="1"/><rect x="5" y="7" width="1" height="1"/><rect x="12" y="7" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/><rect x="5" y="8" width="1" height="1"/><rect x="6" y="8" width="1" height="1"/><rect x="7" y="8" width="1" height="1"/><rect x="8" y="8" width="1" height="1"/><rect x="9" y="8" width="1" height="1"/><rect x="11" y="8" width="1" height="1"/><rect x="3" y="9" width="1" height="1"/><rect x="4" y="9" width="1" height="1"/><rect x="5" y="9" width="1" height="1"/><rect x="6" y="9" width="1" height="1"/><rect x="7" y="9" width="1" height="1"/><rect x="8" y="9" width="1" height="1"/><rect x="9" y="9" width="1" height="1"/><rect x="10" y="9" width="1" height="1"/><rect x="3" y="10" width="1" height="1"/><rect x="4" y="10" width="1" height="1"/><rect x="5" y="10" width="1" height="1"/><rect x="6" y="10" width="1" height="1"/><rect x="7" y="10" width="1" height="1"/><rect x="8" y="10" width="1" height="1"/><rect x="9" y="10" width="1" height="1"/><rect x="3" y="11" width="1" height="1"/><rect x="4" y="11" width="1" height="1"/><rect x="5" y="11" width="1" height="1"/><rect x="6" y="11" width="1" height="1"/><rect x="7" y="11" width="1" height="1"/><rect x="8" y="11" width="1" height="1"/></g></svg>`,
  fill: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="7" y="2" width="1" height="1"/><rect x="8" y="2" width="1" height="1"/><rect x="6" y="3" width="1" height="1"/><rect x="9" y="3" width="1" height="1"/><rect x="6" y="4" width="1" height="1"/><rect x="8" y="4" width="1" height="1"/><rect x="9" y="4" width="1" height="1"/><rect x="6" y="5" width="1" height="1"/><rect x="7" y="5" width="1" height="1"/><rect x="9" y="5" width="1" height="1"/><rect x="10" y="5" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/><rect x="9" y="6" width="1" height="1"/><rect x="11" y="6" width="1" height="1"/><rect x="5" y="7" width="1" height="1"/><rect x="8" y="7" width="1" height="1"/><rect x="9" y="7" width="1" height="1"/><rect x="11" y="7" width="1" height="1"/><rect x="12" y="7" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/><rect x="8" y="8" width="1" height="1"/><rect x="9" y="8" width="1" height="1"/><rect x="11" y="8" width="1" height="1"/><rect x="12" y="8" width="1" height="1"/><rect x="13" y="8" width="1" height="1"/><rect x="3" y="9" width="1" height="1"/><rect x="11" y="9" width="1" height="1"/><rect x="12" y="9" width="1" height="1"/><rect x="13" y="9" width="1" height="1"/><rect x="3" y="10" width="1" height="1"/><rect x="10" y="10" width="1" height="1"/><rect x="12" y="10" width="1" height="1"/><rect x="4" y="11" width="1" height="1"/><rect x="9" y="11" width="1" height="1"/><rect x="12" y="11" width="1" height="1"/><rect x="5" y="12" width="1" height="1"/><rect x="8" y="12" width="1" height="1"/><rect x="6" y="13" width="1" height="1"/><rect x="7" y="13" width="1" height="1"/><rect x="12" y="13" width="1" height="1"/></g></svg>`,
  undo: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="7" y="2" width="1" height="1"/><rect x="8" y="2" width="1" height="1"/><rect x="9" y="2" width="1" height="1"/><rect x="10" y="2" width="1" height="1"/><rect x="11" y="2" width="1" height="1"/><rect x="2" y="3" width="1" height="1"/><rect x="3" y="3" width="1" height="1"/><rect x="6" y="3" width="1" height="1"/><rect x="7" y="3" width="1" height="1"/><rect x="8" y="3" width="1" height="1"/><rect x="9" y="3" width="1" height="1"/><rect x="10" y="3" width="1" height="1"/><rect x="11" y="3" width="1" height="1"/><rect x="12" y="3" width="1" height="1"/><rect x="2" y="4" width="1" height="1"/><rect x="3" y="4" width="1" height="1"/><rect x="5" y="4" width="1" height="1"/><rect x="6" y="4" width="1" height="1"/><rect x="7" y="4" width="1" height="1"/><rect x="11" y="4" width="1" height="1"/><rect x="12" y="4" width="1" height="1"/><rect x="13" y="4" width="1" height="1"/><rect x="2" y="5" width="1" height="1"/><rect x="3" y="5" width="1" height="1"/><rect x="4" y="5" width="1" height="1"/><rect x="5" y="5" width="1" height="1"/><rect x="6" y="5" width="1" height="1"/><rect x="12" y="5" width="1" height="1"/><rect x="13" y="5" width="1" height="1"/><rect x="2" y="6" width="1" height="1"/><rect x="3" y="6" width="1" height="1"/><rect x="4" y="6" width="1" height="1"/><rect x="5" y="6" width="1" height="1"/><rect x="12" y="6" width="1" height="1"/><rect x="13" y="6" width="1" height="1"/><rect x="2" y="7" width="1" height="1"/><rect x="3" y="7" width="1" height="1"/><rect x="4" y="7" width="1" height="1"/><rect x="5" y="7" width="1" height="1"/><rect x="6" y="7" width="1" height="1"/><rect x="7" y="7" width="1" height="1"/><rect x="12" y="7" width="1" height="1"/><rect x="13" y="7" width="1" height="1"/><rect x="2" y="8" width="1" height="1"/><rect x="3" y="8" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/><rect x="5" y="8" width="1" height="1"/><rect x="6" y="8" width="1" height="1"/><rect x="7" y="8" width="1" height="1"/><rect x="11" y="8" width="1" height="1"/><rect x="12" y="8" width="1" height="1"/><rect x="13" y="8" width="1" height="1"/><rect x="10" y="9" width="1" height="1"/><rect x="11" y="9" width="1" height="1"/><rect x="12" y="9" width="1" height="1"/><rect x="9" y="10" width="1" height="1"/><rect x="10" y="10" width="1" height="1"/><rect x="11" y="10" width="1" height="1"/><rect x="8" y="11" width="1" height="1"/><rect x="9" y="11" width="1" height="1"/><rect x="10" y="11" width="1" height="1"/><rect x="8" y="12" width="1" height="1"/><rect x="9" y="12" width="1" height="1"/></g></svg>`,
  clear: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="8" y="3" width="1" height="1"/><rect x="9" y="3" width="1" height="1"/><rect x="12" y="3" width="1" height="1"/><rect x="7" y="4" width="1" height="1"/><rect x="10" y="4" width="1" height="1"/><rect x="6" y="5" width="1" height="1"/><rect x="11" y="5" width="1" height="1"/><rect x="13" y="5" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/><rect x="5" y="7" width="1" height="1"/><rect x="6" y="7" width="1" height="1"/><rect x="7" y="7" width="1" height="1"/><rect x="10" y="7" width="1" height="1"/><rect x="12" y="7" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/><rect x="5" y="8" width="1" height="1"/><rect x="6" y="8" width="1" height="1"/><rect x="7" y="8" width="1" height="1"/><rect x="8" y="8" width="1" height="1"/><rect x="3" y="9" width="1" height="1"/><rect x="4" y="9" width="1" height="1"/><rect x="5" y="9" width="1" height="1"/><rect x="6" y="9" width="1" height="1"/><rect x="7" y="9" width="1" height="1"/><rect x="8" y="9" width="1" height="1"/><rect x="9" y="9" width="1" height="1"/><rect x="3" y="10" width="1" height="1"/><rect x="4" y="10" width="1" height="1"/><rect x="5" y="10" width="1" height="1"/><rect x="6" y="10" width="1" height="1"/><rect x="7" y="10" width="1" height="1"/><rect x="8" y="10" width="1" height="1"/><rect x="9" y="10" width="1" height="1"/><rect x="3" y="11" width="1" height="1"/><rect x="4" y="11" width="1" height="1"/><rect x="5" y="11" width="1" height="1"/><rect x="6" y="11" width="1" height="1"/><rect x="7" y="11" width="1" height="1"/><rect x="8" y="11" width="1" height="1"/><rect x="9" y="11" width="1" height="1"/><rect x="4" y="12" width="1" height="1"/><rect x="5" y="12" width="1" height="1"/><rect x="6" y="12" width="1" height="1"/><rect x="7" y="12" width="1" height="1"/><rect x="8" y="12" width="1" height="1"/><rect x="5" y="13" width="1" height="1"/><rect x="6" y="13" width="1" height="1"/><rect x="7" y="13" width="1" height="1"/></g></svg>`,
  flipH: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="6" y="2" width="1" height="1"/><rect x="7" y="2" width="1" height="1"/><rect x="9" y="2" width="1" height="1"/><rect x="5" y="3" width="1" height="1"/><rect x="6" y="3" width="1" height="1"/><rect x="7" y="3" width="1" height="1"/><rect x="8" y="3" width="1" height="1"/><rect x="10" y="3" width="1" height="1"/><rect x="4" y="4" width="1" height="1"/><rect x="5" y="4" width="1" height="1"/><rect x="6" y="4" width="1" height="1"/><rect x="7" y="4" width="1" height="1"/><rect x="9" y="4" width="1" height="1"/><rect x="11" y="4" width="1" height="1"/><rect x="4" y="5" width="1" height="1"/><rect x="5" y="5" width="1" height="1"/><rect x="8" y="5" width="1" height="1"/><rect x="10" y="5" width="1" height="1"/><rect x="4" y="6" width="1" height="1"/><rect x="9" y="6" width="1" height="1"/><rect x="11" y="6" width="1" height="1"/><rect x="4" y="7" width="1" height="1"/><rect x="6" y="7" width="1" height="1"/><rect x="8" y="7" width="1" height="1"/><rect x="10" y="7" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/><rect x="9" y="8" width="1" height="1"/><rect x="11" y="8" width="1" height="1"/><rect x="4" y="9" width="1" height="1"/><rect x="8" y="9" width="1" height="1"/><rect x="10" y="9" width="1" height="1"/><rect x="4" y="10" width="1" height="1"/><rect x="7" y="10" width="1" height="1"/><rect x="9" y="10" width="1" height="1"/><rect x="11" y="10" width="1" height="1"/><rect x="5" y="11" width="1" height="1"/><rect x="8" y="11" width="1" height="1"/><rect x="10" y="11" width="1" height="1"/><rect x="6" y="12" width="1" height="1"/><rect x="7" y="12" width="1" height="1"/><rect x="9" y="12" width="1" height="1"/></g></svg>`,
  flipV: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="6" y="2" width="1" height="1"/><rect x="7" y="2" width="1" height="1"/><rect x="8" y="2" width="1" height="1"/><rect x="9" y="2" width="1" height="1"/><rect x="5" y="3" width="1" height="1"/><rect x="6" y="3" width="1" height="1"/><rect x="7" y="3" width="1" height="1"/><rect x="8" y="3" width="1" height="1"/><rect x="9" y="3" width="1" height="1"/><rect x="10" y="3" width="1" height="1"/><rect x="4" y="4" width="1" height="1"/><rect x="5" y="4" width="1" height="1"/><rect x="6" y="4" width="1" height="1"/><rect x="7" y="4" width="1" height="1"/><rect x="8" y="4" width="1" height="1"/><rect x="9" y="4" width="1" height="1"/><rect x="10" y="4" width="1" height="1"/><rect x="11" y="4" width="1" height="1"/><rect x="4" y="5" width="1" height="1"/><rect x="5" y="5" width="1" height="1"/><rect x="10" y="5" width="1" height="1"/><rect x="11" y="5" width="1" height="1"/><rect x="4" y="6" width="1" height="1"/><rect x="11" y="6" width="1" height="1"/><rect x="4" y="7" width="1" height="1"/><rect x="6" y="7" width="1" height="1"/><rect x="9" y="7" width="1" height="1"/><rect x="11" y="7" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/><rect x="6" y="8" width="1" height="1"/><rect x="8" y="8" width="1" height="1"/><rect x="10" y="8" width="1" height="1"/><rect x="11" y="8" width="1" height="1"/><rect x="4" y="9" width="1" height="1"/><rect x="5" y="9" width="1" height="1"/><rect x="7" y="9" width="1" height="1"/><rect x="9" y="9" width="1" height="1"/><rect x="11" y="9" width="1" height="1"/><rect x="4" y="10" width="1" height="1"/><rect x="6" y="10" width="1" height="1"/><rect x="8" y="10" width="1" height="1"/><rect x="10" y="10" width="1" height="1"/><rect x="5" y="11" width="1" height="1"/><rect x="7" y="11" width="1" height="1"/><rect x="9" y="11" width="1" height="1"/><rect x="6" y="12" width="1" height="1"/><rect x="8" y="12" width="1" height="1"/></g></svg>`,
  rotate: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="6" y="0" width="1" height="1"/><rect x="7" y="0" width="1" height="1"/><rect x="8" y="0" width="1" height="1"/><rect x="9" y="0" width="1" height="1"/><rect x="3" y="1" width="1" height="1"/><rect x="5" y="1" width="1" height="1"/><rect x="10" y="1" width="1" height="1"/><rect x="3" y="2" width="1" height="1"/><rect x="4" y="2" width="1" height="1"/><rect x="11" y="2" width="1" height="1"/><rect x="3" y="3" width="1" height="1"/><rect x="4" y="3" width="1" height="1"/><rect x="5" y="3" width="1" height="1"/><rect x="11" y="3" width="1" height="1"/><rect x="4" y="6" width="1" height="1"/><rect x="10" y="6" width="1" height="1"/><rect x="11" y="6" width="1" height="1"/><rect x="12" y="6" width="1" height="1"/><rect x="4" y="7" width="1" height="1"/><rect x="11" y="7" width="1" height="1"/><rect x="12" y="7" width="1" height="1"/><rect x="5" y="8" width="1" height="1"/><rect x="10" y="8" width="1" height="1"/><rect x="12" y="8" width="1" height="1"/><rect x="6" y="9" width="1" height="1"/><rect x="7" y="9" width="1" height="1"/><rect x="8" y="9" width="1" height="1"/><rect x="9" y="9" width="1" height="1"/><rect x="5" y="11" width="1" height="1"/><rect x="6" y="11" width="1" height="1"/><rect x="10" y="11" width="1" height="1"/><rect x="11" y="11" width="1" height="1"/><rect x="4" y="12" width="1" height="1"/><rect x="7" y="12" width="1" height="1"/><rect x="9" y="12" width="1" height="1"/><rect x="12" y="12" width="1" height="1"/><rect x="5" y="13" width="1" height="1"/><rect x="6" y="13" width="1" height="1"/><rect x="7" y="13" width="1" height="1"/><rect x="9" y="13" width="1" height="1"/><rect x="12" y="13" width="1" height="1"/><rect x="7" y="14" width="1" height="1"/><rect x="9" y="14" width="1" height="1"/><rect x="12" y="14" width="1" height="1"/><rect x="5" y="15" width="1" height="1"/><rect x="6" y="15" width="1" height="1"/><rect x="10" y="15" width="1" height="1"/><rect x="11" y="15" width="1" height="1"/></g></svg>`,
  shiftX: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="2" y="3" width="1" height="1"/><rect x="3" y="3" width="1" height="1"/><rect x="6" y="3" width="1" height="1"/><rect x="7" y="3" width="1" height="1"/><rect x="1" y="4" width="1" height="1"/><rect x="4" y="4" width="1" height="1"/><rect x="5" y="4" width="1" height="1"/><rect x="8" y="4" width="1" height="1"/><rect x="1" y="5" width="1" height="1"/><rect x="4" y="5" width="1" height="1"/><rect x="5" y="5" width="1" height="1"/><rect x="8" y="5" width="1" height="1"/><rect x="12" y="5" width="1" height="1"/><rect x="2" y="6" width="1" height="1"/><rect x="3" y="6" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/><rect x="7" y="6" width="1" height="1"/><rect x="13" y="6" width="1" height="1"/><rect x="2" y="7" width="1" height="1"/><rect x="3" y="7" width="1" height="1"/><rect x="6" y="7" width="1" height="1"/><rect x="7" y="7" width="1" height="1"/><rect x="10" y="7" width="1" height="1"/><rect x="11" y="7" width="1" height="1"/><rect x="12" y="7" width="1" height="1"/><rect x="13" y="7" width="1" height="1"/><rect x="14" y="7" width="1" height="1"/><rect x="1" y="8" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/><rect x="5" y="8" width="1" height="1"/><rect x="8" y="8" width="1" height="1"/><rect x="13" y="8" width="1" height="1"/><rect x="1" y="9" width="1" height="1"/><rect x="4" y="9" width="1" height="1"/><rect x="5" y="9" width="1" height="1"/><rect x="8" y="9" width="1" height="1"/><rect x="12" y="9" width="1" height="1"/><rect x="2" y="10" width="1" height="1"/><rect x="3" y="10" width="1" height="1"/><rect x="6" y="10" width="1" height="1"/><rect x="7" y="10" width="1" height="1"/></g></svg>`,
  shiftY: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="7" y="1" width="1" height="1"/><rect x="6" y="2" width="1" height="1"/><rect x="7" y="2" width="1" height="1"/><rect x="8" y="2" width="1" height="1"/><rect x="5" y="3" width="1" height="1"/><rect x="7" y="3" width="1" height="1"/><rect x="9" y="3" width="1" height="1"/><rect x="7" y="4" width="1" height="1"/><rect x="7" y="5" width="1" height="1"/><rect x="4" y="7" width="1" height="1"/><rect x="5" y="7" width="1" height="1"/><rect x="8" y="7" width="1" height="1"/><rect x="9" y="7" width="1" height="1"/><rect x="3" y="8" width="1" height="1"/><rect x="6" y="8" width="1" height="1"/><rect x="7" y="8" width="1" height="1"/><rect x="10" y="8" width="1" height="1"/><rect x="3" y="9" width="1" height="1"/><rect x="6" y="9" width="1" height="1"/><rect x="7" y="9" width="1" height="1"/><rect x="10" y="9" width="1" height="1"/><rect x="4" y="10" width="1" height="1"/><rect x="5" y="10" width="1" height="1"/><rect x="8" y="10" width="1" height="1"/><rect x="9" y="10" width="1" height="1"/><rect x="4" y="11" width="1" height="1"/><rect x="5" y="11" width="1" height="1"/><rect x="8" y="11" width="1" height="1"/><rect x="9" y="11" width="1" height="1"/><rect x="3" y="12" width="1" height="1"/><rect x="6" y="12" width="1" height="1"/><rect x="7" y="12" width="1" height="1"/><rect x="10" y="12" width="1" height="1"/><rect x="3" y="13" width="1" height="1"/><rect x="6" y="13" width="1" height="1"/><rect x="7" y="13" width="1" height="1"/><rect x="10" y="13" width="1" height="1"/><rect x="4" y="14" width="1" height="1"/><rect x="5" y="14" width="1" height="1"/><rect x="8" y="14" width="1" height="1"/><rect x="9" y="14" width="1" height="1"/></g></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="6" y="2" width="2" height="10"/><rect x="2" y="6" width="10" height="2"/></g></svg>`,
  copy: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="2"/><rect x="5" y="5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="2"/></g></svg>`,
  paste: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="3" y="1" width="8" height="2"/><rect x="2" y="3" width="10" height="9" fill="none" stroke="currentColor" stroke-width="2"/></g></svg>`,
  trash: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="2" y="3" width="10" height="2"/><rect x="5" y="1" width="4" height="2"/><rect x="3" y="5" width="2" height="8"/><rect x="9" y="5" width="2" height="8"/><rect x="6" y="5" width="2" height="8"/></g></svg>`,
  play: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="3" y="2" width="2" height="10"/><rect x="5" y="3" width="2" height="8"/><rect x="7" y="4" width="2" height="6"/><rect x="9" y="5" width="2" height="4"/><rect x="11" y="6" width="1" height="2"/></g></svg>`,
  pause: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="3" y="2" width="3" height="10"/><rect x="8" y="2" width="3" height="10"/></g></svg>`,
  download: `<svg viewBox="0 0 16 16" width="32" height="32" shape-rendering="crispEdges"><g fill="currentColor"><rect x="7" y="5" width="1" height="1"/><rect x="7" y="6" width="1" height="1"/><rect x="7" y="7" width="1" height="1"/><rect x="7" y="8" width="1" height="1"/><rect x="5" y="9" width="1" height="1"/><rect x="7" y="9" width="1" height="1"/><rect x="9" y="9" width="1" height="1"/><rect x="6" y="10" width="1" height="1"/><rect x="7" y="10" width="1" height="1"/><rect x="8" y="10" width="1" height="1"/><rect x="2" y="11" width="1" height="1"/><rect x="7" y="11" width="1" height="1"/><rect x="12" y="11" width="1" height="1"/><rect x="2" y="12" width="1" height="1"/><rect x="12" y="12" width="1" height="1"/><rect x="2" y="13" width="1" height="1"/><rect x="3" y="13" width="1" height="1"/><rect x="4" y="13" width="1" height="1"/><rect x="5" y="13" width="1" height="1"/><rect x="6" y="13" width="1" height="1"/><rect x="7" y="13" width="1" height="1"/><rect x="8" y="13" width="1" height="1"/><rect x="9" y="13" width="1" height="1"/><rect x="10" y="13" width="1" height="1"/><rect x="11" y="13" width="1" height="1"/><rect x="12" y="13" width="1" height="1"/></g></svg>`,
  share: `<svg viewBox="0 0 16 16" width="32" height="32" shape-rendering="crispEdges"><g fill="currentColor"><rect x="5" y="2" width="1" height="1"/><rect x="6" y="2" width="1" height="1"/><rect x="7" y="2" width="1" height="1"/><rect x="8" y="2" width="1" height="1"/><rect x="9" y="2" width="1" height="1"/><rect x="10" y="2" width="1" height="1"/><rect x="4" y="3" width="1" height="1"/><rect x="6" y="3" width="1" height="1"/><rect x="11" y="3" width="1" height="1"/><rect x="3" y="4" width="1" height="1"/><rect x="6" y="4" width="1" height="1"/><rect x="7" y="4" width="1" height="1"/><rect x="8" y="4" width="1" height="1"/><rect x="12" y="4" width="1" height="1"/><rect x="2" y="5" width="1" height="1"/><rect x="5" y="5" width="1" height="1"/><rect x="6" y="5" width="1" height="1"/><rect x="7" y="5" width="1" height="1"/><rect x="8" y="5" width="1" height="1"/><rect x="9" y="5" width="1" height="1"/><rect x="13" y="5" width="1" height="1"/><rect x="2" y="6" width="1" height="1"/><rect x="5" y="6" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/><rect x="7" y="6" width="1" height="1"/><rect x="8" y="6" width="1" height="1"/><rect x="13" y="6" width="1" height="1"/><rect x="2" y="7" width="1" height="1"/><rect x="5" y="7" width="1" height="1"/><rect x="6" y="7" width="1" height="1"/><rect x="7" y="7" width="1" height="1"/><rect x="9" y="7" width="1" height="1"/><rect x="12" y="7" width="1" height="1"/><rect x="13" y="7" width="1" height="1"/><rect x="2" y="8" width="1" height="1"/><rect x="5" y="8" width="1" height="1"/><rect x="12" y="8" width="1" height="1"/><rect x="13" y="8" width="1" height="1"/><rect x="2" y="9" width="1" height="1"/><rect x="6" y="9" width="1" height="1"/><rect x="13" y="9" width="1" height="1"/><rect x="2" y="10" width="1" height="1"/><rect x="7" y="10" width="1" height="1"/><rect x="8" y="10" width="1" height="1"/><rect x="13" y="10" width="1" height="1"/><rect x="3" y="11" width="1" height="1"/><rect x="7" y="11" width="1" height="1"/><rect x="8" y="11" width="1" height="1"/><rect x="9" y="11" width="1" height="1"/><rect x="12" y="11" width="1" height="1"/><rect x="4" y="12" width="1" height="1"/><rect x="6" y="12" width="1" height="1"/><rect x="7" y="12" width="1" height="1"/><rect x="8" y="12" width="1" height="1"/><rect x="9" y="12" width="1" height="1"/><rect x="11" y="12" width="1" height="1"/><rect x="5" y="13" width="1" height="1"/><rect x="6" y="13" width="1" height="1"/><rect x="7" y="13" width="1" height="1"/><rect x="8" y="13" width="1" height="1"/><rect x="9" y="13" width="1" height="1"/><rect x="10" y="13" width="1" height="1"/></g></svg>`,
  publish: `<svg viewBox="0 0 16 16" width="32" height="32" shape-rendering="crispEdges"><g fill="currentColor"><rect x="4" y="2" width="1" height="1"/><rect x="5" y="2" width="1" height="1"/><rect x="6" y="2" width="1" height="1"/><rect x="7" y="2" width="1" height="1"/><rect x="8" y="2" width="1" height="1"/><rect x="9" y="2" width="1" height="1"/><rect x="10" y="2" width="1" height="1"/><rect x="11" y="2" width="1" height="1"/><rect x="12" y="2" width="1" height="1"/><rect x="13" y="2" width="1" height="1"/><rect x="3" y="3" width="1" height="1"/><rect x="5" y="3" width="1" height="1"/><rect x="6" y="3" width="1" height="1"/><rect x="7" y="3" width="1" height="1"/><rect x="8" y="3" width="1" height="1"/><rect x="11" y="3" width="1" height="1"/><rect x="13" y="3" width="1" height="1"/><rect x="2" y="4" width="1" height="1"/><rect x="5" y="4" width="1" height="1"/><rect x="6" y="4" width="1" height="1"/><rect x="7" y="4" width="1" height="1"/><rect x="8" y="4" width="1" height="1"/><rect x="11" y="4" width="1" height="1"/><rect x="13" y="4" width="1" height="1"/><rect x="2" y="5" width="1" height="1"/><rect x="5" y="5" width="1" height="1"/><rect x="6" y="5" width="1" height="1"/><rect x="7" y="5" width="1" height="1"/><rect x="8" y="5" width="1" height="1"/><rect x="11" y="5" width="1" height="1"/><rect x="13" y="5" width="1" height="1"/><rect x="2" y="6" width="1" height="1"/><rect x="5" y="6" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/><rect x="7" y="6" width="1" height="1"/><rect x="8" y="6" width="1" height="1"/><rect x="9" y="6" width="1" height="1"/><rect x="10" y="6" width="1" height="1"/><rect x="11" y="6" width="1" height="1"/><rect x="13" y="6" width="1" height="1"/><rect x="2" y="7" width="1" height="1"/><rect x="13" y="7" width="1" height="1"/><rect x="2" y="8" width="1" height="1"/><rect x="13" y="8" width="1" height="1"/><rect x="2" y="9" width="1" height="1"/><rect x="13" y="9" width="1" height="1"/><rect x="2" y="10" width="1" height="1"/><rect x="13" y="10" width="1" height="1"/><rect x="2" y="11" width="1" height="1"/><rect x="13" y="11" width="1" height="1"/><rect x="2" y="12" width="1" height="1"/><rect x="13" y="12" width="1" height="1"/><rect x="2" y="13" width="1" height="1"/><rect x="3" y="13" width="1" height="1"/><rect x="4" y="13" width="1" height="1"/><rect x="5" y="13" width="1" height="1"/><rect x="6" y="13" width="1" height="1"/><rect x="7" y="13" width="1" height="1"/><rect x="8" y="13" width="1" height="1"/><rect x="9" y="13" width="1" height="1"/><rect x="10" y="13" width="1" height="1"/><rect x="11" y="13" width="1" height="1"/><rect x="12" y="13" width="1" height="1"/><rect x="13" y="13" width="1" height="1"/></g></svg>`,
  cart: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="4" y="2" width="1" height="1"/><rect x="5" y="2" width="1" height="1"/><rect x="9" y="2" width="1" height="1"/><rect x="10" y="2" width="1" height="1"/><rect x="3" y="3" width="1" height="1"/><rect x="6" y="3" width="1" height="1"/><rect x="7" y="3" width="1" height="1"/><rect x="8" y="3" width="1" height="1"/><rect x="11" y="3" width="1" height="1"/><rect x="2" y="4" width="1" height="1"/><rect x="12" y="4" width="1" height="1"/><rect x="1" y="5" width="1" height="1"/><rect x="13" y="5" width="1" height="1"/><rect x="1" y="6" width="1" height="1"/><rect x="4" y="6" width="1" height="1"/><rect x="10" y="6" width="1" height="1"/><rect x="13" y="6" width="1" height="1"/><rect x="2" y="7" width="1" height="1"/><rect x="3" y="7" width="1" height="1"/><rect x="4" y="7" width="1" height="1"/><rect x="10" y="7" width="1" height="1"/><rect x="11" y="7" width="1" height="1"/><rect x="12" y="7" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/><rect x="10" y="8" width="1" height="1"/><rect x="4" y="9" width="1" height="1"/><rect x="10" y="9" width="1" height="1"/><rect x="4" y="10" width="1" height="1"/><rect x="10" y="10" width="1" height="1"/><rect x="4" y="11" width="1" height="1"/><rect x="10" y="11" width="1" height="1"/><rect x="4" y="12" width="1" height="1"/><rect x="5" y="12" width="1" height="1"/><rect x="6" y="12" width="1" height="1"/><rect x="7" y="12" width="1" height="1"/><rect x="8" y="12" width="1" height="1"/><rect x="9" y="12" width="1" height="1"/><rect x="10" y="12" width="1" height="1"/></g></svg>`,
  key: `<svg viewBox="0 0 16 16" width="32" height="32" shape-rendering="crispEdges"><g fill="currentColor"><rect x="4" y="5" width="1" height="1"/><rect x="5" y="5" width="1" height="1"/><rect x="3" y="6" width="1" height="1"/><rect x="4" y="6" width="1" height="1"/><rect x="5" y="6" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/><rect x="2" y="7" width="1" height="1"/><rect x="3" y="7" width="1" height="1"/><rect x="6" y="7" width="1" height="1"/><rect x="7" y="7" width="1" height="1"/><rect x="8" y="7" width="1" height="1"/><rect x="9" y="7" width="1" height="1"/><rect x="10" y="7" width="1" height="1"/><rect x="11" y="7" width="1" height="1"/><rect x="12" y="7" width="1" height="1"/><rect x="13" y="7" width="1" height="1"/><rect x="2" y="8" width="1" height="1"/><rect x="3" y="8" width="1" height="1"/><rect x="6" y="8" width="1" height="1"/><rect x="7" y="8" width="1" height="1"/><rect x="8" y="8" width="1" height="1"/><rect x="9" y="8" width="1" height="1"/><rect x="10" y="8" width="1" height="1"/><rect x="11" y="8" width="1" height="1"/><rect x="12" y="8" width="1" height="1"/><rect x="13" y="8" width="1" height="1"/><rect x="3" y="9" width="1" height="1"/><rect x="4" y="9" width="1" height="1"/><rect x="5" y="9" width="1" height="1"/><rect x="6" y="9" width="1" height="1"/><rect x="11" y="9" width="1" height="1"/><rect x="13" y="9" width="1" height="1"/><rect x="4" y="10" width="1" height="1"/><rect x="5" y="10" width="1" height="1"/><rect x="11" y="10" width="1" height="1"/><rect x="13" y="10" width="1" height="1"/></g></svg>`,
};

// -- DOM setup --------------------------------------------------------------

const app = document.getElementById("app")!;
app.innerHTML = /* html */ `
  <main>
    <div class="ed-size-picker" role="radiogroup" aria-label="Canvas size">
      <span class="ed-size-label">Size</span>
      ${DRAWING_SIZES.map((s) => `<button type="button" class="btn xs ed-size-opt" data-size="${s}" aria-pressed="${s === DEFAULT_SIZE ? "true" : "false"}">${s}×${s}</button>`).join("")}
    </div>
    <div class="ed-actions">
      <button class="btn" data-action="publish">${ICON.publish} Publish</button>
      <button class="btn primary" data-action="make-merch" id="merchBtn">${ICON.cart} Make merch</button>
      <button class="btn" data-action="share">${ICON.share} Copy share link</button>
      <button class="btn" data-action="export-gif">${ICON.download} Download GIF</button>
    </div>

    <div class="ed-grid">
      <div class="ed-tools" role="toolbar" aria-label="Tools">
        <button class="btn icon ed-tool" data-tool="pixel" aria-pressed="true" title="Pencil" aria-label="Pencil">${ICON.pencil}</button>
        <button class="btn icon ed-tool" data-tool="erase" title="Eraser" aria-label="Eraser">${ICON.eraser}</button>
        <button class="btn icon ed-tool" data-tool="fill" title="Fill" aria-label="Fill">${ICON.fill}</button>
        <button class="btn icon ed-tool" data-action="undo" title="Undo" aria-label="Undo">${ICON.undo}</button>
        <button class="btn icon ed-tool" data-action="clear" title="Clear" aria-label="Clear">${ICON.clear}</button>
        <button class="btn icon ed-tool" data-action="flip-h" title="Flip horizontal" aria-label="Flip horizontal">${ICON.flipH}</button>
        <button class="btn icon ed-tool" data-action="flip-v" title="Flip vertical" aria-label="Flip vertical">${ICON.flipV}</button>
        <button class="btn icon ed-tool" data-action="rotate" title="Rotate" aria-label="Rotate">${ICON.rotate}</button>
        <button class="btn icon ed-tool" data-action="shift-right" title="Shift X" aria-label="Shift X">${ICON.shiftX}</button>
        <button class="btn icon ed-tool" data-action="shift-up" title="Shift Y" aria-label="Shift Y">${ICON.shiftY}</button>
      </div>

      <div class="ed-center">
        <div class="ed-canvas-wrap">
          <canvas id="main" class="ed-canvas" aria-label="drawing canvas"></canvas>
        </div>
        <div class="ed-palette-wrap">
          <label class="ed-palette-select-wrap">
            <span class="ed-palette-select-label">Palette</span>
            <select id="paletteSelect" class="ed-palette-select" aria-label="Palette">
              ${RETRO_PALETTES.map(
                (p) => `<option value="${p.id}">${p.name}</option>`,
              ).join("")}
            </select>
          </label>
          <div class="ed-palette-row">
            <div id="palette" class="ed-palette" role="toolbar" aria-label="Active palette"></div>
            <button class="btn sm ed-edit-color" data-action="edit-color" title="Edit color of selected slot">Edit</button>
          </div>
        </div>
      </div>
    </div>

    <div class="ed-frames">
      <div class="ed-frames-head">
        <span class="panel-h" id="framesHeading">Frames — 1</span>
        <div class="ed-frames-meta">
          <!-- TODO (#inline-styles): the icon+label "margin-left:6px" pattern
               appears here, on the Paste/Play buttons below, and at the bottom
               of this file when toggling Play↔Pause. Replace with a small
               .btn-icon-label class in src/style.css. -->
          <button class="btn xs" data-action="copy-frame" title="Copy current frame">${ICON.copy}<span style="margin-left:6px">Copy</span></button>
          <button class="btn xs" data-action="paste-frame" id="pasteBtn" title="Paste copied frame as a new frame" disabled>${ICON.paste}<span style="margin-left:6px">Paste</span></button>
          <button class="btn xs" data-action="toggle-onion" id="onionBtn" aria-pressed="false" title="Onion skin (preview previous frame)">Onion</button>
          <button class="btn xs" data-action="play" id="playBtn" title="Play animation">${ICON.play}<span style="margin-left:6px">Play</span></button>
        </div>
      </div>
      <div id="frameList" class="ed-frames-strip"></div>
    </div>

  </main>

  <dialog id="palettePicker">
    <p>Pick a color from the 256-color base palette</p>
    <div id="baseGrid"></div>
    <form method="dialog">
      <menu>
        <button value="cancel">Cancel</button>
      </menu>
    </form>
  </dialog>
`;

const mainCanvasEl = document.getElementById("main") as HTMLCanvasElement;
const mainCanvas = new PixelCanvas(mainCanvasEl, {
  pixelSize: pixelSizeFor(currentSize),
  size: currentSize,
  showGrid: true,
  gridColor: "#cfccbf",
});
const frameListEl = document.getElementById("frameList")!;
const paletteEl = document.getElementById("palette")!;
const paletteSelectEl = document.getElementById("paletteSelect") as HTMLSelectElement | null;
const picker = document.getElementById("palettePicker") as HTMLDialogElement;
const baseGridEl = document.getElementById("baseGrid")!;
const framesHeadingEl = document.getElementById("framesHeading")!;
const onionBtnEl = document.getElementById("onionBtn") as HTMLButtonElement;
const playBtnEl = document.getElementById("playBtn") as HTMLButtonElement;
const pasteBtnEl = document.getElementById("pasteBtn") as HTMLButtonElement;

function setLastPublishedId(id: string | null): void {
  lastPublishedId = id;
}

const PALETTE_LS_KEY = "drawbang:palette";

function findRetroPalette(id: string): RetroPalette | null {
  return RETRO_PALETTES.find((p) => p.id === id) ?? null;
}

function paletteToActiveIndices(palette: RetroPalette): Uint8Array {
  const out = new Uint8Array(palette.colors.length);
  for (let i = 0; i < palette.colors.length; i++) {
    out[i] = nearestBaseIndex(hexToRgb(palette.colors[i]));
  }
  return out;
}

// Applies the named palette to activePalette, resets the selected swatch,
// re-renders, and (when persist=true) saves the choice to localStorage.
function applyPalette(id: string, persist = true): void {
  const palette = findRetroPalette(id);
  if (!palette) return;
  activePalette = paletteToActiveIndices(palette);
  currentPaletteId = palette.id;
  selectedSlot = 1;
  if (persist) {
    // TODO (#shared-localstorage): this try/catch wraps the same shape used
    // in auth.ts, order.ts, privacy.ts, and the static/ JS files. Extract
    // safeSet() into src/storage-utils.ts.
    try {
      localStorage.setItem(PALETTE_LS_KEY, currentPaletteId);
    } catch {
      // Quota / private-mode — UX still works for the session.
    }
  }
  if (paletteSelectEl && paletteSelectEl.value !== currentPaletteId) {
    paletteSelectEl.value = currentPaletteId;
  }
  render();
}

function openMerch(): void {
  if (!lastPublishedId) {
    showFlash({
      kind: "info",
      message: "Publish your drawing first.",
      autoDismissMs: 5000,
    });
    return;
  }
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "/");
  const frame = state.current;
  location.assign(
    `${base}merch?d=${encodeURIComponent(lastPublishedId)}&frame=${frame}`,
  );
}

// -- Rendering --------------------------------------------------------------

function onionFrame(): Bitmap | null {
  if (!onion || playing || state.frames.length < 2) return null;
  const prev = (state.current - 1 + state.frames.length) % state.frames.length;
  return state.frames[prev];
}

function render(): void {
  const palette = activePaletteToRgb(activePalette);
  mainCanvas.draw(state.frames[state.current], palette, onionFrame());
  renderFrameStrip();
  renderPalette();
  framesHeadingEl.textContent = `Frames — ${state.frames.length}`;
}

function renderPalette(): void {
  paletteEl.innerHTML = "";
  const hex = activePaletteToHex(activePalette);
  for (let i = 0; i < activePalette.length; i++) {
    const b = document.createElement("button");
    b.className = "ed-swatch" + (i === selectedSlot ? " selected" : "");
    b.style.backgroundColor = hex[i];
    b.title = `Slot ${i} — right-click to change color`;
    b.dataset.slot = String(i);
    b.setAttribute("aria-label", `Color ${hex[i]}`);
    b.addEventListener("click", () => {
      selectedSlot = i;
      tool = "pixel";
      setActiveTool("pixel");
      renderPalette();
    });
    b.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      openPickerForSlot(i);
    });
    paletteEl.appendChild(b);
  }
}

function renderFrameStrip(): void {
  frameListEl.innerHTML = "";
  const palette = activePaletteToRgb(activePalette);
  state.frames.forEach((frame, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "ed-frame" + (idx === state.current ? " selected" : "");
    wrap.dataset.frameIndex = String(idx);
    const cv = document.createElement("canvas");
    const preview = new PixelCanvas(cv, {
      pixelSize: FRAME_THUMB_PIXEL_SIZE,
      showGrid: false,
      gridColor: "",
    });
    preview.draw(frame, palette);
    wrap.appendChild(cv);
    const label = document.createElement("span");
    label.className = "ed-frame-num";
    label.textContent = String(idx + 1);
    wrap.appendChild(label);
    if (idx === state.current && state.frames.length > 1) {
      const actions = document.createElement("div");
      actions.className = "ed-frame-actions";
      const del = document.createElement("button");
      del.className = "btn xs ghost";
      del.title = "Delete frame";
      del.innerHTML = ICON.trash;
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteFrameAt(idx);
      });
      actions.appendChild(del);
      wrap.appendChild(actions);
    }
    wrap.addEventListener("click", () => {
      stopPlay();
      state.current = idx;
      render();
    });
    frameListEl.appendChild(wrap);
  });
  const add = document.createElement("button");
  add.className = "ed-frame ed-frame-add";
  add.title = "Add frame";
  add.setAttribute("aria-label", "Add frame");
  add.innerHTML = ICON.plus;
  add.addEventListener("click", () => addFrame());
  frameListEl.appendChild(add);
}

// -- Tools ------------------------------------------------------------------

function setActiveTool(next: "pixel" | "erase" | "fill"): void {
  tool = next;
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.tool === next ? "true" : "false");
  });
}

function applyTool(x: number, y: number): void {
  const frameIdx = state.current;
  const b = state.frames[frameIdx];
  const value = tool === "erase" ? TRANSPARENT : selectedSlot;
  if (tool === "fill") {
    const before = fillArea(b, x, y, value);
    if (before) {
      history.push(() => {
        state.frames[frameIdx] = before;
        state.current = Math.min(frameIdx, state.frames.length - 1);
        render();
      });
      strokeDirty = true;
    }
  } else {
    const prev = drawPixel(b, x, y, value);
    if (prev !== null) strokeDirty = true;
  }
  render();
}

function beginStroke(): void {
  strokeSnapshot = state.frames[state.current].clone();
  strokeDirty = false;
}

function endStroke(): void {
  if (strokeDirty && strokeSnapshot && tool !== "fill") {
    const snapshot = strokeSnapshot;
    const frameIdx = state.current;
    history.push(() => {
      state.frames[frameIdx] = snapshot;
      state.current = Math.min(frameIdx, state.frames.length - 1);
      render();
    });
  }
  strokeSnapshot = null;
  strokeDirty = false;
  persist();
}

function handleTransform(f: (b: Bitmap) => void): void {
  stopPlay();
  const frameIdx = state.current;
  const before = state.frames[frameIdx].clone();
  f(state.frames[frameIdx]);
  history.push(() => {
    state.frames[frameIdx] = before;
    state.current = Math.min(frameIdx, state.frames.length - 1);
    render();
  });
  render();
  persist();
}

function addFrame(): void {
  stopPlay();
  const undo = addFrameOp(state, MAX_FRAMES);
  if (!undo) {
    showFlash({ kind: "info", message: `Max ${MAX_FRAMES} frames.`, autoDismissMs: 5000 });
    return;
  }
  history.push(() => {
    undo();
    render();
  });
  render();
  persist();
  tracker.frameAddClick(state.frames.length);
}

function deleteFrameAt(idx: number): void {
  stopPlay();
  if (state.frames.length <= 1) {
    showFlash({ kind: "info", message: "Can't delete the only frame.", autoDismissMs: 5000 });
    return;
  }
  const before = { frames: state.frames.slice(), current: state.current };
  state.frames.splice(idx, 1);
  state.current = Math.min(state.current, state.frames.length - 1);
  history.push(() => {
    state.frames = before.frames;
    state.current = Math.min(before.current, state.frames.length - 1);
    render();
  });
  render();
  persist();
  tracker.frameDeleteClick(state.frames.length);
}

function copyFrame(): void {
  clipboard = state.frames[state.current].clone();
  pasteBtnEl.disabled = false;
  showFlash({ kind: "info", message: `Copied frame ${state.current + 1}.`, autoDismissMs: 5000 });
}

// Inserts the clipboard as a new frame after the current one. The original
// "paste into current" behaviour from v1 is gone — too easy to clobber work.
function pasteAsNewFrame(): void {
  stopPlay();
  if (!clipboard) {
    showFlash({ kind: "info", message: "Nothing to paste — copy a frame first.", autoDismissMs: 5000 });
    return;
  }
  if (state.frames.length >= MAX_FRAMES) {
    showFlash({ kind: "info", message: `Max ${MAX_FRAMES} frames.`, autoDismissMs: 5000 });
    return;
  }
  const insertAt = state.current + 1;
  const before = { frames: state.frames.slice(), current: state.current };
  state.frames.splice(insertAt, 0, clipboard.clone());
  state.current = insertAt;
  history.push(() => {
    state.frames = before.frames;
    state.current = Math.min(before.current, state.frames.length - 1);
    render();
  });
  render();
  persist();
}

function resetEditor(opts: { keepPublishedId?: boolean } = {}): void {
  stopPlay();
  state.frames = [new Bitmap(currentSize, currentSize)];
  state.current = 0;
  history.clear();
  localId = null;
  // Re-apply the user's chosen palette on reset — picking a palette is an
  // intentional workflow choice that should outlive a publish or Clear.
  applyPalette(currentPaletteId, false);
  setActiveTool("pixel");
  parentId = null;
  if (!opts.keepPublishedId) setLastPublishedId(null);
  render();
  persist();
}

function clearAllFrames(): void {
  if (!confirm("Clear everything? All frames and undo history will be lost.")) return;
  resetEditor();
}

function togglePlay(): void {
  if (playing) stopPlay();
  else startPlay();
}

function startPlay(): void {
  if (playing) return;
  if (state.frames.length < 2) {
    showFlash({ kind: "info", message: "Add a second frame to play.", autoDismissMs: 5000 });
    return;
  }
  if (playTimer !== null) {
    clearInterval(playTimer);
    playTimer = null;
  }
  playing = true;
  frameBeforePlay = state.current;
  state.current = 0;
  render();
  updatePlayButton();
  playTimer = setInterval(() => {
    state.current = (state.current + 1) % state.frames.length;
    renderPlayTick();
  }, PLAY_DELAY_MS);
}

function renderPlayTick(): void {
  const palette = activePaletteToRgb(activePalette);
  mainCanvas.draw(state.frames[state.current], palette);
  frameListEl
    .querySelectorAll<HTMLElement>(".ed-frame:not(.ed-frame-add)")
    .forEach((w, i) => {
      w.classList.toggle("selected", i === state.current);
    });
}

function stopPlay(): void {
  if (playTimer !== null) {
    clearInterval(playTimer);
    playTimer = null;
  }
  if (!playing) return;
  playing = false;
  state.current = Math.min(frameBeforePlay, state.frames.length - 1);
  render();
  updatePlayButton();
}

function updatePlayButton(): void {
  if (!playBtnEl) return;
  playBtnEl.innerHTML = playing
    ? `${ICON.pause}<span style="margin-left:6px">Pause</span>`
    : `${ICON.play}<span style="margin-left:6px">Play</span>`;
  playBtnEl.setAttribute("aria-pressed", playing ? "true" : "false");
  playBtnEl.setAttribute("title", playing ? "Pause animation" : "Play animation");
}

function setOnion(next: boolean): void {
  onion = next;
  onionBtnEl.setAttribute("aria-pressed", onion ? "true" : "false");
  render();
}

// -- Palette picker ---------------------------------------------------------

let pickerTargetSlot = -1;
const baseCellEls: HTMLButtonElement[] = [];

function buildBaseGrid(): void {
  baseGridEl.innerHTML = "";
  baseCellEls.length = 0;
  BASE_PALETTE.forEach(([r, g, b], idx) => {
    const cell = document.createElement("button");
    cell.className = "base-cell";
    cell.style.backgroundColor = `rgb(${r},${g},${b})`;
    cell.title = `Base #${idx}`;
    cell.dataset.baseIdx = String(idx);
    cell.addEventListener("click", () => {
      if (pickerTargetSlot < 0) return;
      const slot = pickerTargetSlot;
      const prevIdx = activePalette[slot];
      if (idx === prevIdx) {
        picker.close();
        return;
      }
      activePalette[slot] = idx;
      history.push(() => {
        activePalette[slot] = prevIdx;
        render();
        persist();
      });
      picker.close();
      render();
      persist();
    });
    baseGridEl.appendChild(cell);
    baseCellEls.push(cell);
  });
}

function highlightPickerCurrent(slot: number): void {
  const current = activePalette[slot];
  for (let i = 0; i < baseCellEls.length; i++) {
    baseCellEls[i].classList.toggle("current", i === current);
  }
}

function openPickerForSlot(slot: number): void {
  pickerTargetSlot = slot;
  highlightPickerCurrent(slot);
  picker.showModal();
  // Without explicit focus, browsers autofocus the first child (top-left
  // swatch) and stamp a default focus ring over it — visually rivaling
  // the "current" accent highlight on a different cell. Park focus on
  // the current cell instead so the two indicators merge.
  baseCellEls[activePalette[slot]]?.focus();
}

// -- Publishing / export ----------------------------------------------------

function redirectToLogin(): void {
  const next = encodeURIComponent(
    location.pathname + location.search + location.hash,
  );
  location.assign(`/login?next=${next}`);
}

async function handlePublish(): Promise<void> {
  if (!isLoggedIn()) {
    redirectToLogin();
    return;
  }
  tracker.publishClick(state.frames.length);
  showFlash({ kind: "info", message: "Publishing…" });
  // Captured before the await so the remix flag reflects the parent that
  // was actually sent, even if state resets mid-flight.
  const publishedParentId = parentId;
  try {
    const result = await submit({
      ingestUrl: INGEST_URL,
      gif: encodeGif({ frames: state.frames, activePalette, size: currentSize }),
      parent: publishedParentId ?? undefined,
    });
    flashPublished(result.share_url);
    tracker.publishSuccess({
      frames: state.frames.length,
      solve_ms: 0,
      remix: publishedParentId !== null,
      prompt: null,
    });
    if (localId) {
      await local.save({ id: localId, frames: state.frames, activePalette, publishedId: result.id });
    }
    setLastPublishedId(result.id);
    resetEditor({ keepPublishedId: true });
  } catch (err) {
    if (err instanceof MissingSessionError) {
      showFlash({ kind: "error", message: "Sign in to publish." });
      redirectToLogin();
      return;
    }
    showFlash({
      kind: "error",
      message: `Publish failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function flashPublished(shareUrl: string): void {
  const link = document.createElement("a");
  link.href = shareUrl;
  link.textContent = shareUrl;
  link.target = "_blank";
  link.rel = "noopener";
  showFlash({ kind: "success", message: ["Published: ", link] });
}

function downloadGif(): void {
  const bytes = encodeGif({ frames: state.frames, activePalette, size: currentSize });
  const copy = new Uint8Array(bytes);
  const blob = new Blob([copy as unknown as BlobPart], { type: "image/gif" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "drawbang.gif";
  a.click();
  URL.revokeObjectURL(url);
  tracker.gifDownloadClick({ source: "editor", frames: state.frames.length });
}

// -- Size picker -----------------------------------------------------------

function changeSize(newSize: number): void {
  if (!DRAWING_SIZES.includes(newSize) || newSize === currentSize) return;
  const hasContent = state.frames.some((f) => f.data.some((v) => v !== TRANSPARENT));
  if (hasContent) {
    const ok = confirm(
      `Switch canvas to ${newSize}×${newSize}? Your current drawing will be cleared.`,
    );
    if (!ok) return;
  }
  currentSize = newSize;
  state.frames = [new Bitmap(currentSize, currentSize)];
  state.current = 0;
  mainCanvas.setSize(currentSize, pixelSizeFor(currentSize));
  history.clear();
  parentId = null;
  setLastPublishedId(null);
  renderSizePicker();
  render();
  renderFrameStrip();
  persist();
}

function renderSizePicker(): void {
  document
    .querySelectorAll<HTMLButtonElement>(".ed-size-opt")
    .forEach((btn) => {
      const s = Number(btn.dataset.size);
      btn.setAttribute("aria-pressed", s === currentSize ? "true" : "false");
    });
}

function copyShareLink(): void {
  if (currentSize !== DEFAULT_SIZE) {
    showFlash({
      kind: "info",
      message: `Share links only work at ${DEFAULT_SIZE}×${DEFAULT_SIZE} for now. Publish the drawing to share it.`,
      autoDismissMs: 5000,
    });
    return;
  }
  const hash = encodeShare({ frames: state.frames, activePalette });
  const url = `${location.origin}${location.pathname}#d=${hash}`;
  navigator.clipboard?.writeText(url);
  showFlash({
    kind: "success",
    message: `Share link copied (${hash.length} chars).`,
    autoDismissMs: 5000,
  });
}

function persist(): void {
  if (!localId) localId = local.uuid();
  local.save({ id: localId, frames: state.frames, activePalette }).catch(() => {});
}

// -- Events -----------------------------------------------------------------

function pointerToPixel(ev: PointerEvent): { x: number; y: number } {
  return mainCanvas.quantize(ev.clientX, ev.clientY);
}

mainCanvasEl.addEventListener("pointerdown", (ev) => {
  if (playing) return;
  ev.preventDefault();
  painting = true;
  beginStroke();
  const { x, y } = pointerToPixel(ev);
  applyTool(x, y);
});
window.addEventListener("pointermove", (ev) => {
  if (!painting) return;
  const { x, y } = pointerToPixel(ev);
  applyTool(x, y);
});
window.addEventListener("pointerup", () => {
  if (!painting) return;
  painting = false;
  endStroke();
});
window.addEventListener("pointercancel", () => {
  if (!painting) return;
  painting = false;
  endStroke();
});

document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) =>
  b.addEventListener("click", () => {
    const next = b.dataset.tool as typeof tool;
    if (next === tool) return; // No-op re-click — don't bother GA.
    tracker.toolClick(next);
    setActiveTool(next);
  }),
);

document.querySelectorAll<HTMLButtonElement>(".ed-size-opt").forEach((b) =>
  b.addEventListener("click", () => {
    const next = Number(b.dataset.size);
    if (Number.isFinite(next)) changeSize(next);
  }),
);

document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((b) =>
  b.addEventListener("click", () => {
    switch (b.dataset.action) {
      case "undo": history.undo(); render(); break;
      case "clear": clearAllFrames(); break;
      case "flip-h": handleTransform(flipHorizontal); break;
      case "flip-v": handleTransform(flipVertical); break;
      case "rotate": handleTransform(rotateLeft); break;
      case "shift-right": handleTransform(shiftRight); break;
      case "shift-up": handleTransform(shiftUp); break;
      case "copy-frame": copyFrame(); break;
      case "paste-frame": pasteAsNewFrame(); break;
      case "play": togglePlay(); break;
      case "toggle-onion": setOnion(!onion); break;
      case "edit-color": openPickerForSlot(selectedSlot); break;
      case "export-gif": stopPlay(); downloadGif(); break;
      case "share": stopPlay(); copyShareLink(); break;
      case "publish": stopPlay(); void handlePublish(); break;
      case "make-merch": stopPlay(); openMerch(); break;
    }
  }),
);

paletteSelectEl?.addEventListener("change", () => {
  applyPalette(paletteSelectEl.value);
});

window.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "z") {
    ev.preventDefault();
    history.undo();
    render();
  }
});

// -- Bootstrapping ----------------------------------------------------------

async function boot(): Promise<void> {
  buildBaseGrid();
  // Apply the default EGA palette first so the initial swatches match the
  // palette select. Then rehydrate the user's pick from localStorage, if any —
  // unknown ids silently fall back to EGA.
  applyPalette(currentPaletteId, false);
  try {
    const stored = localStorage.getItem(PALETTE_LS_KEY);
    if (stored && findRetroPalette(stored)) {
      applyPalette(stored, false);
    }
  } catch {
    // ignore — applyPalette default state is already in place
  }

  const hash = location.hash.match(/#d=([A-Za-z0-9_-]+)/)?.[1];
  const forkId = new URL(location.href).searchParams.get("fork");

  if (forkId) {
    try {
      const res = await fetch(`${DRAWING_BASE_URL}/${forkId}.gif`);
      if (!res.ok) throw new Error(`fork fetch failed: ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const decoded = decodeGif(buf);
      // Sync the editor's size to whatever the forked drawing was published at.
      if (decoded.size !== currentSize) {
        currentSize = decoded.size;
        mainCanvas.setSize(currentSize, pixelSizeFor(currentSize));
        renderSizePicker();
      }
      state.frames = decoded.frames;
      if (decoded.activePalette) activePalette = decoded.activePalette;
      state.current = 0;
      parentId = forkId;
      setLastPublishedId(forkId);
    } catch (err) {
      showFlash({
        kind: "error",
        message: `Remix failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else if (hash) {
    try {
      const d = decodeShare(hash);
      state.frames = d.frames;
      activePalette = d.activePalette;
      state.current = 0;
    } catch (err) {
      showFlash({
        kind: "error",
        message: `Invalid share link: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  render();
}

void boot();
