import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";

const endpoint = process.argv[2];
const token = process.argv[3];
if (!endpoint || !token) {
  console.error("usage: tsx scripts/smoke-ingest.ts <endpoint-url> <jwt>");
  process.exit(1);
}

const frame = new Bitmap();
for (let i = 0; i < 16; i++) frame.set(i, i, 7);
const gif = encodeGif({ frames: [frame], activePalette: DEFAULT_ACTIVE_PALETTE });

const body = {
  gif: Buffer.from(gif).toString("base64"),
};

const res = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log(`-> ${res.status} ${res.statusText}`);
console.log(text);
