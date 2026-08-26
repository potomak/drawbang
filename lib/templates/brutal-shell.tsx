import * as React from "react";
import { assetUrl } from "../../src/layout/asset-version.js";
import { LOGO_SVG } from "../../src/layout/logo.js";
import { renderAnalyticsInner, renderMetaPixelInner } from "../../src/layout/tracking.js";

export type BrutalVariant = "original" | "fixed" | "noscale";

const BRUTAL_ACCENT = "#00ffcc";

const BASE_FONT_FACE = `@font-face{font-family:"Departure Mono";src:url("/fonts/DepartureMono-Regular.woff2") format("woff2"),url("/fonts/DepartureMono-Regular.woff") format("woff"),url("/fonts/DepartureMono-Regular.otf") format("opentype");font-display:swap;font-feature-settings:"locl"}`;

const BASE_RESET = `*{font-family:"Departure Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace} html{font-synthesis:none;text-rendering:geometricPrecision;-webkit-font-smoothing:none;-moz-osx-font-smoothing:unset;font-smooth:never;image-rendering:pixelated} *{font-variant-ligatures:none;font-feature-settings:"locl"}`;

const TEXT_PIXEL_ORIGINAL = `.text-pixel-2x{font-size:11px!important;line-height:14px!important;display:inline-block;transform:scale(2);transform-origin:left center;image-rendering:pixelated} h1.text-pixel-2x,h2.text-pixel-2x{display:block;transform-origin:left top;margin-bottom:11px}`;

const TEXT_PIXEL_FIXED = `${TEXT_PIXEL_ORIGINAL} .text-pixel-2x{max-width:50%} h1.text-pixel-2x,h2.text-pixel-2x{width:50%;max-width:50%;overflow-wrap:anywhere;word-break:break-word} html,body{overflow-x:hidden;max-width:100vw}`;

const TEXT_PIXEL_NOSCALE = `${BASE_FONT_FACE} ${BASE_RESET} .text-pixel-2x{font-size:22px!important;line-height:22px!important;display:block;transform:none;image-rendering:pixelated;font-weight:400!important} h1.text-pixel-2x,h2.text-pixel-2x{display:block;transform:none;margin-bottom:0;font-weight:400!important}`;

export function brutalStyleForVariant(variant: BrutalVariant = "original"): string {
  if (variant === "noscale") return TEXT_PIXEL_NOSCALE;
  if (variant === "fixed") return `${BASE_FONT_FACE} ${BASE_RESET} ${TEXT_PIXEL_FIXED}`;
  return `${BASE_FONT_FACE} ${BASE_RESET} ${TEXT_PIXEL_ORIGINAL} .hdr-logo svg{height:22px;width:auto;display:block}`;
}

const SHARED_HDR_LOGO_STYLE = `.hdr-logo svg{height:22px;width:auto;display:block}`;

export function getBrutalStyle(variant: BrutalVariant = "original"): string {
  const base = brutalStyleForVariant(variant);
  if (variant === "original" && !base.includes("hdr-logo")) {
    return `${base} ${SHARED_HDR_LOGO_STYLE}`;
  }
  if (variant === "fixed" && !base.includes("hdr-logo")) {
    return `${base} ${SHARED_HDR_LOGO_STYLE}`;
  }
  return base;
}

export function BrutalHeader() {
  return (
    <header className="sticky top-0 z-10 border-b border-black bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <a
          href="/"
          aria-label="Draw! home"
          className="hdr-logo inline-flex items-center hover:opacity-80"
          dangerouslySetInnerHTML={{ __html: LOGO_SVG }}
        />
        <nav className="hidden sm:flex items-center gap-2 text-pixel">
          <a
            href="/products"
            className="rounded-[4px] border border-black bg-white px-3 py-1.5 hover:bg-zinc-50"
          >
            Products
          </a>
          <a
            href="/draw"
            className="rounded-[4px] border border-black bg-[#00ffcc] px-3 py-1.5 font-medium hover:bg-[#00ffcc]/90"
          >
            New drawing
          </a>
          <a
            href="/login"
            className="rounded-[4px] border border-black bg-white px-3 py-1.5 hover:bg-zinc-50"
          >
            Sign in
          </a>
        </nav>
        <a
          href="/draw"
          className="sm:hidden inline-flex items-center rounded-[4px] border border-black bg-[#00ffcc] px-3 py-2 text-pixel font-medium"
        >
          Draw
        </a>
      </div>
    </header>
  );
}

