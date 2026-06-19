import { MAX_FRAMES } from "../config/constants.js";
import { tracker } from "./analytics/analytics.js";
import { Bitmap, TRANSPARENT } from "./editor/bitmap.js";
import { PixelCanvas } from "./editor/canvas.js";
import { decodeGif, encodeGif } from "./editor/gif.js";
import { History } from "./editor/history.js";
import {
  addFrame as addFrameOp,
  addLayer as addLayerOp,
  moveLayer as moveLayerOp,
  newFrameState,
  removeLayer as removeLayerOp,
  toggleLayerVisibility as toggleLayerVisOp,
  type FrameState,
} from "./editor/frames.js";
import {
  cloneFrame,
  composeFrame,
  MAX_LAYERS,
  type Frame,
} from "./editor/layers.js";
import {
  BASE_PALETTE,
  DEFAULT_ACTIVE_PALETTE,
  activePaletteToHex,
  activePaletteToRgb,
  hexToRgb,
  nearestBaseIndex,
} from "./editor/palette.js";
import { RETRO_PALETTES, padPalette, type RetroPalette } from "../config/palettes.js";
import {
  lospecPaletteUrl,
  parseImportInput,
  parseLospecJson,
} from "./editor/lospec.js";
import {
  PixelPerfectStroke,
  drawPixel,
  fillArea,
  flipHorizontal,
  flipVertical,
  mirrorX,
  rotateLeft,
  translate,
} from "./editor/tools.js";
import { decodeShare, encodeShare } from "./share.js";
import { promptFromQuery, promptGuidanceHint } from "./prompt-query.js";
import type { Prompt } from "../config/prompts.js";
import * as local from "./local.js";
import { isLoggedIn } from "./auth.js";
import {
  MissingSessionError,
  submit,
} from "./submit.js";
import { showFlash } from "./layout/flash.js";
import { createExportDialog } from "./export-dialog.js";
import { OpLogRecorder } from "./editor/oplog.js";
import { DEFAULT_SIZE, DRAWING_SIZES, FRAME_DELAY_MS } from "../config/constants.js";

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
const state: FrameState = newFrameState(currentSize, currentSize);
let activePalette: Uint8Array = new Uint8Array(DEFAULT_ACTIVE_PALETTE);
// RetroPalette.id of the currently-applied palette. Persisted to localStorage and applied
// on boot + on every editor reset so the user's last pick survives a
// publish or Clear.
let currentPaletteId = "ega";
let selectedSlot = 1;
let tool: "pixel" | "erase" | "fill" | "move" = "pixel";
let painting = false;
let strokeSnapshot: Bitmap | null = null;
let strokeDirty = false;
// Move tool: drag-translate state. moveSnapshot is the pre-drag bitmap each
// frame of translation reads from (so we never accumulate rounding errors);
// moveStart anchors the drag in unclamped canvas-cell space; moveLastDelta
// caches the most recent net (dx, dy) so we can early-out on duplicate
// pointer events and recover the final delta at pointer-up.
let moveSnapshot: Bitmap | null = null;
let moveStart: { x: number; y: number } | null = null;
let moveLastDelta: { dx: number; dy: number } = { dx: 0, dy: 0 };
let pixelPerfect = false;
// Horizontal symmetry mode: pencil/eraser/fill also paint the
// mirrored column (b.width - 1 - x). Persisted to localStorage.
let symmetryH = false;
// Live only during a pencil stroke when pixelPerfect is on.
let ppStroke: PixelPerfectStroke | null = null;
let playing = false;
let playTimer: ReturnType<typeof setInterval> | null = null;
let frameBeforePlay = 0;
// Clipboard stores a full Frame (all layers) so paste-as-new-frame
// preserves the layer hierarchy of the copied frame.
let clipboard: Frame | null = null;
const history = new History();
let localId: string | null = null;
let lastPublishedId: string | null = null;
// Set when the editor boots with ?fork=<id>. Forwarded to ingest as
// `parent` on the next publish so the new drawing records its lineage.
// Cleared on every reset — a blank canvas isn't a fork of anything.
let parentId: string | null = null;
// Set when the editor boots with ?prompt=<slug> matching TODAY's ET prompt
// (stale/garbage slugs are ignored entirely). Unlike parentId it survives
// resetEditor: the chip stays up, so every publish this session is a
// response to the prompt.
let promptSlug: string | null = null;
let onion = false;
// One delay drives both the preview timer and encodeGif, so the editor
// preview always matches the rendered GIF. Snapped to FPS_STEPS; the
// 5-fps stop (200 ms) is the legacy default every old drawing sits on.
const FPS_STEPS = [4, 5, 6, 8, 10, 12];
const DEFAULT_FPS_INDEX = 1; // 5 fps
let delayMs: number = FRAME_DELAY_MS;

