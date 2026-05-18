# CLAUDE.md

Orientation for future Claude sessions on this repo.

## What this is

Drawbang is a 16×16 pixel art editor + anonymous public gallery. The stack is
static-first: a browser editor, a tiny proof-of-work-gated ingest endpoint, and
a daily batch job that regenerates the gallery as static HTML.

The original Ruby/Sinatra/Redis/RMagick app is archived under `legacy/` and is
not imported by any current code.

## Deployment shape

```
  editor + gallery + gifs + state  →  S3 (drawbang-assets, us-east-1)
                                       fronted by CloudFront for HTTPS + cache
  POST /ingest                     →  AWS Lambda + API Gateway HTTP API
  daily gallery rebuild            →  GitHub Actions cron (reads/writes S3)
```

Single origin: everything serves from the CloudFront distribution (e.g.
`d3te69flws96uk.cloudfront.net`). The S3 bucket is locked down to the
distribution via Origin Access Control. CloudFront Function rewrites clean
URLs (`/gallery`, `/d/<id>`, `/days/<d>/p/<n>`) to the underlying `.html`
files. No GH Pages, no Cloudflare, no persistent webserver.

## Pages of the app

Single source of truth. Any cross-page change (new nav link, new shared
asset, new tracking script) must consider every entry below.

| URL                            | Rendered by                                       | Surface |
|--------------------------------|---------------------------------------------------|---------|
| `/`                            | `index.html` + `src/main.ts`                      | Editor (Vite) |
| `/gallery`                     | `builder/templates/index.ts` → `gallery.html`     | Builder |
| `/days/<YYYY-MM-DD>/p/<N>`     | `builder/templates/day-gallery.ts`                | Builder |
| `/d/<64hex>`                   | `builder/templates/drawing.ts`                    | Builder + sync-rendered by ingest Lambda on publish |
| `/keys/<64hex>`                | `builder/templates/owner.ts`                      | Builder (per-owner profile gallery) |
| `/products`, `/products/p/<N>` | `builder/templates/products.ts`                   | Builder |
| `/merch?d=<id>`                | `merch.html` + `src/merch.ts`                     | Picker (Vite) |
| `/merch/order/<uuid>`          | `order.html` + `src/order.ts`                     | Order status (Vite) |
| `/share?d=<id>`                | `share.html` + `src/share-page.ts`                | Reddit share (Vite) |
| `/pow-test`                    | `pow-test.html` + `src/pow-test.ts`               | Dev test bed (Vite) |
| `/identity`                    | `identity.html` (Vite-served, chrome via markers) | Fallback for the chrome identity link when localStorage has no pubkey |
| `/feed.rss`                    | `builder/templates/feed.ts`                       | Builder (RSS, no chrome) |
| `/canvases`                    | `builder/templates/canvases-archive.ts`           | Builder (archive: current canvas + past) |
| `/canvases/<canvas-id>`        | `builder/templates/canvas.ts`                     | Builder (16×16 tile grid; live for active, frozen for locked) |

