import * as React from "react";

export function FlashDemo() {
  const [flash, setFlash] = React.useState<null | { kind: "success" | "error"; message: string }>(
    null
  );
  React.useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 3000);
    return () => window.clearTimeout(t);
  }, [flash]);

  // Also expose imperative API for consistency with BrutalFlashProvider
  React.useEffect(() => {
    const w = window as unknown as { showBrutalFlash?: unknown; hideBrutalFlash?: unknown };
    const show = (opts: { kind: "success" | "error"; message: string }) => setFlash(opts);
    const hide = () => setFlash(null);
    w.showBrutalFlash = show as unknown as typeof w.showBrutalFlash;
    w.hideBrutalFlash = hide as unknown as typeof w.hideBrutalFlash;
    return () => {
      if (w.showBrutalFlash === show) delete w.showBrutalFlash;
      if (w.hideBrutalFlash === hide) delete w.hideBrutalFlash;
    };
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <button
          className="inline-flex min-h-[44px] items-center rounded-[4px] border border-black bg-white px-4 py-2 font-mono text-pixel hover:bg-zinc-50"
          onClick={() => setFlash({ kind: "success", message: "Saved." })}
        >
          Trigger success
        </button>
        <button
          className="inline-flex min-h-[44px] items-center rounded-[4px] border border-black bg-white px-4 py-2 font-mono text-pixel hover:bg-zinc-50"
          onClick={() => setFlash({ kind: "error", message: "Something went wrong." })}
        >
          Trigger error
        </button>
        <button
          className="inline-flex min-h-[44px] items-center rounded-[4px] border border-black bg-white px-4 py-2 font-mono text-pixel hover:bg-zinc-50"
          onClick={() => setFlash({ kind: "success", message: "Via React state" })}
        >
          Trigger via React
        </button>
      </div>
      {flash && (
        <div
          role={flash.kind === "error" ? "alert" : "status"}
          aria-live="polite"
          className="flex items-center gap-3 rounded-[4px] border border-black bg-white px-4 py-3 font-mono text-pixel shadow-[4px_4px_0_#0a0a0a]"
          style={{ borderLeft: `4px solid ${flash.kind === "success" ? "#00ffcc" : "#ff6060"}` }}
        >
          <span className="flex-1 break-words">{flash.message}</span>
          <button
            aria-label="Dismiss"
            onClick={() => setFlash(null)}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-black bg-white text-pixel hover:bg-zinc-50"
          >
            ×
          </button>
        </div>
      )}
      <p className="font-mono text-pixel text-zinc-600">
        React: <code className="rounded-[4px] border border-black bg-zinc-50 px-1">useState</code> +{" "}
        <code className="rounded-[4px] border border-black bg-zinc-50 px-1">onClick</code>{" "}
        (hydrated). Also{" "}
        <code className="rounded-[4px] border border-black bg-zinc-50 px-1">
          window.showBrutalFlash
        </code>{" "}
        via{" "}
        <code className="rounded-[4px] border border-black bg-zinc-50 px-1">BrutalFlash.tsx</code>.
      </p>
    </div>
  );
}
