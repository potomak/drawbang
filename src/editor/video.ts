import { ArrayBufferTarget, Muxer } from "mp4-muxer";
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

// ---------------------------------------------------------------------------
// Encoder fallback chain
// ---------------------------------------------------------------------------
// The export dialog picks one of: MP4 (WebCodecs + mp4-muxer), WebM
// (MediaRecorder), or GIF (the existing toolbar download). Detection runs
// when the dialog opens so the labels reflect what the browser will
// actually produce. Pure helpers below stay node-testable; the encoders
// themselves are browser-only and exercised by the manual QA matrix.

export type VideoEncodingFormat = "mp4" | "webm";

// Tried in order. Higher AVC levels first so 1080×1920 Reels passes on
// browsers that gate by level; baseline profile (`42…`) maximizes Reels
// compatibility, as Instagram historically transcoded high-profile uploads.
export const MP4_CODEC_CANDIDATES: readonly string[] = [
  "avc1.42002a", // baseline, level 4.2 (≥1080×1920 @ 30fps)
  "avc1.420028", // baseline, level 4.0
  "avc1.42001f", // baseline, level 3.1
];

export const WEBM_MIME_CANDIDATES: readonly string[] = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

export interface VideoSupport {
  mp4: { supported: true; codec: string } | { supported: false };
  webm: { supported: true; mimeType: string } | { supported: false };
}

export function pickWebmMimeType(isSupported: (mime: string) => boolean): string | null {
  for (const mime of WEBM_MIME_CANDIDATES) {
    if (isSupported(mime)) return mime;
  }
  return null;
}

export async function pickMp4Codec(
  width: number,
  height: number,
  isConfigSupported: (config: VideoEncoderConfig) => Promise<VideoEncoderSupport>,
): Promise<string | null> {
  for (const codec of MP4_CODEC_CANDIDATES) {
    try {
      const result = await isConfigSupported({ codec, width, height });
      if (result.supported) return codec;
    } catch {
      // Some browsers throw rather than returning {supported:false}.
    }
  }
  return null;
}

export async function detectVideoSupport(dim: {
  width: number;
  height: number;
}): Promise<VideoSupport> {
  const g = globalThis as unknown as {
    VideoEncoder?: typeof VideoEncoder;
    MediaRecorder?: typeof MediaRecorder;
  };
  let mp4: VideoSupport["mp4"] = { supported: false };
  if (typeof g.VideoEncoder?.isConfigSupported === "function") {
    const codec = await pickMp4Codec(dim.width, dim.height, g.VideoEncoder.isConfigSupported);
    if (codec) mp4 = { supported: true, codec };
  }
  let webm: VideoSupport["webm"] = { supported: false };
  if (typeof g.MediaRecorder?.isTypeSupported === "function") {
    const mimeType = pickWebmMimeType(g.MediaRecorder.isTypeSupported);
    if (mimeType) webm = { supported: true, mimeType };
  }
  return { mp4, webm };
}

export function outputFilename(drawingIdShort: string, format: VideoEncodingFormat): string {
  const slug = drawingIdShort.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "draw";
  return `draw-${slug}.${format}`;
}

export interface EncodeVideoOptions {
  compositor: VideoCompositor;
  format: VideoEncodingFormat;
  support: VideoSupport;
  onProgress?: (fraction: number) => void;
}

export interface EncodedVideo {
  blob: Blob;
  filename: string;
  format: VideoEncodingFormat;
}

export async function encodeVideo(
  options: EncodeVideoOptions & { drawingIdShort: string },
): Promise<EncodedVideo> {
  const { compositor, format, support, drawingIdShort, onProgress } = options;
  const filename = outputFilename(drawingIdShort, format);
  if (format === "mp4") {
    if (!support.mp4.supported) throw new Error("encodeVideo: mp4 not supported");
    const blob = await encodeMp4(compositor, support.mp4.codec, onProgress);
    return { blob, filename, format };
  }
  if (!support.webm.supported) throw new Error("encodeVideo: webm not supported");
  const blob = await encodeWebm(compositor, support.webm.mimeType, onProgress);
  return { blob, filename, format };
}

async function encodeMp4(
  compositor: VideoCompositor,
  codec: string,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  const { plan } = compositor;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    fastStart: "in-memory",
    video: {
      codec: "avc",
      width: plan.width,
      height: plan.height,
      frameRate: plan.fps,
    },
  });
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      throw e;
    },
  });
  // Conservative bitrate: pixel art compresses very well; this keeps a
  // 1080×1920 15s clip well under typical Reels upload caps.
  const bitrate = plan.width * plan.height * 4;
  encoder.configure({
    codec,
    width: plan.width,
    height: plan.height,
    bitrate,
    framerate: plan.fps,
  });

  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("encodeMp4: no 2d context");

  for (let i = 0; i < plan.totalFrames; i++) {
    compositor.paint(ctx, i);
    const timestamp = i * plan.frameDurationUs;
    const frame = new VideoFrame(canvas, { timestamp, duration: plan.frameDurationUs });
    // Every frame a keyframe: clips are short, pixel art compresses well,
    // and this guarantees the muxer can finalize without partial GOPs.
    encoder.encode(frame, { keyFrame: true });
    frame.close();
    if (onProgress) onProgress((i + 1) / plan.totalFrames);
    // Backpressure: if the encoder's queue gets deep, yield so the
    // browser can drain it before we keep submitting frames.
    if (encoder.encodeQueueSize > 8) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  await encoder.flush();
  encoder.close();
  muxer.finalize();
  return new Blob([target.buffer], { type: "video/mp4" });
}

async function encodeWebm(
  compositor: VideoCompositor,
  mimeType: string,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  const { plan } = compositor;
  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("encodeWebm: no 2d context");
  compositor.paint(ctx, 0);

  const stream = canvas.captureStream(plan.fps);
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };

  return new Promise<Blob>((resolve, reject) => {
    recorder.onerror = (ev) => reject((ev as { error?: Error }).error ?? new Error("MediaRecorder error"));
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.start();
    let frame = 1;
    const interval = window.setInterval(() => {
      if (frame >= plan.totalFrames) {
        window.clearInterval(interval);
        // Let the last frame land on the encoder before stopping.
        window.setTimeout(() => recorder.stop(), Math.max(60, 1000 / plan.fps));
        return;
      }
      compositor.paint(ctx, frame);
      if (onProgress) onProgress(frame / plan.totalFrames);
      frame++;
    }, 1000 / plan.fps);
  });
}