The shared chrome (`src/layout/chrome.ts`, #102) renders the header + footer
for everything except `/feed.rss` (XML) and `/identity` (no page yet).
Vite-served pages get the chrome via the `<!--CHROME:HEADER-->` /
`<!--CHROME:FOOTER-->` markers + `vite/plugins/chrome.ts`. Builder pages call
`renderHeader` / `renderFooter` from the chrome module directly.

## Shared CSS (single source of truth)

Three CSS files, each owning a disjoint slice. **Do not duplicate rules
across them — the whole reason for this split is to stop the drift we
used to get from dual-maintaining `.hdr` / `.ftr` / `.btn` / tokens.**

| File                       | Owns                                                              | Loaded by                                              |
|----------------------------|-------------------------------------------------------------------|--------------------------------------------------------|
| `static/chrome.css`        | Design tokens (`:root`), base body/typography, header (`.hdr`+nav), footer (`.ftr`), `main` slot, page chrome (`.page-title`, `.divider`, ...), base `.btn` + `.primary` + `.ghost`. Everything `src/layout/chrome.ts` renders. | Both — `src/style.css` and `static/gallery-v2.css` each `@import url("/chrome.css")` at the top. |
| `src/style.css`            | Editor-surface extensions to the base reset (touch-first `user-select: none`, etc.), `.canvas-banner`, `.flash`, `.btn` variants (`.icon`/`.sm`/`.xs`/`[disabled]`/...), and every Vite-served page (editor `.ed-*`, merch `.mc-*`, order, share, identity, pow-test). | Vite-served pages only.                                |
| `static/gallery-v2.css`    | Builder-only classes: `.img-grid`, `.gal-archive-list`, `.pager`, `.dr-*`, `.pr-*`, `.mono-trunc`.                                                  | Builder templates (`/gallery-v2.css` link tag).        |

Rule of thumb when adding a class:
1. If `src/layout/chrome.ts` renders it → `chrome.css`.
2. If it's on a Vite-served HTML entry (index/merch/share/order/identity/pow-test) → `src/style.css`.
3. If it's only on a `builder/templates/*.ts` page → `static/gallery-v2.css`.

A change that affects both editor and builder surfaces (e.g. footer
margins, header height, button hover) belongs in `chrome.css`. If you
catch yourself editing `.hdr`/`.ftr`/`.btn` in `src/style.css` or
`static/gallery-v2.css`, stop — it's the wrong file.

## Repo layout

```
config/               Shared constants + POW difficulty table
  constants.ts        WIDTH=16, HEIGHT=16, MAX_FRAMES=16, PER_PAGE=36, etc.
  pow.json            Difficulty brackets, baseline_grace_s
  canvases.ts         TILES_PER_SIDE=16, CLAIM_TTL_S=1800, PUBLISH_COOLDOWN_S=900,
                      ISO-week canvas-id helpers (canvasIdForDate, opens/closes, tileKey).

src/                  Vite + TypeScript editor (ships to GitHub Pages)
  editor/             bitmap, canvas, tools, history, palette, gif
  pow.ts              sha256 PoW + contentHash (Node sync fast path + Web Crypto fallback)
  pow.worker.ts       WebWorker: bench + solve
  share.ts            URL-hash share codec (5 bpp, 17 pixel states)
  local.ts            IndexedDB "My drawings" store
  submit.ts           Bench, solve, POST to /ingest
  main.ts             Editor UI

ingest/               Shared ingest logic
  handler.ts          Core logic: validate → content-id → PoW check → write.
                      Canvas-aware: canvas_claim branch runs BEFORE the
                      idempotency short-circuit so the same gif can join
                      multiple canvases.
  gif-validate.ts     GIF89a header check, 16×16, ≤16 frames, DRAWBANG ext
  storage.ts          Storage interface + FsStorage (dev/tests)
  s3-storage.ts       S3Storage (Lambda + daily builder)
  canvas-store.ts     DDB wrapper (claimTile, publishTile, getTiles,
                      cooldownRemaining) + MemoryCanvasStore for dev/tests.
                      All multi-row writes via TransactWriteItems.
  canvas-handler.ts   POST /canvas/claim + GET /canvas/{id}/state.
  user-stats-store.ts DDB wrapper for per-pubkey streak + total counters
                      (#115/#116) + MemoryUserStatsStore for dev/tests.
  user-stats-handler.ts GET /keys/{pubkey}/stats — fresh counters + badges.
  lambda.ts           API Gateway v2 entry point — routes /ingest,
                      /canvas/claim, /canvas/{id}/state,
                      /keys/{pubkey}/stats.
  dev-server.ts       Node HTTP shim for `npm run ingest:dev` — uses
                      MemoryCanvasStore for canvas routes.

builder/              Daily batch job (incremental, day-partitioned)
  build.ts            Sweeps inbox/, publishes to public/, renders HTML.
                      Invokes canvas-pass.ts on every run.
  canvas-pass.ts      Weekly canvas rollover + lock + registry +
                      current-canvas.json state pointer + canvas/archive page
                      rendering. Idempotent; self-heals via ingest's lazy
                      manifest creation if a Monday builder run fails.
  templates/*.ts      Compiled render functions (tagged-literal HTML).
                      Includes products.ts which renders /products.html
                      from DynamoDB counters joined with config/merch.json,
                      canvas.ts (single-canvas page; active hydrates from
                      /canvas/{id}/state, locked is frozen), and
                      canvases-archive.ts.

infra/aws/
  template.yaml       SAM: Lambda + HTTP API + S3 bucket + IAM
  samconfig.toml      sam deploy defaults (stack: drawbang-ingest, us-east-1)
  build-lambda.mjs    esbuild bundler (externals @aws-sdk/*)

test/                 node:test suites (gif, pow, share, ingest, builder)
scripts/
  smoke-ingest.ts     End-to-end smoke test against a deployed endpoint

docs/
  identity-considerations.md  Notes on extending the Ed25519 scheme
                              (domain separation, passkey feasibility)
  gotchas.md                  Build / deploy / SDK quirks worth knowing —
                              consult before debugging anything obscure.

.github/workflows/
  deploy.yml          CI: typecheck + test + sam deploy + build + pages deploy

legacy/               Archived Ruby app; read-only reference, never imported
```

## Critical invariants — don't break these

- **Drawing id is content-addressed on gif bytes alone.**
  `id = hex(sha256(gif_bytes))`. Same drawing → same id, regardless of PoW.
  PoW stays required but lives in metadata as `pow = hex(sha256(gif ‖ baseline ‖ nonce))`.
- **GIF format is fixed.** 16×16, ≤16 frames, 5 FPS (200 ms delay), GCT has 32
  entries: slots 0..15 = active palette RGB, slot 16 = transparent, 17..31 = 0.
- **DRAWBANG Application Extension** (in `src/editor/gif.ts`): app identifier
  `"DRAWBANG"` (8 bytes) + auth `"1.0"` (3 bytes) + one 16-byte sub-block of
  base-palette indices.
- **Builder is day-partitioned and incremental.** Once day `D` is finalized
  (the builder has run for `D+1`), nothing in `public/days/<D>/` is rewritten.
  The only files that change on every run are `public/gallery.html` and
  `public/feed.rss`.
- **Difficulty is computed against `req.baseline`, not current state.** Concurrent
  solvers racing on the same baseline must both succeed. `baselineHistory`
  lives at module scope in `ingest/lambda.ts` — best-effort, per-container.
- **`public/state/last-publish.json`** is written only by the ingest handler.
- **Canvas tile state lives in DynamoDB**, never in S3. S3 has no CAS, so
  two concurrent publishes that read-modify-write a `state.json` will
  clobber. `drawbang-canvas-tiles` (claims/publishes) and
  `drawbang-canvas-cooldowns` (per-pubkey-per-canvas) are the sole source
  of truth; the canvas page hydrates from `GET /canvas/{id}/state`.
- **Soft-claim TTL is enforced by the conditional write**, not a background
  job. The tile row stores `claim_expires_at` (epoch); every claim/publish
  conditional compares it inline against `:now`. DDB TTL (`ttl_epoch`) is
  for housekeeping after canvases close, not for correctness.
- **Claim PoW exists**. Without it, a takeover attacker keygens → claims →
  keygens → claims → … for free. `POST /canvas/claim` requires a PoW over
  `claim:<canvas_id>:<x>:<y>:<pubkey>:<baseline>:<nonce>` at the same
  difficulty curve as publish PoW, per-canvas baseline.
- **`handleIngest` runs canvas_claim BEFORE the idempotency short-circuit.**
  Drawing ids are content-addressed (`sha256(gif_bytes)`), so the same gif
  can legitimately appear in multiple canvases. The early-return on
  `exists(publishedKey)` is gated on `!canvas_claim` — the canvas branch
  always proceeds to update DDB + the canvases sidecar + drawing page.
- **Drawing's canvas memberships live in `public/drawings/<id>.canvases.json`**,
  not in the immutable inbox/day metadata. Each entry attributes the tile
  use to its `claimed_by`, NOT the original drawing author. The drawing
  page renders the claimer's pubkey so the original author isn't implicated
  when key A puts key B's gif in a canvas.

## Commands

```
npm run dev            # Vite dev server (editor only)
npm run dev:all        # Vite + ingest dev server together — full e2e loop
npm run build          # tsc -b + vite build -> dist/
npm run typecheck      # tsc -b --noEmit
npm test               # node:test across test/**/*.test.ts
npm run builder        # Run the builder (S3 if DRAWBANG_S3_BUCKET set, else ./dev-bucket)
npm run ingest:dev     # Node ingest server on :8787 (FsStorage)
npm run lambda:build   # esbuild the Lambda → dist-lambda/
npm run lambda:deploy  # lambda:build + sam deploy
```

### Local e2e loop

`npm run dev:all` starts Vite on :5173 and the ingest dev server on :8787 in
one shell. Together they let you exercise the publish path end-to-end against
the filesystem:

1. Open http://localhost:5173 — generate an identity if you don't have one.
2. Draw, then **Publish**. The ingest server writes to `./dev-bucket/`, runs
   `build()` inline, and logs `[builder] rebuilt in <Xms>`.
3. Visit `/gallery`, `/d/<id>`, or `/keys/<pubkey>` — the dev-bucket Vite
   plugin (`vite/plugins/dev-bucket.ts`) serves them from
   `./dev-bucket/public/` using the same clean-URL rewrites as the prod
   CloudFront Function.

The Vite config also proxies `/ingest` and `/state/last-publish.json` to
`:8787`, so the editor's default relative URLs (`VITE_INGEST_URL=/ingest`,
etc.) work without overrides. The merch / order / products surfaces still
depend on DynamoDB and Stripe in prod — they're out of scope for local e2e.

