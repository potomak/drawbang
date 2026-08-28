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

function UniformCard({
  d,
  scale = 10,
  cell = 160,
}: {
  d: MockDrawing;
  scale?: number;
  cell?: number;
}) {
  const artPx = pixelSize(d.size, scale);
  // Fixed cell (aspect-square), art centered with max constraints so 8 stays small, 64 fills/clamps
  return (
    <a
      href="#"
      className="flex aspect-square items-center justify-center overflow-hidden rounded-[4px] border border-black bg-[#f7f7f5] p-2 hover:bg-white"
      style={{ minHeight: cell, minWidth: 0 }}
      aria-label={`drawing ${d.id_short} ${d.size}×${d.size}`}
    >
      <div
        className="shrink-0 border border-black/10"
        style={{ width: Math.min(artPx, cell - 16), height: Math.min(artPx, cell - 16) }}
      >
        <MockArt d={d} scale={scale} />
      </div>
    </a>
  );
}

// Variant A: uniform cell with centered art (5x in gallery, 10x would overflow 64=640)
function VariantA() {
  return (
    <>
      <p className="font-mono text-pixel text-zinc-600">
        Cell <code className="rounded border border-black bg-zinc-50 px-1">160×160</code> fixed
        `aspect-square`, art at{" "}
        <code className="rounded border border-black bg-zinc-50 px-1">5×</code> (`8→40, 16→80,
        32→160, 64→320→clamped to 144`). Grid{" "}
        <code className="rounded border border-black bg-zinc-50 px-1">
          grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6
        </code>{" "}
        — no gaps, no overflow.
      </p>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {MOCK_DRAWINGS.map((d) => (
          <li key={`A-${d.id}`}>
            {/* 5× keeps 64 inside 160 cell; 10× would be 640 and clamp hard */}
            <UniformCard d={d} scale={5} cell={160} />
          </li>
        ))}
      </ul>
      <p className="font-mono text-pixel text-zinc-500">
        Same as `10×` on `/v2/d` hero, but halved for feed so `64` doesn't dominate. `8` reads as
        tiny on purpose — size stays honest.
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

// Variant C: justified row (like Google Photos) — uniform row height, variable width, but squares stay squares so it's just uniform again
function VariantC() {
  // For squares, justified = same size per row if we lock height, so show the intended alternative: uniform cell with 10× but cell grows to 320 for lg, letting 64 breathe.
  return (
    <>
      <p className="font-mono text-pixel text-zinc-600">
        Cell <code className="rounded border border-black bg-zinc-50 px-1">192×192</code> on `sm` →{" "}
        <code className="rounded border border-black bg-zinc-50 px-1">208×208</code> on `lg`, art at
        `10×` clamped (`64→640→192`). More breathing room than A, same fixed grid (`2→3→4→6`).
      </p>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {MOCK_DRAWINGS.map((d) => (
          <li key={`C-${d.id}`}>
            <UniformCard d={d} scale={10} cell={192} />
          </li>
        ))}
      </ul>
      <p className="font-mono text-pixel text-zinc-500">
        `10×` honest but needs bigger cell — `160` feels cramped for `32→320`. `192–208` is the
        sweet spot before `64` overwhelms.
      </p>
    </>
  );
}

// Variant D: dense packing — grid auto-flow dense with spanning for large sizes (bento)
function VariantD() {
  return (
    <>
      <p className="font-mono text-pixel text-zinc-600">
        Bento: `64` spans `2×2` cells, `32` spans `1` (but art `10×` still centered). `grid-cols-2
        sm:grid-cols-4 md:grid-cols-6` with `auto-rows` — large drawings get visual weight without
        `640px` cells.
      </p>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6 auto-rows-[160px]">
        {MOCK_DRAWINGS.map((d) => {
          const span = d.size === 64 ? "col-span-2 row-span-2 sm:col-span-2 sm:row-span-2" : "";
          const scale = d.size === 64 ? 10 : 5;
          const cell = d.size === 64 ? 320 : 160;
          return (
            <li key={`D-${d.id}`} className={span}>
              <UniformCard d={d} scale={scale} cell={cell} />
            </li>
          );
        })}
      </ul>
      <p className="font-mono text-pixel text-zinc-500">
        Gives `64` hierarchy without ragged gutters. Needs curation — every `64` is a feature.
      </p>
    </>
  );
}

export default function renderGalleryLab(v: { repo_url: string }): string {
  const html = renderToStaticMarkup(
    <BrutalShell title="Draw! · Gallery lab — v2" repoUrl={v.repo_url}>
      <header className="flex flex-col gap-3 rounded-[4px] border border-black bg-white p-4 sm:p-6">
        <h1 className="text-pixel-2x font-normal">Gallery lab — variable `size×10`</h1>
        <p className="font-mono text-pixel text-zinc-600">
          Playground for feed grid. Mock art `8/16/32/64` with `color` blocks — real gifs will be
          `image-rendering:pixelated`. All variants use Tailwind brutal (`1px` `rounded-[4px]`,
          `Departure Mono`, `border-black`).
        </p>
        <p className="font-mono text-pixel text-zinc-500">
          Goal: multi-col on `lg` (`6`), fewer on `sm` (`3`) / mobile (`2`), no Pinterest-style
          `uniform width` (ours are squares, so that would just rescale to col width and break
          `10×`).
        </p>
        <div className="flex flex-wrap gap-2 font-mono text-pixel">
          <a
            href="#A"
            className="rounded-[4px] border border-black bg-[#00ffcc] px-3 py-1.5 hover:bg-[#00ffcc]/90"
          >
            A · uniform 160 + 5×
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
            C · uniform 192 + 10×
          </a>
          <a
            href="#D"
            className="rounded-[4px] border border-black bg-white px-3 py-1.5 hover:bg-zinc-50"
          >
            D · bento
          </a>
        </div>
      </header>

      <div id="A">
        <Section title="A — Uniform 160 + art 5× (recommended)" lede="2→3→4→6 cols, no mess">
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
        <Section title="C — Uniform 192 + art 10×" lede="2→3→4→6, bigger breathing room">
          <VariantC />
        </Section>
      </div>
      <div id="D">
        <Section title="D — Bento (64 spans 2×2)" lede="dense, hierarchy for large">
          <VariantD />
        </Section>
      </div>

      <section className="rounded-[4px] border border-black bg-[#00ffcc]/20 p-4 font-mono text-pixel">
        <p className="font-medium">Takeaway</p>
        <p className="text-zinc-700">
          Keep cells uniform (A or C). `B` proves variable cells create ragged gutters + `640px`
          dominance. `D` is nice if you want to feature `64`s, but `A` (5× in `160`) is the calmer
          brutal default — then keep `10×` only on `/v2/d` hero. Resize to `390px` to compare.
        </p>
      </section>
    </BrutalShell>
  );
  return `<!doctype html>\n${html}`;
}
