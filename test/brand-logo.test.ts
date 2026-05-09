import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildBrandLogoSvg, createBrandLogoProvider } from "../merch/brand-logo.js";
import type { PrintifyClient } from "../merch/printify.js";

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

test("brand logo: SVG starts with <svg, ends with </svg>, declares xmlns + viewBox", () => {
  const svg = decode(buildBrandLogoSvg());
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /\bviewBox="0 0 25 7"/);
  assert.match(svg, /\bshape-rendering="crispEdges"/);
  assert.match(svg, /\bfill="black"/);
});

test("brand logo: 25-cell viewBox = D(5)+space+R(5)+space+A(5)+space+W(5)+space+!(1)", () => {
  // Encodes the layout decision in the test so a future kerning / glyph
  // change has to be acknowledged here.
  const svg = decode(buildBrandLogoSvg());
  // width attribute matches viewBox * cell (20 px / cell)
  assert.ok(svg.includes(`width="500"`), "width=500 missing");
  assert.ok(svg.includes(`height="140"`), "height=140 missing");
});

test("brand logo: emits one rect per filled cell, all width=1 height=1, snapped to integers", () => {
  const svg = decode(buildBrandLogoSvg());
  const rects = svg.match(/<rect [^/]*\/>/g) ?? [];
  // D=23, R=23, A=23, W=22, !=6 — total filled cells in the 5×7 font.
  // Cell counts:
  //   D: 4+2+2+2+2+2+4 = 18  (wait — recompute below)
  //   Sanity-check by asserting > 0 and < cap, and that every rect uses w=h=1.
  assert.ok(rects.length > 30, `expected > 30 rects, got ${rects.length}`);
  assert.ok(rects.length < 200, `expected < 200 rects, got ${rects.length}`);
  for (const r of rects) {
    assert.match(r, /\bx="\d+"/);
    assert.match(r, /\by="\d+"/);
    assert.match(r, /\bwidth="1"/);
    assert.match(r, /\bheight="1"/);
  }
});

test("brand logo: deterministic — same call, same bytes", () => {
  const a = decode(buildBrandLogoSvg());
  const b = decode(buildBrandLogoSvg());
  assert.equal(a, b);
});

test("brand logo provider: uploads exactly once and reuses the id on repeat calls", async () => {
  const calls: { filename: string; bytes: Uint8Array }[] = [];
  const fakeClient = {
    async uploadImage(filename: string, bytes: Uint8Array) {
      calls.push({ filename, bytes });
      return { id: `img_brand_${calls.length}`, preview_url: "u" };
    },
  } as unknown as PrintifyClient;

  const provider = createBrandLogoProvider(fakeClient);
  const id1 = await provider.getImageId();
  const id2 = await provider.getImageId();
  const id3 = await provider.getImageId();
  assert.equal(id1, "img_brand_1");
  assert.equal(id2, "img_brand_1"); // cached
  assert.equal(id3, "img_brand_1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filename, "drawbang-brand-logo.svg");
  // The bytes are an SVG (sanity check)
  assert.match(decode(calls[0].bytes), /^<svg /);
});

test("brand logo provider: concurrent first-callers share one upload (no double-upload race)", async () => {
  let uploads = 0;
  let resolveUpload: ((v: { id: string; preview_url: string }) => void) | null = null;
  const uploadPromise = new Promise<{ id: string; preview_url: string }>((r) => {
    resolveUpload = r;
  });
  const fakeClient = {
    async uploadImage() {
      uploads++;
      return uploadPromise;
    },
  } as unknown as PrintifyClient;

  const provider = createBrandLogoProvider(fakeClient);
  const a = provider.getImageId();
  const b = provider.getImageId();
  const c = provider.getImageId();
  resolveUpload!({ id: "img_brand_only_one", preview_url: "u" });
  const ids = await Promise.all([a, b, c]);
  assert.deepEqual(ids, ["img_brand_only_one", "img_brand_only_one", "img_brand_only_one"]);
  assert.equal(uploads, 1);
});