Ingest tests do real PoW at 16 bits and can take 30-60s each. Non-ingest tests
finish in <2s — iterate with: `node --test --import tsx 'test/gif.test.ts' 'test/pow.test.ts' 'test/share.test.ts' 'test/builder.test.ts'`.

## Environment variables

Editor (build-time):
- `VITE_INGEST_URL` — API Gateway URL for the ingest Lambda.
- `VITE_STATE_URL` — `${cloudfront-domain}/state/last-publish.json`.
- `VITE_DRAWING_BASE_URL` — `${cloudfront-domain}/drawings`.

Lambda (runtime, set via SAM):
- `DRAWBANG_BUCKET` — S3 bucket name.
- `PUBLIC_BASE_URL` — `https://${cloudfront-domain}`. Goes into `share_url`.
- `REPO_URL` — for the footer link on the synchronously-rendered drawing page.
- `DRAWBANG_CANVAS_TILES_TABLE` — DynamoDB table for tile claims (default
  `drawbang-canvas-tiles`).
- `DRAWBANG_CANVAS_COOLDOWNS_TABLE` — DynamoDB table for per-pubkey-
  per-canvas publish cooldowns (default `drawbang-canvas-cooldowns`).
- `DRAWBANG_USER_STATS_TABLE` — DynamoDB table for per-pubkey streak +
  total counters (#115/#116, default `drawbang-user-stats`).

Builder CLI:
- `DRAWBANG_S3_BUCKET` — if set, uses S3Storage; otherwise FsStorage at `DRAWBANG_BUCKET`.
- `DRAWBANG_PUBLIC_BASE` — RSS feed self-link + share URL origin.
- `DRAWBANG_REPO_URL` — repo URL for footer (default: `https://github.com/potomak/drawbang`).
- `DRAWBANG_TODAY` — override "today" (YYYY-MM-DD) for testing.
- `DRAWBANG_FORCE_RERENDER` — `1` to re-render every day's HTML from index.jsonl.
- `DRAWBANG_PRODUCT_COUNTERS_TABLE` — DynamoDB table for the /products gallery
  (default `drawbang-product-counters`). Only read when `DRAWBANG_S3_BUCKET` is
  set; local dev with FsStorage skips the /products surface.
- `DRAWBANG_USER_STATS_TABLE` — DynamoDB table read for the streaks/badges
  block on `/keys/<pubkey>.html` (default `drawbang-user-stats`). Only read
  when `DRAWBANG_S3_BUCKET` is set; local dev with FsStorage omits the block.

## AWS deployment

One-time setup:
1. Create IAM user with `AWSLambda_FullAccess`, `AmazonS3FullAccess`,
   `AmazonAPIGatewayAdministrator`, `AWSCloudFormationFullAccess`,
   `IAMFullAccess`, `AmazonDynamoDBFullAccess`, and `CloudFrontFullAccess`.
   (DynamoDB is needed once the merch stack adds `OrdersTable`; CloudFront is
   needed for distribution + function updates.)
2. GitHub secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
   `PRINTIFY_API_TOKEN`, `PRINTIFY_SHOP_ID`, `STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET`.
3. First deploy happens automatically on push to `master`. SAM creates the S3
   bucket, Lambda, HTTP API, DynamoDB orders table, and IAM role.

API Gateway URL appears in `sam deploy` output as `IngestEndpoint`. Update the
`INGEST_URL` env in `.github/workflows/deploy.yml` if it ever changes.

## Conventions

- TypeScript strict; don't loosen `tsconfig.json` without a reason.
- No comments explaining WHAT — only WHY, and only when non-obvious.
- Tests use `node:test` + `tsx`; don't introduce a test framework dependency.
- Storage operations must go through the `Storage` interface so `FsStorage`
  (dev/tests) and `S3Storage` (Lambda/builder) stay interchangeable.
- **Merge directly to `master`** when a change is green (typecheck + tests
  pass). No PR review gate, no long-lived feature branches. The deploy
  workflow runs on every push to `master`. If you do work on a feature
  branch (e.g. for handoff between sessions), fast-forward merge it into
  `master` as soon as it's ready and push.

## UI / UX consistency (paramount)

Before introducing any visible UI affordance — toast, modal, button
variant, status strip, banner, picker, page title style, link hover, etc. —
**search the repo first** for an existing implementation. Reuse beats new.

Specifically:
- Cross-surface notifications: `src/layout/flash.ts` (Vite consumers) +
  `static/flash.js` (`window.drawbangFlash`, loaded as a plain script by
  builder-rendered pages, e.g. `/d/<id>`). Styles live in `chrome.css` so
  every surface picks them up via the existing import chain.
- Cross-surface chrome (header, footer, nav, identity link, hamburger
  toggle): `src/layout/chrome.ts` + the `<!--CHROME:HEADER-->` /
  `<!--CHROME:FOOTER-->` markers for Vite pages; `renderHeader` /
  `renderFooter` called directly from `builder/templates/*.ts`.
- Buttons: `.btn` / `.primary` / `.ghost` in `chrome.css` (works on both
  `<a>` and `<button>`). Variants `.icon` / `.sm` / `.xs` in `src/style.css`
  (Vite surfaces only).
- Tracking: `src/layout/tracking.ts` (`renderAnalytics`, `renderMetaPixel`)
  is the single source for both GA and Meta Pixel snippets.
- Per-page status / progress / "X copied" confirmations: the flash system
  above — never invent a new toast/snackbar/banner.

When you find that a new surface (e.g. a builder-rendered page) doesn't
have access to a Vite-only helper, **prefer lifting it to the shared layer
over writing a parallel implementation**. The lift pattern is documented:
hand-port to `static/<name>.js` (plain JS, exposes a `window.drawbang*`
global), move its CSS to `chrome.css`, load via `<script src="/<name>.js">`.
This is how `chrome-toggle.js` / `chrome-identity.js` already work.

If reuse genuinely isn't viable (e.g. the surface needs a different
interaction model), say so explicitly in the commit message and ask before
proceeding — divergent UX is harder to walk back than a slightly bigger
refactor.
