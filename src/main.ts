import { MAX_FRAMES } from "../config/constants.js";
import { Bitmap, TRANSPARENT } from "./editor/bitmap.js";
import { PixelCanvas } from "./editor/canvas.js";
import { decodeGif, encodeGif } from "./editor/gif.js";
import { History } from "./editor/history.js";
import {
  addFrame as addFrameOp,
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
import {
  exportIdentity,
  generateIdentity,
  importIdentity,
  pubKeyHex,
  type ExportedIdentity,
} from "./identity.js";
import {
  loadStoredIdentity,
  saveStoredIdentity,
  type StoredIdentity,
} from "./identity-store.js";
import { MissingIdentityError, submit } from "./submit.js";

// Native resolution of the main canvas. 16×35 = 560 — matches the v2
// editor's max wrap width, so CSS scaling produces clean pixel boundaries.
const MAIN_PIXEL_SIZE = 35;
const FRAME_THUMB_PIXEL_SIZE = 5;

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
let selectedSlot = 1;
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
let lastPublishedId: string | null = null;
let identity: StoredIdentity | null = null;
let onion = false;
// GIF playback is locked at 5 fps (200 ms/frame) — matches the encoded
// delay, so previewing in the editor looks the same as the rendered GIF.
const FPS = 5;
const PLAY_DELAY_MS = 1000 / FPS;

// -- Tool icon SVGs (placeholder — will be replaced) ------------------------
// 16×16 viewBox, fill=currentColor. The user plans to swap these later;
// they live inline so the editor doesn't add a sprite-sheet asset request.
const ICON = {
  pencil: `<svg width="18" height="18" viewBox="0 0 16 16"><g fill="currentColor"><rect x="10" y="2" width="2" height="2"/><rect x="8" y="4" width="2" height="2"/><rect x="6" y="6" width="2" height="2"/><rect x="4" y="8" width="2" height="2"/><rect x="2" y="10" width="2" height="2"/><rect x="2" y="12" width="3" height="2"/><rect x="12" y="4" width="2" height="2"/></g></svg>`,
  eraser: `<svg width="18" height="18" viewBox="0 0 16 16"><g fill="currentColor"><rect x="3" y="3" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"/><rect x="8" y="8" width="5" height="5"/></g></svg>`,
  fill: `<svg width="18" height="18" viewBox="0 0 16 16"><g fill="currentColor"><rect x="2" y="2" width="12" height="2"/><rect x="2" y="12" width="12" height="2"/><rect x="2" y="2" width="2" height="12"/><rect x="12" y="2" width="2" height="12"/><rect x="6" y="6" width="4" height="4"/></g></svg>`,
  undo: `<svg width="18" height="18" viewBox="0 0 16 16"><g fill="currentColor"><rect x="2" y="6" width="2" height="2"/><rect x="4" y="4" width="2" height="2"/><rect x="6" y="2" width="2" height="2"/><rect x="4" y="6" width="2" height="2"/><rect x="6" y="6" width="2" height="2"/><rect x="8" y="6" width="2" height="2"/><rect x="10" y="6" width="2" height="2"/><rect x="12" y="8" width="2" height="4"/><rect x="10" y="12" width="2" height="2"/></g></svg>`,
  clear: `<svg width="18" height="18" viewBox="0 0 16 16"><g fill="currentColor"><rect x="3" y="3" width="2" height="2"/><rect x="11" y="3" width="2" height="2"/><rect x="3" y="11" width="2" height="2"/><rect x="11" y="11" width="2" height="2"/><rect x="5" y="5" width="2" height="2"/><rect x="9" y="5" width="2" height="2"/><rect x="5" y="9" width="2" height="2"/><rect x="9" y="9" width="2" height="2"/><rect x="7" y="7" width="2" height="2"/></g></svg>`,
  flipH: `<svg width="18" height="18" viewBox="0 0 16 16"><g fill="currentColor"><rect x="2" y="2" width="5" height="12" fill="none" stroke="currentColor" stroke-width="1"/><rect x="9" y="2" width="5" height="12" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2 1"/><rect x="7" y="0" width="2" height="16"/></g></svg>`,
  flipV: `<svg width="18" height="18" viewBox="0 0 16 16"><g fill="currentColor"><rect x="2" y="2" width="12" height="5" fill="none" stroke="currentColor" stroke-width="1"/><rect x="2" y="9" width="12" height="5" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2 1"/><rect x="0" y="7" width="16" height="2"/></g></svg>`,
  rotate: `<svg width="18" height="18" viewBox="0 0 16 16"><g fill="currentColor"><rect x="4" y="2" width="6" height="2"/><rect x="10" y="4" width="2" height="2"/><rect x="12" y="6" width="2" height="6"/><rect x="10" y="12" width="2" height="2"/><rect x="4" y="12" width="6" height="2"/><rect x="2" y="6" width="2" height="4"/><rect x="4" y="10" width="2" height="2"/></g></svg>`,
  shiftX: `<svg width="18" height="18" viewBox="0 0 16 16"><g fill="currentColor"><rect x="2" y="7" width="12" height="2"/><rect x="0" y="5" width="2" height="6"/><rect x="14" y="5" width="2" height="6"/></g></svg>`,
  shiftY: `<svg width="18" height="18" viewBox="0 0 16 16"><g fill="currentColor"><rect x="7" y="2" width="2" height="12"/><rect x="5" y="0" width="6" height="2"/><rect x="5" y="14" width="6" height="2"/></g></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="6" y="2" width="2" height="10"/><rect x="2" y="6" width="10" height="2"/></g></svg>`,
  copy: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="2"/><rect x="5" y="5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="2"/></g></svg>`,
  paste: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="3" y="1" width="8" height="2"/><rect x="2" y="3" width="10" height="9" fill="none" stroke="currentColor" stroke-width="2"/></g></svg>`,
  trash: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="2" y="3" width="10" height="2"/><rect x="5" y="1" width="4" height="2"/><rect x="3" y="5" width="2" height="8"/><rect x="9" y="5" width="2" height="8"/><rect x="6" y="5" width="2" height="8"/></g></svg>`,
  play: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="3" y="2" width="2" height="10"/><rect x="5" y="3" width="2" height="8"/><rect x="7" y="4" width="2" height="6"/><rect x="9" y="5" width="2" height="4"/><rect x="11" y="6" width="1" height="2"/></g></svg>`,
  pause: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="3" y="2" width="3" height="10"/><rect x="8" y="2" width="3" height="10"/></g></svg>`,
  download: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="6" y="1" width="2" height="7"/><rect x="4" y="6" width="2" height="2"/><rect x="2" y="4" width="2" height="2"/><rect x="8" y="6" width="2" height="2"/><rect x="10" y="4" width="2" height="2"/><rect x="1" y="11" width="12" height="2"/></g></svg>`,
  share: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="2" y="6" width="2" height="2"/><rect x="10" y="2" width="2" height="2"/><rect x="10" y="10" width="2" height="2"/><rect x="4" y="5" width="2" height="2"/><rect x="6" y="4" width="2" height="2"/><rect x="8" y="3" width="2" height="2"/><rect x="4" y="7" width="2" height="2"/><rect x="6" y="8" width="2" height="2"/><rect x="8" y="9" width="2" height="2"/></g></svg>`,
  publish: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="6" y="2" width="2" height="8"/><rect x="4" y="4" width="2" height="2"/><rect x="2" y="6" width="2" height="2"/><rect x="8" y="4" width="2" height="2"/><rect x="10" y="6" width="2" height="2"/><rect x="1" y="11" width="12" height="2"/></g></svg>`,
  cart: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="1" y="2" width="2" height="2"/><rect x="3" y="4" width="2" height="6"/><rect x="5" y="4" width="6" height="2"/><rect x="9" y="6" width="2" height="2"/><rect x="7" y="8" width="2" height="2"/><rect x="5" y="10" width="2" height="2"/><rect x="9" y="10" width="2" height="2"/></g></svg>`,
  key: `<svg width="14" height="14" viewBox="0 0 14 14"><g fill="currentColor"><rect x="2" y="4" width="4" height="4" fill="none" stroke="currentColor" stroke-width="2"/><rect x="6" y="5" width="6" height="2"/><rect x="9" y="7" width="2" height="2"/><rect x="11" y="7" width="2" height="3"/></g></svg>`,
};

// -- DOM setup --------------------------------------------------------------

const app = document.getElementById("app")!;
app.innerHTML = /* html */ `
  <main>
    <div class="ed-actions">
      <button class="btn" data-action="export-gif">${ICON.download} Download GIF</button>
      <button class="btn" data-action="share">${ICON.share} Copy share link</button>
      ${PUBLISH_DISABLED ? "" : `<button class="btn" data-action="publish">${ICON.publish} Publish</button>`}
      <button class="btn primary" data-action="make-merch" id="merchBtn" hidden>${ICON.cart} Make merch</button>
      <button class="btn ghost" data-action="open-identity" id="identityBtn" hidden>${ICON.key} Key</button>
    </div>

    <div class="ed-grid">
      <div class="ed-tools" role="toolbar" aria-label="Tools">
        <button class="btn icon ed-tool" data-tool="pixel" aria-pressed="true" title="Pencil" aria-label="Pencil">${ICON.pencil}</button>
        <button class="btn icon ed-tool" data-tool="erase" title="Eraser" aria-label="Eraser">${ICON.eraser}</button>
        <button class="btn icon ed-tool" data-tool="fill" title="Fill" aria-label="Fill">${ICON.fill}</button>
        <button class="btn icon ed-tool" data-action="undo" title="Undo" aria-label="Undo">${ICON.undo}</button>
        <button class="btn icon ed-tool" data-action="clear" title="Clear" aria-label="Clear">${ICON.clear}</button>
        <button class="btn icon ed-tool" data-action="flip-h" title="Flip horizontal" aria-label="Flip horizontal">${ICON.flipH}</button>
        <button class="btn icon ed-tool" data-action="flip-v" title="Flip vertical" aria-label="Flip vertical">${ICON.flipV}</button>
        <button class="btn icon ed-tool" data-action="rotate" title="Rotate" aria-label="Rotate">${ICON.rotate}</button>
        <button class="btn icon ed-tool" data-action="shift-right" title="Shift X" aria-label="Shift X">${ICON.shiftX}</button>
        <button class="btn icon ed-tool" data-action="shift-up" title="Shift Y" aria-label="Shift Y">${ICON.shiftY}</button>
      </div>

      <div class="ed-center">
        <div class="ed-canvas-wrap">
          <canvas id="main" class="ed-canvas" aria-label="drawing canvas"></canvas>
        </div>
        <div class="ed-palette-wrap">
          <div id="palette" class="ed-palette" role="toolbar" aria-label="Active palette"></div>
          <button class="btn sm ed-edit-color" data-action="edit-color" title="Edit color of selected slot">Edit</button>
        </div>
      </div>
    </div>

    <div class="ed-frames">
      <div class="ed-frames-head">
        <span class="panel-h" id="framesHeading">Frames — 1</span>
        <div class="ed-frames-meta">
          <button class="btn xs" data-action="copy-frame" title="Copy current frame">${ICON.copy}<span style="margin-left:6px">Copy</span></button>
          <button class="btn xs" data-action="paste-frame" id="pasteBtn" title="Paste copied frame as a new frame" disabled>${ICON.paste}<span style="margin-left:6px">Paste</span></button>
          <button class="btn xs" data-action="toggle-onion" id="onionBtn" aria-pressed="false" title="Onion skin (preview previous frame)">Onion</button>
          <button class="btn xs" data-action="play" id="playBtn" title="Play animation">${ICON.play}<span style="margin-left:6px">Play</span></button>
        </div>
      </div>
      <div id="frameList" class="ed-frames-strip"></div>
    </div>

    <p id="status">${PUBLISH_DISABLED ? "Demo mode — draw, export a GIF, or copy a share link." : ""}</p>
  </main>

  <dialog id="palettePicker">
    <p>Pick a color from the 256-color base palette</p>
    <div id="baseGrid"></div>
    <form method="dialog">
      <menu>
        <button value="cancel">Cancel</button>
      </menu>
    </form>
  </dialog>
  <dialog id="identityBootstrap" class="identity-dialog">
    <h2>Set up your key</h2>
    <p>
      Drawbang signs every drawing with a keypair so your work groups under
      its own owner page. Generate a fresh one, or import a key you've used
      before.
    </p>
    <div class="identity-actions">
      <button class="btn primary" id="identityGenerateBtn" data-action="identity-generate">Generate new keypair</button>
      <label class="identity-import-label">
        Import existing keypair
        <input type="file" id="identityBootstrapImport" accept="application/json,.json" hidden>
      </label>
    </div>
    <p id="identityBootstrapError" class="identity-error" hidden></p>
  </dialog>
  <dialog id="identitySettings" class="identity-dialog">
    <h2>Your key</h2>
    <p class="muted">Drawings you publish are signed with this keypair.</p>
    <div class="identity-pubkey">
      <code id="identityPubkey"></code>
      <button class="btn xs" id="identityCopyBtn" data-action="identity-copy" title="Copy pubkey">Copy</button>
    </div>
    <div class="identity-actions">
      <button class="btn" data-action="identity-download">Download keypair (JSON)</button>
      <label class="identity-import-label">
        Import another keypair
        <input type="file" id="identitySettingsImport" accept="application/json,.json" hidden>
      </label>
      <button class="btn identity-danger" data-action="identity-regenerate">Generate a new keypair</button>
    </div>
    <p id="identitySettingsError" class="identity-error" hidden></p>
    <form method="dialog">
      <menu>
        <button value="close">Close</button>
      </menu>
    </form>
  </dialog>
`;

const mainCanvasEl = document.getElementById("main") as HTMLCanvasElement;
const mainCanvas = new PixelCanvas(mainCanvasEl, {
  pixelSize: MAIN_PIXEL_SIZE,
  showGrid: true,
  gridColor: "#1f1d1a",
});
const frameListEl = document.getElementById("frameList")!;
const paletteEl = document.getElementById("palette")!;
const statusEl = document.getElementById("status")!;
const picker = document.getElementById("palettePicker") as HTMLDialogElement;
const baseGridEl = document.getElementById("baseGrid")!;
const merchBtnEl = document.getElementById("merchBtn") as HTMLButtonElement | null;
const identityBtnEl = document.getElementById("identityBtn") as HTMLButtonElement | null;
const identityBootstrapEl = document.getElementById("identityBootstrap") as HTMLDialogElement | null;
const identityBootstrapImportEl = document.getElementById("identityBootstrapImport") as HTMLInputElement | null;
const identityBootstrapErrorEl = document.getElementById("identityBootstrapError") as HTMLParagraphElement | null;
const identitySettingsEl = document.getElementById("identitySettings") as HTMLDialogElement | null;
const identitySettingsImportEl = document.getElementById("identitySettingsImport") as HTMLInputElement | null;
const identitySettingsErrorEl = document.getElementById("identitySettingsError") as HTMLParagraphElement | null;
const identityPubkeyEl = document.getElementById("identityPubkey") as HTMLElement | null;
const framesHeadingEl = document.getElementById("framesHeading")!;
const onionBtnEl = document.getElementById("onionBtn") as HTMLButtonElement;
const playBtnEl = document.getElementById("playBtn") as HTMLButtonElement;
const pasteBtnEl = document.getElementById("pasteBtn") as HTMLButtonElement;

function renderIdentityBadge(): void {
  if (identityBtnEl) identityBtnEl.hidden = identity === null;
}

function setBootstrapError(msg: string | null): void {
  if (!identityBootstrapErrorEl) return;
  if (msg) {
    identityBootstrapErrorEl.hidden = false;
    identityBootstrapErrorEl.textContent = msg;
  } else {
    identityBootstrapErrorEl.hidden = true;
    identityBootstrapErrorEl.textContent = "";
  }
}

function setSettingsError(msg: string | null): void {
  if (!identitySettingsErrorEl) return;
  if (msg) {
    identitySettingsErrorEl.hidden = false;
    identitySettingsErrorEl.textContent = msg;
  } else {
    identitySettingsErrorEl.hidden = true;
    identitySettingsErrorEl.textContent = "";
  }
}

function isValidJwk(jwk: unknown): jwk is JsonWebKey {
  if (!jwk || typeof jwk !== "object") return false;
  const j = jwk as { kty?: unknown; crv?: unknown };
  return j.kty === "OKP" && j.crv === "Ed25519";
}

function parseExportedIdentity(text: string): ExportedIdentity {
  const parsed = JSON.parse(text) as { jwk_public?: unknown; jwk_secret?: unknown };
  if (!isValidJwk(parsed.jwk_public)) {
    throw new Error("invalid public key (expected Ed25519 OKP JWK)");
  }
  if (!isValidJwk(parsed.jwk_secret)) {
    throw new Error("invalid secret key (expected Ed25519 OKP JWK)");
  }
  return { jwk_public: parsed.jwk_public, jwk_secret: parsed.jwk_secret };
}

async function persistGeneratedIdentity(): Promise<StoredIdentity> {
  const live = await generateIdentity();
  const exported = await exportIdentity(live);
  const pubkey_hex = await pubKeyHex(live);
  return { ...exported, pubkey_hex, created_at: Date.now() };
}

async function persistImportedIdentity(file: File): Promise<StoredIdentity> {
  const text = await file.text();
  const exported = parseExportedIdentity(text);
  const live = await importIdentity(exported);
  const pubkey_hex = await pubKeyHex(live);
  return { ...exported, pubkey_hex, created_at: Date.now() };
}

async function commitIdentityFromBootstrap(record: StoredIdentity): Promise<void> {
  const existing = await loadStoredIdentity();
  if (existing) {
    location.reload();
    return;
  }
  await saveStoredIdentity(record);
  identity = record;
  renderIdentityBadge();
  identityBootstrapEl?.close();
}

async function replaceIdentity(record: StoredIdentity): Promise<void> {
  await saveStoredIdentity(record);
  identity = record;
  renderIdentityBadge();
  renderIdentitySettings();
}

function renderIdentitySettings(): void {
  if (!identityPubkeyEl) return;
  identityPubkeyEl.textContent = identity?.pubkey_hex ?? "";
}

function openIdentitySettings(): void {
  if (!identitySettingsEl || !identity) return;
  setSettingsError(null);
  renderIdentitySettings();
  identitySettingsEl.showModal();
}

function openIdentityBootstrap(): void {
  if (!identityBootstrapEl) return;
  setBootstrapError(null);
  if (!identityBootstrapEl.open) identityBootstrapEl.showModal();
}

async function downloadIdentity(): Promise<void> {
  if (!identity) return;
  const payload: ExportedIdentity = {
    jwk_public: identity.jwk_public,
    jwk_secret: identity.jwk_secret,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `drawbang-identity-${identity.pubkey_hex.slice(0, 8)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyPubkey(): Promise<void> {
  if (!identity) return;
  try {
    await navigator.clipboard?.writeText(identity.pubkey_hex);
    setSettingsError(null);
  } catch {
    setSettingsError("Clipboard unavailable — select the value manually.");
  }
}

function setLastPublishedId(id: string | null): void {
  lastPublishedId = id;
  if (!merchBtnEl) return;
  merchBtnEl.hidden = id === null;
}

function openMerch(): void {
  if (!lastPublishedId) return;
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "/");
  const frame = state.current;
  location.assign(
    `${base}merch?d=${encodeURIComponent(lastPublishedId)}&frame=${frame}`,
  );
}

// -- Rendering --------------------------------------------------------------

function onionFrame(): Bitmap | null {
  if (!onion || playing || state.frames.length < 2) return null;
  const prev = (state.current - 1 + state.frames.length) % state.frames.length;
  return state.frames[prev];
}

function render(): void {
  const palette = activePaletteToRgb(activePalette);
  mainCanvas.draw(state.frames[state.current], palette, onionFrame());
  renderFrameStrip();
  renderPalette();
  framesHeadingEl.textContent = `Frames — ${state.frames.length}`;
}

function renderPalette(): void {
  paletteEl.innerHTML = "";
  const hex = activePaletteToHex(activePalette);
  for (let i = 0; i < activePalette.length; i++) {
    const b = document.createElement("button");
    b.className = "ed-swatch" + (i === selectedSlot ? " selected" : "");
    b.style.backgroundColor = hex[i];
    b.title = `Slot ${i} — right-click to change color`;
    b.dataset.slot = String(i);
    b.setAttribute("aria-label", `Color ${hex[i]}`);
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
    wrap.className = "ed-frame" + (idx === state.current ? " selected" : "");
    wrap.dataset.frameIndex = String(idx);
    const cv = document.createElement("canvas");
    const preview = new PixelCanvas(cv, {
      pixelSize: FRAME_THUMB_PIXEL_SIZE,
      showGrid: false,
      gridColor: "",
    });
    preview.draw(frame, palette);
    wrap.appendChild(cv);
    const label = document.createElement("span");
    label.className = "ed-frame-num";
    label.textContent = String(idx + 1);
    wrap.appendChild(label);
    if (idx === state.current && state.frames.length > 1) {
      const actions = document.createElement("div");
      actions.className = "ed-frame-actions";
      const del = document.createElement("button");
      del.className = "btn xs ghost";
      del.title = "Delete frame";
      del.innerHTML = ICON.trash;
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteFrameAt(idx);
      });
      actions.appendChild(del);
      wrap.appendChild(actions);
    }
    wrap.addEventListener("click", () => {
      stopPlay();
      state.current = idx;
      render();
    });
    frameListEl.appendChild(wrap);
  });
  const add = document.createElement("button");
  add.className = "ed-frame ed-frame-add";
  add.title = "Add frame";
  add.setAttribute("aria-label", "Add frame");
  add.innerHTML = ICON.plus;
  add.addEventListener("click", () => addFrame());
  frameListEl.appendChild(add);
}

// -- Tools ------------------------------------------------------------------

function setActiveTool(next: "pixel" | "erase" | "fill"): void {
  tool = next;
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.tool === next ? "true" : "false");
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
    flashStatus(`Max ${MAX_FRAMES} frames.`);
    return;
  }
  history.push(() => {
    undo();
    render();
  });
  render();
  persist();
}

function deleteFrameAt(idx: number): void {
  stopPlay();
  if (state.frames.length <= 1) {
    flashStatus("Can't delete the only frame.");
    return;
  }
  const before = { frames: state.frames.slice(), current: state.current };
  state.frames.splice(idx, 1);
  state.current = Math.min(state.current, state.frames.length - 1);
  history.push(() => {
    state.frames = before.frames;
    state.current = Math.min(before.current, state.frames.length - 1);
    render();
  });
  render();
  persist();
}

function copyFrame(): void {
  clipboard = state.frames[state.current].clone();
  pasteBtnEl.disabled = false;
  flashStatus(`Copied frame ${state.current + 1}.`);
}

// Inserts the clipboard as a new frame after the current one. The original
// "paste into current" behaviour from v1 is gone — too easy to clobber work.
function pasteAsNewFrame(): void {
  stopPlay();
  if (!clipboard) {
    flashStatus("Nothing to paste — copy a frame first.");
    return;
  }
  if (state.frames.length >= MAX_FRAMES) {
    flashStatus(`Max ${MAX_FRAMES} frames.`);
    return;
  }
  const insertAt = state.current + 1;
  const before = { frames: state.frames.slice(), current: state.current };
  state.frames.splice(insertAt, 0, clipboard.clone());
  state.current = insertAt;
  history.push(() => {
    state.frames = before.frames;
    state.current = Math.min(before.current, state.frames.length - 1);
    render();
  });
  render();
  persist();
}

function resetEditor(opts: { keepPublishedId?: boolean } = {}): void {
  stopPlay();
  state.frames = [new Bitmap()];
  state.current = 0;
  history.clear();
  localId = null;
  if (!opts.keepPublishedId) setLastPublishedId(null);
  render();
  persist();
}

function clearAllFrames(): void {
  if (!confirm("Clear everything? All frames and undo history will be lost.")) return;
  resetEditor();
}

function togglePlay(): void {
  if (playing) stopPlay();
  else startPlay();
}

function startPlay(): void {
  if (playing) return;
  if (state.frames.length < 2) {
    flashStatus("Add a second frame to play.");
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
  const palette = activePaletteToRgb(activePalette);
  mainCanvas.draw(state.frames[state.current], palette);
  frameListEl
    .querySelectorAll<HTMLElement>(".ed-frame:not(.ed-frame-add)")
    .forEach((w, i) => {
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
  if (!playBtnEl) return;
  playBtnEl.innerHTML = playing
    ? `${ICON.pause}<span style="margin-left:6px">Pause</span>`
    : `${ICON.play}<span style="margin-left:6px">Play</span>`;
  playBtnEl.setAttribute("aria-pressed", playing ? "true" : "false");
  playBtnEl.setAttribute("title", playing ? "Pause animation" : "Play animation");
}

function setOnion(next: boolean): void {
  onion = next;
  onionBtnEl.setAttribute("aria-pressed", onion ? "true" : "false");
  render();
}

// -- Palette picker ---------------------------------------------------------

let pickerTargetSlot = -1;
const baseCellEls: HTMLButtonElement[] = [];

function buildBaseGrid(): void {
  baseGridEl.innerHTML = "";
  baseCellEls.length = 0;
  BASE_PALETTE.forEach(([r, g, b], idx) => {
    const cell = document.createElement("button");
    cell.className = "base-cell";
    cell.style.backgroundColor = `rgb(${r},${g},${b})`;
    cell.title = `Base #${idx}`;
    cell.dataset.baseIdx = String(idx);
    cell.addEventListener("click", () => {
      if (pickerTargetSlot < 0) return;
      const slot = pickerTargetSlot;
      const prevIdx = activePalette[slot];
      if (idx === prevIdx) {
        picker.close();
        return;
      }
      activePalette[slot] = idx;
      history.push(() => {
        activePalette[slot] = prevIdx;
        render();
        persist();
      });
      picker.close();
      render();
      persist();
    });
    baseGridEl.appendChild(cell);
    baseCellEls.push(cell);
  });
}

