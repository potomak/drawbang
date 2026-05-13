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

The shared chrome (`src/layout/chrome.ts`, #102) renders the header + footer
for everything except `/feed.rss` (XML) and `/identity` (no page yet).
Vite-served pages get the chrome via the `<!--CHROME:HEADER-->` /
`<!--CHROME:FOOTER-->` markers + `vite/plugins/chrome.ts`. Builder pages call
`renderHeader` / `renderFooter` from the chrome module directly.

## Repo layout

```
config/               Shared constants + POW difficulty table
  constants.ts        WIDTH=16, HEIGHT=16, MAX_FRAMES=16, PER_PAGE=36, etc.
  pow.json            Difficulty brackets, baseline_grace_s

src/                  Vite + TypeScript editor (ships to GitHub Pages)
  editor/             bitmap, canvas, tools, history, palette, gif
  pow.ts              sha256 PoW + contentHash (Node sync fast path + Web Crypto fallback)
  pow.worker.ts       WebWorker: bench + solve
  share.ts            URL-hash share codec (5 bpp, 17 pixel states)
  local.ts            IndexedDB "My drawings" store
  submit.ts           Bench, solve, POST to /ingest
  main.ts             Editor UI

ingest/               Shared ingest logic
  handler.ts          Core logic: validate → content-id → PoW check → write
  gif-validate.ts     GIF89a header check, 16×16, ≤16 frames, DRAWBANG ext
  storage.ts          Storage interface + FsStorage (dev/tests)
  s3-storage.ts       S3Storage (Lambda + daily builder)
  lambda.ts           API Gateway v2 entry point
  dev-server.ts       Node HTTP shim for `npm run ingest:dev`

builder/              Daily batch job (incremental, day-partitioned)
  build.ts            Sweeps inbox/, publishes to public/, renders HTML
  templates/*.ts      Compiled render functions (tagged-literal HTML).
                      Includes products.ts which renders /products.html
                      from DynamoDB counters joined with config/merch.json.

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

## Commands

```
npm run dev            # Vite dev server (editor)
npm run build          # tsc -b + vite build -> dist/
npm run typecheck      # tsc -b --noEmit
npm test               # node:test across test/**/*.test.ts
npm run builder        # Run the builder (S3 if DRAWBANG_S3_BUCKET set, else ./dev-bucket)
npm run ingest:dev     # Node ingest server on :8787 (FsStorage)
npm run lambda:build   # esbuild the Lambda → dist-lambda/
npm run lambda:deploy  # lambda:build + sam deploy
```

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

Builder CLI:
- `DRAWBANG_S3_BUCKET` — if set, uses S3Storage; otherwise FsStorage at `DRAWBANG_BUCKET`.
- `DRAWBANG_PUBLIC_BASE` — RSS feed self-link + share URL origin.
- `DRAWBANG_REPO_URL` — repo URL for footer (default: `https://github.com/potomak/drawbang`).
- `DRAWBANG_TODAY` — override "today" (YYYY-MM-DD) for testing.
- `DRAWBANG_FORCE_RERENDER` — `1` to re-render every day's HTML from index.jsonl.
- `DRAWBANG_PRODUCT_COUNTERS_TABLE` — DynamoDB table for the /products gallery
  (default `drawbang-product-counters`). Only read when `DRAWBANG_S3_BUCKET` is
  set; local dev with FsStorage skips the /products surface.

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
