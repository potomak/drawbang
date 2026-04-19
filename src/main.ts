import { HEIGHT, MAX_FRAMES, WIDTH } from "../config/constants.js";
import { Bitmap, TRANSPARENT } from "./editor/bitmap.js";
import { PixelCanvas } from "./editor/canvas.js";
import { decodeGif, encodeGif } from "./editor/gif.js";
import { History } from "./editor/history.js";
import {
  BASE_PALETTE,
  DEFAULT_ACTIVE_PALETTE,
  activePaletteToHex,
  activePaletteToRgb,
} from "./editor/palette.js";
import {
  clearAll,
  drawPixel,
  fillArea,
  flipHorizontal,
  flipVertical,
  rotateLeft,
  shiftRight,
  shiftUp,
} from "./editor/tools.js";
import { decodeShare, encodeShare } from "./share.js";
import * as local from "./local.js";
import { submit } from "./submit.js";

const MAIN_PIXEL_SIZE = 24;
const PREVIEW_PIXEL_SIZE = 4;

const INGEST_URL = import.meta.env.VITE_INGEST_URL ?? "/ingest";
const STATE_URL = import.meta.env.VITE_STATE_URL ?? "/state/last-publish.json";
const DRAWING_BASE_URL = import.meta.env.VITE_DRAWING_BASE_URL ?? "";
const PUBLISH_DISABLED = truthy(import.meta.env.VITE_DISABLE_PUBLISH);

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  return v !== "0" && v.toLowerCase() !== "false";
}

// -- Editor state -----------------------------------------------------------

let frames: Bitmap[] = [new Bitmap(WIDTH, HEIGHT)];
let activePalette: Uint8Array = new Uint8Array(DEFAULT_ACTIVE_PALETTE);
let currentFrame = 0;
let selectedSlot = 1; // start on the second active slot (first is usually black)
let tool: "pixel" | "erase" | "fill" = "pixel";
let painting = false;
const history = new History();
let localId: string | null = null;

// -- DOM setup --------------------------------------------------------------

const app = document.getElementById("app")!;
app.innerHTML = /* html */ `
  <header>
    <h1>drawbang</h1>
    <nav>
      <a href="/">gallery</a>
    </nav>
  </header>
  <main>
    <section class="stage">
      <canvas id="main" aria-label="drawing canvas"></canvas>
      <div class="tools">
        <button data-tool="pixel" class="on">pencil</button>
        <button data-tool="erase">erase</button>
        <button data-tool="fill">fill</button>
        <button data-action="undo">undo</button>
        <button data-action="clear">clear</button>
        <button data-action="flip-h">flip h</button>
        <button data-action="flip-v">flip v</button>
        <button data-action="rotate">rotate</button>
        <button data-action="shift-right">shift →</button>
        <button data-action="shift-up">shift ↑</button>
      </div>
      <div id="palette" class="palette" role="toolbar" aria-label="active palette"></div>
    </section>
    <section class="frames">
      <h2>frames</h2>
      <div id="frameList"></div>
      <button data-action="add-frame">+ frame</button>
    </section>
    <section class="publish">
      <button data-action="export-gif">download gif</button>
      <button data-action="share">copy share link</button>
      ${PUBLISH_DISABLED ? "" : `<button data-action="publish">publish to gallery</button>`}
      <p id="status">${PUBLISH_DISABLED ? "demo mode — draw, export a gif, or copy a share link" : ""}</p>
    </section>
  </main>
  <dialog id="palettePicker">
    <p>pick a color from the 256-color base palette</p>
    <div id="baseGrid"></div>
    <menu>
      <button value="cancel">cancel</button>
    </menu>
  </dialog>
`;

const mainCanvasEl = document.getElementById("main") as HTMLCanvasElement;
const mainCanvas = new PixelCanvas(mainCanvasEl, {
  pixelSize: MAIN_PIXEL_SIZE,
  showGrid: true,
  gridColor: "#2a2a2a",
});
const frameListEl = document.getElementById("frameList")!;
const paletteEl = document.getElementById("palette")!;
const statusEl = document.getElementById("status")!;
const picker = document.getElementById("palettePicker") as HTMLDialogElement;
const baseGridEl = document.getElementById("baseGrid")!;

