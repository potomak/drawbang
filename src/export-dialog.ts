import type { tracker as Tracker } from "./analytics/analytics.js";
import { encodeGif } from "./editor/gif.js";
import { showFlash } from "./layout/flash.js";
import type { Bitmap } from "./editor/bitmap.js";
import type { OpLog } from "./editor/oplog.js";
import { replay } from "./editor/oplog-replay.js";
import {
  createSnapshotCompositor,
  createVideoCompositor,
  detectVideoSupport,
  encodeVideo,
  type EncodedVideo,
  type VideoEncodingFormat,
  type VideoPreset,
  type VideoSupport,
} from "./editor/video.js";

// Export-dialog controller. The dialog markup lives next to the
// palette-picker <dialog> in src/main.ts; this module owns capability
// detection (re-runs each open so plugged-in hardware encoders show up),
// the encode pipeline, Web Share Level 2 dispatch, and tracking.

export type ExportFormatKind = "gif" | "square" | "reels" | "timelapse";

export const FOOTER_LS_KEY = "drawbang:export-footer";

export interface ExportEditorSnapshot {
  frames: Bitmap[];
  activePalette: Uint8Array;
  delayMs: number;
  size: number;
  lastPublishedId: string | null;
  // Op log + flag for timelapse export. opLog is null for legacy drafts
  // and for fresh editors with no recorded actions; the timelapse option
  // is also disabled when the log was truncated (would drift mid-way).
  opLog: OpLog | null;
}

export interface ExportDialogConfig {
  dialog: HTMLDialogElement;
  optionsContainer: HTMLElement;
  footerCheckbox: HTMLInputElement;
  confirmButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  statusEl: HTMLElement;
  getSnapshot: () => ExportEditorSnapshot;
  tracker: typeof Tracker;
}

interface ResolvedOption {
  kind: ExportFormatKind;
  label: string;
  disabled: boolean;
  // What we'll actually produce when the user picks this option.
  produces:
    | { container: "gif" }
    | { container: "video"; format: VideoEncodingFormat; preset: VideoPreset }
    | { container: "timelapse"; format: VideoEncodingFormat };
}

export interface ResolveContext {
  support: VideoSupport;
  // For the timelapse option: how many ops are usable. Zero = no
  // recording yet; null = log was truncated (replay would drift).
  timelapseOpCount: number | null;
}

export function resolveOption(kind: ExportFormatKind, ctx: ResolveContext): ResolvedOption {
  const { support, timelapseOpCount } = ctx;
  if (kind === "gif") {
    return { kind, label: "GIF (looping)", disabled: false, produces: { container: "gif" } };
  }
  if (kind === "timelapse") {
    if (support.mp4.supported || support.webm.supported) {
      const format: VideoEncodingFormat = support.mp4.supported ? "mp4" : "webm";
      const container = format === "mp4" ? "MP4" : "WebM";
      const suffix = format === "webm" ? " (fallback)" : "";
      const disabled = timelapseOpCount === null || timelapseOpCount === 0;
      let label = `Timelapse — ${container} Square${suffix}`;
      if (timelapseOpCount === null) label += " — log was truncated";
      else if (timelapseOpCount === 0) label += " — draw something first";
      return {
        kind,
        label,
        disabled,
        produces: { container: "timelapse", format },
      };
    }
    return {
      kind,
      label: "Timelapse — unavailable in this browser",
      disabled: true,
      produces: { container: "timelapse", format: "mp4" },
    };
  }
  const preset: VideoPreset = kind === "square" ? "square" : "reels";
  const presetLabel = kind === "square" ? "Square (1080×1080)" : "Reels (1080×1920)";
  if (support.mp4.supported) {
    return {
      kind,
      label: `MP4 — ${presetLabel}`,
      disabled: false,
      produces: { container: "video", format: "mp4", preset },
    };
  }
  if (support.webm.supported) {
    return {
      kind,
      label: `WebM — ${presetLabel} (fallback)`,
      disabled: false,
      produces: { container: "video", format: "webm", preset },
    };
  }
  return {
    kind,
    label: `${presetLabel} — unavailable in this browser`,
    disabled: true,
    produces: { container: "video", format: "mp4", preset },
  };
}

