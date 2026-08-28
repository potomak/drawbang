import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrutalShell } from "./brutal-shell.js";

// Lab to compare gallery layouts with variable-size pixel art (8/16/32/64)
// All examples are Tailwind brutalist, no legacy chrome.css.

type MockDrawing = {
  id: string;
  id_short: string;
  size: number;
  color: string;
  pattern?: "checker" | "diag" | "dot";
};

const MOCK_DRAWINGS: MockDrawing[] = [
  { id: "a0", id_short: "a0", size: 8, color: "#ff6060" },
  { id: "a1", id_short: "a1", size: 16, color: "#00ffcc" },
  { id: "a2", id_short: "a2", size: 32, color: "#ffd400" },
  { id: "a3", id_short: "a3", size: 64, color: "#8b5cf6" },
  { id: "b0", id_short: "b0", size: 16, color: "#60a5fa" },
  { id: "b1", id_short: "b1", size: 8, color: "#34d399" },
  { id: "b2", id_short: "b2", size: 32, color: "#f472b6" },
  { id: "b3", id_short: "b3", size: 64, color: "#fb923c" },
  { id: "c0", id_short: "c0", size: 32, color: "#a3e635" },
  { id: "c1", id_short: "c1", size: 16, color: "#f87171" },
  { id: "c2", id_short: "c2", size: 8, color: "#38bdf8" },
  { id: "c3", id_short: "c3", size: 64, color: "#e879f9" },
  { id: "d0", id_short: "d0", size: 64, color: "#4ade80" },
  { id: "d1", id_short: "d1", size: 8, color: "#facc15" },
  { id: "d2", id_short: "d2", size: 16, color: "#818cf8" },
  { id: "d3", id_short: "d3", size: 32, color: "#fb7185" },
  { id: "e0", id_short: "e0", size: 16, color: "#2dd4bf" },
  { id: "e1", id_short: "e1", size: 32, color: "#f97316" },
  { id: "e2", id_short: "e2", size: 64, color: "#a78bfa" },
  { id: "e3", id_short: "e3", size: 8, color: "#f472b6" },
];

function pixelSize(size: number, scale: number): number {
  return size * scale;
}

function MockArt({ d, scale }: { d: MockDrawing; scale: number }) {
  const px = pixelSize(d.size, scale);
  // Visual: solid color square with size label; pixelated border to sell the idea
  return (
    <div
      className="flex items-center justify-center font-mono text-pixel text-black/70 border border-black/10"
      style={{
        width: px,
        height: px,
        background: d.color,
        imageRendering: "pixelated" as const,
      }}
      title={`${d.size}×${d.size} → ${px}×${px}`}
    >
      {d.size}×{d.size}
    </div>
  );
}

function Section({
  title,
  lede,
  children,
}: {
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-[4px] border border-black bg-white p-4 sm:p-5">
      <div className="flex flex-col gap-1 border-b border-black pb-3">
        <h2 className="text-pixel-2x font-normal">{title}</h2>
        <p className="font-mono text-pixel text-zinc-600">{lede}</p>
      </div>
      {children}
    </section>
  );
}

function UniformCard({ d, cell }: { d: MockDrawing; cell: number }) {
  // Integer-pixel fit: biggest multiple of `size` that fits in `cell - 16` padding.
  // Guarantees `scale` is integer so `image-rendering:pixelated` stays crisp.
  const max = Math.max(0, cell - 16);
  const scale = Math.max(1, Math.floor(max / d.size));
  const artPx = d.size * scale;
  return (
    <a
      href="#"
      className="flex aspect-square items-center justify-center overflow-hidden rounded-[4px] border border-black bg-[#f7f7f5] p-2 hover:bg-white"
      style={{ minHeight: cell, minWidth: 0 }}
      aria-label={`drawing ${d.id_short} ${d.size}×${d.size} → ${artPx}×${artPx} in ${cell}×${cell}`}
      title={`${d.size}×${d.size} → ${artPx}×${artPx} (scale ${scale}×) in ${cell}×${cell}`}
    >
      <div className="shrink-0 border border-black/10" style={{ width: artPx, height: artPx }}>
        <MockArt d={d} scale={scale} />
      </div>
    </a>
  );
}

// Variant A: 128 uniform — integer fit (64*2, 32*4, 16*8, 8*16)
function VariantA() {
  return (
    <>
      <p className="font-mono text-pixel text-zinc-600">
        Cell <code className="rounded border border-black bg-zinc-50 px-1">128×128</code> fixed
        `aspect-square`, art = biggest `size×integer` that fits `128-16=112` → `8→112 (14×), 16→112
        (7×), 32→96 (3×), 64→64 (1×)`. Grid{" "}
        <code className="rounded border border-black bg-zinc-50 px-1">
          grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6
        </code>{" "}
        — every render is integer, no blur.
      </p>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {MOCK_DRAWINGS.map((d) => (
          <li key={`A-${d.id}`}>
            <UniformCard d={d} cell={128} />
          </li>
        ))}
      </ul>
      <p className="font-mono text-pixel text-zinc-500">
        Multiples of 64? `128=64*2` — yes. Whole grid stays `1px` aligned on `390px` with `2` cols.
      </p>
    </>
  );
}