// -- Tool icon SVGs (placeholder — will be replaced) ------------------------
// 16×16 viewBox, fill=currentColor. The user plans to swap these later;
// they live inline so the editor doesn't add a sprite-sheet asset request.
const ICON = {
  pencil: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="9" y="2" width="1" height="1"/><rect x="10" y="2" width="1" height="1"/><rect x="9" y="3" width="1" height="1"/><rect x="10" y="3" width="1" height="1"/><rect x="11" y="3" width="1" height="1"/><rect x="8" y="4" width="1" height="1"/><rect x="10" y="4" width="1" height="1"/><rect x="11" y="4" width="1" height="1"/><rect x="12" y="4" width="1" height="1"/><rect x="8" y="5" width="1" height="1"/><rect x="11" y="5" width="1" height="1"/><rect x="7" y="6" width="1" height="1"/><rect x="10" y="6" width="1" height="1"/><rect x="7" y="7" width="1" height="1"/><rect x="10" y="7" width="1" height="1"/><rect x="6" y="8" width="1" height="1"/><rect x="9" y="8" width="1" height="1"/><rect x="6" y="9" width="1" height="1"/><rect x="9" y="9" width="1" height="1"/><rect x="5" y="10" width="1" height="1"/><rect x="8" y="10" width="1" height="1"/><rect x="5" y="11" width="1" height="1"/><rect x="8" y="11" width="1" height="1"/><rect x="4" y="12" width="1" height="1"/><rect x="7" y="12" width="1" height="1"/><rect x="4" y="13" width="1" height="1"/><rect x="5" y="13" width="1" height="1"/><rect x="6" y="13" width="1" height="1"/><rect x="4" y="14" width="1" height="1"/><rect x="5" y="14" width="1" height="1"/></g></svg>`,
  eraser: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="7" y="5" width="1" height="1"/><rect x="8" y="5" width="1" height="1"/><rect x="9" y="5" width="1" height="1"/><rect x="10" y="5" width="1" height="1"/><rect x="11" y="5" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/><rect x="12" y="6" width="1" height="1"/><rect x="5" y="7" width="1" height="1"/><rect x="12" y="7" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/><rect x="5" y="8" width="1" height="1"/><rect x="6" y="8" width="1" height="1"/><rect x="7" y="8" width="1" height="1"/><rect x="8" y="8" width="1" height="1"/><rect x="9" y="8" width="1" height="1"/><rect x="11" y="8" width="1" height="1"/><rect x="3" y="9" width="1" height="1"/><rect x="4" y="9" width="1" height="1"/><rect x="5" y="9" width="1" height="1"/><rect x="6" y="9" width="1" height="1"/><rect x="7" y="9" width="1" height="1"/><rect x="8" y="9" width="1" height="1"/><rect x="9" y="9" width="1" height="1"/><rect x="10" y="9" width="1" height="1"/><rect x="3" y="10" width="1" height="1"/><rect x="4" y="10" width="1" height="1"/><rect x="5" y="10" width="1" height="1"/><rect x="6" y="10" width="1" height="1"/><rect x="7" y="10" width="1" height="1"/><rect x="8" y="10" width="1" height="1"/><rect x="9" y="10" width="1" height="1"/><rect x="3" y="11" width="1" height="1"/><rect x="4" y="11" width="1" height="1"/><rect x="5" y="11" width="1" height="1"/><rect x="6" y="11" width="1" height="1"/><rect x="7" y="11" width="1" height="1"/><rect x="8" y="11" width="1" height="1"/></g></svg>`,
  fill: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="7" y="2" width="1" height="1"/><rect x="8" y="2" width="1" height="1"/><rect x="6" y="3" width="1" height="1"/><rect x="9" y="3" width="1" height="1"/><rect x="6" y="4" width="1" height="1"/><rect x="8" y="4" width="1" height="1"/><rect x="9" y="4" width="1" height="1"/><rect x="6" y="5" width="1" height="1"/><rect x="7" y="5" width="1" height="1"/><rect x="9" y="5" width="1" height="1"/><rect x="10" y="5" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/><rect x="9" y="6" width="1" height="1"/><rect x="11" y="6" width="1" height="1"/><rect x="5" y="7" width="1" height="1"/><rect x="8" y="7" width="1" height="1"/><rect x="9" y="7" width="1" height="1"/><rect x="11" y="7" width="1" height="1"/><rect x="12" y="7" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/><rect x="8" y="8" width="1" height="1"/><rect x="9" y="8" width="1" height="1"/><rect x="11" y="8" width="1" height="1"/><rect x="12" y="8" width="1" height="1"/><rect x="13" y="8" width="1" height="1"/><rect x="3" y="9" width="1" height="1"/><rect x="11" y="9" width="1" height="1"/><rect x="12" y="9" width="1" height="1"/><rect x="13" y="9" width="1" height="1"/><rect x="3" y="10" width="1" height="1"/><rect x="10" y="10" width="1" height="1"/><rect x="12" y="10" width="1" height="1"/><rect x="4" y="11" width="1" height="1"/><rect x="9" y="11" width="1" height="1"/><rect x="12" y="11" width="1" height="1"/><rect x="5" y="12" width="1" height="1"/><rect x="8" y="12" width="1" height="1"/><rect x="6" y="13" width="1" height="1"/><rect x="7" y="13" width="1" height="1"/><rect x="12" y="13" width="1" height="1"/></g></svg>`,
  hand: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="6" y="1" width="1" height="1"/><rect x="7" y="1" width="1" height="1"/><rect x="5" y="2" width="1" height="1"/><rect x="6" y="2" width="1" height="1"/><rect x="7" y="2" width="1" height="1"/><rect x="8" y="2" width="1" height="1"/><rect x="5" y="3" width="1" height="1"/><rect x="6" y="3" width="1" height="1"/><rect x="7" y="3" width="1" height="1"/><rect x="8" y="3" width="1" height="1"/><rect x="5" y="4" width="1" height="1"/><rect x="6" y="4" width="1" height="1"/><rect x="7" y="4" width="1" height="1"/><rect x="8" y="4" width="1" height="1"/><rect x="9" y="4" width="1" height="1"/><rect x="10" y="4" width="1" height="1"/><rect x="3" y="5" width="1" height="1"/><rect x="4" y="5" width="1" height="1"/><rect x="5" y="5" width="1" height="1"/><rect x="6" y="5" width="1" height="1"/><rect x="7" y="5" width="1" height="1"/><rect x="8" y="5" width="1" height="1"/><rect x="9" y="5" width="1" height="1"/><rect x="10" y="5" width="1" height="1"/><rect x="11" y="5" width="1" height="1"/><rect x="3" y="6" width="1" height="1"/><rect x="4" y="6" width="1" height="1"/><rect x="5" y="6" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/><rect x="7" y="6" width="1" height="1"/><rect x="8" y="6" width="1" height="1"/><rect x="9" y="6" width="1" height="1"/><rect x="10" y="6" width="1" height="1"/><rect x="11" y="6" width="1" height="1"/><rect x="2" y="7" width="1" height="1"/><rect x="3" y="7" width="1" height="1"/><rect x="4" y="7" width="1" height="1"/><rect x="5" y="7" width="1" height="1"/><rect x="6" y="7" width="1" height="1"/><rect x="7" y="7" width="1" height="1"/><rect x="8" y="7" width="1" height="1"/><rect x="9" y="7" width="1" height="1"/><rect x="10" y="7" width="1" height="1"/><rect x="11" y="7" width="1" height="1"/><rect x="2" y="8" width="1" height="1"/><rect x="3" y="8" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/><rect x="5" y="8" width="1" height="1"/><rect x="6" y="8" width="1" height="1"/><rect x="7" y="8" width="1" height="1"/><rect x="8" y="8" width="1" height="1"/><rect x="9" y="8" width="1" height="1"/><rect x="10" y="8" width="1" height="1"/><rect x="11" y="8" width="1" height="1"/><rect x="3" y="9" width="1" height="1"/><rect x="4" y="9" width="1" height="1"/><rect x="5" y="9" width="1" height="1"/><rect x="6" y="9" width="1" height="1"/><rect x="7" y="9" width="1" height="1"/><rect x="8" y="9" width="1" height="1"/><rect x="9" y="9" width="1" height="1"/><rect x="10" y="9" width="1" height="1"/><rect x="11" y="9" width="1" height="1"/><rect x="4" y="10" width="1" height="1"/><rect x="5" y="10" width="1" height="1"/><rect x="6" y="10" width="1" height="1"/><rect x="7" y="10" width="1" height="1"/><rect x="8" y="10" width="1" height="1"/><rect x="9" y="10" width="1" height="1"/><rect x="10" y="10" width="1" height="1"/><rect x="11" y="10" width="1" height="1"/><rect x="5" y="11" width="1" height="1"/><rect x="6" y="11" width="1" height="1"/><rect x="7" y="11" width="1" height="1"/><rect x="8" y="11" width="1" height="1"/><rect x="9" y="11" width="1" height="1"/><rect x="10" y="11" width="1" height="1"/><rect x="11" y="11" width="1" height="1"/><rect x="6" y="12" width="1" height="1"/><rect x="7" y="12" width="1" height="1"/><rect x="8" y="12" width="1" height="1"/><rect x="9" y="12" width="1" height="1"/><rect x="10" y="12" width="1" height="1"/></g></svg>`,
  undo: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="7" y="2" width="1" height="1"/><rect x="8" y="2" width="1" height="1"/><rect x="9" y="2" width="1" height="1"/><rect x="10" y="2" width="1" height="1"/><rect x="11" y="2" width="1" height="1"/><rect x="2" y="3" width="1" height="1"/><rect x="3" y="3" width="1" height="1"/><rect x="6" y="3" width="1" height="1"/><rect x="7" y="3" width="1" height="1"/><rect x="8" y="3" width="1" height="1"/><rect x="9" y="3" width="1" height="1"/><rect x="10" y="3" width="1" height="1"/><rect x="11" y="3" width="1" height="1"/><rect x="12" y="3" width="1" height="1"/><rect x="2" y="4" width="1" height="1"/><rect x="3" y="4" width="1" height="1"/><rect x="5" y="4" width="1" height="1"/><rect x="6" y="4" width="1" height="1"/><rect x="7" y="4" width="1" height="1"/><rect x="11" y="4" width="1" height="1"/><rect x="12" y="4" width="1" height="1"/><rect x="13" y="4" width="1" height="1"/><rect x="2" y="5" width="1" height="1"/><rect x="3" y="5" width="1" height="1"/><rect x="4" y="5" width="1" height="1"/><rect x="5" y="5" width="1" height="1"/><rect x="6" y="5" width="1" height="1"/><rect x="12" y="5" width="1" height="1"/><rect x="13" y="5" width="1" height="1"/><rect x="2" y="6" width="1" height="1"/><rect x="3" y="6" width="1" height="1"/><rect x="4" y="6" width="1" height="1"/><rect x="5" y="6" width="1" height="1"/><rect x="12" y="6" width="1" height="1"/><rect x="13" y="6" width="1" height="1"/><rect x="2" y="7" width="1" height="1"/><rect x="3" y="7" width="1" height="1"/><rect x="4" y="7" width="1" height="1"/><rect x="5" y="7" width="1" height="1"/><rect x="6" y="7" width="1" height="1"/><rect x="7" y="7" width="1" height="1"/><rect x="12" y="7" width="1" height="1"/><rect x="13" y="7" width="1" height="1"/><rect x="2" y="8" width="1" height="1"/><rect x="3" y="8" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/><rect x="5" y="8" width="1" height="1"/><rect x="6" y="8" width="1" height="1"/><rect x="7" y="8" width="1" height="1"/><rect x="11" y="8" width="1" height="1"/><rect x="12" y="8" width="1" height="1"/><rect x="13" y="8" width="1" height="1"/><rect x="10" y="9" width="1" height="1"/><rect x="11" y="9" width="1" height="1"/><rect x="12" y="9" width="1" height="1"/><rect x="9" y="10" width="1" height="1"/><rect x="10" y="10" width="1" height="1"/><rect x="11" y="10" width="1" height="1"/><rect x="8" y="11" width="1" height="1"/><rect x="9" y="11" width="1" height="1"/><rect x="10" y="11" width="1" height="1"/><rect x="8" y="12" width="1" height="1"/><rect x="9" y="12" width="1" height="1"/></g></svg>`,
  clear: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="8" y="3" width="1" height="1"/><rect x="9" y="3" width="1" height="1"/><rect x="12" y="3" width="1" height="1"/><rect x="7" y="4" width="1" height="1"/><rect x="10" y="4" width="1" height="1"/><rect x="6" y="5" width="1" height="1"/><rect x="11" y="5" width="1" height="1"/><rect x="13" y="5" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/><rect x="5" y="7" width="1" height="1"/><rect x="6" y="7" width="1" height="1"/><rect x="7" y="7" width="1" height="1"/><rect x="10" y="7" width="1" height="1"/><rect x="12" y="7" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/><rect x="5" y="8" width="1" height="1"/><rect x="6" y="8" width="1" height="1"/><rect x="7" y="8" width="1" height="1"/><rect x="8" y="8" width="1" height="1"/><rect x="3" y="9" width="1" height="1"/><rect x="4" y="9" width="1" height="1"/><rect x="5" y="9" width="1" height="1"/><rect x="6" y="9" width="1" height="1"/><rect x="7" y="9" width="1" height="1"/><rect x="8" y="9" width="1" height="1"/><rect x="9" y="9" width="1" height="1"/><rect x="3" y="10" width="1" height="1"/><rect x="4" y="10" width="1" height="1"/><rect x="5" y="10" width="1" height="1"/><rect x="6" y="10" width="1" height="1"/><rect x="7" y="10" width="1" height="1"/><rect x="8" y="10" width="1" height="1"/><rect x="9" y="10" width="1" height="1"/><rect x="3" y="11" width="1" height="1"/><rect x="4" y="11" width="1" height="1"/><rect x="5" y="11" width="1" height="1"/><rect x="6" y="11" width="1" height="1"/><rect x="7" y="11" width="1" height="1"/><rect x="8" y="11" width="1" height="1"/><rect x="9" y="11" width="1" height="1"/><rect x="4" y="12" width="1" height="1"/><rect x="5" y="12" width="1" height="1"/><rect x="6" y="12" width="1" height="1"/><rect x="7" y="12" width="1" height="1"/><rect x="8" y="12" width="1" height="1"/><rect x="5" y="13" width="1" height="1"/><rect x="6" y="13" width="1" height="1"/><rect x="7" y="13" width="1" height="1"/></g></svg>`,
  flipH: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="6" y="2" width="1" height="1"/><rect x="7" y="2" width="1" height="1"/><rect x="9" y="2" width="1" height="1"/><rect x="5" y="3" width="1" height="1"/><rect x="6" y="3" width="1" height="1"/><rect x="7" y="3" width="1" height="1"/><rect x="8" y="3" width="1" height="1"/><rect x="10" y="3" width="1" height="1"/><rect x="4" y="4" width="1" height="1"/><rect x="5" y="4" width="1" height="1"/><rect x="6" y="4" width="1" height="1"/><rect x="7" y="4" width="1" height="1"/><rect x="9" y="4" width="1" height="1"/><rect x="11" y="4" width="1" height="1"/><rect x="4" y="5" width="1" height="1"/><rect x="5" y="5" width="1" height="1"/><rect x="8" y="5" width="1" height="1"/><rect x="10" y="5" width="1" height="1"/><rect x="4" y="6" width="1" height="1"/><rect x="9" y="6" width="1" height="1"/><rect x="11" y="6" width="1" height="1"/><rect x="4" y="7" width="1" height="1"/><rect x="6" y="7" width="1" height="1"/><rect x="8" y="7" width="1" height="1"/><rect x="10" y="7" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/><rect x="9" y="8" width="1" height="1"/><rect x="11" y="8" width="1" height="1"/><rect x="4" y="9" width="1" height="1"/><rect x="8" y="9" width="1" height="1"/><rect x="10" y="9" width="1" height="1"/><rect x="4" y="10" width="1" height="1"/><rect x="7" y="10" width="1" height="1"/><rect x="9" y="10" width="1" height="1"/><rect x="11" y="10" width="1" height="1"/><rect x="5" y="11" width="1" height="1"/><rect x="8" y="11" width="1" height="1"/><rect x="10" y="11" width="1" height="1"/><rect x="6" y="12" width="1" height="1"/><rect x="7" y="12" width="1" height="1"/><rect x="9" y="12" width="1" height="1"/></g></svg>`,
  flipV: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="6" y="2" width="1" height="1"/><rect x="7" y="2" width="1" height="1"/><rect x="8" y="2" width="1" height="1"/><rect x="9" y="2" width="1" height="1"/><rect x="5" y="3" width="1" height="1"/><rect x="6" y="3" width="1" height="1"/><rect x="7" y="3" width="1" height="1"/><rect x="8" y="3" width="1" height="1"/><rect x="9" y="3" width="1" height="1"/><rect x="10" y="3" width="1" height="1"/><rect x="4" y="4" width="1" height="1"/><rect x="5" y="4" width="1" height="1"/><rect x="6" y="4" width="1" height="1"/><rect x="7" y="4" width="1" height="1"/><rect x="8" y="4" width="1" height="1"/><rect x="9" y="4" width="1" height="1"/><rect x="10" y="4" width="1" height="1"/><rect x="11" y="4" width="1" height="1"/><rect x="4" y="5" width="1" height="1"/><rect x="5" y="5" width="1" height="1"/><rect x="10" y="5" width="1" height="1"/><rect x="11" y="5" width="1" height="1"/><rect x="4" y="6" width="1" height="1"/><rect x="11" y="6" width="1" height="1"/><rect x="4" y="7" width="1" height="1"/><rect x="6" y="7" width="1" height="1"/><rect x="9" y="7" width="1" height="1"/><rect x="11" y="7" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/><rect x="6" y="8" width="1" height="1"/><rect x="8" y="8" width="1" height="1"/><rect x="10" y="8" width="1" height="1"/><rect x="11" y="8" width="1" height="1"/><rect x="4" y="9" width="1" height="1"/><rect x="5" y="9" width="1" height="1"/><rect x="7" y="9" width="1" height="1"/><rect x="9" y="9" width="1" height="1"/><rect x="11" y="9" width="1" height="1"/><rect x="4" y="10" width="1" height="1"/><rect x="6" y="10" width="1" height="1"/><rect x="8" y="10" width="1" height="1"/><rect x="10" y="10" width="1" height="1"/><rect x="5" y="11" width="1" height="1"/><rect x="7" y="11" width="1" height="1"/><rect x="9" y="11" width="1" height="1"/><rect x="6" y="12" width="1" height="1"/><rect x="8" y="12" width="1" height="1"/></g></svg>`,
  rotate: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="6" y="0" width="1" height="1"/><rect x="7" y="0" width="1" height="1"/><rect x="8" y="0" width="1" height="1"/><rect x="9" y="0" width="1" height="1"/><rect x="3" y="1" width="1" height="1"/><rect x="5" y="1" width="1" height="1"/><rect x="10" y="1" width="1" height="1"/><rect x="3" y="2" width="1" height="1"/><rect x="4" y="2" width="1" height="1"/><rect x="11" y="2" width="1" height="1"/><rect x="3" y="3" width="1" height="1"/><rect x="4" y="3" width="1" height="1"/><rect x="5" y="3" width="1" height="1"/><rect x="11" y="3" width="1" height="1"/><rect x="4" y="6" width="1" height="1"/><rect x="10" y="6" width="1" height="1"/><rect x="11" y="6" width="1" height="1"/><rect x="12" y="6" width="1" height="1"/><rect x="4" y="7" width="1" height="1"/><rect x="11" y="7" width="1" height="1"/><rect x="12" y="7" width="1" height="1"/><rect x="5" y="8" width="1" height="1"/><rect x="10" y="8" width="1" height="1"/><rect x="12" y="8" width="1" height="1"/><rect x="6" y="9" width="1" height="1"/><rect x="7" y="9" width="1" height="1"/><rect x="8" y="9" width="1" height="1"/><rect x="9" y="9" width="1" height="1"/><rect x="5" y="11" width="1" height="1"/><rect x="6" y="11" width="1" height="1"/><rect x="10" y="11" width="1" height="1"/><rect x="11" y="11" width="1" height="1"/><rect x="4" y="12" width="1" height="1"/><rect x="7" y="12" width="1" height="1"/><rect x="9" y="12" width="1" height="1"/><rect x="12" y="12" width="1" height="1"/><rect x="5" y="13" width="1" height="1"/><rect x="6" y="13" width="1" height="1"/><rect x="7" y="13" width="1" height="1"/><rect x="9" y="13" width="1" height="1"/><rect x="12" y="13" width="1" height="1"/><rect x="7" y="14" width="1" height="1"/><rect x="9" y="14" width="1" height="1"/><rect x="12" y="14" width="1" height="1"/><rect x="5" y="15" width="1" height="1"/><rect x="6" y="15" width="1" height="1"/><rect x="10" y="15" width="1" height="1"/><rect x="11" y="15" width="1" height="1"/></g></svg>`,
  perfect: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="3" y="12" width="1" height="1"/><rect x="4" y="12" width="1" height="1"/><rect x="4" y="11" width="1" height="1"/><rect x="5" y="11" width="1" height="1"/><rect x="5" y="10" width="1" height="1"/><rect x="6" y="10" width="1" height="1"/><rect x="6" y="9" width="1" height="1"/><rect x="7" y="9" width="1" height="1"/><rect x="7" y="8" width="1" height="1"/><rect x="8" y="8" width="1" height="1"/><rect x="8" y="7" width="1" height="1"/><rect x="9" y="7" width="1" height="1"/><rect x="9" y="6" width="1" height="1"/><rect x="10" y="6" width="1" height="1"/><rect x="10" y="5" width="1" height="1"/><rect x="11" y="5" width="1" height="1"/><rect x="11" y="4" width="1" height="1"/><rect x="12" y="4" width="1" height="1"/><rect x="12" y="3" width="1" height="1"/><rect x="13" y="3" width="1" height="1"/></g></svg>`,
  symmetryH: `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges"><g fill="currentColor"><rect x="7" y="1" width="1" height="1"/><rect x="8" y="1" width="1" height="1"/><rect x="7" y="3" width="1" height="1"/><rect x="8" y="3" width="1" height="1"/><rect x="5" y="6" width="1" height="1"/><rect x="10" y="6" width="1" height="1"/><rect x="4" y="7" width="1" height="1"/><rect x="5" y="7" width="1" height="1"/><rect x="10" y="7" width="1" height="1"/><rect x="11" y="7" width="1" height="1"/><rect x="3" y="8" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/><rect x="5" y="8" width="1" height="1"/><rect x="10" y="8" width="1" height="1"/><rect x="11" y="8" width="1" height="1"/><rect x="12" y="8" width="1" height="1"/><rect x="4" y="9" width="1" height="1"/><rect x="5" y="9" width="1" height="1"/><rect x="10" y="9" width="1" height="1"/><rect x="11" y="9" width="1" height="1"/><rect x="5" y="10" width="1" height="1"/><rect x="10" y="10" width="1" height="1"/><rect x="7" y="12" width="1" height="1"/><rect x="8" y="12" width="1" height="1"/><rect x="7" y="14" width="1" height="1"/><rect x="8" y="14" width="1" height="1"/></g></svg>`,
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
    <div id="promptBanner" class="canvas-banner" hidden></div>
    <div class="ed-size-picker" role="radiogroup" aria-label="Canvas size">
      <span class="ed-size-label">Size</span>
      ${DRAWING_SIZES.map((s) => `<button type="button" class="btn xs ed-size-opt" data-size="${s}" aria-pressed="${s === DEFAULT_SIZE ? "true" : "false"}">${s}×${s}</button>`).join("")}
    </div>
    <div class="ed-actions">
      <button class="btn" data-action="publish">${ICON.publish} Publish</button>
      <button class="btn primary" data-action="make-merch" id="merchBtn">${ICON.cart} Make merch</button>
      <button class="btn" data-action="share">${ICON.share} Copy share link</button>
      <button class="btn" data-action="open-export">${ICON.download} Export…</button>
    </div>

    <div class="ed-grid">
      <div class="ed-tools" role="toolbar" aria-label="Tools">
        <button class="btn icon ed-tool" data-tool="pixel" aria-pressed="true" title="Pencil (B)" aria-label="Pencil">${ICON.pencil}</button>
        <button class="btn icon ed-tool" data-tool="erase" title="Eraser (E)" aria-label="Eraser">${ICON.eraser}</button>
        <button class="btn icon ed-tool" data-tool="fill" title="Fill (G)" aria-label="Fill">${ICON.fill}</button>
        <button class="btn icon ed-tool" data-tool="move" title="Move (V) — drag to translate the layer, wraps at edges" aria-label="Move">${ICON.hand}</button>
        <button class="btn icon ed-tool" data-action="toggle-pixel-perfect" id="pixelPerfectBtn" aria-pressed="false" title="Pixel-perfect strokes (clean 1px diagonals)" aria-label="Pixel-perfect strokes">${ICON.perfect}</button>
        <button class="btn icon ed-tool" data-action="toggle-symmetry-h" id="symmetryHBtn" aria-pressed="false" title="Horizontal symmetry — mirror strokes across the vertical axis" aria-label="Horizontal symmetry">${ICON.symmetryH}</button>
        <div class="ed-tools-divider" aria-hidden="true"></div>
        <button class="btn icon ed-tool" data-action="undo" title="Undo" aria-label="Undo">${ICON.undo}</button>
        <button class="btn icon ed-tool" data-action="clear" title="Clear" aria-label="Clear">${ICON.clear}</button>
        <button class="btn icon ed-tool" data-action="flip-h" title="Flip horizontal" aria-label="Flip horizontal">${ICON.flipH}</button>
        <button class="btn icon ed-tool" data-action="flip-v" title="Flip vertical" aria-label="Flip vertical">${ICON.flipV}</button>
        <button class="btn icon ed-tool" data-action="rotate" title="Rotate" aria-label="Rotate">${ICON.rotate}</button>
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

    <div class="ed-layers">
      <div class="ed-layers-head">
        <span class="panel-h" id="layersHeading">Layers — 1</span>
        <button class="btn xs" data-action="add-layer" id="addLayerBtn" title="Add layer">${ICON.plus}<span style="margin-left:6px">Add layer</span></button>
      </div>
      <div id="layerList" class="ed-layers-list"></div>
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
          <button class="btn xs" data-action="copy-png" title="Copy current frame to the system clipboard as a PNG">Copy PNG</button>
          <button class="btn xs" data-action="toggle-onion" id="onionBtn" aria-pressed="false" title="Onion skin (preview previous frame)">Onion</button>
          <button class="btn xs" data-action="toggle-grid" id="gridBtn" aria-pressed="true" title="Pixel grid + transparency markers">Grid</button>
          <button class="btn xs" data-action="play" id="playBtn" title="Play animation">${ICON.play}<span style="margin-left:6px">Play</span></button>
          <label class="ed-fps" title="Animation speed (frames per second)">
            <span class="ed-fps-label">FPS</span>
            <input type="range" id="fpsRange" min="0" max="${FPS_STEPS.length - 1}" step="1" value="${DEFAULT_FPS_INDEX}" aria-label="Animation speed in frames per second" />
            <output id="fpsOut" class="ed-fps-out">${FPS_STEPS[DEFAULT_FPS_INDEX]}</output>
          </label>
        </div>
      </div>
      <div id="frameList" class="ed-frames-strip"></div>
    </div>

  </main>

  <dialog id="palettePicker">
    <p>Pick a color from the 256-color base palette</p>
    <div id="baseGrid"></div>
    <div class="ed-import">
      <label class="ed-import-label" for="lospecInput">Import a palette — Lospec slug, URL, or hex colors</label>
      <div class="ed-import-row">
        <input id="lospecInput" type="text" placeholder="sweetie-16" autocomplete="off" spellcheck="false" enterkeyhint="go" />
        <button type="button" class="btn sm" id="lospecImportBtn">Import</button>
      </div>
    </div>
    <form method="dialog">
      <menu>
        <button value="cancel">Cancel</button>
      </menu>
    </form>
  </dialog>

  <dialog id="exportDialog" class="ed-export-dialog">
    <h2 class="ed-export-title">Export</h2>
    <fieldset class="ed-export-options" id="exportOptions" aria-label="Export format"></fieldset>
    <label class="ed-export-footer-toggle">
      <input type="checkbox" id="exportFooter" />
      <span>Add "Made with Draw!" wordmark</span>
    </label>
    <p class="ed-export-status" id="exportStatus" hidden></p>
    <menu class="ed-export-menu">
      <button type="button" class="btn" id="exportCancel">Cancel</button>
      <button type="button" class="btn primary" id="exportConfirm">Export</button>
    </menu>
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
const lospecInputEl = document.getElementById("lospecInput") as HTMLInputElement;
const lospecImportBtnEl = document.getElementById("lospecImportBtn") as HTMLButtonElement;
const framesHeadingEl = document.getElementById("framesHeading")!;
const layerListEl = document.getElementById("layerList")!;
const layersHeadingEl = document.getElementById("layersHeading")!;
const addLayerBtnEl = document.getElementById("addLayerBtn") as HTMLButtonElement;
const onionBtnEl = document.getElementById("onionBtn") as HTMLButtonElement;
const gridBtnEl = document.getElementById("gridBtn") as HTMLButtonElement;
const pixelPerfectBtnEl = document.getElementById("pixelPerfectBtn") as HTMLButtonElement;
const symmetryHBtnEl = document.getElementById("symmetryHBtn") as HTMLButtonElement;
const playBtnEl = document.getElementById("playBtn") as HTMLButtonElement;
const pasteBtnEl = document.getElementById("pasteBtn") as HTMLButtonElement;
const fpsRangeEl = document.getElementById("fpsRange") as HTMLInputElement;
const fpsOutEl = document.getElementById("fpsOut") as HTMLOutputElement;
const exportDialog = document.getElementById("exportDialog") as HTMLDialogElement;
const exportOptionsEl = document.getElementById("exportOptions")!;
const exportFooterEl = document.getElementById("exportFooter") as HTMLInputElement;
const exportConfirmEl = document.getElementById("exportConfirm") as HTMLButtonElement;
const exportCancelEl = document.getElementById("exportCancel") as HTMLButtonElement;
const exportStatusEl = document.getElementById("exportStatus")!;

// Per-session timelapse recorder. Captures one op per pointer stroke
// + frame/transform/palette/clear/size actions, capped at MAX_OPS /
// MAX_BYTES. Persisted as StoredDrawing.opLog so a draft survives a
// reload; reset on publish + size change because those start a new
// drawing artifact.
const opLog = new OpLogRecorder();

const exportCtrl = createExportDialog({
  dialog: exportDialog,
  optionsContainer: exportOptionsEl,
  footerCheckbox: exportFooterEl,
  confirmButton: exportConfirmEl,
  cancelButton: exportCancelEl,
  statusEl: exportStatusEl,
  tracker,
  getSnapshot: () => ({
    frames: state.frames.map((f) => composeFrame(state.layers, f)),
    activePalette,
    delayMs,
    size: currentSize,
    lastPublishedId,
    opLog: opLog.opCount > 0 ? opLog.serialize() : null,
  }),
});

function setLastPublishedId(id: string | null): void {
  lastPublishedId = id;
}

const PALETTE_LS_KEY = "drawbang:palette";
const GRID_LS_KEY = "drawbang:grid";
const PIXEL_PERFECT_LS_KEY = "drawbang:pixel-perfect";
const SYMMETRY_H_LS_KEY = "drawbang:symmetry-h";

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
  opLog.recordPalette(activePalette);
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

// Returns the active layer's bitmap on the current frame. All tool
// writes (pencil, fill, erase, transforms) target this single bitmap.
function activeBitmap(): Bitmap {
  return state.frames[state.current].bitmaps[state.currentLayer];
}

function onionFrame(): Bitmap | null {
  if (!onion || playing || state.frames.length < 2) return null;
  const prev = (state.current - 1 + state.frames.length) % state.frames.length;
  return composeFrame(state.layers, state.frames[prev]);
}

function render(): void {
  const palette = activePaletteToRgb(activePalette);
  mainCanvas.draw(composeFrame(state.layers, state.frames[state.current]), palette, onionFrame());
  renderFrameStrip();
  renderPalette();
  renderLayers();
  framesHeadingEl.textContent = `Frames — ${state.frames.length}`;
  layersHeadingEl.textContent = `Layers — ${state.layers.length}`;
  addLayerBtnEl.disabled = state.layers.length >= MAX_LAYERS;
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
    preview.draw(composeFrame(state.layers, frame), palette);
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

// -- Layers panel -----------------------------------------------------------

// Tiny inline SVGs for visibility + reorder controls. Match the existing
// in-file pattern (currentColor, small viewBox).
const LAYER_EYE_ON = `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><path d="M7 3.5C4 3.5 1.6 5.4 0.7 7c0.9 1.6 3.3 3.5 6.3 3.5s5.4-1.9 6.3-3.5C12.4 5.4 10 3.5 7 3.5zm0 5.7A2.2 2.2 0 1 1 7 4.8a2.2 2.2 0 0 1 0 4.4z"/><circle cx="7" cy="7" r="1.1"/></g></svg>`;
const LAYER_EYE_OFF = `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><path d="M7 3.5C4 3.5 1.6 5.4 0.7 7c0.9 1.6 3.3 3.5 6.3 3.5s5.4-1.9 6.3-3.5C12.4 5.4 10 3.5 7 3.5zm0 5.7A2.2 2.2 0 1 1 7 4.8a2.2 2.2 0 0 1 0 4.4z" opacity="0.4"/><path d="M2 2 L12 12" stroke="currentColor" stroke-width="1.5" fill="none"/></g></svg>`;
const LAYER_UP = `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 3 L11 8 H3 Z" fill="currentColor"/></svg>`;
const LAYER_DOWN = `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 11 L11 6 H3 Z" fill="currentColor"/></svg>`;

// Render the layers panel. Top of the list = topmost layer (z-order),
// so we iterate state.layers in reverse order (last entry = top).
function renderLayers(): void {
  layerListEl.innerHTML = "";
  for (let dataIdx = state.layers.length - 1; dataIdx >= 0; dataIdx--) {
    const layer = state.layers[dataIdx];
    const row = document.createElement("div");
    row.className =
      "ed-layer-row" +
      (dataIdx === state.currentLayer ? " selected" : "") +
      (!layer.visible ? " hidden" : "");
    row.dataset.layerIndex = String(dataIdx);

    const vis = document.createElement("button");
    vis.className = "btn xs ghost ed-layer-vis";
    vis.title = layer.visible ? "Hide layer" : "Show layer";
    vis.setAttribute("aria-pressed", layer.visible ? "true" : "false");
    vis.innerHTML = layer.visible ? LAYER_EYE_ON : LAYER_EYE_OFF;
    vis.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleLayerAt(dataIdx);
    });
    row.appendChild(vis);

    const name = document.createElement("span");
    name.className = "ed-layer-name";
    name.textContent = layer.name;
    name.title = "Click to rename";
    name.addEventListener("click", (e) => {
      e.stopPropagation();
      renameLayerAt(dataIdx);
    });
    row.appendChild(name);

    const up = document.createElement("button");
    up.className = "btn xs ghost ed-layer-move";
    up.title = "Move layer up";
    up.innerHTML = LAYER_UP;
    up.disabled = dataIdx === state.layers.length - 1;
    up.addEventListener("click", (e) => {
      e.stopPropagation();
      moveLayerAt(dataIdx, dataIdx + 1);
    });
    row.appendChild(up);

    const down = document.createElement("button");
    down.className = "btn xs ghost ed-layer-move";
    down.title = "Move layer down";
    down.innerHTML = LAYER_DOWN;
    down.disabled = dataIdx === 0;
    down.addEventListener("click", (e) => {
      e.stopPropagation();
      moveLayerAt(dataIdx, dataIdx - 1);
    });
    row.appendChild(down);

    const del = document.createElement("button");
    del.className = "btn xs ghost ed-layer-del";
    del.title = "Delete layer";
    del.innerHTML = ICON.trash;
    del.disabled = state.layers.length <= 1;
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeLayerAt(dataIdx);
    });
    row.appendChild(del);

    row.addEventListener("click", () => {
      if (state.currentLayer === dataIdx) return;
      state.currentLayer = dataIdx;
      render();
    });
    layerListEl.appendChild(row);
  }
}

