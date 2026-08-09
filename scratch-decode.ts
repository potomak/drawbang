import { readFileSync } from "node:fs";
import { decodeGif } from "./src/editor/gif.js";
import { validateGif } from "./ingest/gif-validate.js";
const p = process.argv[2];
const bytes = new Uint8Array(readFileSync(p));
try {
  const v = validateGif(bytes);
  console.log(`  validateGif OK: size=${v.size} frames=${v.frameCount}`);
} catch (e) {
  console.log(`  validateGif THREW: ${(e as Error).message}`);
}
try {
  const d = decodeGif(bytes);
  console.log(`  decodeGif OK: frames=${d.frames.length} delayMs=${d.delayMs} activePalette=${d.activePalette ? "present" : "MISSING"}`);
} catch (e) {
  console.log(`  decodeGif THREW: ${(e as Error).message}`);
}
