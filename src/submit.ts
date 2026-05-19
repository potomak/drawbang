import { importIdentity, signCanvasClaim, signDrawingId } from "./identity.js";
import { loadStoredIdentity, markPublished } from "./identity-store.js";
import type { LastPublishState, SolveProgress } from "./pow.js";
import {
  INITIAL_STATE,
  POW_CONFIG,
  ageSecondsBetween,
  contentHash,
  hashHex,
  requiredBits,
} from "./pow.js";

export interface IngestResponse {
  id: string;
  share_url: string;
  required_bits: number;
  solve_ms: number;
  canvas?: { canvas_id: string; x: number; y: number };
}

export interface TileClaimRef {
  canvasId: string;
  x: number;
  y: number;
}

export interface SubmitOptions {
  ingestUrl: string;
  stateUrl: string;
  gif: Uint8Array;
  parent?: string;
  // If present, the submission is treated as a canvas-tile publish. The user
  // must already hold a valid claim on (canvasId, x, y) — typically via a
  // prior claimTile() call from the same browser tab.
  tileClaim?: TileClaimRef;
  onPhase?: (phase: "bench" | "solve", detail: string) => void;
  onProgress?: (p: SolveProgress) => void;
  signal?: AbortSignal;
}

export class MissingIdentityError extends Error {
  constructor() {
    super("no identity configured — set up your key before publishing");
    this.name = "MissingIdentityError";
  }
}

export class TileTakenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TileTakenError";
  }
}

export class CanvasClaimRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasClaimRejectedError";
  }
}

export class CanvasCooldownError extends Error {
  constructor(public readonly retryAfterS: number) {
    super(`cooldown active, retry in ${retryAfterS}s`);
    this.name = "CanvasCooldownError";
  }
}

export async function submit(opts: SubmitOptions): Promise<IngestResponse> {
  // Surface the missing-identity case before kicking off the worker so we
  // don't burn CPU on PoW that the server would reject anyway.
  const stored = await loadStoredIdentity();
  if (!stored) throw new MissingIdentityError();

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

    const identity = await importIdentity({
      jwk_public: stored.jwk_public,
      jwk_secret: stored.jwk_secret,
    });
    const drawingIdHex = hashHex(await contentHash(opts.gif));
    const signature = await signDrawingId(identity, drawingIdHex);

    const res = await fetch(opts.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gif: base64(opts.gif),
        nonce: solved.nonce,
        baseline: state.last_publish_at,
        solve_ms: solved.solveMs,
        bench_hps: benchHps,
        parent: opts.parent,
        pubkey: stored.pubkey_hex,
        signature,
        ...(opts.tileClaim
          ? {
              canvas_claim: {
                canvas_id: opts.tileClaim.canvasId,
                x: opts.tileClaim.x,
                y: opts.tileClaim.y,
              },
            }
          : {}),
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text();
      let parsed: { error?: string; retry_after_s?: number } = {};
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        // Non-JSON body (e.g., 405 text/plain) — fall through.
      }
      const msg = parsed.error ?? bodyText;
      if (res.status === 409) throw new TileTakenError(msg);
      if (res.status === 403) throw new CanvasClaimRejectedError(msg);
      if (res.status === 429) {
        throw new CanvasCooldownError(parsed.retry_after_s ?? 0);
      }
      throw new Error(`ingest rejected: ${res.status} ${msg}`);
    }
    // Unlocks the chrome's /keys/<pubkey> upgrade. Set before returning so
    // the next page load (post-publish) finds the flag without waiting on
    // the caller to remember to mark it.
    markPublished();
    return (await res.json()) as IngestResponse;
  } finally {
    worker.terminate();
  }
}

// -- Canvas tile claim --------------------------------------------------------

export interface ClaimTileOptions {
  canvasId: string;
  x: number;
  y: number;
  // /canvas/<id>/state — fetched to obtain baseline + required_bits.
  stateUrl: string;
  // POST endpoint, e.g. /canvas/claim.
  claimUrl: string;
  onPhase?: (phase: "bench" | "solve", detail: string) => void;
  onProgress?: (p: SolveProgress) => void;
  signal?: AbortSignal;
}

export interface ClaimResponse {
  claim_expires_at: number;
  edit_url: string;
  required_bits: number;
}

interface CanvasStateForClaim {
  required_bits: number;
  last_claim_at: string;
  locked: boolean;
}

export async function claimTile(opts: ClaimTileOptions): Promise<ClaimResponse> {
  const stored = await loadStoredIdentity();
  if (!stored) throw new MissingIdentityError();

  const state = await fetchCanvasState(opts.stateUrl);
  if (state.locked) throw new CanvasClaimRejectedError("canvas is locked");
  const bits = state.required_bits;
  const baseline = state.last_claim_at;

  opts.onPhase?.("bench", "measuring hash rate");
  const worker = new Worker(new URL("./pow.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    const benchHps = await runWorker<number>(
      worker,
      { type: "bench", ms: 200 },
      (msg) => {
        if (msg.type === "benchResult") return msg.hps;
      },
    );

    opts.onPhase?.(
      "solve",
      `${bits} bits, est ${estimateSolveSeconds(bits, benchHps).toFixed(1)}s`,
    );

    const solved = await runWorker<{ nonce: string; hashHex: string; solveMs: number }>(
      worker,
      {
        type: "solveClaim",
        input: {
          canvasId: opts.canvasId,
          x: opts.x,
          y: opts.y,
          pubkey: stored.pubkey_hex,
        },
        baseline,
        bits,
      },
      (msg) => {
        if (msg.type === "progress" && opts.onProgress) opts.onProgress(msg);
        if (msg.type === "done") return msg;
        if (msg.type === "error") throw new Error(msg.message);
      },
      opts.signal,
    );

    const identity = await importIdentity({
      jwk_public: stored.jwk_public,
      jwk_secret: stored.jwk_secret,
    });
    const signature = await signCanvasClaim(
      identity,
      opts.canvasId,
      opts.x,
      opts.y,
    );

    const res = await fetch(opts.claimUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        canvas_id: opts.canvasId,
        x: opts.x,
        y: opts.y,
        pubkey: stored.pubkey_hex,
        signature,
        baseline,
        nonce: solved.nonce,
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
      if (res.status === 409) throw new TileTakenError(msg);
      if (res.status === 403) throw new CanvasClaimRejectedError(msg);
      throw new Error(`claim rejected: ${res.status} ${msg}`);
    }
    return (await res.json()) as ClaimResponse;
  } finally {
    worker.terminate();
  }
}

async function fetchCanvasState(url: string): Promise<CanvasStateForClaim> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new CanvasClaimRejectedError(`canvas state unavailable: ${res.status}`);
  }
  return (await res.json()) as CanvasStateForClaim;
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
