import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import {
  findMarkerBboxes,
  sampleSurroundColor,
  fillMarkerPixels,
  type Bbox,
} from "./magenta-clean.js";

// One-shot post-processor: takes the existing static/mockups/*.{jpg,png}
// (which still have the raw Printify magenta marker baked in) and:
//   1. detects every magenta connected component
//   2. samples the natural mockup color just outside the markers
//   3. replaces every magenta-ish pixel in the image with that color
//   4. writes the cleaned asset back in place
//   5. emits placeholders[] entries to drop into config/mockups.json
//
// Run once after pulling new mockup-cleaning code; the regular
// fetch-printify-mockups.ts script does the same cleanup inline so re-fetches
// don't need this. No Printify API access required.

interface MerchProduct {
  id: string;
  placeholder_positions?: string[];
}

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const STATIC_DIR = path.join(PROJECT_ROOT, "static/mockups");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config/mockups.json");

async function main(): Promise<void> {
  const merch = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, "config/merch.json"), "utf8"),
  ) as { products: MerchProduct[] };
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")) as {
    _note?: string;
    products: Record<
      string,
      {
        mockup_url: string;
        mockup_width: number;
        mockup_height: number;
        placeholder?: Bbox;
        placeholders?: Bbox[];
      }
    >;
  };

  for (const product of merch.products) {
    const cfg = config.products[product.id];
    if (!cfg) {
      console.warn(`skip ${product.id}: no mockup config`);
      continue;
    }
    const filename = path.basename(cfg.mockup_url);
    const filepath = path.join(STATIC_DIR, filename);
    console.log(`\n== ${product.id} (${filename}) ==`);

    const bytes = new Uint8Array(await fs.readFile(filepath));
    const ext = filename.endsWith(".png") ? "png" : "jpg";

    let rgba: { width: number; height: number; data: Uint8Array | Buffer };
    if (ext === "jpg") {
      const decoded = jpeg.decode(Buffer.from(bytes), { useTArray: true });
      rgba = { width: decoded.width, height: decoded.height, data: decoded.data };
    } else {
      const png = await new Promise<PNG>((resolve, reject) => {
        const p = new PNG();
        p.parse(Buffer.from(bytes), (err, parsed) => {
          if (err) reject(err);
          else resolve(parsed);
        });
      });
      rgba = { width: png.width, height: png.height, data: png.data };
    }

    const bboxes = findMarkerBboxes(rgba);
    if (bboxes.length === 0) {
      console.warn(`  no magenta bbox found; skipping`);
      continue;
    }
    console.log(
      `  bboxes: ${bboxes.length} (${bboxes
        .map((b) => `${b.width}×${b.height}@(${b.x},${b.y})`)
        .join(", ")})`,
    );

    const fill = sampleSurroundColor(rgba, bboxes);
    const replaced = fillMarkerPixels(rgba, bboxes, fill);
    console.log(`  fill=rgb(${fill.join(",")}), ${replaced} px replaced`);

    let outBytes: Uint8Array;
    if (ext === "jpg") {
      const encoded = jpeg.encode(
        { data: Buffer.from(rgba.data), width: rgba.width, height: rgba.height },
        90,
      );
      outBytes = new Uint8Array(encoded.data);
    } else {
      const png = new PNG({ width: rgba.width, height: rgba.height });
      png.data = Buffer.from(rgba.data);
      outBytes = PNG.sync.write(png);
    }
    await fs.writeFile(filepath, outBytes);
    console.log(`  wrote ${filepath} (${(outBytes.length / 1024).toFixed(0)} KB)`);

    cfg.placeholders = bboxes.map(snapBbox);
    cfg.mockup_width = rgba.width;
    cfg.mockup_height = rgba.height;
    delete cfg.placeholder;
  }

  config._note =
    "Per-product preview mockup config. mockup_url is served from Vite's publicDir (static/), so the value lives at /mockups/<file>.<ext> at runtime. placeholders[] is the list of print-area rectangles in mockup-pixel space; the merch picker compositor draws the user's drawing centered (square fit) into each rect — multi-up products like the sticker sheet end up with one entry per print position. Assets in static/mockups/ are real Printify catalog mockups with the magenta marker + JPEG halo cleaned out, regeneratable via scripts/fetch-printify-mockups.ts.";
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log(`\nwrote ${path.relative(PROJECT_ROOT, CONFIG_PATH)}`);
}

function snapBbox(bbox: Bbox): Bbox {
  const snappedW = Math.floor(bbox.width / 16) * 16;
  const snappedH = Math.floor(bbox.height / 16) * 16;
  const snappedX = bbox.x + Math.floor((bbox.width - snappedW) / 2);
  const snappedY = bbox.y + Math.floor((bbox.height - snappedH) / 2);
  return { x: snappedX, y: snappedY, width: snappedW, height: snappedH };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
