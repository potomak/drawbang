import { WIDTH, HEIGHT } from "../../config/constants.js";
import { Bitmap } from "./bitmap.js";

export interface FrameState {
  frames: Bitmap[];
  current: number;
}

export function addFrame(state: FrameState, max: number): (() => void) | null {
  if (state.frames.length >= max) return null;
  const prevCurrent = state.current;
  state.frames.push(new Bitmap(WIDTH, HEIGHT));
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

export function pasteIntoCurrent(state: FrameState, clip: Bitmap): () => void {
  const idx = state.current;
  const before = state.frames[idx].clone();
  state.frames[idx] = clip.clone();
  return () => {
    state.frames[idx] = before;
  };
}
