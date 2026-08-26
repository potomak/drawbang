import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FlashDemo } from "../../src/components/FlashDemo.js";
import { BrutalShell } from "./brutal-shell.js";

export interface DesignV2View {
  repo_url: string;
}

const COLOR_TOKENS: ReadonlyArray<{ name: string; hex: string; role: string }> = [
  { name: "--paper", hex: "#ffffff", role: "page background" },
  { name: "--paper-2", hex: "#f7f7f5", role: "recessed surface" },
  { name: "--ink", hex: "#0a0a0a", role: "primary text / line" },
  { name: "--accent", hex: "#00ffcc", role: "CTA, active, focus" },
  { name: "--accent-on", hex: "#0a0a0a", role: "text on accent" },
  { name: "--fg-muted", hex: "#52525b", role: "secondary text" },
];

const TYPE_SCALE: ReadonlyArray<{ label: string; cls: string; sample: string }> = [
  { label: "text-pixel", cls: "text-pixel", sample: "11 — body / badge / button (1×)" },
  { label: "text-pixel-2x", cls: "text-pixel-2x", sample: "22 — title / hero (2×)" },
];

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
    <section className="flex flex-col gap-3 rounded-[4px] border border-black bg-white p-4 sm:p-5">
      <div className="flex flex-col gap-1 border-b border-black pb-3 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-pixel font-normal">{title}</h2>
        <p className="text-pixel text-zinc-600 font-mono">{lede}</p>
      </div>
      {children}
    </section>
  );
}

function ColorSwatch({ hex, name, role }: { hex: string; name: string; role: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-[4px] border border-black bg-white p-3">
      <div className="h-10 rounded-[4px] border border-black" style={{ background: hex }} />
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-pixel font-medium">{name}</span>
        <span className="font-mono text-pixel text-zinc-600">{hex}</span>
        <span className="font-mono text-pixel text-zinc-500">{role}</span>
      </div>
    </div>
  );
}

function FlashDemoSSR() {
  return (
    <div id="flash-demo-root">
      <FlashDemo />
    </div>
  );
}

function BrutalButton({
  children,
  variant = "default",
  disabled,
  href,
}: {
  children: React.ReactNode;
  variant?: "default" | "primary" | "ghost" | "danger";
  disabled?: boolean;
  href?: string;
}) {
  const base =
    "inline-flex min-h-[44px] items-center justify-center rounded-[4px] border border-black px-4 py-2 font-mono text-pixel font-medium transition-none active:translate-y-px disabled:opacity-50 disabled:pointer-events-none";
  const variants: Record<string, string> = {
    default: "bg-white hover:bg-zinc-50",
    primary: "bg-[#00ffcc] hover:bg-[#00ffcc]/90",
    ghost: "bg-transparent hover:bg-zinc-50",
    danger: "bg-red-500 text-white hover:bg-red-600",
  };
  const cls = `${base} ${variants[variant]}`;
  if (href) {
    return (
      <a href={href} className={cls}>
        {children}
      </a>
    );
  }
  return (
    <button className={cls} disabled={disabled}>
      {children}
    </button>
  );
}

