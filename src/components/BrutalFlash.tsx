import * as React from "react";

export type BrutalFlashKind = "info" | "success" | "error";

export interface BrutalFlashOptions {
  kind: BrutalFlashKind;
  message: string;
  autoDismissMs?: number;
}

interface FlashState extends BrutalFlashOptions {
  id: number;
}

const FlashContext = React.createContext<{
  show: (opts: BrutalFlashOptions) => void;
  hide: () => void;
} | null>(null);

let nextId = 0;

export function BrutalFlashProvider({ children }: { children: React.ReactNode }) {
  const [flash, setFlash] = React.useState<FlashState | null>(null);
  const timerRef = React.useRef<number | null>(null);

  const hide = React.useCallback(() => {
    setFlash(null);
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const show = React.useCallback(
    (opts: BrutalFlashOptions) => {
      const id = ++nextId;
      setFlash({ ...opts, id });
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (opts.autoDismissMs && Number.isFinite(opts.autoDismissMs) && opts.autoDismissMs > 0) {
        timerRef.current = window.setTimeout(hide, opts.autoDismissMs);
      }
    },
    [hide]
  );

  // Expose imperative globals for kitchen-sink onclick="" and for non-React callers
  React.useEffect(() => {
    const w = window as unknown as {
      showBrutalFlash?: (opts: BrutalFlashOptions) => void;
      hideBrutalFlash?: () => void;
      drawbangShowFlash?: (opts: { kind: BrutalFlashKind; message: string }) => void;
    };
    w.showBrutalFlash = show;
    w.hideBrutalFlash = hide;
    // Back-compat for existing onclick="window.drawbangShowFlash(...)"
    w.drawbangShowFlash = (opts) =>
      show({ kind: opts.kind as BrutalFlashKind, message: opts.message });
    return () => {
      if (w.showBrutalFlash === show) delete w.showBrutalFlash;
      if (w.hideBrutalFlash === hide) delete w.hideBrutalFlash;
    };
  }, [show, hide]);

  return (
    <FlashContext.Provider value={{ show, hide }}>
      {children}
      {flash && (
        <div
          role={flash.kind === "error" ? "alert" : "status"}
          aria-live="polite"
          data-kind={flash.kind}
          className="fixed left-0 right-0 top-0 z-40 flex items-center gap-3 border-b border-black bg-white px-4 py-3 font-mono text-pixel shadow-[4px_4px_0_#0a0a0a] sm:px-6"
          style={{
            borderLeft: `4px solid ${flash.kind === "success" ? "#00ffcc" : flash.kind === "error" ? "#ff6060" : "#0a0a0a"}`,
          }}
        >
          <span className="flex-1 min-w-0 break-words text-pixel">{flash.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={hide}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-black bg-white font-mono text-pixel hover:bg-zinc-50"
          >
            ×
          </button>
        </div>
      )}
    </FlashContext.Provider>
  );
}

export function useBrutalFlash() {
  const ctx = React.useContext(FlashContext);
  if (!ctx) throw new Error("useBrutalFlash must be used within BrutalFlashProvider");
  return ctx;
}

// Standalone brutal flash for static SSR pages without a provider — renders hidden host
// and is shown via window.showBrutalFlash. For /v2/design kitchen sink we render the provider.
export function BrutalFlashHost() {
  return (
    <div
      id="brutal-flash-host"
      className="pointer-events-none fixed left-0 right-0 top-0 z-40 hidden"
      aria-hidden
    />
  );
}
