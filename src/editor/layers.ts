import { Bitmap, TRANSPARENT } from "./bitmap.js";

// Aseprite-style shared layers: the layer list (names + visibility) is
// global, and each layer has its own bitmap per animation frame. A flat
// "1-layer" drawing is a strict subset — the editor always boots with
// one layer, so the model is identical to the pre-layers world until
// the user adds a second layer.

export const MAX_LAYERS = 8;
export const DEFAULT_LAYER_NAME = "Layer";

export interface LayerMeta {
  // Session-stable short id, used by the UI to key rows across renders.
  // Not persisted to the GIF or to the server payload — only inside the
  // local draft and the layers panel itself.
  id: string;
  name: string;
  // Global: applies to every frame. Hidden layers don't paint into the
  // composited output but pixel writes to them still succeed (matches
  // Aseprite — you can paint on a hidden layer and reveal it later).
  visible: boolean;
}

// A Frame holds one Bitmap per layer. The Frame.bitmaps index aligns
// 1:1 with the document-level FrameState.layers index — addLayer
// inserts at the same slot in every frame to keep this invariant.
export interface Frame {
  bitmaps: Bitmap[];
}

export function newLayerMeta(name: string): LayerMeta {
  return { id: shortId(), name, visible: true };
}

export function newFrame(width: number, height: number, layerCount: number): Frame {
  const bitmaps: Bitmap[] = [];
  for (let i = 0; i < layerCount; i++) bitmaps.push(new Bitmap(width, height));
  return { bitmaps };
}

export function cloneFrame(f: Frame): Frame {
  return { bitmaps: f.bitmaps.map((b) => b.clone()) };
}

// Picks a default name for a freshly-created layer that doesn't collide
// with any existing layer. Iterates "Layer N" until it finds an
// available number so the panel never shows two "Layer 2"s.
export function nextLayerName(layers: readonly LayerMeta[]): string {
  const taken = new Set(layers.map((l) => l.name));
  for (let n = 1; n <= MAX_LAYERS + 1; n++) {
    const candidate = `${DEFAULT_LAYER_NAME} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${DEFAULT_LAYER_NAME} ${layers.length + 1}`;
}

// Flattens visible layers bottom→top into a single Bitmap. Transparent
// pixels (value === TRANSPARENT) let lower layers show through. Hidden
// layers contribute nothing. Output is a fresh Bitmap matching the
// input dimensions — callers can mutate it without affecting the
// underlying layer bitmaps.
export function composeFrame(layers: readonly LayerMeta[], frame: Frame): Bitmap {
  if (frame.bitmaps.length === 0) {
    throw new Error("composeFrame: frame has no layers");
  }
  const first = frame.bitmaps[0];
  const out = new Bitmap(first.width, first.height);
  for (let i = 0; i < layers.length; i++) {
    if (!layers[i].visible) continue;
    const src = frame.bitmaps[i];
    if (!src) continue;
    const data = src.data;
    const dst = out.data;
    for (let p = 0; p < data.length; p++) {
      const v = data[p];
      if (v !== TRANSPARENT) dst[p] = v;
    }
  }
  return out;
}

// 6-char random id — collisions are not a security concern, the id is
// only used to key UI rows in the same draft session.
function shortId(): string {
  const bytes = new Uint8Array(4);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