function addLayer(): void {
  stopPlay();
  const undo = addLayerOp(state, MAX_LAYERS);
  if (!undo) {
    showFlash({ kind: "info", message: `Max ${MAX_LAYERS} layers.`, autoDismissMs: 5000 });
    return;
  }
  const at = state.currentLayer;
  history.push(() => {
    undo();
    render();
  });
  opLog.recordLayerAdd(at);
  render();
  persist();
}

function removeLayerAt(idx: number): void {
  stopPlay();
  const undo = removeLayerOp(state, idx);
  if (!undo) {
    showFlash({ kind: "info", message: "Can't delete the only layer.", autoDismissMs: 5000 });
    return;
  }
  history.push(() => {
    undo();
    render();
  });
  opLog.recordLayerDel(idx);
  render();
  persist();
}

function toggleLayerAt(idx: number): void {
  const undo = toggleLayerVisOp(state, idx);
  if (!undo) return;
  history.push(() => {
    undo();
    render();
  });
  opLog.recordLayerVisibility(idx, state.layers[idx].visible);
  render();
  persist();
}

function moveLayerAt(from: number, to: number): void {
  stopPlay();
  const undo = moveLayerOp(state, from, to);
  if (!undo) return;
  history.push(() => {
    undo();
    render();
  });
  opLog.recordLayerMove(from, to);
  render();
  persist();
}