export function exportFilename(snapshot: ExportEditorSnapshot, extension: string): string {
  const id = snapshot.lastPublishedId ?? "";
  const slug = id.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "draw";
  return `draw-${slug}.${extension}`;
}

export function exportShareCaption(): string {
  // Matches the in-product hashtag used in the daily-prompt copy. Adjust
  // here, not at each call site, so the social funnel stays consistent.
  return "Made with Draw! #draw16";
}

export function createExportDialog(cfg: ExportDialogConfig): { open: () => Promise<void>; close: () => void } {
  let lastSupport: VideoSupport | null = null;
  let inflight = false;

  cfg.footerCheckbox.checked = readFooterPreference();
  cfg.footerCheckbox.addEventListener("change", () => {
    writeFooterPreference(cfg.footerCheckbox.checked);
  });

  cfg.cancelButton.addEventListener("click", (ev) => {
    ev.preventDefault();
    cfg.dialog.close();
  });

  cfg.confirmButton.addEventListener("click", async (ev) => {
    ev.preventDefault();
    if (inflight) return;
    if (!lastSupport) return;
    const kindEl = cfg.optionsContainer.querySelector<HTMLInputElement>(
      'input[name="ed-export-format"]:checked',
    );
    if (!kindEl) return;
    const kind = kindEl.value as ExportFormatKind;
    const snapshot = cfg.getSnapshot();
    const option = resolveOption(kind, {
      support: lastSupport,
      timelapseOpCount: timelapseOpCountFromSnapshot(snapshot),
    });
    if (option.disabled) return;
    inflight = true;
    cfg.confirmButton.disabled = true;
    setStatus(cfg.statusEl, "Encoding…");
    try {
      const result = await runExport({
        snapshot,
        option,
        footer: cfg.footerCheckbox.checked,
        support: lastSupport,
      });
      const trackerFormat = trackerLabel(option.produces);
      cfg.tracker.videoExportClick({ format: trackerFormat, duration_s: result.durationS });
      const shared = await shareOrDownload(result.blob, result.filename);
      cfg.dialog.close();
      showFlash({
        kind: "success",
        message: shared ? "Shared!" : `Downloaded ${result.filename}`,
        autoDismissMs: 4000,
      });
    } catch (e) {
      showFlash({
        kind: "error",
        message: `Export failed: ${(e as Error).message}`,
        autoDismissMs: 6000,
      });
    } finally {
      inflight = false;
      cfg.confirmButton.disabled = false;
      setStatus(cfg.statusEl, "");
    }
  });

  function trackerLabel(produces: ResolvedOption["produces"]): string {
    if (produces.container === "gif") return "gif";
    if (produces.container === "timelapse") return `timelapse-${produces.format}`;
    return `${produces.format}-${produces.preset}`;
  }

  async function open(): Promise<void> {
    setStatus(cfg.statusEl, "Detecting encoders…");
    // Probe against the larger Reels canvas — anything that can encode
    // 1080×1920 trivially handles 1080×1080 too, so one check is enough.
    const support = await detectVideoSupport({ width: 1080, height: 1920 });
    lastSupport = support;
    const snapshot = cfg.getSnapshot();
    renderOptions(cfg.optionsContainer, {
      support,
      timelapseOpCount: timelapseOpCountFromSnapshot(snapshot),
    });
    setStatus(cfg.statusEl, "");
    cfg.dialog.showModal();
  }

  function close(): void {
    cfg.dialog.close();
  }

  return { open, close };
}

function renderOptions(container: HTMLElement, ctx: ResolveContext): void {
  const kinds: ExportFormatKind[] = ["gif", "square", "reels", "timelapse"];
  container.innerHTML = kinds
    .map((kind, i) => {
      const option = resolveOption(kind, ctx);
      const id = `ed-export-${kind}`;
      const disabled = option.disabled ? " disabled" : "";
      const checked = i === 0 ? " checked" : "";
      return `<label class="ed-export-option${option.disabled ? " is-disabled" : ""}">
  <input type="radio" name="ed-export-format" id="${id}" value="${kind}"${checked}${disabled} />
  <span class="ed-export-option-label">${option.label}</span>
</label>`;
    })
    .join("");
}

