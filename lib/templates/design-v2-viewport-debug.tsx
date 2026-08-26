import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assetUrl } from "../../src/layout/asset-version.js";
import { LOGO_SVG } from "../../src/layout/logo.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";

export interface ViewportDebugView {
  repo_url: string;
}

// Original BrutalShell CSS without overflow fixes — to isolate the bug
const DEBUG_STYLE_ORIGINAL = `@font-face{font-family:"Departure Mono";src:url("/fonts/DepartureMono-Regular.woff2") format("woff2"),url("/fonts/DepartureMono-Regular.woff") format("woff"),url("/fonts/DepartureMono-Regular.otf") format("opentype");font-display:swap;font-feature-settings:"locl"} *{font-family:"Departure Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace} html{font-synthesis:none;text-rendering:geometricPrecision;-webkit-font-smoothing:none;-moz-osx-font-smoothing:unset;font-smooth:never;image-rendering:pixelated} *{font-variant-ligatures:none;font-feature-settings:"locl"} .text-pixel-2x{font-size:11px!important;line-height:14px!important;display:inline-block;transform:scale(2);transform-origin:left center;image-rendering:pixelated} h1.text-pixel-2x,h2.text-pixel-2x{display:block;transform-origin:left top;margin-bottom:11px}`;

const DEBUG_STYLE_FIXED = `${DEBUG_STYLE_ORIGINAL} .text-pixel-2x{max-width:50%} h1.text-pixel-2x,h2.text-pixel-2x{width:50%;max-width:50%;overflow-wrap:anywhere;word-break:break-word} html,body{overflow-x:hidden;max-width:100vw}`;

