// Mural-aware editor banner. Two display modes:
//   - home: "This week's mural: N/256 tiles · [Claim a tile →]"
//   - tile-claim: "Drawing tile (x, y) — claim expires in MM:SS"
// The module is purely presentational beyond an internal countdown timer; the
// caller (main.ts) drives state and decides when to claim a tile.

export interface HomeBannerData {
  mode: "home";
  mural_id: string;
  name: string;
  tiles_published: number;
  tiles_total: number;
}

export interface TileClaimBannerData {
  mode: "tile-claim";
  mural_id: string;
  name: string;
  x: number;
  y: number;
  phase: "claiming" | "claimed" | "failed";
  // Required when phase === "claimed".
  claim_expires_at?: number; // epoch seconds
  // Required when phase === "failed".
  error?: string;
}

export type BannerState = HomeBannerData | TileClaimBannerData;

export interface MuralBannerHandle {
  setState(state: BannerState): void;
  destroy(): void;
}

export function mountMuralBanner(
  container: HTMLElement,
  initial: BannerState,
): MuralBannerHandle {
  container.classList.add("mural-banner");
  let state: BannerState = initial;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  function clearCountdown(): void {
    if (countdownTimer !== null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function paint(): void {
    if (state.mode === "home") {
      container.innerHTML = renderHome(state);
      clearCountdown();
      return;
    }
    container.innerHTML = renderTileClaim(state);
    if (state.phase === "claimed" && state.claim_expires_at) {
      const exp = state.claim_expires_at;
      clearCountdown();
      countdownTimer = setInterval(() => {
        const left = exp - Math.floor(Date.now() / 1000);
        const el = container.querySelector(".cv-countdown");
        if (!el) return;
        if (left <= 0) {
          el.textContent = "expired";
          clearCountdown();
          return;
        }
        el.textContent = formatCountdown(left);
      }, 1000);
    } else {
      clearCountdown();
    }
  }

  paint();

  return {
    setState(next) {
      state = next;
      paint();
    },
    destroy() {
      clearCountdown();
      container.innerHTML = "";
      container.classList.remove("mural-banner");
    },
  };
}

function renderHome(s: HomeBannerData): string {
  const ctaHref = `/murals/${encodeURIComponent(s.mural_id)}`;
  return `
    <div class="cv-banner-row">
      <span class="cv-banner-text"><span class="cv-banner-emoji" aria-hidden="true">▦</span><strong>This week's mural:</strong>
        ${escapeHtml(String(s.tiles_published))} / ${escapeHtml(String(s.tiles_total))} tiles</span>
      <a class="cv-banner-cta" href="${escapeAttr(ctaHref)}">Claim a tile →</a>
    </div>
  `;
}

function renderTileClaim(s: TileClaimBannerData): string {
  const muralHref = `/murals/${encodeURIComponent(s.mural_id)}`;
  const nameLink = `<a class="cv-banner-mural" href="${escapeAttr(muralHref)}" target="_blank" rel="noopener"><strong>${escapeHtml(s.name)}</strong></a>`;
  if (s.phase === "claiming") {
    return `
      <div class="cv-banner-row">
        <span class="cv-banner-text"><span class="cv-banner-emoji" aria-hidden="true">▦</span>Claiming tile (${s.x}, ${s.y}) of ${nameLink}…</span>
      </div>
    `;
  }
  if (s.phase === "failed") {
    return `
      <div class="cv-banner-row cv-banner--error">
        <span class="cv-banner-text"><span class="cv-banner-emoji" aria-hidden="true">⚠</span>Couldn't claim tile (${s.x}, ${s.y}) — ${escapeHtml(s.error ?? "unknown error")}</span>
        <a class="cv-banner-cta" href="${escapeAttr(muralHref)}">Pick another tile →</a>
      </div>
    `;
  }
  const left = (s.claim_expires_at ?? 0) - Math.floor(Date.now() / 1000);
  return `
    <div class="cv-banner-row cv-banner--claimed">
      <span class="cv-banner-text"><span class="cv-banner-emoji" aria-hidden="true">▦</span>Drawing tile (${s.x}, ${s.y}) of ${nameLink} — claim expires in <span class="cv-countdown">${formatCountdown(Math.max(0, left))}</span></span>
    </div>
  `;
}

function formatCountdown(s: number): string {
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

const ATTR_ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  '"': "&quot;",
  "'": "&#39;",
};
function escapeAttr(v: string): string {
  return v.replace(/[&<"']/g, (c) => ATTR_ESC[c]!);
}

const HTML_ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};
function escapeHtml(v: string): string {
  return v.replace(/[&<>]/g, (c) => HTML_ESC[c]!);
}
