import { authHeader, getSession } from "./auth.js";
import type { LastPublishState, SolveProgress } from "./pow.js";
import {
  INITIAL_STATE,
  POW_CONFIG,
  ageSecondsBetween,
  contentHash,
  hashHex,
  requiredBits,
} from "./pow.js";
import { canonicalCanvasString, type CanvasManifest } from "../config/canvas.js";

export interface IngestResponse {
  id: string;
  share_url: string;
  required_bits: number;
  solve_ms: number;
}

export interface SubmitOptions {
  ingestUrl: string;
  stateUrl: string;
  gif: Uint8Array;
  parent?: string;
  onPhase?: (phase: "bench" | "solve", detail: string) => void;
  onProgress?: (p: SolveProgress) => void;
  signal?: AbortSignal;
}

export class MissingSessionError extends Error {
  constructor() {
    super("sign in to publish");
    this.name = "MissingSessionError";
  }
}

export async function submit(opts: SubmitOptions): Promise<IngestResponse> {
  // Surface the missing-session case before kicking off the worker so we
  // don't burn CPU on PoW that the server would reject anyway.
  const session = getSession();
  if (!session) throw new MissingSessionError();

  const state = await fetchState(opts.stateUrl);
  const ageS = Math.max(
    0,
    ageSecondsBetween(new Date().toISOString(), state.last_publish_at),
  );
  const bits = requiredBits(ageS);

  opts.onPhase?.("bench", "measuring hash rate");
  const worker = new Worker(new URL("./pow.worker.ts", import.meta.url), { type: "module" });
  try {
    const benchHps = await runWorker<number>(worker, { type: "bench", ms: 200 }, (msg) => {
      if (msg.type === "benchResult") return msg.hps;
    });

    opts.onPhase?.("solve", `${bits} bits, est ${estimateSolveSeconds(bits, benchHps).toFixed(1)}s`);

    const solved = await runWorker<{ nonce: string; hashHex: string; solveMs: number }>(
      worker,
      { type: "solve", gif: opts.gif, baseline: state.last_publish_at, bits },
      (msg) => {
        if (msg.type === "progress" && opts.onProgress) opts.onProgress(msg);
        if (msg.type === "done") return msg;
        if (msg.type === "error") throw new Error(msg.message);
      },
      opts.signal,
    );

    const res = await fetch(opts.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({
        gif: base64(opts.gif),
        nonce: solved.nonce,
        baseline: state.last_publish_at,
        solve_ms: solved.solveMs,
        bench_hps: benchHps,
        parent: opts.parent,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text();
      let parsed: { error?: string } = {};
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        // Non-JSON body (e.g., 405 text/plain) — fall through.
      }
      const msg = parsed.error ?? bodyText;
      if (res.status === 401) throw new MissingSessionError();
      throw new Error(`ingest rejected: ${res.status} ${msg}`);
    }
    return (await res.json()) as IngestResponse;
  } finally {
    worker.terminate();
  }
}

// -- Canvas publish (personal multi-tile drawing) ----------------------------

export interface CanvasCellInput {
  x: number;
  y: number;
  gif: Uint8Array;
}

export interface CanvasPublishResponse {
  canvas_id: string;
  tile_ids: string[];
  share_url: string;
}

export interface PublishCanvasOptions {
  canvasUrl: string; // POST /canvas
  stateUrl: string;
  cols: number;
  rows: number;
  cells: CanvasCellInput[]; // non-empty cells, each an encoded 16×16 gif
  parent?: string;
  onPhase?: (phase: "bench" | "solve", detail: string) => void;
  onProgress?: (p: SolveProgress) => void;
  signal?: AbortSignal;
}

export async function publishCanvas(
  opts: PublishCanvasOptions,
): Promise<CanvasPublishResponse> {
  const session = getSession();
  if (!session) throw new MissingSessionError();
  if (opts.cells.length === 0) throw new Error("nothing to publish");

  const state = await fetchState(opts.stateUrl);
  const ageS = Math.max(
    0,
    ageSecondsBetween(new Date().toISOString(), state.last_publish_at),
  );
  const bits = requiredBits(ageS);

  // Content-address each tile, then build the canonical manifest the PoW + the
  // server's canvas_id are computed over.
  const grid: (string | null)[] = Array(opts.cols * opts.rows).fill(null);
  for (const c of opts.cells) {
    grid[c.y * opts.cols + c.x] = hashHex(await contentHash(c.gif));
  }
  const manifest: CanvasManifest = { cols: opts.cols, rows: opts.rows, tiles: grid };
  const canonical = new TextEncoder().encode(canonicalCanvasString(manifest));

  opts.onPhase?.("bench", "measuring hash rate");
  const worker = new Worker(new URL("./pow.worker.ts", import.meta.url), { type: "module" });
  try {
    const benchHps = await runWorker<number>(worker, { type: "bench", ms: 200 }, (msg) => {
      if (msg.type === "benchResult") return msg.hps;
    });
    opts.onPhase?.("solve", `${bits} bits, est ${estimateSolveSeconds(bits, benchHps).toFixed(1)}s`);
    const solved = await runWorker<{ nonce: string; solveMs: number }>(
      worker,
      { type: "solve", gif: canonical, baseline: state.last_publish_at, bits },
      (msg) => {
        if (msg.type === "progress" && opts.onProgress) opts.onProgress(msg);
        if (msg.type === "done") return msg;
        if (msg.type === "error") throw new Error(msg.message);
      },
      opts.signal,
    );

    const res = await fetch(opts.canvasUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({
        cols: opts.cols,
        rows: opts.rows,
        tiles: opts.cells.map((c) => ({ x: c.x, y: c.y, gif: base64(c.gif) })),
        nonce: solved.nonce,
        baseline: state.last_publish_at,
        solve_ms: solved.solveMs,
        bench_hps: benchHps,
        parent: opts.parent,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text();
      let parsed: { error?: string } = {};
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        // Non-JSON body — keep raw text.
      }
      const msg = parsed.error ?? bodyText;
      if (res.status === 401) throw new MissingSessionError();
      throw new Error(`canvas publish rejected: ${res.status} ${msg}`);
    }
    return (await res.json()) as CanvasPublishResponse;
  } finally {
    worker.terminate();
  }
}

async function fetchState(url: string): Promise<LastPublishState> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return INITIAL_STATE;
    return (await res.json()) as LastPublishState;
  } catch {
    return INITIAL_STATE;
  }
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function estimateSolveSeconds(bits: number, hps: number): number {
  return Math.pow(2, bits) / Math.max(1, hps);
}

function runWorker<T>(
  worker: Worker,
  request: unknown,
  handle: (msg: any) => T | undefined | void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onMessage = (ev: MessageEvent) => {
      try {
        const result = handle(ev.data);
        if (result !== undefined) {
          worker.removeEventListener("message", onMessage);
          resolve(result as T);
        }
      } catch (err) {
        worker.removeEventListener("message", onMessage);
        reject(err);
      }
    };
    worker.addEventListener("message", onMessage);
    const onError = (ev: ErrorEvent) => {
      worker.removeEventListener("error", onError);
      reject(new Error(ev.message));
    };
    worker.addEventListener("error", onError);
    if (signal) {
      signal.addEventListener("abort", () => {
        worker.terminate();
        reject(new DOMException("aborted", "AbortError"));
      });
    }
    worker.postMessage(request);
  });
}

// Re-export so callers can reference the same difficulty table.
export { POW_CONFIG };