function highlightPickerCurrent(slot: number): void {
  const current = activePalette[slot];
  for (let i = 0; i < baseCellEls.length; i++) {
    baseCellEls[i].classList.toggle("current", i === current);
  }
}

function openPickerForSlot(slot: number): void {
  pickerTargetSlot = slot;
  highlightPickerCurrent(slot);
  picker.showModal();
  // Without explicit focus, browsers autofocus the first child (top-left
  // swatch) and stamp a default focus ring over it — visually rivaling
  // the "current" accent highlight on a different cell. Park focus on
  // the current cell instead so the two indicators merge.
  baseCellEls[activePalette[slot]]?.focus();
}

// -- Publishing / export ----------------------------------------------------

async function handlePublish(): Promise<void> {
  const gif = encodeGif({ frames: state.frames, activePalette });
  setStatus("Starting proof of work…");
  try {
    const result = await submit({
      ingestUrl: INGEST_URL,
      stateUrl: STATE_URL,
      gif,
      onPhase: (phase, detail) => setStatus(`${phase}: ${detail}`),
      onProgress: (p) => {
        const rate = (p.hashes / Math.max(1, p.elapsedMs / 1000)).toFixed(0);
        setStatus(`Solving… ${p.hashes.toLocaleString()} hashes (${rate}/s)`);
      },
    });
    statusEl.innerHTML = "";
    statusEl.appendChild(document.createTextNode("Published: "));
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
    setLastPublishedId(result.id);
    resetEditor({ keepPublishedId: true });
  } catch (err) {
    if (err instanceof MissingIdentityError) {
      setStatus("Set up your key before publishing.");
      openIdentityBootstrap();
      return;
    }
    setStatus(`Publish failed: ${err instanceof Error ? err.message : String(err)}`);
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
  setStatus(`Share link copied (${hash.length} chars).`);
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
      case "copy-frame": copyFrame(); break;
      case "paste-frame": pasteAsNewFrame(); break;
      case "play": togglePlay(); break;
      case "toggle-onion": setOnion(!onion); break;
      case "edit-color": openPickerForSlot(selectedSlot); break;
      case "export-gif": stopPlay(); downloadGif(); break;
      case "share": stopPlay(); copyShareLink(); break;
      case "publish": stopPlay(); void handlePublish(); break;
      case "make-merch": stopPlay(); openMerch(); break;
      case "open-identity": openIdentitySettings(); break;
      case "identity-generate": void handleGenerateFromBootstrap(); break;
      case "identity-copy": void copyPubkey(); break;
      case "identity-download": void downloadIdentity(); break;
      case "identity-regenerate": void handleRegenerateFromSettings(); break;
    }
  }),
);

