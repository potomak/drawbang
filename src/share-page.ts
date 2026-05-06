import { Bitmap } from "./editor/bitmap.js";
import { PixelCanvas } from "./editor/canvas.js";
import { decodeGif } from "./editor/gif.js";
import { encodeScaledGif } from "./editor/scaled-gif.js";
import { activePaletteToRgb, DEFAULT_ACTIVE_PALETTE } from "./editor/palette.js";

const DRAWING_BASE_URL = import.meta.env.VITE_DRAWING_BASE_URL ?? "/drawings";

// 16 source pixels × 20 = 320×320 output. Big enough to look good in a
// Reddit/Twitter/etc. embed; still tiny on the wire.
const SCALE = 20;

const previewCanvasEl = document.getElementById("preview") as HTMLCanvasElement;
const subredditEl = document.getElementById("subredditInput") as HTMLInputElement;
const titleEl = document.getElementById("titleInput") as HTMLInputElement;
const shareBtn = document.getElementById("shareBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;

let frames: Bitmap[] = [];
let activePalette: Uint8Array = new Uint8Array(DEFAULT_ACTIVE_PALETTE);
let drawingId: string | null = null;
let busy = false;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function renderPreview(): void {
  if (frames.length === 0) return;
  // Pixel size 16 → 256-px canvas. Smaller than the upscaled GIF but matches
  // the rest of the editor's preview chrome.
  const canvas = new PixelCanvas(previewCanvasEl, {
    pixelSize: 16,
    showGrid: false,
    gridColor: "",
  });
  canvas.draw(frames[0], activePaletteToRgb(activePalette));
}

async function loadDrawing(id: string): Promise<void> {
  setStatus("loading drawing…");
  const res = await fetch(`${DRAWING_BASE_URL}/${id}.gif`);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const decoded = decodeGif(bytes);
  frames = decoded.frames;
  if (decoded.activePalette) activePalette = decoded.activePalette;
  setStatus("");
}

function downloadBlob(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: "image/gif" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildRedditUrl(subreddit: string, title: string): string {
  // Reddit accepts either /r/<sub>/submit or /submit for the home feed.
  // We always want a subreddit, so reject empty input and the leading "r/"
  // people sometimes paste in.
  const cleanSub = subreddit.replace(/^\/?r\//i, "").trim();
  const url = new URL(`https://www.reddit.com/r/${encodeURIComponent(cleanSub)}/submit`);
  url.searchParams.set("type", "IMAGE");
  if (title) url.searchParams.set("title", title);
  return url.toString();
}

async function handleShare(): Promise<void> {
  if (busy || !drawingId || frames.length === 0) return;
  const subreddit = subredditEl.value.trim().replace(/^\/?r\//i, "");
  if (!subreddit) {
    setStatus("subreddit can't be empty");
    return;
  }
  busy = true;
  shareBtn.disabled = true;
  setStatus("generating GIF…");
  try {
    const bytes = encodeScaledGif({ frames, activePalette, scale: SCALE });
    downloadBlob(bytes, `drawbang-${drawingId.slice(0, 8)}-320.gif`);
    const reddit = buildRedditUrl(subreddit, titleEl.value);
    setStatus("opening Reddit in a new tab — drag the downloaded GIF into the form");
    window.open(reddit, "_blank", "noopener,noreferrer");
  } catch (err) {
    setStatus(`failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    busy = false;
    shareBtn.disabled = false;
  }
}

async function boot(): Promise<void> {
  const params = new URL(location.href).searchParams;
  drawingId = params.get("d");
  if (!drawingId || !/^[0-9a-f]{64}$/.test(drawingId)) {
    setStatus("missing or malformed ?d=<drawing id>");
    shareBtn.disabled = true;
    return;
  }

  try {
    await loadDrawing(drawingId);
    renderPreview();
  } catch (err) {
    setStatus(`could not load drawing: ${err instanceof Error ? err.message : String(err)}`);
    shareBtn.disabled = true;
    return;
  }

  if (!titleEl.value) {
    titleEl.value = `pixel art on drawbang (#${drawingId.slice(0, 8)})`;
  }

  shareBtn.addEventListener("click", () => void handleShare());
}

void boot();
