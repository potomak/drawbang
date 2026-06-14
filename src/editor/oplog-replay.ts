import { Bitmap } from "./bitmap.js";
import {
  composeFrame,
  newFrame,
  newLayerMeta,
  type Frame,
  type LayerMeta,
} from "./layers.js";
import {
  fillArea,
  flipHorizontal,
  flipVertical,
  rotateLeft,
  shiftRight,
  shiftUp,
  translate,
} from "./tools.js";
import type {
  FillPayload,
  FrameAddPayload,
  FrameDelPayload,
  FrameDupPayload,
  LayerAddPayload,
  LayerDelPayload,
  LayerMovPayload,
  LayerVisPayload,
  Op,
  OpLog,
  PalPayload,
  PxPayload,
  SizePayload,
  TranslatePayload,
  XformPayload,
} from "./oplog.js";

// Replay engine for the M8 op log. Pure: same input → same output, so
// the timelapse export and any future "draw-in" preview can share the
// same walker. applyOp() mutates a working ReplayState; replay() drives
// it forward in time and snaps frame bitmaps at a target FPS.
//
// As of v2 the engine is layer-aware: state.layers is the document-level
// list, and each Frame holds one Bitmap per layer. Pre-v2 logs that
// don't carry an `l` field on px/fill/xform ops fall back to layer 0,
// which is the only layer in the bootstrap state.

export interface ReplayState {
  layers: LayerMeta[];
  frames: Frame[];
  current: number;
  currentLayer: number;
  size: number;
  palette: Uint8Array;
}

export interface ReplayInit {
  size: number;
  palette: Uint8Array;
}

export function initialReplayState({ size, palette }: ReplayInit): ReplayState {
  return {
    layers: [newLayerMeta("Layer 1")],
    frames: [newFrame(size, size, 1)],
    current: 0,
    currentLayer: 0,
    size,
    palette: new Uint8Array(palette),
  };
}

export function applyOp(state: ReplayState, op: Op): void {
  switch (op.k) {
    case "px":
      applyPx(state, op);
      return;
    case "fill":
      applyFill(state, op);
      return;
    case "fradd":
      applyFrameAdd(state, op);
      return;
    case "frdel":
      applyFrameDel(state, op);
      return;
    case "frdup":
      applyFrameDup(state, op);
      return;
    case "ladd":
      applyLayerAdd(state, op);
      return;
    case "ldel":
      applyLayerDel(state, op);
      return;
    case "lvis":
      applyLayerVis(state, op);
      return;
    case "lmov":
      applyLayerMove(state, op);
      return;
    case "xform":
      applyXform(state, op);
      return;
    case "translate":
      applyTranslate(state, op);
      return;
    case "pal":
      state.palette = new Uint8Array((op.d as PalPayload).palette);
      return;
    case "clear":
      state.frames = [newFrame(state.size, state.size, state.layers.length)];
      state.current = 0;
      return;
    case "size":
      applySize(state, op);
      return;
  }
}

function targetBitmap(state: ReplayState, op: Op): { b: Bitmap; f: number; l: number } {
  const f = clampFrame(state, op.f);
  const l = clampLayer(state, op.l);
  return { b: state.frames[f].bitmaps[l], f, l };
}

function applyPx(state: ReplayState, op: Op): void {
  const { b, f } = targetBitmap(state, op);
  const px = (op.d as PxPayload).pixels;
  for (let i = 0; i + 2 < px.length; i += 3) {
    const x = px[i];
    const y = px[i + 1];
    if (x >= 0 && x < b.width && y >= 0 && y < b.height) {
      b.set(x, y, px[i + 2]);
    }
  }
  state.current = f;
}

function applyFill(state: ReplayState, op: Op): void {
  const { b, f } = targetBitmap(state, op);
  const d = op.d as FillPayload;
  fillArea(b, d.x, d.y, d.color);
  state.current = f;
}

function applyFrameAdd(state: ReplayState, op: Op): void {
  const at = clampInsertIndex(state, (op.d as FrameAddPayload).at);
  state.frames.splice(at, 0, newFrame(state.size, state.size, state.layers.length));
  state.current = at;
}

function applyFrameDel(state: ReplayState, op: Op): void {
  if (state.frames.length <= 1) return;
  const at = clampFrame(state, (op.d as FrameDelPayload).at);
  state.frames.splice(at, 1);
  if (state.current >= state.frames.length) {
    state.current = state.frames.length - 1;
  }
}

function applyFrameDup(state: ReplayState, op: Op): void {
  const { from, to } = op.d as FrameDupPayload;
  const fromIdx = clampFrame(state, from);
  const toIdx = clampInsertIndex(state, to);
  const src = state.frames[fromIdx];
  state.frames.splice(toIdx, 0, {
    bitmaps: src.bitmaps.map((bm) => bm.clone()),
  });
  state.current = toIdx;
}

function applyLayerAdd(state: ReplayState, op: Op): void {
  const at = clampLayerInsertIndex(state, (op.d as LayerAddPayload).at);
  state.layers.splice(at, 0, newLayerMeta(`Layer ${state.layers.length + 1}`));
  for (const f of state.frames) {
    f.bitmaps.splice(at, 0, new Bitmap(state.size, state.size));
  }
  state.currentLayer = at;
}

function applyLayerDel(state: ReplayState, op: Op): void {
  if (state.layers.length <= 1) return;
  const at = clampLayer(state, (op.d as LayerDelPayload).at);
  state.layers.splice(at, 1);
  for (const f of state.frames) f.bitmaps.splice(at, 1);
  if (state.currentLayer >= state.layers.length) {
    state.currentLayer = state.layers.length - 1;
  }
}

