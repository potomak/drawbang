// Standalone PoW test bed. Spins up the same Web Worker the editor uses
// (`pow.worker.ts`) so timings reflect what real publishers see.

const FIXED_BASELINE = "1970-01-01T00:00:00.000Z";

const bitsEl = document.getElementById("bits") as HTMLInputElement;
const payloadEl = document.getElementById("payload") as HTMLInputElement;
const baselineEl = document.getElementById("baseline") as unknown as HTMLSelectElement;
const benchMsEl = document.getElementById("benchMs") as HTMLInputElement;
const benchBtn = document.getElementById("benchBtn") as HTMLButtonElement;
const solveBtn = document.getElementById("solveBtn") as HTMLButtonElement;
const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
const clearBtn = document.getElementById("clearBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const resultsEl = document.getElementById("results")!;

let worker: Worker | null = null;
let lastHps: number | null = null;
let runCounter = 0;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function spawnWorker(): Worker {
  return new Worker(new URL("./pow.worker.ts", import.meta.url), { type: "module" });
}

function killWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

function setRunning(running: boolean): void {
  benchBtn.disabled = running;
  solveBtn.disabled = running;
  stopBtn.disabled = !running;
}

function makePayload(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31) & 0xff;
  return buf;
}

function prependRow(cells: string[], cls?: string): void {
  const tr = document.createElement("tr");
  if (cls) tr.className = cls;
  for (const c of cells) {
    const td = document.createElement("td");
    td.className = "mono";
    if (c.length > 32) td.classList.add("hash");
    td.textContent = c;
    tr.appendChild(td);
  }
  resultsEl.insertBefore(tr, resultsEl.firstChild);
}

benchBtn.addEventListener("click", () => {
  killWorker();
  setRunning(true);
  setStatus("running benchmark…");
  const ms = Number(benchMsEl.value);
  worker = spawnWorker();
  worker.addEventListener("message", (ev) => {
    const data = ev.data as { type: string; hps?: number; message?: string };
    if (data.type === "benchResult") {
      lastHps = data.hps ?? null;
      setStatus(`benchmark: ${lastHps?.toLocaleString() ?? "?"} hashes/s over ${ms} ms`);
      runCounter++;
      prependRow([
        String(runCounter),
        "—",
        lastHps?.toLocaleString() ?? "?",
        "—",
        String(ms),
        "(bench)",
        "",
      ]);
      killWorker();
      setRunning(false);
    } else if (data.type === "error") {
      setStatus(`error: ${data.message ?? "unknown"}`);
      killWorker();
      setRunning(false);
    }
  });
  worker.postMessage({ type: "bench", ms });
});

solveBtn.addEventListener("click", () => {
  killWorker();
  const bits = Number(bitsEl.value);
  const payloadSize = Number(payloadEl.value);
  const baseline =
    baselineEl.value === "now" ? new Date().toISOString() : FIXED_BASELINE;
  const gif = makePayload(payloadSize);

  setRunning(true);
  setStatus(`solving ${bits} bits against ${payloadSize}-byte payload…`);
  const startedAt = performance.now();

  worker = spawnWorker();
  worker.addEventListener("message", (ev) => {
    const data = ev.data as {
      type: string;
      hashes?: number;
      elapsedMs?: number;
      nonce?: string;
      hashHex?: string;
      solveMs?: number;
      message?: string;
    };
    if (data.type === "progress") {
      const hashes = data.hashes ?? 0;
      const elapsed = data.elapsedMs ?? 0;
      const rate = elapsed > 0 ? Math.round((hashes * 1000) / elapsed) : 0;
      setStatus(
        `solving ${bits} bits… ${hashes.toLocaleString()} hashes (${rate.toLocaleString()}/s)`,
      );
    } else if (data.type === "done") {
      const wallMs = Math.round(performance.now() - startedAt);
      const solveMs = data.solveMs ?? wallMs;
      const hashes = data.hashes ?? 0;
      const hps = solveMs > 0 ? Math.round((hashes * 1000) / solveMs) : 0;
      runCounter++;
      prependRow([
        String(runCounter),
        String(bits),
        hps.toLocaleString(),
        hashes.toLocaleString(),
        solveMs.toLocaleString(),
        data.nonce ?? "",
        data.hashHex ?? "",
      ]);
      setStatus(`done: ${bits} bits in ${solveMs} ms (${hashes.toLocaleString()} hashes)`);
      killWorker();
      setRunning(false);
    } else if (data.type === "error") {
      setStatus(`error: ${data.message ?? "unknown"}`);
      killWorker();
      setRunning(false);
    }
  });
  worker.postMessage({ type: "solve", gif, baseline, bits });
});

stopBtn.addEventListener("click", () => {
  killWorker();
  setRunning(false);
  setStatus("stopped");
});

clearBtn.addEventListener("click", () => {
  resultsEl.innerHTML = "";
  runCounter = 0;
  setStatus("");
});

setStatus("idle");
