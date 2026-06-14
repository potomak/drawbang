import { WIDTH, HEIGHT } from "../../config/constants.js";
import { Bitmap } from "./bitmap.js";
import {
  cloneFrame,
  MAX_LAYERS,
  newFrame,
  newLayerMeta,
  nextLayerName,
  type Frame,
  type LayerMeta,
} from "./layers.js";

export interface FrameState {
  // Document-level layer list. Shared across all frames; bottom→top so
  // index 0 paints first and is occluded by later layers in composeFrame.
  layers: LayerMeta[];
  // Each Frame.bitmaps.length === layers.length. Adding/removing a layer
  // walks every frame to keep the invariant.
  frames: Frame[];
  // Active animation frame.
  current: number;
  // Active layer — tool writes go here.
  currentLayer: number;
}

// Convenience factory for a fresh single-layer document.
export function newFrameState(width: number, height: number): FrameState {
  const layers = [newLayerMeta(`${"Layer"} 1`)];
  return {
    layers,
    frames: [newFrame(width, height, 1)],
    current: 0,
    currentLayer: 0,
  };
}

function frameDims(state: FrameState): { w: number; h: number } {
  const b = state.frames[0]?.bitmaps[0];
  return { w: b?.width ?? WIDTH, h: b?.height ?? HEIGHT };
}

export function addFrame(state: FrameState, max: number): (() => void) | null {
  if (state.frames.length >= max) return null;
  const prevCurrent = state.current;
  const { w, h } = frameDims(state);
  state.frames.push(newFrame(w, h, state.layers.length));
  const addedIdx = state.frames.length - 1;
  state.current = addedIdx;
  return () => {
    state.frames.splice(addedIdx, 1);
    state.current = prevCurrent;
  };
}

export function removeCurrentFrame(state: FrameState): (() => void) | null {
  if (state.frames.length <= 1) return null;
  const idx = state.current;
  const removed = state.frames[idx];
  const prevCurrent = state.current;
  state.frames.splice(idx, 1);
  state.current = Math.min(state.current, state.frames.length - 1);
  return () => {
    state.frames.splice(idx, 0, removed);
    state.current = prevCurrent;
  };
}

// Replaces the current frame's contents with a clone of the supplied
// Frame. Used by the paste-as-new-frame path's predecessor in v1; the
// editor now pastes as a *new* frame, but this helper is preserved for
// the existing tests + any future "replace current" affordance.
export function pasteIntoCurrent(state: FrameState, clip: Frame): () => void {
  const idx = state.current;
  const before = cloneFrame(state.frames[idx]);
  state.frames[idx] = cloneFrame(clip);
  return () => {
    state.frames[idx] = before;
  };
}

// -- Layer operations -------------------------------------------------------

// Inserts a fresh empty layer above `state.currentLayer` (so it sits on
// top in visual z-order) and makes it active. Walks every frame so the
// bitmaps.length === layers.length invariant holds. Returns undo or
// null when the layer cap would be exceeded.
export function addLayer(state: FrameState, max: number = MAX_LAYERS): (() => void) | null {
  if (state.layers.length >= max) return null;
  const insertAt = state.currentLayer + 1;
  const meta = newLayerMeta(nextLayerName(state.layers));
  const { w, h } = frameDims(state);
  const prevCurrentLayer = state.currentLayer;
  state.layers.splice(insertAt, 0, meta);
  for (const f of state.frames) {
    f.bitmaps.splice(insertAt, 0, new Bitmap(w, h));
  }
  state.currentLayer = insertAt;
  return () => {
    state.layers.splice(insertAt, 1);
    for (const f of state.frames) f.bitmaps.splice(insertAt, 1);
    state.currentLayer = prevCurrentLayer;
  };
}

// Removes the layer at `index`. Refuses when only one layer remains —
// the document must always carry at least one drawable surface.
// Clamps currentLayer if the active one was removed.
export function removeLayer(state: FrameState, index: number): (() => void) | null {
  if (state.layers.length <= 1) return null;
  if (index < 0 || index >= state.layers.length) return null;
  const prevCurrentLayer = state.currentLayer;
  const removedMeta = state.layers[index];
  const removedBitmaps = state.frames.map((f) => f.bitmaps[index]);
  state.layers.splice(index, 1);
  for (const f of state.frames) f.bitmaps.splice(index, 1);
  state.currentLayer = Math.min(state.currentLayer, state.layers.length - 1);
  return () => {
    state.layers.splice(index, 0, removedMeta);
    for (let i = 0; i < state.frames.length; i++) {
      state.frames[i].bitmaps.splice(index, 0, removedBitmaps[i]);
    }
    state.currentLayer = prevCurrentLayer;
  };
}

export function toggleLayerVisibility(state: FrameState, index: number): (() => void) | null {
  if (index < 0 || index >= state.layers.length) return null;
  const meta = state.layers[index];
  const prev = meta.visible;
  meta.visible = !prev;
  return () => {
    meta.visible = prev;
  };
}

// Moves a layer from `from` to `to`. Walks every frame so the bitmap
// stack reorders in lockstep with the metadata. Returns undo.
export function moveLayer(state: FrameState, from: number, to: number): (() => void) | null {
  if (from === to) return null;
  if (from < 0 || from >= state.layers.length) return null;
  if (to < 0 || to >= state.layers.length) return null;
  const prevCurrentLayer = state.currentLayer;
  const meta = state.layers.splice(from, 1)[0];
  state.layers.splice(to, 0, meta);
  for (const f of state.frames) {
    const b = f.bitmaps.splice(from, 1)[0];
    f.bitmaps.splice(to, 0, b);
  }
  if (state.currentLayer === from) state.currentLayer = to;
  return () => {
    const m = state.layers.splice(to, 1)[0];
    state.layers.splice(from, 0, m);
    for (const f of state.frames) {
      const b = f.bitmaps.splice(to, 1)[0];
      f.bitmaps.splice(from, 0, b);
    }
    state.currentLayer = prevCurrentLayer;
  };
}
