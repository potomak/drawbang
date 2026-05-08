// Detect magenta marker regions in a Printify mockup, sample the surrounding
// mockup color, and replace every magenta-ish pixel (including JPEG bleed)
// with that sampled color. The result is a mockup whose print area looks
// like the natural product surface — so when the compositor draws a 16×16
// pixel-art frame on top, transparent source pixels show the product, not
// magenta.

export interface RGBA {
  width: number;
  height: number;
  data: Uint8Array | Buffer;
}

export interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Pixel is "marker core" — bright in red+blue, dim in green. Tight enough
// that the bbox tracks the marker boundary; wide enough to survive JPEG
// quantisation at the centre of a magenta block.
function isMarkerCore(r: number, g: number, b: number): boolean {
  return r >= 160 && b >= 160 && g <= 90 && r > g && b > g;
}

// "Marker bleed" — looser threshold that catches the desaturated halo JPEG
// compression smears around the marker edge. Still requires red and blue
// dominance so we don't strip incidental cool/warm tones from the mockup.
function isMarkerBleed(r: number, g: number, b: number): boolean {
  return r >= 140 && b >= 140 && r > g + 20 && b > g + 20;
}

// Scan for connected components of marker-core pixels via row-major sweep
// + BFS flood fill. Returns one bbox per component, ignoring any component
// smaller than `minPixels` (rejects stray JPEG noise).
export function findMarkerBboxes(rgba: RGBA, minPixels = 200): Bbox[] {
  const { width, height, data } = rgba;
  const visited = new Uint8Array(width * height);
  const bboxes: Bbox[] = [];
  const queueX: number[] = [];
  const queueY: number[] = [];

  for (let y0 = 0; y0 < height; y0++) {
    for (let x0 = 0; x0 < width; x0++) {
      const startIdx = y0 * width + x0;
      if (visited[startIdx]) continue;
      const di = startIdx * 4;
      if (!isMarkerCore(data[di], data[di + 1], data[di + 2])) continue;

      let minX = x0;
      let minY = y0;
      let maxX = x0;
      let maxY = y0;
      let count = 0;
      queueX.length = 0;
      queueY.length = 0;
      queueX.push(x0);
      queueY.push(y0);
      visited[startIdx] = 1;

      while (queueX.length > 0) {
        const x = queueX.pop()!;
        const y = queueY.pop()!;
        count++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;

        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (visited[nIdx]) continue;
          const ni = nIdx * 4;
          if (!isMarkerCore(data[ni], data[ni + 1], data[ni + 2])) continue;
          visited[nIdx] = 1;
          queueX.push(nx);
          queueY.push(ny);
        }
      }

      if (count >= minPixels) {
        bboxes.push({
          x: minX,
          y: minY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
        });
      }
    }
  }

  bboxes.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return bboxes;
}

// Sample a thin band just outside every bbox, skip any pixel still tinted
// magenta (JPEG halo), return the median RGB. Median over mean keeps the
// fill stable when shadows or stitching produce a few dark outliers.
export function sampleSurroundColor(
  rgba: RGBA,
  bboxes: Bbox[],
  band = 16,
): [number, number, number] {
  const { width, height, data } = rgba;
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];

  for (const bbox of bboxes) {
    const x0 = Math.max(0, bbox.x - band);
    const y0 = Math.max(0, bbox.y - band);
    const x1 = Math.min(width, bbox.x + bbox.width + band);
    const y1 = Math.min(height, bbox.y + bbox.height + band);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const insideBbox =
          x >= bbox.x && x < bbox.x + bbox.width && y >= bbox.y && y < bbox.y + bbox.height;
        if (insideBbox) continue;
        const i = (y * width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (isMarkerBleed(r, g, b)) continue;
        reds.push(r);
        greens.push(g);
        blues.push(b);
      }
    }
  }

  if (reds.length === 0) return [255, 255, 255];
  return [median(reds), median(greens), median(blues)];
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

// Replace every marker-bleed pixel with the given fill color, then sweep
// once more around each bbox with a looser "any magenta tint" threshold to
// pick up the desaturated 1–2px JPEG halo that survives the strict pass.
// The looser pass is constrained to an expanded bbox region so it can't
// accidentally desaturate cool/warm tones elsewhere in the mockup.
export function fillMarkerPixels(
  rgba: RGBA,
  bboxes: Bbox[],
  fill: [number, number, number],
  haloExpand = 12,
): number {
  const { width, height, data } = rgba;
  let replaced = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (isMarkerBleed(data[i], data[i + 1], data[i + 2])) {
        data[i] = fill[0];
        data[i + 1] = fill[1];
        data[i + 2] = fill[2];
        replaced++;
      }
    }
  }

  for (const bbox of bboxes) {
    const x0 = Math.max(0, bbox.x - haloExpand);
    const y0 = Math.max(0, bbox.y - haloExpand);
    const x1 = Math.min(width, bbox.x + bbox.width + haloExpand);
    const y1 = Math.min(height, bbox.y + bbox.height + haloExpand);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (r - g >= 12 && b - g >= 12) {
          data[i] = fill[0];
          data[i + 1] = fill[1];
          data[i + 2] = fill[2];
          replaced++;
        }
      }
    }
  }

  return replaced;
}