function ViewportDebugShell({ useFix, children }: { useFix: boolean; children: React.ReactNode }) {
  const style = useFix ? DEBUG_STYLE_FIXED : DEBUG_STYLE_ORIGINAL;
  const tailwindConfig = `tailwind.config={theme:{extend:{colors:{paper:'#ffffff','paper-2':'#f7f7f5',ink:'#0a0a0a',line:'#0a0a0a',accent:'#00ffcc','accent-on':'#0a0a0a'},fontFamily:{mono:['Departure Mono','ui-monospace','SFMono-Regular','Menlo','Consolas','monospace'],sans:['Departure Mono','ui-monospace','SFMono-Regular','Menlo','Consolas','monospace']},borderRadius:{brutal:'4px'},fontSize:{pixel:['11px','14px'],'pixel-2x':['22px','22px']}}}}`;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Viewport debug — v2/design</title>
        <script src="https://cdn.tailwindcss.com" />
        <script dangerouslySetInnerHTML={{ __html: tailwindConfig }} />
        <link
          rel="preload"
          href="/fonts/DepartureMono-Regular.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <style dangerouslySetInnerHTML={{ __html: style }} />
        <style
          dangerouslySetInnerHTML={{
            __html: `.debug-on{outline:2px solid #ff3b30}.debug-badge{position:fixed;bottom:12px;left:12px;right:12px;z-index:50;background:#0a0a0a;color:#fff;border:1px solid #fff;border-radius:4px;padding:8px 12px;font-family:"Departure Mono",monospace;font-size:11px;line-height:14px} .debug-badge.ok{background:#00a86b} .debug-badge.warn{background:#b00020} .hdr-logo svg{height:22px;width:auto;display:block} .hdr-logo-16 svg{height:16px;width:auto;display:block}`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{ __html: renderAnalytics().replace(/<\/?script[^>]*>/gi, "") }}
        />
        <script
          dangerouslySetInnerHTML={{ __html: renderMetaPixel().replace(/<\/?script[^>]*>/gi, "") }}
        />
      </head>
      <body className="bg-white text-black font-mono antialiased">
        <header className="sticky top-0 z-10 border-b border-black bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
            <a
              href="/"
              aria-label="Draw! home"
              className="inline-flex items-center hover:opacity-80"
            >
              <span className="hdr-logo" dangerouslySetInnerHTML={{ __html: LOGO_SVG }} />
              <span className="ml-2 text-pixel text-zinc-500 hidden sm:inline">v1 22px</span>
            </a>
            <a
              href="/"
              aria-label="Draw! home"
              className="inline-flex items-center hover:opacity-80"
            >
              <span className="hdr-logo-16" dangerouslySetInnerHTML={{ __html: LOGO_SVG }} />
              <span className="ml-2 text-pixel text-zinc-500 hidden sm:inline">v2 16px (bug)</span>
            </a>
            <span className="text-pixel text-zinc-600">debug</span>
          </div>
        </header>
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-6">
          <div className="mb-4 rounded-[4px] border border-black bg-[#00ffcc]/20 p-3 font-mono text-pixel">
            <div className="font-bold">Viewport debug playground — /v2/design/viewport_debug</div>
            <div className="text-zinc-600">
              Toggle sections one by one on a small viewport (≤390px) to see which causes horizontal
              scroll. Red outline = element wider than viewport. Fix ={" "}
              <code className="bg-white border border-black rounded-[4px] px-1">
                h1.text-pixel-2x width:50%
              </code>{" "}
              so visual 22px wraps at 50% layout.
            </div>
            <label className="mt-2 inline-flex items-center gap-2 rounded-[4px] border border-black bg-white px-3 py-2 text-pixel">
              <input type="checkbox" id="debug-fix-toggle" defaultChecked={useFix} /> Use fix (
              {useFix ? "on" : "off"}) — reload with{" "}
              <code className="bg-zinc-100 border border-black rounded-[4px] px-1">?fix=1</code> /{" "}
              <code className="bg-zinc-100 border border-black rounded-[4px] px-1">?fix=0</code>
            </label>
          </div>
          {children}
        </div>
        <div id="debug-badge" className="debug-badge">
          measuring…
        </div>
        <script
          dangerouslySetInnerHTML={{
            __html: `
(function(){
  var badge=document.getElementById('debug-badge');
  var toggle=document.getElementById('debug-fix-toggle');
  if(toggle){
    toggle.addEventListener('change',function(){
      var u=new URL(location.href);
      u.searchParams.set('fix', toggle.checked?'1':'0');
      location.href=u.toString();
    });
  }
  // Highlight any element wider than viewport
  function check(){
    var vw=window.innerWidth;
    var sw=document.documentElement.scrollWidth;
    var overflow=sw>vw;
    var msg='vw:'+vw+' scrollWidth:'+sw+' '+(overflow?'OVERFLOW ':'ok ')+'| fix:'+(new URLSearchParams(location.search).get('fix')||'0');
    // find widest element
    var widest=null, maxW=0;
    document.querySelectorAll('[data-debug]').forEach(function(el){
      el.classList.remove('debug-on');
      var r=el.getBoundingClientRect();
      if(r.width>maxW){maxW=r.width; widest=el;}
      if(r.right>vw+0.5 || r.width>vw+0.5){
        el.classList.add('debug-on');
      }
    });
    if(widest){
      msg+=' | widest:'+widest.getAttribute('data-debug')+'('+Math.round(maxW)+'px)';
    }
    badge.textContent=msg;
    badge.className='debug-badge '+(overflow?'warn':'ok');
  }
  window.addEventListener('resize',check);
  window.addEventListener('load',check);
  setTimeout(check,100);
  // Toggle visibility via checkboxes
  document.querySelectorAll('[data-debug-toggle]').forEach(function(cb){
    cb.addEventListener('change',function(){
      var id=cb.getAttribute('data-debug-toggle');
      var el=document.querySelector('[data-debug="'+id+'"]');
      if(el) el.hidden=!cb.checked;
      setTimeout(check,50);
    });
  });
  check();
})();
`,
          }}
        />
        <script src={assetUrl("/flash.js")} />
        <script src={assetUrl("/chrome-toggle.js")} />
        <script src={assetUrl("/chrome-identity.js")} />
        <script src={assetUrl("/hydrate.js")} />
      </body>
    </html>
  );
}

function DebugSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-debug={id}
      className="flex flex-col gap-3 rounded-[4px] border border-black bg-white p-4"
    >
      <div className="flex items-center gap-2 border-b border-black pb-2">
        <label className="inline-flex items-center gap-2 text-pixel">
          <input type="checkbox" data-debug-toggle={id} defaultChecked /> {title}
        </label>
        <span className="ml-auto text-pixel text-zinc-500">id:{id}</span>
      </div>
      {children}
    </section>
  );
}

