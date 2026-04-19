import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Bitmap, TRANSPARENT } from "../src/editor/bitmap.js";
import {
  addFrame,
  pasteIntoCurrent,
  removeCurrentFrame,
  type FrameState,
} from "../src/editor/frames.js";
import { History } from "../src/editor/history.js";

const MAX = 16;

function paint(state: FrameState, value: number): () => void {
  const idx = state.current;
  const before = state.frames[idx].clone();
  state.frames[idx].set(0, 0, value);
  return () => {
    state.frames[idx] = before;
    state.current = Math.min(idx, state.frames.length - 1);
  };
}

function push(history: History, undo: (() => void) | null): void {
  if (undo) history.push(undo);
}

test("addFrame appends a blank frame and selects it", () => {
  const state: FrameState = { frames: [new Bitmap()], current: 0 };
  const undo = addFrame(state, MAX);
  assert.ok(undo);
  assert.equal(state.frames.length, 2);
  assert.equal(state.current, 1);
});

test("addFrame returns null at the frame cap", () => {
  const state: FrameState = {
    frames: Array.from({ length: MAX }, () => new Bitmap()),
    current: 0,
  };
  const undo = addFrame(state, MAX);
  assert.equal(undo, null);
  assert.equal(state.frames.length, MAX);
});

test("addFrame undo removes the added frame and restores current", () => {
  const state: FrameState = { frames: [new Bitmap()], current: 0 };
  const undo = addFrame(state, MAX);
  undo!();
  assert.equal(state.frames.length, 1);
  assert.equal(state.current, 0);
});

test("removeCurrentFrame returns null when only one frame remains", () => {
  const state: FrameState = { frames: [new Bitmap()], current: 0 };
  const undo = removeCurrentFrame(state);
  assert.equal(undo, null);
  assert.equal(state.frames.length, 1);
});

test("removeCurrentFrame undo restores frame at the original index", () => {
  const a = new Bitmap();
  const b = new Bitmap();
  b.set(3, 3, 5);
  const state: FrameState = { frames: [a, b], current: 1 };
  const undo = removeCurrentFrame(state);
  assert.equal(state.frames.length, 1);
  assert.equal(state.current, 0);
  undo!();
  assert.equal(state.frames.length, 2);
  assert.equal(state.current, 1);
  assert.equal(state.frames[1].get(3, 3), 5);
});

test("pasteIntoCurrent replaces the current frame and undo restores it", () => {
  const original = new Bitmap();
  original.set(0, 0, 1);
  const clip = new Bitmap();
  clip.set(15, 15, 7);
  const state: FrameState = { frames: [original], current: 0 };
  const undo = pasteIntoCurrent(state, clip);
  assert.equal(state.frames[0].get(15, 15), 7);
  assert.equal(state.frames[0].get(0, 0), TRANSPARENT);
  undo();
  assert.equal(state.frames[0].get(0, 0), 1);
  assert.equal(state.frames[0].get(15, 15), TRANSPARENT);
});

test("pasteIntoCurrent stores a clone so later edits do not leak", () => {
  const clip = new Bitmap();
  clip.set(1, 1, 2);
  const state: FrameState = { frames: [new Bitmap()], current: 0 };
  pasteIntoCurrent(state, clip);
  clip.set(1, 1, 9);
  assert.equal(state.frames[0].get(1, 1), 2);
});

// The regression scenario from the user report: add a frame, draw two
// strokes, delete the frame, undo once. Expected: the deleted frame is
// restored with both strokes (the undo reverses the delete, not a stroke).
test("undo stack: add → stroke → stroke → delete → undo restores the deleted frame", () => {
  const state: FrameState = { frames: [new Bitmap()], current: 0 };
  const history = new History();

  push(history, addFrame(state, MAX));
  push(history, paint(state, 3));
  push(history, paint(state, 4));
  push(history, removeCurrentFrame(state));

  assert.equal(state.frames.length, 1);
  history.undo();
  assert.equal(state.frames.length, 2);
  assert.equal(state.current, 1);
  assert.equal(state.frames[1].get(0, 0), 4);
});

test("undo stack: fully reverses add → stroke → stroke → delete in order", () => {
  const state: FrameState = { frames: [new Bitmap()], current: 0 };
  const history = new History();

  push(history, addFrame(state, MAX));
  push(history, paint(state, 3));
  push(history, paint(state, 4));
  push(history, removeCurrentFrame(state));

  history.undo(); // un-delete
  assert.equal(state.frames.length, 2);
  assert.equal(state.frames[1].get(0, 0), 4);

  history.undo(); // un-stroke-2
  assert.equal(state.frames[1].get(0, 0), 3);

  history.undo(); // un-stroke-1
  assert.equal(state.frames[1].get(0, 0), TRANSPARENT);

  history.undo(); // un-add
  assert.equal(state.frames.length, 1);
  assert.equal(state.current, 0);
});

test("undo stack: stroke on non-current frame restores that frame, not the viewed one", () => {
  const state: FrameState = { frames: [new Bitmap(), new Bitmap()], current: 1 };
  const history = new History();

  push(history, paint(state, 7)); // paints frame 1
  state.current = 0;              // user switches view
  push(history, paint(state, 2)); // paints frame 0

  history.undo(); // reverts frame 0
  assert.equal(state.frames[0].get(0, 0), TRANSPARENT);
  assert.equal(state.frames[1].get(0, 0), 7);

  history.undo(); // reverts frame 1 — must restore frame 1 by index
  assert.equal(state.frames[1].get(0, 0), TRANSPARENT);
});

test("addFrame undo after deletes still splices at the recorded index", () => {
  const state: FrameState = { frames: [new Bitmap(), new Bitmap()], current: 0 };
  const addUndo = addFrame(state, MAX); // appends at index 2
  assert.ok(addUndo);
  assert.equal(state.frames.length, 3);
  assert.equal(state.current, 2);

  addUndo();
  assert.equal(state.frames.length, 2);
  assert.equal(state.current, 0);
});