function renameLayerAt(idx: number): void {
  const current = state.layers[idx].name;
  const next = prompt("Layer name", current);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === current) return;
  state.layers[idx].name = trimmed;
  history.push(() => {
    state.layers[idx].name = current;
    render();
  });
  render();
  persist();
}

// -- Tools ------------------------------------------------------------------

function setActiveTool(next: "pixel" | "erase" | "fill" | "move"): void {
  tool = next;
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.tool === next ? "true" : "false");
  });
}

function applyTool(x: number, y: number): void {
  const frameIdx = state.current;
  const layerIdx = state.currentLayer;
  const b = state.frames[frameIdx].bitmaps[layerIdx];
  const value = tool === "erase" ? TRANSPARENT : selectedSlot;
  const mx = symmetryH ? mirrorX(x, b.width) : -1;
  const mirror = symmetryH && mx !== x;
  if (tool === "fill") {
    // Snapshot upfront so a single undo restores both fill regions even
    // when symmetric clicks fill distinct disconnected areas.
    const beforeAll = mirror ? b.clone() : null;
    const before = fillArea(b, x, y, value);
    let mirrorDirty = false;
    if (mirror) {
      const mBefore = fillArea(b, mx, y, value);
      mirrorDirty = mBefore !== null;
    }
    if (before || mirrorDirty) {
      // When both sides changed we restore from the upfront clone;
      // when only one side did, the original fillArea snapshot suffices.
      const snapshot = mirror ? beforeAll! : before!;
      history.push(() => {
        state.frames[frameIdx].bitmaps[layerIdx] = snapshot;
        state.current = Math.min(frameIdx, state.frames.length - 1);
        state.currentLayer = Math.min(layerIdx, state.layers.length - 1);
        render();
      });
      strokeDirty = true;
      if (before) opLog.recordFill(frameIdx, x, y, value, Date.now(), layerIdx);
      if (mirrorDirty) opLog.recordFill(frameIdx, mx, y, value, Date.now(), layerIdx);
    }
  } else {
    const prev = drawPixel(b, x, y, value);
    if (prev !== null) {
      strokeDirty = true;
      opLog.recordPixel(x, y, value);
    }
    if (mirror) {
      const mPrev = drawPixel(b, mx, y, value);
      if (mPrev !== null) {
        strokeDirty = true;
        opLog.recordPixel(mx, y, value);
      }
    }
    if (ppStroke && tool === "pixel") {
      const corner = ppStroke.next(x, y);
      // Un-paint the L corner by restoring whatever the stroke started over.
      if (corner && strokeSnapshot) {
        const restore = strokeSnapshot.get(corner.x, corner.y);
        b.set(corner.x, corner.y, restore);
        opLog.recordPixel(corner.x, corner.y, restore);
        if (symmetryH) {
          const cmx = mirrorX(corner.x, b.width);
          if (cmx !== corner.x) {
            const mRestore = strokeSnapshot.get(cmx, corner.y);
            b.set(cmx, corner.y, mRestore);
            opLog.recordPixel(cmx, corner.y, mRestore);
          }
        }
      }
    }
  }
  render();
}