export default function renderDesignV2(v: DesignV2View): string {
  const html = renderToStaticMarkup(
    <BrutalShell
      title="Draw! · Design system — v2 (React + Tailwind brutalist)"
      repoUrl={v.repo_url}
      includeHydrate
    >
      {/* Page intro — now part of children since BrutalShell is shared chrome */}
      <header className="flex flex-col gap-3 border border-black rounded-[4px] bg-white p-4 sm:p-6">
        <h1 className="text-pixel-2x sm:text-pixel-2x font-normal">Design system — brutalist</h1>
        <p className="text-pixel text-zinc-600 font-mono">
          Mobile-first, mono everywhere, 1px round borders, accent{" "}
          <span className="inline-flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-[4px] border border-black bg-[#00ffcc]" />
            #00ffcc
          </span>{" "}
          — tokens → Tailwind → kitchen sink. Old{" "}
          <code className="bg-zinc-100 border border-black rounded-[4px] px-1">/design</code> stays
          on <code className="bg-zinc-100 border border-black rounded-[4px] px-1">chrome.css</code>.
        </p>
        <p className="text-pixel text-zinc-500">
          Playground for #1 — prove one component model before touching <code>/</code>,{" "}
          <code>/d/*</code>, <code>/u/*</code>.
        </p>
      </header>

      <Section
        title="Color — brutalist"
        lede="White / black / #00ffcc only. No gradients, no shadows."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {COLOR_TOKENS.map((t) => (
            <ColorSwatch key={t.name} name={t.name} hex={t.hex} role={t.role} />
          ))}
        </div>
      </Section>

      <Section title="Type — mono everywhere" lede="ui-monospace, 6 steps, mobile-first.">
        <div className="flex flex-col divide-y divide-black border border-black rounded-[4px] overflow-hidden">
          {TYPE_SCALE.map((t) => (
            <div
              key={t.label}
              className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4 px-3 py-2 sm:py-3 bg-white"
            >
              <span className="font-mono text-pixel text-zinc-600 min-w-[90px]">{t.label}</span>
              <span className={`${t.cls} font-mono`}>{t.sample}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="1px round borders"
        lede="border + rounded-[4px] (4px), never 0 radius. Touch target ≥44px."
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-[4px] border border-black bg-white p-4 text-pixel font-mono">
            border + rounded-[4px]
          </div>
          <div className="rounded-[4px] border border-black bg-[#00ffcc] p-4 text-pixel font-mono">
            accent block
          </div>
          <div className="rounded-[4px] border border-black bg-zinc-50 p-4 text-pixel font-mono">
            recessed
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <span className="inline-flex h-10 w-20 items-center justify-center rounded-[4px] border border-black bg-white text-pixel font-mono">
            40px tap
          </span>
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-[4px] border border-black bg-white text-pixel font-mono">
            1px
          </span>
        </div>
      </Section>

      <Section title="Buttons — brutalist" lede="Mono, 1px round, 44px min, active translate-y.">
        <div className="flex flex-wrap gap-3">
          <BrutalButton>Default</BrutalButton>
          <BrutalButton variant="primary">Primary #00ffcc</BrutalButton>
          <BrutalButton variant="ghost">Ghost</BrutalButton>
          <BrutalButton variant="danger">Danger</BrutalButton>
          <BrutalButton href="#">Link as button</BrutalButton>
          <BrutalButton disabled>Disabled</BrutalButton>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            className="inline-flex min-h-[44px] items-center gap-2 rounded-[4px] border border-black bg-white px-4 py-2 font-mono text-pixel hover:bg-zinc-50"
            aria-pressed="false"
          >
            Follow
          </button>
          <button
            className="inline-flex min-h-[44px] items-center gap-2 rounded-[4px] border border-black bg-[#00ffcc] px-4 py-2 font-mono text-pixel"
            aria-pressed="true"
          >
            Following
          </button>
        </div>
      </Section>

      <Section title="Badge" lede="Mono micro, 1px round, paper-2.">
        <div className="flex flex-wrap gap-3">
          <span className="inline-flex rounded-[4px] border border-black bg-white px-2 py-1 font-mono text-pixel">
            Beta
          </span>
          <span className="inline-flex rounded-[4px] border border-black bg-white px-2 py-1 font-mono text-pixel">
            Daily streak
          </span>
          <span className="inline-flex rounded-[4px] border border-black bg-[#00ffcc] px-2 py-1 font-mono text-pixel">
            New
          </span>
        </div>
      </Section>

      <Section
        title="Feed card — brutalist"
        lede="Single canonical card, mobile stacked, desktop row."
      >
        <article className="flex flex-col gap-4 rounded-[4px] border border-black bg-white p-4 sm:max-w-[480px]">
          <header className="flex items-center gap-2 font-mono text-pixel">
            <a href="#" className="font-medium underline decoration-black underline-offset-2">
              @artist
            </a>
            <span aria-hidden>·</span>
            <time className="text-zinc-600">Jun 6, 2026</time>
          </header>
          <div className="aspect-square flex items-center justify-center rounded-[4px] border border-black bg-zinc-50 font-mono text-pixel text-zinc-500">
            16×16 GIF
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-[4px] border border-black bg-white px-3 py-2 font-mono text-pixel"
              aria-pressed="false"
            >
              ♥ <span className="text-pixel">42</span>
            </button>
            <button
              className="inline-flex min-h-[44px] items-center justify-center rounded-[4px] border border-black bg-white px-3 py-2 font-mono text-pixel"
              aria-pressed="false"
            >
              🔖
            </button>
            <a
              href="#"
              className="inline-flex min-h-[44px] items-center rounded-[4px] border border-black bg-white px-3 py-2 font-mono text-pixel"
            >
              Remix
            </a>
          </div>
        </article>
      </Section>

      <Section
        title="Page chrome — brutalist"
        lede="Header/footer are now Tailwind, not chrome.css."
      >
        <div className="flex flex-col gap-3">
          <div className="rounded-[4px] border border-black bg-white p-3">
            <h3 className="font-mono text-pixel font-normal">Panel header</h3>
            <p className="font-mono text-pixel text-zinc-600">
              Muted body — mono, 1px round, mobile padded.
            </p>
          </div>
          <hr className="border-black" />
        </div>
      </Section>

      <Section
        title="Flash — brutalist"
        lede="showBrutalFlash({kind, message}) — React hydrated, 1px round, mono 11px."
      >
        <FlashDemoSSR />
      </Section>

      <div className="rounded-[4px] border border-black bg-[#00ffcc]/20 p-3 font-mono text-pixel sm:text-pixel">
        <span className="font-bold">Mobile-first check:</span> resize to 390px — grid collapses to 1
        col, buttons stay ≥44px, header shows “Draw” CTA, no horizontal scroll.
      </div>
    </BrutalShell>
  );
  return `<!doctype html>\n${html}`;
}