export function BrutalFooter({ repoUrl }: { repoUrl: string }) {
  return (
    <footer className="border border-black rounded-[4px] bg-white p-4 text-pixel text-zinc-600 flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
      <span className="font-mono">
        Draw! — brutalist, mono, 1px round •{" "}
        <a href="/privacy" className="underline decoration-black underline-offset-2">
          Privacy
        </a>{" "}
        •{" "}
        <a
          href="https://github.com/potomak/drawbang/issues/new?labels=feedback"
          className="underline decoration-black underline-offset-2"
        >
          Feedback
        </a>
      </span>
      <a
        href={repoUrl}
        className="rounded-[4px] border border-black bg-zinc-50 px-2 py-1 font-mono text-pixel hover:bg-white"
      >
        {repoUrl.replace("https://", "")}
      </a>
    </footer>
  );
}

export interface BrutalShellProps {
  title: string;
  repoUrl: string;
  variant?: BrutalVariant;
  children: React.ReactNode;
  includeHydrate?: boolean;
  extraHead?: React.ReactNode;
  extraBody?: React.ReactNode;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}

export function BrutalShell({
  title,
  repoUrl,
  variant = "original",
  children,
  includeHydrate = false,
  extraHead,
  extraBody,
  header,
  footer,
}: BrutalShellProps) {
  const tailwindConfig = `tailwind.config={theme:{extend:{colors:{paper:'#ffffff','paper-2':'#f7f7f5',ink:'#0a0a0a',line:'#0a0a0a',accent:'${BRUTAL_ACCENT}','accent-on':'#0a0a0a'},fontFamily:{mono:['Departure Mono','ui-monospace','SFMono-Regular','Menlo','Consolas','monospace'],sans:['Departure Mono','ui-monospace','SFMono-Regular','Menlo','Consolas','monospace']},borderRadius:{brutal:'4px'},fontSize:{pixel:['11px','14px'],'pixel-2x':['22px','22px']}}}}`;
  const brutalStyle = getBrutalStyle(variant);
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title}</title>
        <script src="https://cdn.tailwindcss.com" />
        <script dangerouslySetInnerHTML={{ __html: tailwindConfig }} />
        <link
          rel="preload"
          href="/fonts/DepartureMono-Regular.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <style dangerouslySetInnerHTML={{ __html: brutalStyle }} />
        {extraHead}
        <script dangerouslySetInnerHTML={{ __html: renderAnalyticsInner() }} />
        <script dangerouslySetInnerHTML={{ __html: renderMetaPixelInner() }} />
        {includeHydrate &&
          (() => {
            const hydrateSrc = process.env.DRAWBANG_ASSET_VERSION
              ? assetUrl("/assets/hydrate-v2-design.js")
              : "/src/hydrate-v2-design.tsx";
            return <script type="module" src={hydrateSrc} />;
          })()}
      </head>
      <body className="bg-white text-black font-mono antialiased">
        {header ?? <BrutalHeader />}
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          <div className="flex flex-col gap-6 sm:gap-8">
            {children}
            {footer ?? <BrutalFooter repoUrl={repoUrl} />}
          </div>
        </div>
        <script src={assetUrl("/flash.js")} />
        <script src={assetUrl("/chrome-toggle.js")} />
        <script src={assetUrl("/chrome-identity.js")} />
        <script src={assetUrl("/hydrate.js")} />
        {extraBody}
      </body>
    </html>
  );
}