function applyLayerVis(state: ReplayState, op: Op): void {
  const d = op.d as LayerVisPayload;
  const at = clampLayer(state, d.at);
  state.layers[at].visible = d.visible;
}

function applyLayerMove(state: ReplayState, op: Op): void {
  const { from, to } = op.d as LayerMovPayload;
  if (from === to) return;
  const fromIdx = clampLayer(state, from);
  const toIdx = clampLayer(state, to);
  const meta = state.layers.splice(fromIdx, 1)[0];
  state.layers.splice(toIdx, 0, meta);
  for (const f of state.frames) {
    const b = f.bitmaps.splice(fromIdx, 1)[0];
    f.bitmaps.splice(toIdx, 0, b);
  }
  if (state.currentLayer === fromIdx) state.currentLayer = toIdx;
}

function applyXform(state: ReplayState, op: Op): void {
  const { b, f } = targetBitmap(state, op);
  switch ((op.d as XformPayload).op) {
    case "flip-h":
      flipHorizontal(b);
      break;
    case "flip-v":
      flipVertical(b);
      break;
    case "rotate":
      rotateLeft(b);
      break;
    case "shift-x":
      shiftRight(b);
      break;
    case "shift-y":
      shiftUp(b);
      break;
  }
  state.current = f;
}

function applyTranslate(state: ReplayState, op: Op): void {
  const { b, f } = targetBitmap(state, op);
  const { dx, dy } = op.d as TranslatePayload;
  translate(b, b.clone(), dx, dy);
  state.current = f;
}

function applySize(state: ReplayState, op: Op): void {
  const { to } = op.d as SizePayload;
  state.size = to;
  state.layers = [newLayerMeta("Layer 1")];
  state.frames = [newFrame(to, to, 1)];
  state.current = 0;
  state.currentLayer = 0;
}

function clampFrame(state: ReplayState, n: number | undefined): number {
  if (n === undefined) return state.current;
  return Math.max(0, Math.min(state.frames.length - 1, n));
}

function clampLayer(state: ReplayState, n: number | undefined): number {
  if (n === undefined) return 0;
  return Math.max(0, Math.min(state.layers.length - 1, n));
}

function clampInsertIndex(state: ReplayState, n: number): number {
  return Math.max(0, Math.min(state.frames.length, n));
}

function clampLayerInsertIndex(state: ReplayState, n: number): number {
  return Math.max(0, Math.min(state.layers.length, n));
}

// ---------------------------------------------------------------------------
// Timelapse sampling
// ---------------------------------------------------------------------------

export interface ReplayOptions extends ReplayInit {
  targetFps?: number;
  minDurationMs?: number;
  maxDurationMs?: number;
}

export interface Timelapse {
  fps: number;
  durationMs: number;
  snapshots: Bitmap[];
  palette: Uint8Array;
  size: number;
}

export const TIMELAPSE_DEFAULT_FPS = 12;
export const TIMELAPSE_MIN_DURATION_MS = 5000;
export const TIMELAPSE_MAX_DURATION_MS = 10000;

function snapshot(state: ReplayState): Bitmap {
  return composeFrame(state.layers, state.frames[state.current]);
}

export function replay(log: OpLog, opts: ReplayOptions): Timelapse {
  const state = initialReplayState(opts);
  const fps = opts.targetFps ?? TIMELAPSE_DEFAULT_FPS;
  const minDuration = opts.minDurationMs ?? TIMELAPSE_MIN_DURATION_MS;
  const maxDuration = opts.maxDurationMs ?? TIMELAPSE_MAX_DURATION_MS;

  if (log.ops.length === 0) {
    return {
      fps,
      durationMs: minDuration,
      snapshots: [snapshot(state)],
      palette: state.palette,
      size: state.size,
    };
  }

  // Stretch or shrink the original timeline into the [min,max] window
  // so every timelapse hits the share-friendly 5–10s sweet spot.
  const sourceMs = Math.max(1, log.ops[log.ops.length - 1].t);
  const durationMs = clamp(sourceMs, minDuration, maxDuration);
  const totalSamples = Math.max(2, Math.round((durationMs / 1000) * fps));

  const snapshots: Bitmap[] = [];
  let applied = 0;
  for (let s = 0; s < totalSamples; s++) {
    const cutoff = ((s + 1) / totalSamples) * sourceMs;
    while (applied < log.ops.length && log.ops[applied].t <= cutoff) {
      applyOp(state, log.ops[applied]);
      applied++;
    }
    snapshots.push(snapshot(state));
  }
  // Final state: drain any remaining ops so the last snapshot matches
  // what the live editor would have shown.
  while (applied < log.ops.length) {
    applyOp(state, log.ops[applied]);
    applied++;
  }
  // Replace the last snapshot with the truly-final state — for ops that
  // landed in the same time bucket as totalSamples-1 but rounded past it.
  snapshots[snapshots.length - 1] = snapshot(state);

  return {
    fps,
    durationMs: Math.round((snapshots.length / fps) * 1000),
    snapshots,
    palette: state.palette,
    size: state.size,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Runs the entire log through the state machine without sampling — used
// by tests to assert that replay-final-state equals live-editor-state.
export function finalState(log: OpLog, opts: ReplayInit): ReplayState {
  const state = initialReplayState(opts);
  for (const op of log.ops) applyOp(state, op);
  return state;
}