function beginStroke(): void {
  strokeSnapshot = activeBitmap().clone();
  strokeDirty = false;
  ppStroke = pixelPerfect && tool === "pixel" ? new PixelPerfectStroke() : null;
  if (tool !== "fill") opLog.beginStroke(state.current, state.currentLayer);
}

function endStroke(): void {
  if (strokeDirty && strokeSnapshot && tool !== "fill") {
    const snapshot = strokeSnapshot;
    const frameIdx = state.current;
    const layerIdx = state.currentLayer;
    history.push(() => {
      state.frames[frameIdx].bitmaps[layerIdx] = snapshot;
      state.current = Math.min(frameIdx, state.frames.length - 1);
      state.currentLayer = Math.min(layerIdx, state.layers.length - 1);
      render();
    });
  }
  opLog.endStroke();
  strokeSnapshot = null;
  strokeDirty = false;
  ppStroke = null;
  persist();
}

function handleTransform(f: (b: Bitmap) => void, op: "flip-h" | "flip-v" | "rotate" | "shift-x" | "shift-y"): void {
  stopPlay();
  const frameIdx = state.current;
  const layerIdx = state.currentLayer;
  const before = state.frames[frameIdx].bitmaps[layerIdx].clone();
  f(state.frames[frameIdx].bitmaps[layerIdx]);
  history.push(() => {
    state.frames[frameIdx].bitmaps[layerIdx] = before;
    state.current = Math.min(frameIdx, state.frames.length - 1);
    state.currentLayer = Math.min(layerIdx, state.layers.length - 1);
    render();
  });
  opLog.recordXform(frameIdx, op, Date.now(), layerIdx);
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
  opLog.recordFrameAdd(state.frames.length - 1);
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
  opLog.recordFrameDel(idx);
  render();
  persist();
  tracker.frameDeleteClick(state.frames.length);
}

