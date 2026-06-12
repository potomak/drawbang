import { LOGO_BITMAP, LOGO_H, LOGO_W } from "../layout/logo-bitmap.js";
import { TRANSPARENT, type Bitmap } from "./bitmap.js";
import { activePaletteToRgb, type RGB } from "./palette.js";
import { deriveShareColors } from "./share-gif.js";

// Social-video compositor: paints the drawing's frames onto a 1080-wide
// canvas (square or 9:16 Reels) with integer nearest-neighbor upscale and
// an optional "Made with Draw!" wordmark, looping the animation to a
// share-friendly duration. planVideo() is the pure layout/timing math
// (node-testable); the canvas painting itself is browser-only and driven
// by the export dialog (M4-3).
//
// Art-area targets are chosen so every canvas size lands on an exact
// integer scale (both divide by 8/16/32/64): 896 on the square preset
// leaves a margin that clears the bottom-right wordmark; 1024 on Reels
// is near-full-bleed horizontally with the 9:16 letterbox above/below.

export const VIDEO_PRESETS = {
  square: { width: 1080, height: 1080, artTarget: 896 },
  reels: { width: 1080, height: 1920, artTarget: 1024 },
} as const;

export type VideoPreset = keyof typeof VIDEO_PRESETS;

export const MIN_VIDEO_DURATION_MS = 5000;
export const MAX_VIDEO_DURATION_MS = 15000;

const VIDEO_LOGO_SCALE = 4;
const VIDEO_LOGO_INSET = 24;

export interface VideoPlanInput {
  frameCount: number;
  delayMs: number;
  size: number;
  preset: VideoPreset;
}

export interface VideoPlan {
  preset: VideoPreset;
  width: number;
  height: number;
  artScale: number;
  artW: number;
  artH: number;
  artX: number;
  artY: number;
  fps: number;
  frameDurationUs: number;
  repeats: number;
  totalFrames: number;
  durationMs: number;
}

export function planVideo(input: VideoPlanInput): VideoPlan {
  const { frameCount, delayMs, size, preset } = input;
  if (frameCount < 1) throw new Error("planVideo: no frames");
  if (delayMs <= 0) throw new Error(`planVideo: bad delay ${delayMs}`);
  const { width, height, artTarget } = VIDEO_PRESETS[preset];
  const artScale = Math.max(1, Math.floor(artTarget / size));
  const artW = size * artScale;
  const artH = size * artScale;
  const artX = Math.round((width - artW) / 2);
  const artY = Math.round((height - artH) / 2);

  const loopMs = frameCount * delayMs;
  // Repeat whole loops until the clip is share-length (≥5s) without
  // blowing past the cap; a single loop always fits the cap with the
  // editor's real limits (≤16 frames × ≤250ms = 4s), so maxRepeats only
  // floors at 1 for out-of-range inputs.
  const maxRepeats = Math.max(1, Math.floor(MAX_VIDEO_DURATION_MS / loopMs));
  const repeats = Math.min(
    Math.max(1, Math.ceil(MIN_VIDEO_DURATION_MS / loopMs)),
    maxRepeats,
  );
  const totalFrames = frameCount * repeats;

  return {
    preset,
    width,
    height,
    artScale,
    artW,
    artH,
    artX,
    artY,
    fps: 1000 / delayMs,
    frameDurationUs: Math.round(delayMs * 1000),
    repeats,
    totalFrames,
    durationMs: totalFrames * delayMs,
  };
}

export interface VideoCompositorInput {
  frames: Bitmap[];
  activePalette: Uint8Array;
  delayMs: number;
  preset: VideoPreset;
  footer: boolean;
}

export interface VideoCompositor {
  plan: VideoPlan;
  // frameIndex ∈ [0, plan.totalFrames) — wraps over the source loop.
  paint(ctx: CanvasRenderingContext2D, frameIndex: number): void;
}

export function createVideoCompositor(input: VideoCompositorInput): VideoCompositor {
  const { frames, activePalette, delayMs, preset, footer } = input;
  if (frames.length === 0) throw new Error("createVideoCompositor: no frames");
  const size = frames[0].width;
  const plan = planVideo({ frameCount: frames.length, delayMs, size, preset });
  const { bg, fg } = deriveShareColors(frames, activePalette);
  const paletteRgb = activePaletteToRgb(activePalette);
  const frameCanvases = frames.map((f) => rasterizeFrame(f, paletteRgb));
  const logoCanvas = footer ? buildLogoCanvas(fg) : null;
  const bgCss = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
  const logoX = plan.width - LOGO_W * VIDEO_LOGO_SCALE - VIDEO_LOGO_INSET;
  const logoY = plan.height - LOGO_H * VIDEO_LOGO_SCALE - VIDEO_LOGO_INSET;

  return {
    plan,
    paint(ctx, frameIndex) {
      ctx.fillStyle = bgCss;
      ctx.fillRect(0, 0, plan.width, plan.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        frameCanvases[frameIndex % frameCanvases.length],
        plan.artX,
        plan.artY,
        plan.artW,
        plan.artH,
      );
      if (logoCanvas) {
        ctx.drawImage(
          logoCanvas,
          logoX,
          logoY,
          LOGO_W * VIDEO_LOGO_SCALE,
          LOGO_H * VIDEO_LOGO_SCALE,
        );
      }
    },
  };
}

// Transparent pixels stay alpha-0 so the derived background shows through,
// matching the share gif's treatment.
function rasterizeFrame(frame: Bitmap, paletteRgb: RGB[]): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = frame.width;
  c.height = frame.height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("rasterizeFrame: no 2d context");
  const img = ctx.createImageData(frame.width, frame.height);
  for (let i = 0; i < frame.data.length; i++) {
    const slot = frame.data[i];
    if (slot === TRANSPARENT) continue;
    const [r, g, b] = paletteRgb[slot];
    const o = i * 4;
    img.data[o] = r;
    img.data[o + 1] = g;
    img.data[o + 2] = b;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function buildLogoCanvas(fg: RGB): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = LOGO_W;
  c.height = LOGO_H;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("buildLogoCanvas: no 2d context");
  const img = ctx.createImageData(LOGO_W, LOGO_H);
  for (let i = 0; i < LOGO_BITMAP.length; i++) {
    if (!LOGO_BITMAP[i]) continue;
    const o = i * 4;
    img.data[o] = fg[0];
    img.data[o + 1] = fg[1];
    img.data[o + 2] = fg[2];
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
