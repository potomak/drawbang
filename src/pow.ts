import powConfig from "../config/pow.json" with { type: "json" };

export interface PowConfig {
  hash_algo: "sha-256";
  baseline_grace_s: number;
  difficulty_table: Array<{ max_age_s: number | null; bits: number }>;
}

export const POW_CONFIG = powConfig as PowConfig;

export interface LastPublishState {
  last_publish_at: string; // ISO-8601
  last_difficulty_bits: number;
}

export const INITIAL_STATE: LastPublishState = {
  last_publish_at: "1970-01-01T00:00:00.000Z",
  last_difficulty_bits: 20,
};

const enc = new TextEncoder();

// Node vs browser: Node's sync `crypto.createHash` is ~50x faster than the
// async Web Crypto digest for small inputs (no promise microtask overhead
// between iterations). Load it once up front.
const nodeCreateHash: ((buf: Uint8Array) => Uint8Array) | null = (() => {
  if (typeof process !== "undefined" && process.versions?.node) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createHash } = require("node:crypto") as typeof import("node:crypto");
      return (buf: Uint8Array) =>
        new Uint8Array(createHash("sha256").update(buf).digest());
    } catch {
      return null;
    }
  }
  return null;
})();

// Count leading zero bits in a 32-byte SHA-256 digest.
export function leadingZeroBits(hash: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < hash.length; i++) {
    const b = hash[i];
    if (b === 0) {
      count += 8;
      continue;
    }
    // Math.clz32 counts leading zeros in a 32-bit int; byte lives in low 8 bits.
    count += Math.clz32(b) - 24;
    break;
  }
  return count;
}

// Concatenates `gif || baseline-ascii || nonce-ascii` and returns the SHA-256 digest.
export async function powHash(
  gif: Uint8Array,
  baseline: string,
  nonce: string,
): Promise<Uint8Array> {
  const buf = preimage(gif, baseline, nonce);
  if (nodeCreateHash) return nodeCreateHash(buf);
  const digest = await crypto.subtle.digest("SHA-256", buf as BufferSource);
  return new Uint8Array(digest);
}

function preimage(gif: Uint8Array, baseline: string, nonce: string): Uint8Array {
  const baselineBytes = enc.encode(baseline);
  const nonceBytes = enc.encode(nonce);
  const buf = new Uint8Array(gif.length + baselineBytes.length + nonceBytes.length);
  buf.set(gif, 0);
  buf.set(baselineBytes, gif.length);
  buf.set(nonceBytes, gif.length + baselineBytes.length);
  return buf;
}

export function hashHex(hash: Uint8Array): string {
  let s = "";
  for (let i = 0; i < hash.length; i++) s += hash[i].toString(16).padStart(2, "0");
  return s;
}

// Picks the required difficulty bits for a given time delta (seconds since
// the baseline publish). Brackets are defined in config/pow.json.
export function requiredBits(ageSeconds: number): number {
  for (const row of POW_CONFIG.difficulty_table) {
    if (row.max_age_s === null) return row.bits;
    if (ageSeconds < row.max_age_s) return row.bits;
  }
  return POW_CONFIG.difficulty_table[POW_CONFIG.difficulty_table.length - 1].bits;
}

export function ageSecondsBetween(nowISO: string, baselineISO: string): number {
  return (new Date(nowISO).getTime() - new Date(baselineISO).getTime()) / 1000;
}

export interface SolveProgress {
  hashes: number;
  elapsedMs: number;
}

export interface SolveResult {
  nonce: string;
  hashHex: string;
  solveMs: number;
  hashes: number;
}

// Grinds nonces until the hash has at least `bits` leading zeros.
// `onProgress` is called roughly every 5000 hashes so callers can update UI.
// The hot loop stays synchronous when Node's crypto is available (no per-call
// microtask overhead); otherwise it yields via `await` between hashes.
export async function solve(
  gif: Uint8Array,
  baseline: string,
  bits: number,
  onProgress?: (p: SolveProgress) => void,
  signal?: AbortSignal,
): Promise<SolveResult> {
  const start = performance.now();
  let n = 0;
  while (true) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const nonceStr = n.toString();
    const hash = nodeCreateHash
      ? nodeCreateHash(preimage(gif, baseline, nonceStr))
      : await powHash(gif, baseline, nonceStr);
    if (leadingZeroBits(hash) >= bits) {
      const elapsed = performance.now() - start;
      return {
        nonce: nonceStr,
        hashHex: hashHex(hash),
        solveMs: Math.round(elapsed),
        hashes: n + 1,
      };
    }
    n++;
    if (onProgress && n % 5000 === 0) {
      onProgress({ hashes: n, elapsedMs: performance.now() - start });
      // Yield to the event loop so the worker can receive abort signals.
      if (!nodeCreateHash) await Promise.resolve();
    }
  }
}

// Simple self-benchmark: reports hashes-per-second over a short window so the
// server can sanity-check the reported solve time against actual hardware.
export async function bench(ms: number, sampleGif?: Uint8Array): Promise<number> {
  const gif = sampleGif ?? new Uint8Array(256);
  const start = performance.now();
  const deadline = start + ms;
  let n = 0;
  while (performance.now() < deadline) {
    await powHash(gif, "bench", n.toString());
    n++;
  }
  const elapsed = performance.now() - start;
  return Math.round((n * 1000) / elapsed);
}