// -- Rendering --------------------------------------------------------------

function render(): void {
  mainCanvas.draw(frames[currentFrame], activePaletteToRgb(activePalette));
  renderFrameStrip();
  renderPalette();
}

function renderPalette(): void {
  paletteEl.innerHTML = "";
  const hex = activePaletteToHex(activePalette);
  for (let i = 0; i < activePalette.length; i++) {
    const b = document.createElement("button");
    b.className = "swatch" + (i === selectedSlot ? " selected" : "");
    b.style.backgroundColor = hex[i];
    b.title = `slot ${i} — right-click to change color`;
    b.dataset.slot = String(i);
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
  frames.forEach((frame, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "frame" + (idx === currentFrame ? " selected" : "");
    const cv = document.createElement("canvas");
    const preview = new PixelCanvas(cv, {
      pixelSize: PREVIEW_PIXEL_SIZE,
      showGrid: false,
      gridColor: "",
    });
    preview.draw(frame, palette);
    wrap.appendChild(cv);
    const label = document.createElement("span");
    label.textContent = String(idx + 1);
    wrap.appendChild(label);
    if (frames.length > 1) {
      const rm = document.createElement("button");
      rm.textContent = "×";
      rm.addEventListener("click", (ev) => {
        ev.stopPropagation();
        removeFrame(idx);
      });
      wrap.appendChild(rm);
    }
    wrap.addEventListener("click", () => {
      currentFrame = idx;
      render();
    });
    frameListEl.appendChild(wrap);
  });
}

// -- Tools ------------------------------------------------------------------

function setActiveTool(next: "pixel" | "erase" | "fill"): void {
  tool = next;
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => {
    b.classList.toggle("on", b.dataset.tool === next);
  });
}

function applyTool(x: number, y: number): void {
  const b = frames[currentFrame];
  const value = tool === "erase" ? TRANSPARENT : selectedSlot;
  if (tool === "fill") {
    const before = fillArea(b, x, y, value);
    if (before) {
      const snapshot = before;
      history.push(() => {
        frames[currentFrame] = snapshot;
        render();
      });
    }
  } else {
    const prev = drawPixel(b, x, y, value);
    if (prev !== null) {
      history.push(() => {
        b.set(x, y, prev);
        render();
      });
    }
  }
  render();
  persist();
}

function handleTransform(f: (b: Bitmap) => void): void {
  const before = frames[currentFrame].clone();
  f(frames[currentFrame]);
  history.push(() => {
    frames[currentFrame] = before;
    render();
  });
  render();
  persist();
}

function addFrame(): void {
  if (frames.length >= MAX_FRAMES) {
    flashStatus(`max ${MAX_FRAMES} frames`);
    return;
  }
  frames.push(new Bitmap(WIDTH, HEIGHT));
  currentFrame = frames.length - 1;
  render();
  persist();
}

function removeFrame(idx: number): void {
  if (frames.length === 1) return;
  frames.splice(idx, 1);
  currentFrame = Math.min(currentFrame, frames.length - 1);
  render();
  persist();
}

// -- Palette picker ---------------------------------------------------------

let pickerTargetSlot = -1;

function buildBaseGrid(): void {
  baseGridEl.innerHTML = "";
  BASE_PALETTE.forEach(([r, g, b], idx) => {
    const cell = document.createElement("button");
    cell.className = "base-cell";
    cell.style.backgroundColor = `rgb(${r},${g},${b})`;
    cell.title = `base #${idx}`;
    cell.addEventListener("click", () => {
      if (pickerTargetSlot >= 0) {
        activePalette[pickerTargetSlot] = idx;
        picker.close();
        render();
        persist();
      }
    });
    baseGridEl.appendChild(cell);
  });
}

function openPickerForSlot(slot: number): void {
  pickerTargetSlot = slot;
  picker.showModal();
}

// -- Publishing / export ----------------------------------------------------