function copyFrame(): void {
  clipboard = cloneFrame(state.frames[state.current]);
  pasteBtnEl.disabled = false;
  showFlash({ kind: "info", message: `Copied frame ${state.current + 1}.`, autoDismissMs: 5000 });
}

// Writes the current frame to the system clipboard as an upscaled PNG so it
// can be pasted into chats/posts. Transparent cells stay transparent.
async function copyFrameAsPng(): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    showFlash({ kind: "error", message: "Copying images isn't supported in this browser." });
    return;
  }
  const scale = Math.max(1, Math.floor(512 / currentSize));
  const cv = document.createElement("canvas");
  cv.width = currentSize * scale;
  cv.height = currentSize * scale;
  const ctx = cv.getContext("2d")!;
  const frame = composeFrame(state.layers, state.frames[state.current]);
  const palette = activePaletteToRgb(activePalette);
  for (let y = 0; y < currentSize; y++) {
    for (let x = 0; x < currentSize; x++) {
      const v = frame.get(x, y);
      if (v === TRANSPARENT) continue;
      const [r, g, b] = palette[v];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  try {
    // Hand ClipboardItem the blob *promise* — Safari rejects the write as
    // out-of-gesture if we await toBlob before constructing the item.
    const blob = new Promise<Blob>((resolve, reject) => {
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
    });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    showFlash({
      kind: "success",
      message: `Frame ${state.current + 1} copied as PNG.`,
      autoDismissMs: 5000,
    });
  } catch {
    showFlash({ kind: "error", message: "Couldn't copy the frame to the clipboard." });
  }
}

// Inserts the clipboard as a new frame after the current one. The original
// "paste into current" behaviour from v1 is gone — too easy to clobber work.
// The clipboard preserves the full layer stack: pasting brings back every
// layer of the copied frame, not just the composited result.
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
  // A layer added since the copy means the clipboard's per-layer slot
  // count no longer matches the document. Pad with empty bitmaps so the
  // invariant holds; truncate if layers were removed instead.
  const copy = cloneFrame(clipboard);
  while (copy.bitmaps.length < state.layers.length) {
    copy.bitmaps.push(new Bitmap(currentSize, currentSize));
  }
  if (copy.bitmaps.length > state.layers.length) {
    copy.bitmaps.length = state.layers.length;
  }
  const insertAt = state.current + 1;
  const fromIdx = state.current;
  const before = { frames: state.frames.slice(), current: state.current };
  state.frames.splice(insertAt, 0, copy);
  state.current = insertAt;
  history.push(() => {
    state.frames = before.frames;
    state.current = Math.min(before.current, state.frames.length - 1);
    render();
  });
  opLog.recordFrameDup(fromIdx, insertAt);
  render();
  persist();
}

