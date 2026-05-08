import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import merch from "../config/merch.json" with { type: "json" };
import { PrintifyClient, PrintifyError } from "../merch/printify.js";
import {
  findMarkerBboxes,
  sampleSurroundColor,
  fillMarkerPixels,
  type Bbox,
} from "./magenta-clean.js";

// One-shot operator script: for every product in config/merch.json,
// 1. generate a flat-magenta marker PNG at print_area_px dims
// 2. upload it to Printify
// 3. create a draft product with the marker positioned at every entry of
//    placeholder_positions (defaults to ["front"])
// 4. poll until Printify renders the mockup
// 5. download the front mockup
// 6. find every magenta connected component → that's our list of
//    placeholder rects in mockup-pixel space
// 7. clean the magenta + JPEG halo out of the image (replace with a color
//    sampled from just outside each bbox) so transparent source pixels
//    later show natural mockup background instead of magenta
// 8. save the cleaned mockup to static/mockups/<id>.<ext> and update
//    config/mockups.json with the placeholders[] array
// 9. delete the draft product
//
// Requires env: PRINTIFY_API_TOKEN. PRINTIFY_SHOP_ID is auto-fetched if
// unset.
//
// Idempotent at the file level — re-running just overwrites the assets,
// it doesn't accumulate draft products on the Printify side because we
// delete each one after fetching its mockup.

interface MerchVariant {
  id: number;
  label: string;
  base_cost_cents: number;
  retail_cents: number;
}

interface MerchProduct {
  id: string;
  name: string;
  blueprint_id: number;
  print_provider_id: number;
  print_area_px: { width: number; height: number };
  shipping_cents: number;
  placeholder_positions?: string[];
  variants: MerchVariant[];
}

interface MockupConfig {
  mockup_url: string;
  mockup_width: number;
  mockup_height: number;
  placeholders: { x: number; y: number; width: number; height: number }[];
}

interface MockupsFile {
  _note?: string;
  products: Record<string, MockupConfig>;
}

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const STATIC_DIR = path.join(PROJECT_ROOT, "static/mockups");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config/mockups.json");

const MARKER_RGB: [number, number, number] = [255, 0, 255];