async function handlePublish(): Promise<void> {
  const gif = encodeGif({ frames, activePalette });
  setStatus("starting proof of work…");
  try {
    const result = await submit({
      ingestUrl: INGEST_URL,
      stateUrl: STATE_URL,
      gif,
      onPhase: (phase, detail) => setStatus(`${phase}: ${detail}`),
      onProgress: (p) => {
        const rate = (p.hashes / Math.max(1, p.elapsedMs / 1000)).toFixed(0);
        setStatus(`solving… ${p.hashes.toLocaleString()} hashes (${rate}/s)`);
      },
    });
    setStatus(`published: ${result.share_url} (${result.required_bits} bits in ${result.solve_ms}ms)`);
    if (localId) {
      await local.save({
        id: localId,
        frames,
        activePalette,
        publishedId: result.id,
      });
    }
  } catch (err) {
    setStatus(`publish failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function downloadGif(): void {
  const bytes = encodeGif({ frames, activePalette });
  const copy = new Uint8Array(bytes);
  const blob = new Blob([copy as unknown as BlobPart], { type: "image/gif" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "drawbang.gif";
  a.click();
  URL.revokeObjectURL(url);
}

function copyShareLink(): void {
  const hash = encodeShare({ frames, activePalette });
  const url = `${location.origin}${location.pathname}#d=${hash}`;
  navigator.clipboard?.writeText(url);
  setStatus(`share link copied (${hash.length} chars)`);
}

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function flashStatus(msg: string): void {
  setStatus(msg);
  setTimeout(() => {
    if (statusEl.textContent === msg) statusEl.textContent = "";
  }, 2000);
}

function persist(): void {
  if (!localId) localId = local.uuid();
  local.save({ id: localId, frames, activePalette }).catch(() => {});
}

// -- Events -----------------------------------------------------------------

function pointerToPixel(ev: PointerEvent): { x: number; y: number } {
  return mainCanvas.quantize(ev.clientX, ev.clientY);
}

mainCanvasEl.addEventListener("pointerdown", (ev) => {
  mainCanvasEl.setPointerCapture(ev.pointerId);
  painting = true;
  const { x, y } = pointerToPixel(ev);
  applyTool(x, y);
});
mainCanvasEl.addEventListener("pointermove", (ev) => {
  if (!painting) return;
  const { x, y } = pointerToPixel(ev);
  applyTool(x, y);
});
mainCanvasEl.addEventListener("pointerup", () => {
  painting = false;
});

document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) =>
  b.addEventListener("click", () => setActiveTool(b.dataset.tool as typeof tool)),
);

document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((b) =>
  b.addEventListener("click", () => {
    switch (b.dataset.action) {
      case "undo": history.undo(); render(); break;
      case "clear": handleTransform(clearAll); break;
      case "flip-h": handleTransform(flipHorizontal); break;
      case "flip-v": handleTransform(flipVertical); break;
      case "rotate": handleTransform(rotateLeft); break;
      case "shift-right": handleTransform(shiftRight); break;
      case "shift-up": handleTransform(shiftUp); break;
      case "add-frame": addFrame(); break;
      case "export-gif": downloadGif(); break;
      case "share": copyShareLink(); break;
      case "publish": void handlePublish(); break;
    }
  }),
);

window.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "z") {
    ev.preventDefault();
    history.undo();
    render();
  }
});

// -- Bootstrapping ----------------------------------------------------------

async function boot(): Promise<void> {
  buildBaseGrid();

  // Load from ?fork=<id>, then from #d=<...>, then fall back to blank.
  const hash = location.hash.match(/#d=([A-Za-z0-9_-]+)/)?.[1];
  const forkId = new URL(location.href).searchParams.get("fork");

  if (forkId) {
    try {
      const res = await fetch(`${DRAWING_BASE_URL}/drawings/${forkId}.gif`);
      if (!res.ok) throw new Error(`fork fetch failed: ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const decoded = decodeGif(buf);
      frames = decoded.frames;
      if (decoded.activePalette) activePalette = decoded.activePalette;
      currentFrame = 0;
    } catch (err) {
      setStatus(`fork failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (hash) {
    try {
      const d = decodeShare(hash);
      frames = d.frames;
      activePalette = d.activePalette;
      currentFrame = 0;
    } catch (err) {
      setStatus(`invalid share link: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  render();
}

void boot();
