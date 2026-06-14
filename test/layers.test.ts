import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { Bitmap, TRANSPARENT } from "../src/editor/bitmap.js";
import {
  addFrame,
  addLayer,
  moveLayer,
  newFrameState,
  removeLayer,
  toggleLayerVisibility,
} from "../src/editor/frames.js";
import {
  composeFrame,
  MAX_LAYERS,
  newFrame,
  newLayerMeta,
} from "../src/editor/layers.js";
import { History } from "../src/editor/history.js";
import { migrate, type StoredDrawing } from "../src/local.js";

const SIZE = 16;
const FRAMES_MAX = 16;

// composeFrame: each layer's non-transparent pixels show through unless
// occluded by a higher visible layer.
describe("composeFrame", () => {
  test("a single visible layer composes to its own bitmap", () => {
    const layer = newLayerMeta("L1");
    const b = new Bitmap(SIZE, SIZE);
    b.set(2, 3, 5);
    b.set(4, 5, 7);
    const out = composeFrame([layer], { bitmaps: [b] });
    assert.equal(out.get(2, 3), 5);
    assert.equal(out.get(4, 5), 7);
    assert.equal(out.get(0, 0), TRANSPARENT);
  });

  test("a higher visible layer occludes the layer below at painted pixels", () => {
    const a = newLayerMeta("bottom");
    const b = newLayerMeta("top");
    const bot = new Bitmap(SIZE, SIZE);
    bot.set(2, 2, 5);
    bot.set(3, 3, 6);
    const top = new Bitmap(SIZE, SIZE);
    top.set(2, 2, 8); // overwrites bottom at (2, 2)
    const out = composeFrame([a, b], { bitmaps: [bot, top] });
    assert.equal(out.get(2, 2), 8); // top wins
    assert.equal(out.get(3, 3), 6); // bottom shows through (top is transparent here)
  });

  test("a hidden layer contributes nothing — lower layers show through", () => {
    const a = newLayerMeta("bottom");
    const b = newLayerMeta("top");
    b.visible = false;
    const bot = new Bitmap(SIZE, SIZE);
    bot.set(1, 1, 4);
    const top = new Bitmap(SIZE, SIZE);
    top.set(1, 1, 9);
    const out = composeFrame([a, b], { bitmaps: [bot, top] });
    assert.equal(out.get(1, 1), 4);
  });

  test("composing returns a fresh Bitmap — mutating it doesn't leak into layers", () => {
    const layer = newLayerMeta("L1");
    const src = new Bitmap(SIZE, SIZE);
    src.set(0, 0, 5);
    const out = composeFrame([layer], { bitmaps: [src] });
    out.set(0, 0, 9);
    assert.equal(src.get(0, 0), 5);
  });
});

// addLayer / removeLayer / toggleLayerVisibility / moveLayer — and their
// undo closures. Every layer op walks all frames so each frame's bitmap
// stack stays aligned with the document layers array.
describe("layer ops", () => {
  test("addLayer inserts above currentLayer in every frame", () => {
    const state = newFrameState(SIZE, SIZE);
    addFrame(state, FRAMES_MAX);
    state.current = 0;
    addLayer(state);
    assert.equal(state.layers.length, 2);
    assert.equal(state.currentLayer, 1);
    for (const f of state.frames) {
      assert.equal(f.bitmaps.length, 2);
    }
  });

  test("addLayer undo restores layer list, frames, and currentLayer", () => {
    const state = newFrameState(SIZE, SIZE);
    addFrame(state, FRAMES_MAX);
    const undo = addLayer(state);
    assert.ok(undo);
    state.frames[0].bitmaps[1].set(0, 0, 5);
    undo!();
    assert.equal(state.layers.length, 1);
    assert.equal(state.currentLayer, 0);
    for (const f of state.frames) {
      assert.equal(f.bitmaps.length, 1);
    }
  });

  test("addLayer returns null at the layer cap", () => {
    const state = newFrameState(SIZE, SIZE);
    for (let i = 1; i < MAX_LAYERS; i++) addLayer(state);
    assert.equal(state.layers.length, MAX_LAYERS);
    assert.equal(addLayer(state), null);
  });

  test("removeLayer drops the bitmap at the same index in every frame", () => {
    const state = newFrameState(SIZE, SIZE);
    addFrame(state, FRAMES_MAX);
    addLayer(state); // 2 layers
    addLayer(state); // 3 layers
    // Tag each layer's bitmap on frame 0 so we can tell who survives.
    state.frames[0].bitmaps[0].set(0, 0, 1);
    state.frames[0].bitmaps[1].set(0, 0, 2);
    state.frames[0].bitmaps[2].set(0, 0, 3);
    removeLayer(state, 1);
    assert.equal(state.layers.length, 2);
    assert.equal(state.frames[0].bitmaps.length, 2);
    assert.equal(state.frames[0].bitmaps[0].get(0, 0), 1); // index 0 untouched
    assert.equal(state.frames[0].bitmaps[1].get(0, 0), 3); // index 2 shifted down
  });

  test("removeLayer refuses when only one layer remains", () => {
    const state = newFrameState(SIZE, SIZE);
    assert.equal(removeLayer(state, 0), null);
  });

  test("removeLayer undo restores the layer's bitmap on every frame", () => {
    const state = newFrameState(SIZE, SIZE);
    addFrame(state, FRAMES_MAX);
    addLayer(state); // 2 layers
    state.frames[0].bitmaps[1].set(5, 5, 7);
    state.frames[1].bitmaps[1].set(6, 6, 8);
    const undo = removeLayer(state, 1);
    assert.ok(undo);
    undo!();
    assert.equal(state.layers.length, 2);
    assert.equal(state.frames[0].bitmaps[1].get(5, 5), 7);
    assert.equal(state.frames[1].bitmaps[1].get(6, 6), 8);
  });

  test("toggleLayerVisibility flips and undo restores", () => {
    const state = newFrameState(SIZE, SIZE);
    addLayer(state);
    assert.equal(state.layers[0].visible, true);
    const undo = toggleLayerVisibility(state, 0);
    assert.ok(undo);
    assert.equal(state.layers[0].visible, false);
    undo!();
    assert.equal(state.layers[0].visible, true);
  });

  test("moveLayer reorders every frame's bitmap stack in lockstep", () => {
    const state = newFrameState(SIZE, SIZE);
    addFrame(state, FRAMES_MAX);
    addLayer(state);
    addLayer(state);
    // Tag each layer so we can identify them after the move.
    state.frames[0].bitmaps[0].set(0, 0, 1);
    state.frames[0].bitmaps[1].set(0, 0, 2);
    state.frames[0].bitmaps[2].set(0, 0, 3);
    state.frames[1].bitmaps[0].set(0, 0, 10);
    state.frames[1].bitmaps[1].set(0, 0, 11);
    state.frames[1].bitmaps[2].set(0, 0, 12);
    moveLayer(state, 2, 0);
    // Layer that was at index 2 is now at index 0 on every frame.
    assert.equal(state.frames[0].bitmaps[0].get(0, 0), 3);
    assert.equal(state.frames[0].bitmaps[1].get(0, 0), 1);
    assert.equal(state.frames[0].bitmaps[2].get(0, 0), 2);
    assert.equal(state.frames[1].bitmaps[0].get(0, 0), 12);
    assert.equal(state.frames[1].bitmaps[1].get(0, 0), 10);
    assert.equal(state.frames[1].bitmaps[2].get(0, 0), 11);
  });

  test("addFrame on a multi-layer doc allocates layers.length empty bitmaps", () => {
    const state = newFrameState(SIZE, SIZE);
    addLayer(state); // 2 layers
    addLayer(state); // 3 layers
    addFrame(state, FRAMES_MAX);
    assert.equal(state.frames[1].bitmaps.length, 3);
    for (const b of state.frames[1].bitmaps) {
      // Empty — every cell transparent
      for (let i = 0; i < b.data.length; i++) {
        assert.equal(b.data[i], TRANSPARENT);
      }
    }
  });
});