function resetEditor(opts: { keepPublishedId?: boolean } = {}): void {
  stopPlay();
  const fresh = newFrameState(currentSize, currentSize);
  state.layers = fresh.layers;
  state.frames = fresh.frames;
  state.current = 0;
  state.currentLayer = 0;
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
  opLog.recordClear();
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
  startPlayTimer();
}

function startPlayTimer(): void {
  if (playTimer !== null) clearInterval(playTimer);
  playTimer = setInterval(() => {
    state.current = (state.current + 1) % state.frames.length;
    renderPlayTick();
  }, delayMs);
}

function renderPlayTick(): void {
  const palette = activePaletteToRgb(activePalette);
  mainCanvas.draw(composeFrame(state.layers, state.frames[state.current]), palette);
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

function setPixelPerfect(next: boolean, persistChoice = true): void {
  pixelPerfect = next;
  pixelPerfectBtnEl.setAttribute("aria-pressed", next ? "true" : "false");
  if (persistChoice) {
    try {
      localStorage.setItem(PIXEL_PERFECT_LS_KEY, next ? "1" : "0");
    } catch {
      // ignore — the preference just won't survive this session
    }
  }
}

function setSymmetryH(next: boolean, persistChoice = true): void {
  symmetryH = next;
  symmetryHBtnEl.setAttribute("aria-pressed", next ? "true" : "false");
  mainCanvas.settings.symmetryAxisH = next;
  render();
  if (persistChoice) {
    try {
      localStorage.setItem(SYMMETRY_H_LS_KEY, next ? "1" : "0");
    } catch {
      // ignore — the preference just won't survive this session
    }
  }
}

// Toggles both the empty-cell grid lines and the transparency markers —
// PixelCanvas keys them off one flag, giving an unobstructed view of the art.
function setGrid(next: boolean, persistChoice = true): void {
  mainCanvas.settings.showGrid = next;
  gridBtnEl.setAttribute("aria-pressed", next ? "true" : "false");
  render();
  if (persistChoice) {
    try {
      localStorage.setItem(GRID_LS_KEY, next ? "1" : "0");
    } catch {
      // ignore — the preference just won't survive this session
    }
  }
}

function fpsToDelayMs(fps: number): number {
  return Math.round(1000 / fps);
}

// Snap an arbitrary GIF delay onto the nearest slider stop. Needed for
// forks: GIF delays are stored in centiseconds, so a 6-fps drawing (167 ms)
// decodes as 170 ms — snapping restores the exact stop (and wire format).
function nearestFpsIndex(ms: number): number {
  let best = 0;
  for (let i = 1; i < FPS_STEPS.length; i++) {
    const better =
      Math.abs(fpsToDelayMs(FPS_STEPS[i]) - ms) < Math.abs(fpsToDelayMs(FPS_STEPS[best]) - ms);
    if (better) best = i;
  }
  return best;
}

function setFps(index: number): void {
  const i = Math.max(0, Math.min(FPS_STEPS.length - 1, Math.round(index)));
  delayMs = fpsToDelayMs(FPS_STEPS[i]);
  fpsRangeEl.value = String(i);
  fpsOutEl.textContent = String(FPS_STEPS[i]);
  // Retime an in-flight preview so dragging the slider changes the loop live.
  if (playing) startPlayTimer();
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

// -- Lospec palette import ---------------------------------------------------

const IMPORTED_PALETTE_ID = "imported";

// Reflects an imported palette in the select via a dynamic "Imported — <name>"
// option (created on first import, relabeled on later ones). Deliberately not
// persisted to PALETTE_LS_KEY: the colors themselves survive reload through
// the share hash, same as per-slot edits.
function setImportedOption(name: string): void {
  currentPaletteId = IMPORTED_PALETTE_ID;
  if (!paletteSelectEl) return;
  let opt = paletteSelectEl.querySelector<HTMLOptionElement>(
    `option[value="${IMPORTED_PALETTE_ID}"]`,
  );
  if (!opt) {
    opt = document.createElement("option");
    opt.value = IMPORTED_PALETTE_ID;
    paletteSelectEl.appendChild(opt);
  }
  opt.textContent = `Imported — ${name}`;
  paletteSelectEl.value = IMPORTED_PALETTE_ID;
}

function applyImportedPalette(name: string, colors: readonly string[]): void {
  // The DRAWBANG gif extension stores base-palette indices, so arbitrary
  // RGB must snap to the nearest base color.
  const padded = padPalette(colors);
  const next = new Uint8Array(padded.length);
  for (let i = 0; i < padded.length; i++) {
    next[i] = nearestBaseIndex(hexToRgb(padded[i]));
  }
  activePalette = next;
  selectedSlot = 1;
  setImportedOption(name);
  picker.close();
  render();
  persist();
  showFlash({ kind: "success", message: `Imported “${name}”`, autoDismissMs: 4000 });
}

async function handlePaletteImport(): Promise<void> {
  const req = parseImportInput(lospecInputEl.value);
  if (!req) {
    // The flash renders below the <dialog> top layer — close before flashing.
    picker.close();
    showFlash({
      kind: "error",
      message: "Enter a Lospec palette slug, lospec.com URL, or hex colors.",
      autoDismissMs: 6000,
    });
    return;
  }
  if (req.kind === "colors") {
    applyImportedPalette("Custom palette", req.colors);
    return;
  }
  lospecImportBtnEl.disabled = true;
  try {
    const res = await fetch(lospecPaletteUrl(req.slug));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const palette = parseLospecJson(await res.json(), req.slug);
    applyImportedPalette(palette.name, palette.colors);
  } catch {
    picker.close();
    showFlash({
      kind: "error",
      message: `Couldn't load “${req.slug}” from Lospec.`,
      autoDismissMs: 6000,
    });
  } finally {
    lospecImportBtnEl.disabled = false;
  }
}

lospecImportBtnEl.addEventListener("click", () => void handlePaletteImport());
lospecInputEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  void handlePaletteImport();
});

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
  // Captured before the await so the remix flag and prompt tag reflect
  // what was actually sent, even if state resets mid-flight.
  const publishedParentId = parentId;
  const publishedPromptSlug = promptSlug;
  try {
    const flattened = state.frames.map((f) => composeFrame(state.layers, f));
    const result = await submit({
      ingestUrl: INGEST_URL,
      gif: encodeGif({ frames: flattened, activePalette, size: currentSize, delayMs }),
      parent: publishedParentId ?? undefined,
      prompt: publishedPromptSlug ?? undefined,
      layers: state.layers.length > 1 ? buildLayersPayload() : undefined,
    });
    flashPublished(result.share_url);
    tracker.publishSuccess({
      frames: state.frames.length,
      solve_ms: 0,
      remix: publishedParentId !== null,
      prompt: publishedPromptSlug,
    });
    if (localId) {
      await local.save({
        id: localId,
        frames: state.frames,
        layers: state.layers,
        activePalette,
        delayMs,
        publishedId: result.id,
        opLog: opLog.serialize(),
      });
    }
    setLastPublishedId(result.id);
    // Successful publish ends the current authoring session. The next
    // drawing's timelapse starts fresh.
    opLog.reset();
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

// Build the LayersPayload sidecar for the publish body. Each per-layer
// bitmap is base64-encoded so the JSON stays small (~33% overhead vs
// raw bytes). Only called when the document has 2+ layers — flat
// drawings save the round-trip.
function buildLayersPayload(): import("./submit.js").LayersPayload {
  const frames: string[][] = state.frames.map((f) =>
    f.bitmaps.map((b) => bytesToBase64(b.data)),
  );
  return {
    v: 1,
    layers: state.layers.map((l) => ({ name: l.name, visible: l.visible })),
    frames,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function flashPublished(shareUrl: string): void {
  const link = document.createElement("a");
  link.href = shareUrl;
  link.textContent = shareUrl;
  link.target = "_blank";
  link.rel = "noopener";
  showFlash({ kind: "success", message: ["Published: ", link] });
}

// -- Size picker -----------------------------------------------------------

function changeSize(newSize: number): void {
  if (!DRAWING_SIZES.includes(newSize) || newSize === currentSize) return;
  const hasContent = state.frames.some((f) =>
    f.bitmaps.some((b) => b.data.some((v) => v !== TRANSPARENT)),
  );
  if (hasContent) {
    const ok = confirm(
      `Switch canvas to ${newSize}×${newSize}? Your current drawing will be cleared.`,
    );
    if (!ok) return;
  }
  // Replay can't make sense of strokes whose coordinates straddle a
  // resize, so start the timelapse fresh at the new dimensions.
  opLog.reset();
  opLog.recordSize(currentSize, newSize);
  currentSize = newSize;
  const fresh = newFrameState(currentSize, currentSize);
  state.layers = fresh.layers;
  state.frames = fresh.frames;
  state.current = 0;
  state.currentLayer = 0;
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
  // Share links carry just the flattened bitmaps — the codec is a
  // pre-layers wire format. Layered drawings still compose down to the
  // same pixels the GIF would carry, so the link round-trips visually.
  const flat = state.frames.map((f) => composeFrame(state.layers, f));
  const hash = encodeShare({ frames: flat, activePalette });
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
  local
    .save({
      id: localId,
      frames: state.frames,
      layers: state.layers,
      activePalette,
      delayMs,
      opLog: opLog.serialize(),
    })
    .catch(() => {});
}

// -- Events -----------------------------------------------------------------

function pointerToPixel(ev: PointerEvent): { x: number; y: number } {
  return mainCanvas.quantize(ev.clientX, ev.clientY);
}

mainCanvasEl.addEventListener("pointerdown", (ev) => {
  if (playing) return;
  ev.preventDefault();
  if (tool === "move") {
    moveSnapshot = activeBitmap().clone();
    moveStart = mainCanvas.quantizeUnclamped(ev.clientX, ev.clientY);
    moveLastDelta = { dx: 0, dy: 0 };
    return;
  }
  painting = true;
  beginStroke();
  const { x, y } = pointerToPixel(ev);
  applyTool(x, y);
});
window.addEventListener("pointermove", (ev) => {
  if (moveSnapshot && moveStart) {
    const p = mainCanvas.quantizeUnclamped(ev.clientX, ev.clientY);
    const dx = p.x - moveStart.x;
    const dy = p.y - moveStart.y;
    if (dx === moveLastDelta.dx && dy === moveLastDelta.dy) return;
    moveLastDelta = { dx, dy };
    translate(activeBitmap(), moveSnapshot, dx, dy);
    render();
    return;
  }
  if (!painting) return;
  const { x, y } = pointerToPixel(ev);
  applyTool(x, y);
});
window.addEventListener("pointerup", () => {
  if (moveSnapshot && moveStart) {
    endMoveDrag();
    return;
  }
  if (!painting) return;
  painting = false;
  endStroke();
});
window.addEventListener("pointercancel", () => {
  if (moveSnapshot && moveStart) {
    endMoveDrag();
    return;
  }
  if (!painting) return;
  painting = false;
  endStroke();
});

function endMoveDrag(): void {
  if (!moveSnapshot || !moveStart) return;
  const { dx, dy } = moveLastDelta;
  if (dx !== 0 || dy !== 0) {
    const snapshot = moveSnapshot;
    const frameIdx = state.current;
    const layerIdx = state.currentLayer;
    history.push(() => {
      state.frames[frameIdx].bitmaps[layerIdx] = snapshot;
      state.current = Math.min(frameIdx, state.frames.length - 1);
      state.currentLayer = Math.min(layerIdx, state.layers.length - 1);
      render();
    });
    opLog.recordTranslate(frameIdx, dx, dy, Date.now(), layerIdx);
  }
  moveSnapshot = null;
  moveStart = null;
  moveLastDelta = { dx: 0, dy: 0 };
  persist();
}

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
      case "flip-h": handleTransform(flipHorizontal, "flip-h"); break;
      case "flip-v": handleTransform(flipVertical, "flip-v"); break;
      case "rotate": handleTransform(rotateLeft, "rotate"); break;
      case "copy-frame": copyFrame(); break;
      case "paste-frame": pasteAsNewFrame(); break;
      case "copy-png": stopPlay(); void copyFrameAsPng(); break;
      case "play": togglePlay(); break;
      case "toggle-onion": setOnion(!onion); break;
      case "toggle-grid": setGrid(!mainCanvas.settings.showGrid); break;
      case "toggle-pixel-perfect": setPixelPerfect(!pixelPerfect); break;
      case "toggle-symmetry-h": setSymmetryH(!symmetryH); break;
      case "edit-color": openPickerForSlot(selectedSlot); break;
      case "open-export": stopPlay(); void exportCtrl.open(); break;
      case "share": stopPlay(); copyShareLink(); break;
      case "publish": stopPlay(); void handlePublish(); break;
      case "make-merch": stopPlay(); openMerch(); break;
      case "add-layer": addLayer(); break;
    }
  }),
);