// Variant B: real 10× variable cell (masonry-like) — shows why it gets messy
function VariantB() {
  return (
    <>
      <p className="font-mono text-pixel text-zinc-600">
        Cell = art itself (`size×10`, no fixed square). `flex flex-wrap gap-3 items-start` — natural
        masonry, but `64→640` dominates and `8→80` looks lost. Gutters ragged on `lg`.
      </p>
      <div className="flex flex-wrap gap-3 items-start">
        {MOCK_DRAWINGS.map((d) => {
          const px = pixelSize(d.size, 10);
          return (
            <a
              key={`B-${d.id}`}
              href="#"
              className="shrink-0 rounded-[4px] border border-black bg-[#f7f7f5] p-2 hover:bg-white"
              style={{ width: px + 16, height: px + 16 }}
              aria-label={`drawing ${d.id_short}`}
            >
              <MockArt d={d} scale={10} />
            </a>
          );
        })}
      </div>
      <p className="font-mono text-pixel text-zinc-500">
        Breaks the brutal grid — columns never align because cells are `80` vs `640`. Resize to
        `390px` → horizontal scroll.
      </p>
    </>
  );
}

// Variant C: 192 uniform — also multiple of 64 (64*3)
function VariantC() {
  return (
    <>
      <p className="font-mono text-pixel text-zinc-600">
        Cell <code className="rounded border border-black bg-zinc-50 px-1">192×192</code> fixed
        `aspect-square` (64*3), art = biggest `size×integer` that fits `192-16=176` → `8→176 (22×),
        16→176 (11×), 32→160 (5×), 64→128 (2×)`. Same grid `2→3→4→6` — a bit more breathing room
        than `128`.
      </p>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {MOCK_DRAWINGS.map((d) => (
          <li key={`C-${d.id}`}>
            <UniformCard d={d} cell={192} />
          </li>
        ))}
      </ul>
      <p className="font-mono text-pixel text-zinc-500">
        Also multiple of 64, so integer fit stays clean. Good middle ground if `128` feels tight.
      </p>
    </>
  );
}

// Variant D: 256 uniform — also multiple of 64 (64*4)
function VariantD() {
  return (
    <>
      <p className="font-mono text-pixel text-zinc-600">
        Cell <code className="rounded border border-black bg-zinc-50 px-1">256×256</code> fixed
        `aspect-square` (64*4), art = biggest `size×integer` that fits `256-16=240` → `8→240 (30×),
        16→240 (15×), 32→224 (7×), 64→192 (3×)`. Same grid `2→3→4→6` — most breathing room, best for
        detail.
      </p>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {MOCK_DRAWINGS.map((d) => (
          <li key={`D-${d.id}`}>
            <UniformCard d={d} cell={256} />
          </li>
        ))}
      </ul>
      <p className="font-mono text-pixel text-zinc-500">
        `256=64*4` — integer for all sizes. Use if you want `64` to feel hero.
      </p>
    </>
  );
}

export default function renderGalleryLab(v: { repo_url: string }): string {
  const html = renderToStaticMarkup(
    <BrutalShell title="Draw! · Gallery lab — v2" repoUrl={v.repo_url}>
      <header className="flex flex-col gap-3 rounded-[4px] border border-black bg-white p-4 sm:p-6">
        <h1 className="text-pixel-2x font-normal">Gallery lab — integer multiples of 64</h1>
        <p className="font-mono text-pixel text-zinc-600">
          Playground for feed grid. Mock art `8/16/32/64` with `color` blocks — real gifs will be
          `image-rendering:pixelated`. All variants use Tailwind brutal (`1px` `rounded-[4px]`,
          `Departure Mono`, `border-black`). Cells `128/192/256` are `64*2/3/4` so scale stays
          integer.
        </p>
        <p className="font-mono text-pixel text-zinc-500">
          Goal: multi-col on `lg` (`6`), fewer on `sm` (`3`) / mobile (`2`), no Pinterest-style
          `uniform width` (would rescale squares to col width and break integer scale).
        </p>
        <div className="flex flex-wrap gap-2 font-mono text-pixel">
          <a
            href="#A"
            className="rounded-[4px] border border-black bg-[#00ffcc] px-3 py-1.5 hover:bg-[#00ffcc]/90"
          >
            A · 128
          </a>
          <a
            href="#B"
            className="rounded-[4px] border border-black bg-white px-3 py-1.5 hover:bg-zinc-50"
          >
            B · variable 10×
          </a>
          <a
            href="#C"
            className="rounded-[4px] border border-black bg-white px-3 py-1.5 hover:bg-zinc-50"
          >
            C · 192
          </a>
          <a
            href="#D"
            className="rounded-[4px] border border-black bg-white px-3 py-1.5 hover:bg-zinc-50"
          >
            D · 256
          </a>
        </div>
      </header>

      <div id="A">
        <Section title="A — 128 uniform (64×2)" lede="2→3→4→6 cols, integer fit">
          <VariantA />
        </Section>
      </div>
      <div id="B">
        <Section
          title="B — Variable 10× (masonry-like, for contrast)"
          lede="flex-wrap, 80 vs 640 — ragged"
        >
          <VariantB />
        </Section>
      </div>
      <div id="C">
        <Section title="C — 192 uniform (64×3)" lede="2→3→4→6, middle ground">
          <VariantC />
        </Section>
      </div>
      <div id="D">
        <Section title="D — 256 uniform (64×4)" lede="2→3→4→6, most breathing room">
          <VariantD />
        </Section>
      </div>

      <section className="rounded-[4px] border border-black bg-[#00ffcc]/20 p-4 font-mono text-pixel">
        <p className="font-medium">Takeaway</p>
        <p className="text-zinc-700">
          `128/192/256` are `64*2/3/4` — all integer, no blur. `B` proves variable cells create
          ragged `640px` dominance. Pick `128` for densest feed, `192` for middle, `256` for hero
          feel — all keep `1px` grid aligned at `390px`.
        </p>
      </section>
    </BrutalShell>
  );
  return `<!doctype html>\n${html}`;
}
