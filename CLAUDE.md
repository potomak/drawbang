# CLAUDE.md

Orientation for future Claude sessions on this repo.

## What this is

Drawbang is a 16×16 pixel art editor + anonymous public gallery. The stack is
static-first: a browser editor, a tiny proof-of-work-gated ingest endpoint, and
a daily batch job that regenerates the gallery as static HTML.

The original Ruby/Sinatra/Redis/RMagick app is archived under `legacy/` and is
not imported by any current code.

## Repo layout

```
config/               Shared constants + POW difficulty table
  constants.ts        WIDTH=16, HEIGHT=16, MAX_FRAMES=16, PER_PAGE=36, etc.
  pow.json            Difficulty brackets (20..28 bits), baseline_grace_s

src/                  Vite + TypeScript editor (ships to Pages static assets)
  editor/             bitmap, canvas, tools, history, palette, gif
    palette.ts        256-color BASE_PALETTE + 16-slot active palette
    gif.ts            Encode/decode + DRAWBANG Application Extension
  pow.ts              sha256 PoW (Node sync crypto fast path + Web Crypto fallback)
  pow.worker.ts       WebWorker: bench + solve
  share.ts            URL-hash share codec (5 bpp, 17 pixel states)
  local.ts            IndexedDB "My drawings" store
  submit.ts           Bench, solve, POST to /ingest
  main.ts             Editor UI

functions/            Pages Functions (same-origin /ingest, /state, R2 proxy)
  ingest.ts           POST /ingest -> handleIngest
  state/last-publish.json.ts  GET current baseline + difficulty
  [[path]].ts         Catchall: serves gallery HTML and gifs from R2;
                      falls through to static assets for /, /assets/*, etc.

ingest/               Shared ingest logic (used by Pages Functions + tests)
  handler.ts          Core logic: validate -> PoW check -> content-addressed write
  gif-validate.ts     GIF89a header check, 16x16, <=16 frames, DRAWBANG ext
  storage.ts          Storage interface + FsStorage (local dev + tests)
  r2-storage.ts       R2Storage (Cloudflare Worker + Pages Functions runtime)
  dev-server.ts       Node HTTP shim for `npm run ingest:dev`
  worker.ts           Cloudflare Worker: scheduled (cron) + POST /_build

builder/              Daily batch job (incremental, day-partitioned)
  build.ts            Sweeps inbox/, publishes to public/, renders HTML
  templates/*.mustache  Page templates (inlined into the Worker at build time)

infra/
  wrangler.toml       Cloudflare Worker config: R2 binding + cron
wrangler.toml         Pages project config (R2 binding for functions/)

test/                 node:test suites (gif, pow, share, ingest, builder)
.github/workflows/
  deploy.yml          CI: typecheck + test + deploy Pages & Worker
  pages.yml           Demo build to GitHub Pages (VITE_DISABLE_PUBLISH=1)

legacy/               Archived Ruby app; read-only reference, never imported
```

## Critical invariants — don't break these

- **Drawing id is content-addressed.** `id = hex(sha256(gif_bytes || baseline || nonce))`.
  The same bytes must produce the same id on every runtime (editor, ingest, builder).
  Keep `src/pow.ts` the single source of truth.
- **GIF format is fixed.** 16×16, ≤16 frames, 5 FPS (200 ms delay), GCT has 32
  entries: slots 0..15 = active palette RGB, slot 16 = transparent, 17..31 = 0.
- **DRAWBANG Application Extension** (in `src/editor/gif.ts`): app identifier
  `"DRAWBANG"` (8 bytes) + auth `"1.0"` (3 bytes) + one 16-byte sub-block of
  base-palette indices. Every edit to the gif format must preserve this.
- **Builder is day-partitioned and incremental.** Once day `D` is finalized
  (the builder has run for `D+1`), nothing in `public/days/<D>/` is rewritten.
  The only files that change on every run are `public/index.html` and
  `public/feed.rss`.
- **Difficulty is computed against `req.baseline`, not current state.** Concurrent
  solvers racing on the same baseline must both succeed. The rolling
  `baselineHistory` array (last 8 accepted baselines) bounds staleness. The
  array lives in `functions/ingest.ts` at module scope so it survives within
  a single Pages Function isolate but is not shared across isolates.
- **`public/state/last-publish.json`** is written only by the ingest handler,
  never by the builder. It's the single source of truth for the current
  baseline + difficulty.

## Commands

```
npm run dev            # Vite dev server (editor)
npm run build          # tsc -b + vite build -> dist/
npm run typecheck      # tsc -b --noEmit
npm test               # node:test across test/**/*.test.ts
npm run builder        # Run the daily builder against ./dev-bucket
npm run ingest:dev     # Node ingest server on :8787 (uses FsStorage)
npm run worker:dev     # `wrangler dev --local` (Cloudflare Worker locally)
npm run worker:deploy  # Deploy the Worker to Cloudflare
npm run pages:deploy   # Build + deploy editor to Cloudflare Pages
```

Ingest tests do real PoW at 20 bits and can take 60-90s each. Non-ingest tests
finish in <2s — run them alone when iterating: `node --test --import tsx 'test/gif.test.ts' 'test/pow.test.ts' 'test/share.test.ts' 'test/builder.test.ts'`.

## Environment variables

Editor (build-time, read by Vite — see `.env.example`):
- `VITE_INGEST_URL` — defaults to same-origin `/ingest`; override only for
  standalone demos hosted elsewhere (e.g. the GitHub Pages preview).
- `VITE_STATE_URL` — defaults to same-origin `/state/last-publish.json`.
- `VITE_DRAWING_BASE_URL` — defaults to same-origin; R2 gifs are proxied
  through Pages Functions at `/drawings/*`.
- `VITE_DISABLE_PUBLISH` — truthy hides the publish button (GitHub Pages demo).

Pages (runtime, in root `wrangler.toml` `[vars]`):
- `PUBLIC_BASE_URL` — goes into `share_url` in the ingest response.

Worker (runtime, in `infra/wrangler.toml` `[vars]`):
- `PUBLIC_BASE_URL` — RSS feed self-link.
- `BUILD_SECRET` — optional; if set, `POST /_build?secret=...` runs the builder.

## Cloudflare deployment

Same-origin layout: editor, gallery HTML, gifs, `/ingest`, and `/state`
all serve from `drawbang.pages.dev`. The Worker only runs the daily cron.

One-time setup:
1. `wrangler r2 bucket create drawbang`
2. Create a Pages project named `drawbang` (production branch `master`)
3. GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
4. Update `PUBLIC_BASE_URL` in `wrangler.toml` and `infra/wrangler.toml`

CI deploys on every push to `master` via `.github/workflows/deploy.yml`.

## Conventions

- TypeScript strict; don't loosen `tsconfig.json` without a reason.
- No comments explaining WHAT — only WHY, and only when non-obvious.
- Don't add backwards-compatibility shims: the legacy Ruby app is archived,
  not running, so there's no compat layer to preserve.
- Tests use `node:test` + `tsx`; don't introduce a test framework dependency.
- Storage operations must go through the `Storage` interface so both `FsStorage`
  (tests, dev, Node CLI) and `R2Storage` (Worker) stay interchangeable.
