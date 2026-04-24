import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import { INITIAL_STATE, solve } from "../src/pow.js";

const endpoint = process.argv[2];
if (!endpoint) {
  console.error("usage: tsx scripts/smoke-ingest.ts <endpoint-url>");
  process.exit(1);
}

const frame = new Bitmap();
for (let i = 0; i < 16; i++) frame.set(i, i, 7);
const gif = encodeGif({ frames: [frame], activePalette: DEFAULT_ACTIVE_PALETTE });

// Virgin state: first bracket requires 16 bits.
const baseline = INITIAL_STATE.last_publish_at;
console.log(`solving @ 16 bits against baseline ${baseline}...`);
const sol = await solve(gif, baseline, 16);
console.log(`solved in ${sol.solveMs}ms (nonce=${sol.nonce})`);

const body = {
  gif: Buffer.from(gif).toString("base64"),
  nonce: sol.nonce,
  baseline,
  solve_ms: sol.solveMs,
  bench_hps: 5_000_000,
};

const res = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log(`-> ${res.status} ${res.statusText}`);
console.log(text);