function timelapseOpCountFromSnapshot(snapshot: ExportEditorSnapshot): number | null {
  const log = snapshot.opLog;
  if (!log) return 0;
  if (log.truncated) return null;
  return log.ops.length;
}

function setStatus(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.hidden = text === "";
}

function readFooterPreference(): boolean {
  try {
    const raw = localStorage.getItem(FOOTER_LS_KEY);
    if (raw === null) return true; // default: include the wordmark
    return raw === "1";
  } catch {
    return true;
  }
}

function writeFooterPreference(value: boolean): void {
  try {
    localStorage.setItem(FOOTER_LS_KEY, value ? "1" : "0");
  } catch {
    // Private mode etc. — non-fatal.
  }
}

interface RunInput {
  snapshot: ExportEditorSnapshot;
  option: ResolvedOption;
  footer: boolean;
  support: VideoSupport;
}

interface RunResult {
  blob: Blob;
  filename: string;
  durationS: number;
}

async function runExport(input: RunInput): Promise<RunResult> {
  const { snapshot, option, footer, support } = input;
  if (option.produces.container === "gif") {
    const bytes = encodeGif({
      frames: snapshot.frames,
      activePalette: snapshot.activePalette,
      size: snapshot.size,
      delayMs: snapshot.delayMs,
    });
    const copy = new Uint8Array(bytes);
    return {
      blob: new Blob([copy as unknown as BlobPart], { type: "image/gif" }),
      filename: exportFilename(snapshot, "gif"),
      durationS: Math.round(((snapshot.frames.length * snapshot.delayMs) / 1000) * 10) / 10,
    };
  }
  if (option.produces.container === "timelapse") {
    if (!snapshot.opLog) throw new Error("timelapse: op log is empty");
    const timelapse = replay(snapshot.opLog, {
      size: snapshot.size,
      palette: snapshot.activePalette,
    });
    const compositor = createSnapshotCompositor({
      snapshots: timelapse.snapshots,
      activePalette: timelapse.palette,
      fps: timelapse.fps,
      preset: "square",
      footer,
    });
    const encoded: EncodedVideo = await encodeVideo({
      compositor,
      format: option.produces.format,
      support,
      drawingIdShort: snapshot.lastPublishedId ?? "timelapse",
    });
    return {
      blob: encoded.blob,
      filename: encoded.filename,
      durationS: Math.round((compositor.plan.durationMs / 1000) * 10) / 10,
    };
  }
  const compositor = createVideoCompositor({
    frames: snapshot.frames,
    activePalette: snapshot.activePalette,
    delayMs: snapshot.delayMs,
    preset: option.produces.preset,
    footer,
  });
  const encoded: EncodedVideo = await encodeVideo({
    compositor,
    format: option.produces.format,
    support,
    drawingIdShort: snapshot.lastPublishedId ?? "",
  });
  return {
    blob: encoded.blob,
    filename: encoded.filename,
    durationS: Math.round((compositor.plan.durationMs / 1000) * 10) / 10,
  };
}

async function shareOrDownload(blob: Blob, filename: string): Promise<boolean> {
  const nav = navigator as Navigator & {
    canShare?: (data: { files?: File[] }) => boolean;
  };
  if (typeof nav.canShare === "function" && typeof File === "function") {
    try {
      const file = new File([blob], filename, { type: blob.type });
      if (nav.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "Draw!",
          text: exportShareCaption(),
        });
        return true;
      }
    } catch (e) {
      // AbortError = the user dismissed the share sheet on purpose; treat
      // that as "they chose not to download either" and don't flash error.
      if ((e as { name?: string }).name === "AbortError") return false;
      // Any other share failure falls through to the download path.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return false;
}