async function handleGenerateFromBootstrap(): Promise<void> {
  setBootstrapError(null);
  try {
    const record = await persistGeneratedIdentity();
    await commitIdentityFromBootstrap(record);
  } catch (err) {
    setBootstrapError(`Could not generate key: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleRegenerateFromSettings(): Promise<void> {
  if (!confirm(
    "Replace your current keypair? Drawings already published with the old key won't be affected, but new drawings will go to a new owner page.",
  )) {
    return;
  }
  setSettingsError(null);
  try {
    const record = await persistGeneratedIdentity();
    await replaceIdentity(record);
  } catch (err) {
    setSettingsError(`Could not generate key: ${err instanceof Error ? err.message : String(err)}`);
  }
}

identityBootstrapEl?.addEventListener("cancel", (ev) => {
  if (!identity) ev.preventDefault();
});

identityBootstrapImportEl?.addEventListener("change", async () => {
  const file = identityBootstrapImportEl.files?.[0];
  if (!file) return;
  setBootstrapError(null);
  try {
    const record = await persistImportedIdentity(file);
    await commitIdentityFromBootstrap(record);
  } catch (err) {
    setBootstrapError(`Could not import: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    identityBootstrapImportEl.value = "";
  }
});

identitySettingsImportEl?.addEventListener("change", async () => {
  const file = identitySettingsImportEl.files?.[0];
  if (!file) return;
  setSettingsError(null);
  try {
    if (!confirm(
      "Replace your current keypair? Drawings already published with the old key won't be affected, but new drawings will go to a new owner page.",
    )) {
      return;
    }
    const record = await persistImportedIdentity(file);
    await replaceIdentity(record);
  } catch (err) {
    setSettingsError(`Could not import: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    identitySettingsImportEl.value = "";
  }
});

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

  try {
    identity = await loadStoredIdentity();
  } catch {
    identity = null;
  }
  renderIdentityBadge();
  if (!identity && !PUBLISH_DISABLED) openIdentityBootstrap();

  const hash = location.hash.match(/#d=([A-Za-z0-9_-]+)/)?.[1];
  const forkId = new URL(location.href).searchParams.get("fork");

  if (forkId) {
    try {
      const res = await fetch(`${DRAWING_BASE_URL}/${forkId}.gif`);
      if (!res.ok) throw new Error(`fork fetch failed: ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const decoded = decodeGif(buf);
      state.frames = decoded.frames;
      if (decoded.activePalette) activePalette = decoded.activePalette;
      state.current = 0;
      setLastPublishedId(forkId);
    } catch (err) {
      setStatus(`Fork failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (hash) {
    try {
      const d = decodeShare(hash);
      state.frames = d.frames;
      activePalette = d.activePalette;
      state.current = 0;
    } catch (err) {
      setStatus(`Invalid share link: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  render();
}

void boot();
