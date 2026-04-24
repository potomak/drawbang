import { MAX_FRAMES } from "../config/constants.js";
import { Bitmap, TRANSPARENT } from "./editor/bitmap.js";
import { PixelCanvas } from "./editor/canvas.js";
import { decodeGif, encodeGif } from "./editor/gif.js";
import { History } from "./editor/history.js";
import {
  addFrame as addFrameOp,
  pasteIntoCurrent,
  removeCurrentFrame,
  type FrameState,
} from "./editor/frames.js";
import {
  BASE_PALETTE,
  DEFAULT_ACTIVE_PALETTE,
  activePaletteToHex,
  activePaletteToRgb,
} from "./editor/palette.js";
import {
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

const state: FrameState = { frames: [new Bitmap()], current: 0 };
let activePalette: Uint8Array = new Uint8Array(DEFAULT_ACTIVE_PALETTE);
let selectedSlot = 1; // start on the second active slot (first is usually black)
let tool: "pixel" | "erase" | "fill" = "pixel";
let painting = false;
let strokeSnapshot: Bitmap | null = null;
let strokeDirty = false;
let playing = false;
let playTimer: ReturnType<typeof setInterval> | null = null;
let frameBeforePlay = 0;
let clipboard: Bitmap | null = null;
const history = new History();
let localId: string | null = null;
const PLAY_DELAY_MS = 200;

// -- DOM setup --------------------------------------------------------------

const app = document.getElementById("app")!;
app.innerHTML = /* html */ `
  <header>
    <h1>Draw!</h1>
    <nav>
      <a href="${import.meta.env.BASE_URL}gallery.html">gallery</a>
    </nav>
  </header>
  <main>
    <section class="stage">
      <canvas id="main" aria-label="drawing canvas"></canvas>
      <div class="tools">
        <div class="tool-group">
          <button data-tool="pixel" class="on sprite-btn sprite-pencil" title="pencil" aria-label="pencil"></button>
          <button data-tool="erase" class="sprite-btn sprite-erase" title="erase" aria-label="erase"></button>
          <button data-tool="fill" class="sprite-btn sprite-fill" title="fill" aria-label="fill"></button>
        </div>
        <div class="tool-group">
          <button data-action="undo" class="sprite-btn sprite-undo" title="undo" aria-label="undo"></button>
          <button data-action="clear" class="sprite-btn sprite-clear" title="clear" aria-label="clear"></button>
        </div>
        <div class="tool-group">
          <button data-action="flip-h" class="sprite-btn sprite-flip-h" title="flip horizontal" aria-label="flip horizontal"></button>
          <button data-action="flip-v" class="sprite-btn sprite-flip-v" title="flip vertical" aria-label="flip vertical"></button>
          <button data-action="rotate" class="sprite-btn sprite-rotate" title="rotate" aria-label="rotate"></button>
        </div>
        <div class="tool-group">
          <button data-action="shift-right" class="sprite-btn sprite-shift-right" title="shift right" aria-label="shift right"></button>
          <button data-action="shift-up" class="sprite-btn sprite-shift-up" title="shift up" aria-label="shift up"></button>
        </div>
      </div>
      <div id="palette" class="palette" role="toolbar" aria-label="active palette"></div>
      <button data-action="edit-color" class="text-btn" title="change color of selected slot">edit color</button>
    </section>
    <section class="frames">
      <h2>frames</h2>
      <div id="frameList"></div>
      <div class="frame-actions">
        <button data-action="add-frame" class="text-btn" title="add frame">+ frame</button>
        <button data-action="delete-frame" class="text-btn" title="delete current frame">− frame</button>
        <button data-action="copy-frame" class="sprite-btn sprite-copy" title="copy current frame" aria-label="copy"></button>
        <button data-action="paste-frame" class="sprite-btn sprite-paste" title="paste into current frame" aria-label="paste"></button>
        <button data-action="play" class="sprite-btn sprite-play" id="playBtn" title="play animation" aria-label="play"></button>
      </div>
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
    <form method="dialog">
      <menu>
        <button value="cancel">cancel</button>
      </menu>
    </form>
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
  mainCanvas.draw(state.frames[state.current], activePaletteToRgb(activePalette));
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
  state.frames.forEach((frame, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "frame" + (idx === state.current ? " selected" : "");
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
    wrap.addEventListener("click", () => {
      stopPlay();
      state.current = idx;
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
  const frameIdx = state.current;
  const b = state.frames[frameIdx];
  const value = tool === "erase" ? TRANSPARENT : selectedSlot;
  if (tool === "fill") {
    const before = fillArea(b, x, y, value);
    if (before) {
      history.push(() => {
        state.frames[frameIdx] = before;
        state.current = Math.min(frameIdx, state.frames.length - 1);
        render();
      });
      strokeDirty = true;
    }
  } else {
    const prev = drawPixel(b, x, y, value);
    if (prev !== null) strokeDirty = true;
  }
  render();
}

function beginStroke(): void {
  strokeSnapshot = state.frames[state.current].clone();
  strokeDirty = false;
}

function endStroke(): void {
  if (strokeDirty && strokeSnapshot && tool !== "fill") {
    const snapshot = strokeSnapshot;
    const frameIdx = state.current;
    history.push(() => {
      state.frames[frameIdx] = snapshot;
      state.current = Math.min(frameIdx, state.frames.length - 1);
      render();
    });
  }
  strokeSnapshot = null;
  strokeDirty = false;
  persist();
}

function handleTransform(f: (b: Bitmap) => void): void {
  stopPlay();
  const frameIdx = state.current;
  const before = state.frames[frameIdx].clone();
  f(state.frames[frameIdx]);
  history.push(() => {
    state.frames[frameIdx] = before;
    state.current = Math.min(frameIdx, state.frames.length - 1);
    render();
  });
  render();
  persist();
}

function addFrame(): void {
  stopPlay();
  const undo = addFrameOp(state, MAX_FRAMES);
  if (!undo) {
    flashStatus(`max ${MAX_FRAMES} frames`);
    return;
  }
  history.push(() => {
    undo();
    render();
  });
  render();
  persist();
}

function copyFrame(): void {
  clipboard = state.frames[state.current].clone();
  flashStatus(`copied frame ${state.current + 1}`);
}

function pasteFrame(): void {
  stopPlay();
  if (!clipboard) {
    flashStatus("nothing to paste — copy a frame first");
    return;
  }
  const undo = pasteIntoCurrent(state, clipboard);
  history.push(() => {
    undo();
    render();
  });
  render();
  persist();
}

function deleteCurrentFrame(): void {
  stopPlay();
  const undo = removeCurrentFrame(state);
  if (!undo) {
    flashStatus("can't delete the only frame");
    return;
  }
  history.push(() => {
    undo();
    render();
  });
  render();
  persist();
}

function clearAllFrames(): void {
  if (!confirm("Clear everything? All frames and undo history will be lost.")) return;
  stopPlay();
  state.frames = [new Bitmap()];
  state.current = 0;
  history.clear();
  render();
  persist();
}

function togglePlay(): void {
  if (playing) stopPlay();
  else startPlay();
}

function startPlay(): void {
  if (playing) return;
  if (state.frames.length < 2) {
    flashStatus("add a second frame to play");
    return;
  }
  if (playTimer !== null) {
    clearInterval(playTimer);
    playTimer = null;
  }
  playing = true;
  frameBeforePlay = state.current;
  state.current = 0;
  render();
  updatePlayButton();
  playTimer = setInterval(() => {
    state.current = (state.current + 1) % state.frames.length;
    renderPlayTick();
  }, PLAY_DELAY_MS);
}

function renderPlayTick(): void {
  mainCanvas.draw(state.frames[state.current], activePaletteToRgb(activePalette));
  frameListEl.querySelectorAll<HTMLElement>(".frame").forEach((w, i) => {
    w.classList.toggle("selected", i === state.current);
  });
}

function stopPlay(): void {
  if (playTimer !== null) {
    clearInterval(playTimer);
    playTimer = null;
  }
  if (!playing) return;
  playing = false;
  state.current = Math.min(frameBeforePlay, state.frames.length - 1);
  render();
  updatePlayButton();
}

function updatePlayButton(): void {
  const btn = document.getElementById("playBtn");
  if (!btn) return;
  btn.classList.toggle("sprite-play", !playing);
  btn.classList.toggle("sprite-stop", playing);
  btn.setAttribute("aria-label", playing ? "stop" : "play");
  btn.setAttribute("title", playing ? "stop animation" : "play animation");
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
  const gif = encodeGif({ frames: state.frames, activePalette });
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
    statusEl.innerHTML = "";
    statusEl.appendChild(document.createTextNode("published: "));
    const link = document.createElement("a");
    link.href = result.share_url;
    link.textContent = result.share_url;
    link.target = "_blank";
    link.rel = "noopener";
    statusEl.appendChild(link);
    statusEl.appendChild(
      document.createTextNode(` (${result.required_bits} bits in ${result.solve_ms}ms)`),
    );
    if (localId) {
      await local.save({
        id: localId,
        frames: state.frames,
        activePalette,
        publishedId: result.id,
      });
    }
  } catch (err) {
    setStatus(`publish failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function downloadGif(): void {
  const bytes = encodeGif({ frames: state.frames, activePalette });
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
  const hash = encodeShare({ frames: state.frames, activePalette });
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
  local.save({ id: localId, frames: state.frames, activePalette }).catch(() => {});
}

// -- Events -----------------------------------------------------------------

function pointerToPixel(ev: PointerEvent): { x: number; y: number } {
  return mainCanvas.quantize(ev.clientX, ev.clientY);
}

mainCanvasEl.addEventListener("pointerdown", (ev) => {
  if (playing) return;
  ev.preventDefault();
  painting = true;
  beginStroke();
  const { x, y } = pointerToPixel(ev);
  applyTool(x, y);
});
window.addEventListener("pointermove", (ev) => {
  if (!painting) return;
  const { x, y } = pointerToPixel(ev);
  applyTool(x, y);
});
window.addEventListener("pointerup", () => {
  if (!painting) return;
  painting = false;
  endStroke();
});
window.addEventListener("pointercancel", () => {
  if (!painting) return;
  painting = false;
  endStroke();
});

document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) =>
  b.addEventListener("click", () => setActiveTool(b.dataset.tool as typeof tool)),
);

