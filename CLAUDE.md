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
  editor + gallery HTML         →  GitHub Pages (potomak.github.io/drawbang)
  drawing gifs + inbox + state  →  S3 (drawbang-assets, us-east-1)
  POST /ingest                  →  AWS Lambda + API Gateway HTTP API
  daily gallery rebuild         →  GitHub Actions cron (reads/writes S3)
```

No Cloudflare anymore. No persistent webserver.

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
  templates/*.ts      Compiled render functions (tagged-literal HTML)

infra/aws/
  template.yaml       SAM: Lambda + HTTP API + S3 bucket + IAM
  samconfig.toml      sam deploy defaults (stack: drawbang-ingest, us-east-1)
  build-lambda.mjs    esbuild bundler (externals @aws-sdk/*)

test/                 node:test suites (gif, pow, share, ingest, builder)
scripts/
  smoke-ingest.ts     End-to-end smoke test against a deployed endpoint

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
- `VITE_STATE_URL` — URL of `last-publish.json` on S3.
- `VITE_DRAWING_BASE_URL` — S3 URL prefix for drawing gifs.
- `VITE_BASE` — Vite public path; `/drawbang/` on GitHub Pages.

Lambda (runtime, set via SAM):
- `DRAWBANG_BUCKET` — S3 bucket name.
- `PUBLIC_BASE_URL` — goes into `share_url` in the response.
- `DRAWINGS_BASE_URL` — absolute URL prefix for drawing gifs in rendered HTML.

Builder CLI:
- `DRAWBANG_S3_BUCKET` — if set, uses S3Storage; otherwise FsStorage at `DRAWBANG_BUCKET`.
- `DRAWBANG_PUBLIC_BASE` — RSS feed self-link + share URL origin.
- `DRAWBANG_DRAWINGS_BASE` — absolute URL prefix for drawing gifs in rendered HTML.
- `DRAWBANG_TODAY` — override "today" (YYYY-MM-DD) for testing.
- `DRAWBANG_FORCE_RERENDER` — `1` to re-render every day's HTML from index.jsonl.

## AWS deployment

One-time setup:
1. Create IAM user with `AWSLambda_FullAccess`, `AmazonS3FullAccess`,
   `AmazonAPIGatewayAdministrator`, `AWSCloudFormationFullAccess`, `IAMFullAccess`.
2. GitHub secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
3. First deploy happens automatically on push to `master`. SAM creates the S3
   bucket, Lambda, HTTP API, and IAM role.

API Gateway URL appears in `sam deploy` output as `IngestEndpoint`. Update the
`INGEST_URL` env in `.github/workflows/deploy.yml` if it ever changes.

## Conventions

- TypeScript strict; don't loosen `tsconfig.json` without a reason.
- No comments explaining WHAT — only WHY, and only when non-obvious.
- Tests use `node:test` + `tsx`; don't introduce a test framework dependency.
- Storage operations must go through the `Storage` interface so `FsStorage`
  (dev/tests) and `S3Storage` (Lambda/builder) stay interchangeable.