async function main(): Promise<void> {
  const token = process.env.PRINTIFY_API_TOKEN;
  if (!token) {
    console.error("error: PRINTIFY_API_TOKEN env var is required");
    process.exit(2);
  }

  const shopId = process.env.PRINTIFY_SHOP_ID ?? (await resolveShopId(token));
  console.log(`shop:  ${shopId}`);

  const client = new PrintifyClient({ token, shopId });
  await fs.mkdir(STATIC_DIR, { recursive: true });

  const existing = (await readJson(CONFIG_PATH)) as MockupsFile | null;
  const updated: MockupsFile = {
    _note:
      "Per-product preview mockup config. mockup_url is served from Vite's publicDir (static/), so the value lives at /mockups/<file>.<ext> at runtime. placeholders[] is the list of print-area rectangles in mockup-pixel space; the merch picker compositor draws the user's drawing centered (square fit) into each rect — multi-up products like the sticker sheet end up with one entry per print position. Assets in static/mockups/ are real Printify catalog mockups with the magenta marker + JPEG halo cleaned out, regeneratable via scripts/fetch-printify-mockups.ts.",
    products: existing?.products ?? {},
  };

  for (const product of (merch as { products: MerchProduct[] }).products) {
    console.log(`\n== ${product.id} (${product.name}) ==`);
    try {
      const cfg = await fetchOne(client, product, shopId, token);
      updated.products[product.id] = cfg;
      console.log(
        `  ✓ ${product.id}: ${cfg.mockup_width}×${cfg.mockup_height}, placeholder ${cfg.placeholder.width}×${cfg.placeholder.height} @ (${cfg.placeholder.x}, ${cfg.placeholder.y})`,
      );
    } catch (err) {
      console.error(`  ✗ ${product.id}: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof PrintifyError) {
        console.error(`    body: ${JSON.stringify(err.body)?.slice(0, 400)}`);
      }
    }
  }

  await fs.writeFile(CONFIG_PATH, JSON.stringify(updated, null, 2) + "\n");
  console.log(`\nwrote ${path.relative(PROJECT_ROOT, CONFIG_PATH)}`);

  // Prune mockup files no longer referenced by the config (e.g. dev
  // placeholders left over from scripts/generate-dev-mockups.ts).
  const referenced = new Set(
    Object.values(updated.products).map((p) => path.basename(p.mockup_url)),
  );
  const onDisk = await fs.readdir(STATIC_DIR);
  for (const name of onDisk) {
    if (!referenced.has(name)) {
      await fs.unlink(path.join(STATIC_DIR, name));
      console.log(`  cleaned up unreferenced ${name}`);
    }
  }
}

async function fetchOne(
  client: PrintifyClient,
  product: MerchProduct,
  shopId: string,
  token: string,
): Promise<MockupConfig> {
  const positions = product.placeholder_positions ?? ["front"];
  console.log(`  positions: ${positions.join(", ")}`);

  // 1. marker
  const marker = generateMarker(product.print_area_px.width, product.print_area_px.height);
  console.log(`  marker:   ${product.print_area_px.width}×${product.print_area_px.height} (${(marker.length / 1024).toFixed(0)} KB)`);

  // 2. upload — single image, reused at every placeholder position
  const upload = await client.uploadImage(`marker-${product.id}.png`, marker);
  console.log(`  uploaded: ${upload.id}`);

  // 3. create draft product, with the marker at every requested position so
  //    multi-up products (e.g. the 4-sticker sheet) render every print rect
  //    in a single mockup pass.
  const variant = product.variants[0];
  const created = await client.createProduct({
    title: `drawbang-marker-${product.id}-${Date.now()}`,
    description: "[drawbang] mockup-fetch marker — draft product, will be deleted",
    blueprint_id: product.blueprint_id,
    print_provider_id: product.print_provider_id,
    variants: [{ id: variant.id, price: variant.retail_cents, is_enabled: true }],
    print_areas: [
      {
        variant_ids: [variant.id],
        placeholders: positions.map((position) => ({
          position,
          images: [{ id: upload.id, x: 0.5, y: 0.5, scale: 1, angle: 0 }],
        })),
      },
    ],
  });
  console.log(`  product:  ${created.id}`);

  try {
    // 4. poll for mockup. Printify returns images[] on the product GET; the
    // first batch may be empty until mockups render. Prefer the default
    // mockup matching the first requested position.
    const mockupUrl = await pollForMockup(token, shopId, created.id, positions[0]);
    console.log(`  mockup:   ${mockupUrl}`);

    // 5. download
    const img = await downloadImage(mockupUrl);
    console.log(`  download: ${img.width}×${img.height} ${img.ext.toUpperCase()} (${(img.bytes.length / 1024).toFixed(0)} KB)`);

    // 6. find every magenta connected component
    const bboxes = findMarkerBboxes(img.rgba);
    if (bboxes.length === 0) {
      throw new Error("could not find magenta marker in mockup");
    }
    console.log(`  bboxes:   ${bboxes.length} (${bboxes.map((b) => `${b.width}×${b.height}@(${b.x},${b.y})`).join(", ")})`);

    // 7. clean the magenta out of the JPEG. Sample the natural mockup color
    //    just outside the marker, then replace every magenta-ish pixel
    //    (including JPEG bleed halos) with that color. After this, the
    //    placeholder rects look like the bare product surface — so when
    //    the runtime compositor draws the user's drawing, transparent
    //    source pixels reveal the product, not magenta.
    const fill = sampleSurroundColor(img.rgba, bboxes);
    const replaced = fillMarkerPixels(img.rgba, bboxes, fill);
    console.log(`  cleaned:  fill=rgb(${fill.join(",")}), ${replaced} px replaced`);

    // 8. re-encode and save
    const filename = `${product.id}.${img.ext}`;
    const out = path.join(STATIC_DIR, filename);
    const reencoded = encodeImage(img);
    await fs.writeFile(out, reencoded);

    return {
      mockup_url: `/mockups/${filename}`,
      mockup_width: img.width,
      mockup_height: img.height,
      placeholders: bboxes.map(snapBbox),
    };
  } finally {
    // 9. cleanup
    await deleteProduct(token, shopId, created.id).catch((err) => {
      console.warn(`  warn: could not delete draft product ${created.id}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

// Snap bbox dims down to the nearest multiple of 16 so per-pixel scaling
// of the 16×16 source comes out clean (the test in
// test/mockup-config.test.ts enforces this). Keep the centre stable.
function snapBbox(bbox: Bbox): Bbox {
  const snappedW = Math.floor(bbox.width / 16) * 16;
  const snappedH = Math.floor(bbox.height / 16) * 16;
  const snappedX = bbox.x + Math.floor((bbox.width - snappedW) / 2);
  const snappedY = bbox.y + Math.floor((bbox.height - snappedH) / 2);
  return { x: snappedX, y: snappedY, width: snappedW, height: snappedH };
}

function encodeImage(img: DownloadedImage): Uint8Array {
  if (img.ext === "jpg") {
    const encoded = jpeg.encode(
      { data: Buffer.from(img.rgba.data), width: img.width, height: img.height },
      90,
    );
    return new Uint8Array(encoded.data);
  }
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.rgba.data);
  return PNG.sync.write(png);
}

function generateMarker(width: number, height: number): Uint8Array {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = MARKER_RGB[0];
    png.data[i + 1] = MARKER_RGB[1];
    png.data[i + 2] = MARKER_RGB[2];
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

interface MockupImage {
  src: string;
  position: string;
  is_default: boolean;
  variant_ids: number[];
}

async function pollForMockup(
  token: string,
  shopId: string,
  productId: string,
  position: string,
): Promise<string> {
  const url = `https://api.printify.com/v1/shops/${shopId}/products/${productId}.json`;
  // Printify renders mockups asynchronously; first-time generation for a
  // fresh product is slower than steady-state. Give it 3 minutes.
  const deadline = Date.now() + 180_000;
  // Initial grace — Printify tends to return empty images[] for the first
  // ~10s after createProduct. No point hammering during that window.
  await new Promise((r) => setTimeout(r, 5000));
  let lastImagesCount = -1;
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`product GET failed: ${res.status}`);
    }
    const body = (await res.json()) as { images?: MockupImage[] };
    const images = body.images ?? [];
    if (images.length !== lastImagesCount) {
      console.log(`    (${images.length} mockup image(s) so far)`);
      lastImagesCount = images.length;
    }
    // Prefer the default-front mockup; fall back to anything matching
    // position; fall back to the first image.
    const exact = images.find((i) => i.position === position && i.is_default);
    const samePos = images.find((i) => i.position === position);
    const any = images[0];
    const pick = exact ?? samePos ?? any;
    if (pick) return pick.src;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("timed out waiting for Printify to render mockup");
}

interface DownloadedImage {
  bytes: Uint8Array;
  rgba: { width: number; height: number; data: Uint8Array | Buffer };
  width: number;
  height: number;
  ext: "png" | "jpg";
}

async function downloadImage(url: string): Promise<DownloadedImage> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mockup download failed: ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await res.arrayBuffer());

  const isJpeg = contentType.includes("jpeg") || /\.jpe?g(\?|$)/i.test(url);
  if (isJpeg) {
    const decoded = jpeg.decode(Buffer.from(bytes), { useTArray: true });
    return {
      bytes,
      rgba: { width: decoded.width, height: decoded.height, data: decoded.data },
      width: decoded.width,
      height: decoded.height,
      ext: "jpg",
    };
  }

  const png = await new Promise<PNG>((resolve, reject) => {
    const p = new PNG();
    p.parse(Buffer.from(bytes), (err, parsed) => {
      if (err) reject(err);
      else resolve(parsed);
    });
  });
  return {
    bytes,
    rgba: { width: png.width, height: png.height, data: png.data },
    width: png.width,
    height: png.height,
    ext: "png",
  };
}

async function resolveShopId(token: string): Promise<string> {
  const res = await fetch("https://api.printify.com/v1/shops.json", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`shops list failed: ${res.status}`);
  const shops = (await res.json()) as { id: number; title: string }[];
  if (shops.length === 0) throw new Error("no shops on this Printify account");
  return String(shops[0].id);
}

async function deleteProduct(token: string, shopId: string, productId: string): Promise<void> {
  const res = await fetch(
    `https://api.printify.com/v1/shops/${shopId}/products/${productId}.json`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete failed: ${res.status}`);
  }
}

async function readJson(p: string): Promise<unknown> {
  try {
    const text = await fs.readFile(p, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