document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((b) =>
  b.addEventListener("click", () => {
    switch (b.dataset.action) {
      case "undo": history.undo(); render(); break;
      case "clear": clearAllFrames(); break;
      case "flip-h": handleTransform(flipHorizontal); break;
      case "flip-v": handleTransform(flipVertical); break;
      case "rotate": handleTransform(rotateLeft); break;
      case "shift-right": handleTransform(shiftRight); break;
      case "shift-up": handleTransform(shiftUp); break;
      case "add-frame": addFrame(); break;
      case "delete-frame": deleteCurrentFrame(); break;
      case "copy-frame": copyFrame(); break;
      case "paste-frame": pasteFrame(); break;
      case "play": togglePlay(); break;
      case "edit-color": openPickerForSlot(selectedSlot); break;
      case "export-gif": stopPlay(); downloadGif(); break;
      case "share": stopPlay(); copyShareLink(); break;
      case "publish": stopPlay(); void handlePublish(); break;
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
      state.frames = decoded.frames;
      if (decoded.activePalette) activePalette = decoded.activePalette;
      state.current = 0;
    } catch (err) {
      setStatus(`fork failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (hash) {
    try {
      const d = decodeShare(hash);
      state.frames = d.frames;
      activePalette = d.activePalette;
      state.current = 0;
    } catch (err) {
      setStatus(`invalid share link: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  render();
}

void boot();
