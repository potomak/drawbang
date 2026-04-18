import { INITIAL_STATE, ageSecondsBetween, hashHex, leadingZeroBits, powHash, requiredBits } from "../src/pow.js";
import type { LastPublishState } from "../src/pow.js";
import { validateGif } from "./gif-validate.js";
import type { Storage } from "./storage.js";

export interface IngestRequest {
  gif: string; // base64
  nonce: string;
  baseline: string; // iso-8601
  solve_ms?: number;
  bench_hps?: number;
  parent?: string;
}

export interface IngestSuccess {
  status: 200 | 202;
  body: {
    id: string;
    share_url: string;
    required_bits: number;
    solve_ms: number;
  };
}
export interface IngestError {
  status: 400 | 413 | 500;
  body: { error: string };
}
export type IngestResult = IngestSuccess | IngestError;

export interface HandlerConfig {
  storage: Storage;
  publicBaseUrl: string; // e.g. https://drawbang.example
  now?: () => Date;
  baselineHistory?: string[]; // optional: last N baselines to accept
}

// Stateful per-instance list of accepted baselines, used as a rolling grace
// window so concurrent solvers racing on the same baseline both succeed.
const defaultBaselineHistory: string[] = [];

export async function handleIngest(req: IngestRequest, cfg: HandlerConfig): Promise<IngestResult> {
  const now = cfg.now ? cfg.now() : new Date();
  const nowISO = now.toISOString();

  // -- 1. Parse gif from base64 and validate structure -----------------------
  let gif: Uint8Array;
  try {
    gif = base64Decode(req.gif);
  } catch (err) {
    return err400(`bad base64: ${errMsg(err)}`);
  }
  try {
    validateGif(gif);
  } catch (err) {
    return err400(`invalid gif: ${errMsg(err)}`);
  }

  // -- 2. Load state and validate baseline -----------------------------------
  const state = (await cfg.storage.getJSON<LastPublishState>("public/state/last-publish.json")) ?? INITIAL_STATE;
  const history = cfg.baselineHistory ?? defaultBaselineHistory;
  if (ageSecondsBetween(nowISO, req.baseline) < -5) {
    return err400(`baseline in the future: ${req.baseline}`);
  }

  // Virgin state: accept any baseline that matches the initial sentinel.
  const firstEver = state.last_publish_at === INITIAL_STATE.last_publish_at;
  const baselineOk =
    req.baseline === state.last_publish_at ||
    history.includes(req.baseline) ||
    (firstEver && req.baseline === INITIAL_STATE.last_publish_at);

  if (!baselineOk) {
    return err400(`baseline stale: does not match current or recent history (${req.baseline})`);
  }

  // Difficulty is computed relative to the baseline the client used, not the
  // (possibly newer) current state. This keeps concurrent solvers fair — they
  // grind against the same bits they computed at fetch time — while the
  // baseline-grace window above bounds how long a stale baseline is valid.
  const baselineAge = firstEver
    ? Number.POSITIVE_INFINITY
    : Math.max(0, ageSecondsBetween(nowISO, req.baseline));

  // -- 3. Compute required bits and verify PoW -------------------------------
  const bits = requiredBits(baselineAge);
  const hash = await powHash(gif, req.baseline, req.nonce);
  const actualBits = leadingZeroBits(hash);
  if (actualBits < bits) {
    return err400(`pow insufficient: ${actualBits} < ${bits}`);
  }

  // Benchmark sanity (log-only, not rejected).
  if (req.solve_ms && req.bench_hps) {
    const expected = Math.pow(2, bits);
    const claimed = (req.solve_ms / 1000) * req.bench_hps;
    const ratio = claimed / expected;
    if (ratio < 0.01 || ratio > 100) {
      // eslint-disable-next-line no-console
      console.warn(`pow benchmark mismatch: claimed=${claimed.toFixed(0)} expected=${expected.toFixed(0)} ratio=${ratio.toFixed(2)}`);
    }
  }

  // -- 4. Content-addressed id, idempotency check ----------------------------
  const id = hashHex(hash);
  const day = nowISO.slice(0, 10);
  const gifKey = `inbox/${day}/${id}.gif`;
  const jsonKey = `inbox/${day}/${id}.json`;
  const publishedKey = `public/drawings/${id}.gif`;

  if ((await cfg.storage.exists(publishedKey)) || (await cfg.storage.exists(gifKey))) {
    return {
      status: 200,
      body: {
        id,
        share_url: `${cfg.publicBaseUrl}/d/${id}`,
        required_bits: bits,
        solve_ms: req.solve_ms ?? 0,
      },
    };
  }

  // -- 5. Persist ------------------------------------------------------------
  await cfg.storage.put(gifKey, gif, "image/gif");
  const metadata = {
    id,
    nonce: req.nonce,
    baseline: req.baseline,
    solve_ms: req.solve_ms ?? null,
    bench_hps: req.bench_hps ?? null,
    required_bits: bits,
    created_at: nowISO,
    parent: req.parent ?? null,
  };
  await cfg.storage.put(jsonKey, new TextEncoder().encode(JSON.stringify(metadata)), "application/json");

  // -- 6. Update last-publish.json (and keep baseline history window) --------
  const newState: LastPublishState = {
    last_publish_at: nowISO,
    last_difficulty_bits: bits,
  };
  await cfg.storage.put(
    "public/state/last-publish.json",
    new TextEncoder().encode(JSON.stringify(newState)),
    "application/json",
  );
  history.push(state.last_publish_at);
  while (history.length > 8) history.shift();

  return {
    status: 202,
    body: {
      id,
      share_url: `${cfg.publicBaseUrl}/d/${id}`,
      required_bits: bits,
      solve_ms: req.solve_ms ?? 0,
    },
  };
}

function err400(message: string): IngestError {
  return { status: 400, body: { error: message } };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function base64Decode(s: string): Uint8Array {
  // Works in both Node (Buffer) and browser (atob).
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