paletteSelectEl?.addEventListener("change", () => {
  applyPalette(paletteSelectEl.value);
});

fpsRangeEl.addEventListener("input", () => {
  setFps(Number(fpsRangeEl.value));
  persist();
});

window.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "z") {
    ev.preventDefault();
    history.undo();
    render();
    return;
  }
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const t = ev.target as HTMLElement | null;
  if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
  // Aseprite-style tool hotkeys: B brush, E eraser, G paint bucket, V move.
  switch (ev.key.toLowerCase()) {
    case "b": setActiveTool("pixel"); break;
    case "e": setActiveTool("erase"); break;
    case "g": setActiveTool("fill"); break;
    case "v": setActiveTool("move"); break;
  }
});

// -- Daily prompt ------------------------------------------------------------

function showPromptBanner(p: Prompt): void {
  const banner = document.getElementById("promptBanner");
  if (!banner) return;
  const row = document.createElement("div");
  row.className = "cv-banner-row";
  const text = document.createElement("span");
  text.className = "cv-banner-text";
  const title = document.createElement("strong");
  title.textContent = `Today's prompt: ${p.title}`;
  text.append(title, ` — ${p.blurb}`);
  row.appendChild(text);
  const hint = promptGuidanceHint(p);
  if (hint) {
    const hintEl = document.createElement("span");
    hintEl.className = "cv-banner-hint";
    hintEl.textContent = hint;
    row.appendChild(hintEl);
  }
  banner.appendChild(row);
  banner.hidden = false;
}

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
  try {
    if (localStorage.getItem(GRID_LS_KEY) === "0") setGrid(false, false);
    if (localStorage.getItem(PIXEL_PERFECT_LS_KEY) === "1") setPixelPerfect(true, false);
    if (localStorage.getItem(SYMMETRY_H_LS_KEY) === "1") setSymmetryH(true, false);
  } catch {
    // ignore — defaults stay in place
  }

  const hash = location.hash.match(/#d=([A-Za-z0-9_-]+)/)?.[1];
  const forkId = new URL(location.href).searchParams.get("fork");

  // ?prompt= and ?fork= may coexist — remixing today's prompt is legal.
  const todaysPrompt = promptFromQuery(location.search, new Date());
  if (todaysPrompt) {
    promptSlug = todaysPrompt.slug;
    showPromptBanner(todaysPrompt);
    tracker.promptCtaClick({ slug: todaysPrompt.slug });
  }

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
      // The published GIF is the flattened result; the fork starts as
      // a one-layer document. Future work: fetch layers_json from the
      // server when present and rehydrate the full hierarchy.
      const fresh = newFrameState(currentSize, currentSize);
      state.layers = fresh.layers;
      state.frames = decoded.frames.map((b) => ({ bitmaps: [b] }));
      state.current = 0;
      state.currentLayer = 0;
      if (decoded.activePalette) activePalette = decoded.activePalette;
      setFps(nearestFpsIndex(decoded.delayMs));
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
      const fresh = newFrameState(currentSize, currentSize);
      state.layers = fresh.layers;
      state.frames = d.frames.map((b) => ({ bitmaps: [b] }));
      activePalette = d.activePalette;
      state.current = 0;
      state.currentLayer = 0;
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
