import { bench, solve, solveClaim, type ClaimPowInput } from "./proof-of-work.js";

interface SolveRequest {
  type: "solve";
  gif: Uint8Array;
  baseline: string;
  bits: number;
}
interface SolveClaimRequest {
  type: "solveClaim";
  input: ClaimPowInput;
  baseline: string;
  bits: number;
}
interface BenchRequest {
  type: "bench";
  ms: number;
}
type Request = SolveRequest | SolveClaimRequest | BenchRequest;

self.addEventListener("message", async (ev: MessageEvent<Request>) => {
  const msg = ev.data;
  try {
    if (msg.type === "bench") {
      const hps = await bench(msg.ms);
      (self as any).postMessage({ type: "benchResult", hps });
      return;
    }
    if (msg.type === "solve") {
      const result = await solve(
        msg.gif,
        msg.baseline,
        msg.bits,
        (p) => (self as any).postMessage({ type: "progress", ...p }),
      );
      (self as any).postMessage({ type: "done", ...result });
      return;
    }
    if (msg.type === "solveClaim") {
      const result = await solveClaim(
        msg.input,
        msg.baseline,
        msg.bits,
        (p) => (self as any).postMessage({ type: "progress", ...p }),
      );
      (self as any).postMessage({ type: "done", ...result });
      return;
    }
  } catch (err) {
    (self as any).postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