// History stacks must round-trip layer ops the same way they do frame ops.
describe("history round-trip with layer ops", () => {
  test("addLayer → paint → undo twice returns to single-layer initial state", () => {
    const state = newFrameState(SIZE, SIZE);
    const history = new History();

    const addUndo = addLayer(state);
    if (addUndo) history.push(addUndo);
    const before = state.frames[0].bitmaps[1].clone();
    state.frames[0].bitmaps[1].set(3, 3, 5);
    history.push(() => {
      state.frames[0].bitmaps[1] = before;
    });

    // Undo paint, then undo addLayer.
    history.undo();
    // After the paint undo, the addLayer is still applied — there should
    // still be 2 layers but the bitmap is back to all-transparent.
    assert.equal(state.layers.length, 2);
    assert.equal(state.frames[0].bitmaps[1].get(3, 3), TRANSPARENT);

    history.undo();
    assert.equal(state.layers.length, 1);
    assert.equal(state.frames[0].bitmaps.length, 1);
  });
});

// v2 → v3 migration in src/local.ts: legacy records carrying frames as
// Uint8Array[] get wrapped into a single-layer v3 record without losing
// pixel data.
describe("local store migration v2 → v3", () => {
  test("a v2 record (frames: Uint8Array[], no layers) is wrapped into a single-layer v3 record", () => {
    const frameA = new Uint8Array(SIZE * SIZE);
    frameA[42] = 5;
    const frameB = new Uint8Array(SIZE * SIZE);
    frameB[100] = 9;
    const v2Record = {
      id: "abc",
      created_at: 1,
      frames: [frameA, frameB],
      activePalette: new Uint8Array(16),
    } as unknown as StoredDrawing;

    const migrated = migrate(v2Record);

    assert.equal(migrated.layers.length, 1);
    assert.equal(migrated.layers[0].name, "Layer 1");
    assert.equal(migrated.layers[0].visible, true);
    assert.equal(migrated.frames.length, 2);
    assert.equal(migrated.frames[0].length, 1);
    assert.equal(migrated.frames[1].length, 1);
    assert.equal(migrated.frames[0][0][42], 5);
    assert.equal(migrated.frames[1][0][100], 9);
  });

  test("a v3 record passes through unchanged", () => {
    const v3Record: StoredDrawing = {
      id: "xyz",
      created_at: 1,
      frames: [[new Uint8Array(SIZE * SIZE)]],
      layers: [{ id: "abc", name: "Foo", visible: true }],
      activePalette: new Uint8Array(16),
    };
    const migrated = migrate(v3Record);
    assert.strictEqual(migrated, v3Record);
    assert.equal(migrated.layers[0].name, "Foo");
  });
});

// newFrame allocates the right number of bitmaps for the layer count.
describe("newFrame", () => {
  test("allocates `layerCount` empty bitmaps", () => {
    const f = newFrame(SIZE, SIZE, 3);
    assert.equal(f.bitmaps.length, 3);
    for (const b of f.bitmaps) {
      assert.equal(b.width, SIZE);
      assert.equal(b.height, SIZE);
    }
  });
});