export default function renderViewportDebug(v: ViewportDebugView & { useFix: boolean }): string {
  const useFix = v.useFix;
  const html = renderToStaticMarkup(
    <ViewportDebugShell useFix={useFix}>
      <div className="flex flex-col gap-6">
        <DebugSection id="intro" title="Intro — h1.text-pixel-2x (suspect)">
          <div className="rounded-[4px] border border-dashed border-zinc-400 p-2 text-pixel text-zinc-600">
            This header contains the scaled <code>h1.text-pixel-2x</code> that overflows on
            320-390px. Original: <code>transform:scale(2)</code> without width → visual 2× layout
            overflows card.
          </div>
          <header className="flex flex-col gap-3 border border-black rounded-[4px] bg-white p-4">
            <h1 className="text-pixel-2x font-normal">Design system — brutalist</h1>
            <p className="text-pixel text-zinc-600">
              Mobile-first, mono everywhere, 1px round borders, accent #00ffcc — tokens → Tailwind →
              kitchen sink.
            </p>
          </header>
        </DebugSection>

        <DebugSection id="color" title="Color — grid 2 cols">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {["--paper #fff", "--paper-2 #f7f7f5", "--ink #0a0a0a", "--accent #00ffcc"].map((t) => (
              <div key={t} className="rounded-[4px] border border-black bg-white p-3 text-pixel">
                {t}
              </div>
            ))}
          </div>
        </DebugSection>

        <DebugSection id="type" title="Type — text-pixel-2x sample">
          <div className="flex flex-col divide-y divide-black border border-black rounded-[4px] overflow-hidden">
            <div className="flex flex-col sm:flex-row gap-1 px-3 py-2 bg-white">
              <span className="font-mono text-pixel text-zinc-600 min-w-[90px]">text-pixel</span>
              <span className="text-pixel font-mono">11 — body (1×)</span>
            </div>
            <div className="flex flex-col sm:flex-row gap-1 px-3 py-2 bg-white">
              <span className="font-mono text-pixel text-zinc-600 min-w-[90px]">text-pixel-2x</span>
              <span className="text-pixel-2x font-mono">22 — title / hero (2×)</span>
            </div>
          </div>
        </DebugSection>

        <DebugSection id="borders" title="Borders — grid 1 col">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-[4px] border border-black bg-white p-4 text-pixel">border</div>
            <div className="rounded-[4px] border border-black bg-[#00ffcc] p-4 text-pixel">
              accent
            </div>
            <div className="rounded-[4px] border border-black bg-zinc-50 p-4 text-pixel">
              recessed
            </div>
          </div>
        </DebugSection>

        <DebugSection id="buttons" title="Buttons — flex wrap">
          <div className="flex flex-wrap gap-3">
            <button className="inline-flex min-h-[44px] items-center rounded-[4px] border border-black bg-white px-4 py-2 text-pixel">
              Default
            </button>
            <button className="inline-flex min-h-[44px] items-center rounded-[4px] border border-black bg-[#00ffcc] px-4 py-2 text-pixel">
              Primary
            </button>
            <button className="inline-flex min-h-[44px] items-center rounded-[4px] border border-black bg-white px-4 py-2 text-pixel">
              Ghost
            </button>
          </div>
        </DebugSection>

        <DebugSection id="feed-card" title="Feed card — aspect-square">
          <article className="flex flex-col gap-4 rounded-[4px] border border-black bg-white p-4 sm:max-w-[480px]">
            <div className="aspect-square flex items-center justify-center rounded-[4px] border border-black bg-zinc-50 text-pixel">
              16×16 GIF
            </div>
          </article>
        </DebugSection>

        <DebugSection id="footer" title="Footer — flex-col on mobile">
          <footer className="border border-black rounded-[4px] bg-white p-4 text-pixel flex flex-col sm:flex-row gap-2">
            <span>Draw! — brutalist</span>
            <a
              href={v.repo_url}
              className="rounded-[4px] border border-black bg-zinc-50 px-2 py-1 text-pixel"
            >
              {v.repo_url.replace("https://", "")}
            </a>
          </footer>
        </DebugSection>
      </div>
    </ViewportDebugShell>
  );
  return `<!doctype html>\n${html}`;
}
