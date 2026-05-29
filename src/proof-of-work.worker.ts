import { bench, solve } from "./pow.js";

interface SolveRequest {
  type: "solve";
  gif: Uint8Array;
  baseline: string;
  bits: number;
}
interface BenchRequest {
  type: "bench";
  ms: number;
}
type Request = SolveRequest | BenchRequest;

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
  } catch (err) {
    (self as any).postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
