# CLAUDE.md

Orientation for future Claude sessions on this repo.

## What this is

Drawbang is a pixel art editor + public gallery built from a 16×16 tile atom.
The stack is static-first: a browser editor, a tiny proof-of-work-gated ingest
endpoint, and a daily batch job that regenerates the gallery as static HTML.

Identity is an **email/password account** (replaced the original anonymous
Ed25519 keypair scheme). The gallery is publicly viewable and you can draw
locally without an account, but **publishing and mural tile claims require a
logged-in account**. Sessions are stateless HS256 JWTs; the public handle is a
chosen **username** (profiles live at `/u/<username>`). See "Identity model".

The original Ruby/Sinatra/Redis/RMagick app is archived under `legacy/` and is
not imported by any current code.

## Tile / canvas / mural model

Three nouns, one shared atom. **Get these straight before touching anything.**

- **Tile** — the 16×16 atom: a standard DRAWBANG GIF, content-addressed
  (`tile_id = sha256(gif_bytes)`). Canonical page `/t/<tile_id>`
  (`builder/templates/tile-page.ts`), asset `public/tiles/<id>.gif`. This is the
  single-gif page that **replaced the old `/d/<id>` drawing page**; `/d/<id>`
  now 301-redirects to `/t/<id>` and `/drawings/<id>.gif` rewrites to
  `/tiles/<id>.gif` at the edge.
- **Canvas** — a personal drawing = an ordered `cols×rows` grid (1×1 up to 4×4)
  of tiles. `canvas_id = sha256(canonical_manifest)`. Page `/c/<canvas_id>`
  (`builder/templates/canvas-page.ts`), manifest `public/c/<id>.json`. **Every
  editor publish is a canvas** (a plain 16×16 is a 1-tile canvas) — the editor
  POSTs `/canvas`, never `/ingest`. `config/canvas.ts` holds the caps + manifest
  helpers; `src/editor/canvas-doc.ts` is the in-editor model; `src/submit.ts`
  `publishCanvas()` encodes + one PoW over the canonical manifest.
- **Mural** — the *collaborative* weekly grid (renamed from the original
  "canvas" concept), 16×16 tiles at `/murals` + `/murals/<mural-id>`. A mural
  cell references a tile; placing a tile into a cell goes through `/ingest` with
  a `mural_claim`. Tile-claim state lives in DynamoDB (`drawbang-mural-*`).

`src/canvas-composite.ts` flattens a canvas's tiles into a square, letterboxed
`Bitmap` stack — shared by the merch preview (client) and print asset (server)
so they stay in lock-step. `ingest/stitch.ts` builds the raster composites
(animated GIF + static PNG) for canvas thumbnails / OG.

## Deployment shape

```
  editor + gallery + gifs + state  →  S3 (drawbang-assets, us-east-1)
                                       fronted by CloudFront for HTTPS + cache
  POST /ingest                     →  AWS Lambda + API Gateway HTTP API
  daily gallery rebuild            →  GitHub Actions cron (reads/writes S3)
```

Single origin: everything serves from the CloudFront distribution (e.g.
`d3te69flws96uk.cloudfront.net`). The S3 bucket is locked down to the
distribution via Origin Access Control. A CloudFront Function rewrites clean
URLs (`/gallery`, `/t/<id>`, `/c/<id>`, `/days/<d>/p/<n>`, `/murals/...`) to the
underlying `.html` files, 301s legacy `/d/<id>` → `/t/<id>`, and rewrites legacy
`/drawings/<id>.gif` → `/tiles/<id>.gif`. No GH Pages, no Cloudflare, no
persistent webserver.

## Pages of the app

Single source of truth. Any cross-page change (new nav link, new shared
asset, new tracking script) must consider every entry below.

| URL                            | Rendered by                                       | Surface |
|--------------------------------|---------------------------------------------------|---------|
| `/`                            | `index.html` + `src/main.ts`                      | Editor (Vite) |
| `/gallery`                     | `builder/templates/gallery.ts` → `gallery.html`   | Builder |
| `/days/<YYYY-MM-DD>/p/<N>`     | `builder/templates/day-gallery.ts`                | Builder |
| `/t/<64hex>`                   | `builder/templates/tile-page.ts`                  | Builder + sync-rendered by ingest on publish (the single-gif page; `/d/<id>` 301s here) |
| `/c/<64hex>`                   | `builder/templates/canvas-page.ts`                | Builder + sync-rendered by the `/canvas` publish handler |
| `/u/<username>`                | `builder/templates/owner.ts`                      | Builder (per-account profile gallery: drawings + canvases) |
| `/products`, `/products/p/<N>` | `builder/templates/products.ts`                   | Builder |
| `/merch?d=<tile>` / `?c=<canvas>` | `merch.html` + `src/merch.ts`                  | Picker (Vite); `?d=` single tile, `?c=` canvas composite |
| `/merch/order/<uuid>`          | `order.html` + `src/order.ts`                     | Order status (Vite) |
| `/pow-test`                    | `pow-test.html` + `src/pow-test.ts`               | Dev test bed (Vite) |
| `/login`                       | `login.html` + `src/login.ts`                     | Auth (Vite) |
| `/signup`                      | `signup.html` + `src/signup.ts`                   | Auth (Vite) |
| `/reset`                       | `reset.html` + `src/reset.ts`                     | Password reset request + confirm (Vite) |
| `/account`                     | `account.html` + `src/account.ts`                 | Logged-in account / sign-out (Vite) |
| `/feed.rss`                    | `builder/templates/feed.ts`                       | Builder (RSS, no chrome) |
| `/murals`                      | `builder/templates/murals-archive.ts`             | Builder (archive: current mural + past) |
| `/murals/<mural-id>`           | `builder/templates/mural.ts`                      | Builder (16×16 tile grid; live for active, frozen for locked) |

The shared chrome (`src/layout/chrome.ts`, #102) renders the header + footer
for everything except `/feed.rss` (XML). Vite-served pages get the chrome via
the `<!--CHROME:HEADER-->` / `<!--CHROME:FOOTER-->` markers +
`vite/plugins/chrome.ts`. Builder pages call `renderHeader` / `renderFooter`
from the chrome module directly. The chrome's identity link defaults to
`/login` ("Sign in") and is rewritten client-side to `/u/<username>`
("Profile") by `static/chrome-identity.js` when `localStorage["drawbang:username"]`
is present.

## Identity model

- **Account** = email (private, unique, login key) + password + a chosen
  **username** (public, unique, immutable in v1) + a stable random 64-hex
  `user_id`. Stored in DynamoDB `drawbang-users` (PK email); `drawbang-usernames`
  reserves the handle. Registration writes both in one `TransactWriteItems`.
- **Password hashing**: scrypt (`ingest/password.ts`), built-in, no native dep.
- **Sessions**: stateless HS256 JWT (`ingest/jwt.ts`), `{ sub: user_id, un:
  username }`, ~30-day exp, signed with `JWT_SECRET`. Client keeps it in
  `localStorage["drawbang:jwt"]` and mirrors the username to
  `localStorage["drawbang:username"]`. Publish/claim send `Authorization:
  Bearer <jwt>`; the route verifies signature + exp (no DB read) and passes
  `{ user_id, username }` into the handlers.
- **Password reset**: `ingest/email.ts` sends a link via SES carrying a 1h
  reset-JWT (`{ email, tv: token_version, purpose: "reset" }`). Confirm checks
  `tv === token_version` then bumps `token_version`, making the link single-use.
  No signup email verification. Reset requests always return 200 (no email
  enumeration).
- **Auth surface**: `src/auth.ts` (client), `ingest/auth-handler.ts` (server),
  routes `POST /auth/{register,login,reset/request,reset/confirm}`.
- Tile/canvas metadata stores `user_id` + `username`; the tile page, canvas
  page, and mural memberships link authors to `/u/<username>`. Legacy
  keypair-published gifs (fresh start) keep no `username` and render as
  "anonymous" with no profile.

## Shared CSS (single source of truth)

Three CSS files, each owning a disjoint slice. **Do not duplicate rules
across them — the whole reason for this split is to stop the drift we
used to get from dual-maintaining `.hdr` / `.ftr` / `.btn` / tokens.**

| File                       | Owns                                                              | Loaded by                                              |
|----------------------------|-------------------------------------------------------------------|--------------------------------------------------------|
| `static/chrome.css`        | Design tokens (`:root`), base body/typography, header (`.hdr`+nav), footer (`.ftr`), `main` slot, page chrome (`.page-title`, `.divider`, ...), base `.btn` + `.primary` + `.ghost`. Everything `src/layout/chrome.ts` renders. | Both — `src/style.css` and `static/gallery-v2.css` each `@import url("/chrome.css")` at the top. |
| `src/style.css`            | Editor-surface extensions to the base reset (touch-first `user-select: none`, etc.), `.canvas-banner`, `.btn` variants (`.icon`/`.sm`/`.xs`/`[disabled]`/...), and every Vite-served page (editor `.ed-*`, merch `.mc-*`, order, identity, pow-test). | Vite-served pages only.                                |
| `static/gallery-v2.css`    | Builder-only classes: `.img-grid`, `.gal-archive-list`, `.pager`, `.dr-*`, `.pr-*`, `.mono-trunc`.                                                  | Builder templates (`/gallery-v2.css` link tag).        |

Rule of thumb when adding a class:
1. If `src/layout/chrome.ts` renders it → `chrome.css`.
2. If it's on a Vite-served HTML entry (index/merch/order/identity/pow-test) → `src/style.css`.
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
  canvas.ts           Personal-canvas caps (CANVAS_MAX_COLS/ROWS=4) + manifest
                      helpers: canonicalCanvasString, canvasIdFor (sha256).
  murals.ts           Collaborative weekly grid: TILES_PER_SIDE=16, CLAIM_TTL_S,
                      PUBLISH_COOLDOWN_S, ISO-week mural-id helpers (muralIdForDate,
                      opens/closes, tileKey).

src/                  Vite + TypeScript editor
  editor/             bitmap, canvas (PixelCanvas), canvas-doc (multi-tile model),
                      tools, history, palette, gif, frames, share-gif
  canvas-composite.ts Flatten a canvas's tiles → square letterboxed Bitmap stack
                      (shared by merch preview + print asset).
  pow.ts              sha256 PoW + contentHash (Node sync fast path + Web Crypto fallback)
  pow.worker.ts       WebWorker: bench + solve (publish + mural claim)
  share.ts            URL-hash share codec (5 bpp, 17 pixel states)
  local.ts            IndexedDB "My drawings" store
  auth.ts             Client session: register/login/reset, JWT in localStorage,
                      authHeader() for publish/claim, getSession/logout.
  login.ts/signup.ts/reset.ts/account.ts  Auth page controllers (Vite entries)
  submit.ts           publishCanvas() → POST /canvas; submit() → POST /ingest
                      (mural tile claim). Both bench/solve with Bearer auth.
  mural-banner.ts     Home-page mural status banner.
  merch.ts/merch-preview.ts/order.ts  Merch picker (?d= tile / ?c= canvas) + order status
  main.ts             Editor UI (publish gated on a logged-in session)

ingest/               Shared ingest logic
  handler.ts          POST /ingest (mural tile claim path): validate → content-id
                      → PoW → write tile (public/tiles/) + render /t page. Identity
                      from cfg.auth ({user_id, username}) set by the route after
                      JWT verification. mural_claim branch runs BEFORE the
                      idempotency short-circuit so the same gif can join multiple
                      murals.
  canvas-publish-handler.ts  POST /canvas: validate shape + each tile gif, dedup
                      tiles to public/tiles/, ONE PoW over the canonical manifest,
                      write public/c/<id>.json + sync-render /c + /t pages + OG.
  stitch.ts           Raster composites for canvas thumbs/OG: stitchCompositeGif
                      (animated, merged palette, ≤255 colours) + stitchCompositePng.
  jwt.ts              HS256 sign/verify (Node crypto, no dep) for sessions + reset.
  password.ts         scrypt hash/verify.
  user-store.ts       DDB wrapper for accounts (register via TransactWriteItems,
                      getByEmail, updatePassword) + MemoryUserStore. Tables:
                      drawbang-users (PK email), drawbang-usernames (PK username).
  email.ts            SES password-reset sender + ConsoleEmailSender (dev stub).
  auth-handler.ts     POST /auth/{register,login,reset/request,reset/confirm}.
  gif-validate.ts     GIF89a header check, 16×16, ≤16 frames, DRAWBANG ext
  storage.ts          Storage interface + FsStorage (dev/tests)
  s3-storage.ts       S3Storage (Lambda + daily builder)
  mural-store.ts      DDB wrapper (claimTile, publishTile, getTiles,
                      cooldownRemaining) + MemoryMuralStore for dev/tests.
                      All multi-row writes via TransactWriteItems. Keyed on user_id.
  mural-handler.ts    POST /mural/claim (auth via cfg.auth) + GET /mural/{id}/state.
  murals-sidecar.ts   public/tiles/<id>.murals.json — a tile's mural memberships.
  user-stats-store.ts DDB wrapper for per-account streak + total counters
                      (#115/#116) + MemoryUserStatsStore for dev/tests.
  user-stats-handler.ts GET /users/{user_id}/stats — fresh counters + badges.
  lambda.ts           API Gateway v2 entry point — routes /ingest, /canvas,
                      /mural/claim, /mural/{id}/state, /users/{user_id}/stats,
                      /auth/*. Verifies the Bearer JWT for /ingest + /canvas + /mural/claim.
  dev-server.ts       Node HTTP shim for `npm run ingest:dev` — MemoryMuralStore
                      + MemoryUserStore + ConsoleEmailSender (reset link logged).

builder/              Daily batch job (incremental, day-partitioned)
  build.ts            Sweeps inbox/ (tiles → public/tiles/ + /t pages; canvas
                      records → /c pages + composites + rolling canvas index),
                      renders galleries/feed/profiles. Invokes mural-pass.ts on
                      every run.
  mural-pass.ts       Weekly mural rollover + lock + registry +
                      current-mural.json state pointer + mural/archive page
                      rendering. Idempotent; self-heals via ingest's lazy
                      manifest creation if a Monday builder run fails.
  templates/*.ts      Compiled render functions (tagged-literal HTML).
                      tile-page.ts (canonical single-gif page), canvas-page.ts
                      (multi-tile grid), products.ts (/products from DynamoDB
                      counters joined with config/merch.json), mural.ts
                      (single-mural page; active hydrates from /mural/{id}/state,
                      locked is frozen), and murals-archive.ts.

infra/aws/
  template.yaml       SAM: Lambda + HTTP API + S3 bucket + IAM
  samconfig.toml      sam deploy defaults (stack: drawbang-ingest, us-east-1)
  build-lambda.mjs    esbuild bundler (externals @aws-sdk/*)

test/                 node:test suites (gif, pow, share, ingest, builder)
scripts/
  smoke-ingest.ts     End-to-end smoke test against a deployed endpoint

docs/
  identity-considerations.md  Account model: JWT sessions, scrypt, reset flow,
                              and the security trade-offs taken.
  gotchas.md                  Build / deploy / SDK quirks worth knowing —
                              consult before debugging anything obscure.

.github/workflows/
  deploy.yml          CI: typecheck + test + sam deploy + build + pages deploy

legacy/               Archived Ruby app; read-only reference, never imported
```

## Critical invariants — don't break these

- **Tile id is content-addressed on gif bytes alone.**
  `tile_id = hex(sha256(gif_bytes))`. Same gif → same id, regardless of PoW.
  PoW stays required but lives in metadata as `pow = hex(sha256(gif ‖ baseline ‖ nonce))`.
  A **canvas id** is content-addressed on its manifest: `canvas_id =
  sha256(canonicalCanvasString({cols, rows, tiles}))` (`config/canvas.ts`).
- **Single-gif page is `/t/<id>`, not `/d/<id>`.** The drawing page was retired
  in the tile unification; `/d/<id>` 301s to `/t/<id>` and gifs live at
  `public/tiles/<id>.gif` (legacy `/drawings/<id>.gif` rewrites to it). Clean
  cutover — old `/d` HTML + `/drawings/` assets were left as orphans, not
  backfilled.
- **Identity comes from the verified session JWT, never the request body.**
  The route (`ingest/lambda.ts` / `ingest/dev-server.ts`) verifies the Bearer
  JWT and passes `{ user_id, username }` into `handleIngest` /
  `handleCanvasPublish` / `handleMuralClaim` via `cfg.auth`. A missing/invalid
  token is a 401 before the handler runs.
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
- **Mural tile state lives in DynamoDB**, never in S3. S3 has no CAS, so
  two concurrent publishes that read-modify-write a `state.json` will
  clobber. `drawbang-mural-tiles` (claims/publishes) and
  `drawbang-mural-cooldowns` (per-user_id-per-mural) are the sole source
  of truth; the mural page hydrates from `GET /mural/{id}/state`.
- **Soft-claim TTL is enforced by the conditional write**, not a background
  job. The tile row stores `claim_expires_at` (epoch); every claim/publish
  conditional compares it inline against `:now`. DDB TTL (`ttl_epoch`) is
  for housekeeping after murals close, not for correctness.
- **Claim PoW exists**. Per-action PoW (not identity) is what bounds tile
  takeover, since account creation is cheap (no signup verification).
  `POST /mural/claim` requires a PoW over
  `claim:<mural_id>:<x>:<y>:<user_id>:<baseline>:<nonce>` at the same
  difficulty curve as publish PoW, per-mural baseline.
- **`handleIngest` runs mural_claim BEFORE the idempotency short-circuit.**
  Tile ids are content-addressed (`sha256(gif_bytes)`), so the same gif
  can legitimately appear in multiple murals. The early-return on
  `exists(publishedKey)` is gated on `!mural_claim` — the mural branch
  always proceeds to update DDB + the murals sidecar + tile page.
- **A tile's mural memberships live in `public/tiles/<id>.murals.json`**,
  not in the immutable inbox/day metadata. Each entry stores `claimed_by`
  (`user_id`) + `claimed_by_username`; the tile page links the claimer to
  `/u/<username>`. (With one identity per request the claimer equals the
  publishing author.)
- **Canvas publish runs ONE PoW over the whole manifest**, not per tile, and
  is idempotent on `canvas_id` (re-publishing the same manifest → 200). Tiles
  are deduped to `public/tiles/<tile_id>.gif`; the same tile can appear in many
  canvases / murals.

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

1. Open http://localhost:5173 — visit `/signup` and create an account (the
   dev server uses an in-memory `MemoryUserStore`, so accounts reset on restart).
2. Draw, then **Publish** (requires a session; otherwise you're sent to
   `/login`). The ingest server writes to `./dev-bucket/`, runs `build()`
   inline, and logs `[builder] rebuilt in <Xms>`.
3. Visit `/gallery`, `/c/<id>`, `/t/<id>`, or `/u/<username>` — the dev-bucket
   Vite plugin (`vite/plugins/dev-bucket.ts`) serves them from
   `./dev-bucket/public/` using the same clean-URL rewrites (and `/d`→`/t`
   redirect) as the prod CloudFront Function.
4. **Forgot password**: `/reset` → the ingest dev server logs the reset link to
   its console (`[email] password reset for …`). Open it to set a new password.

The Vite config proxies `/ingest`, `/auth`, and `/state/last-publish.json` to
`:8787`, so the editor's default relative URLs (`VITE_INGEST_URL=/ingest`,
etc.) work without overrides. The merch / order / products surfaces still
depend on DynamoDB and Stripe in prod — they're out of scope for local e2e.

Ingest tests do real PoW at 16 bits and can take 30-60s each. Non-ingest tests
finish in <2s — iterate with: `node --test --import tsx 'test/gif.test.ts' 'test/pow.test.ts' 'test/share.test.ts' 'test/builder.test.ts'`.

## Environment variables

Editor (build-time):
- `VITE_INGEST_URL` — API Gateway URL for the ingest Lambda.
- `VITE_STATE_URL` — `${cloudfront-domain}/state/last-publish.json`.
- `VITE_DRAWING_BASE_URL` — `${cloudfront-domain}/tiles` (tile/fork/merch gif source).

Lambda (runtime, set via SAM):
- `DRAWBANG_BUCKET` — S3 bucket name.
- `PUBLIC_BASE_URL` — `https://${cloudfront-domain}`. Goes into `share_url`
  and the password-reset link.
- `REPO_URL` — for the footer link on the synchronously-rendered tile/canvas pages.
- `DRAWBANG_MURAL_TILES_TABLE` — DynamoDB table for mural tile claims (default
  `drawbang-mural-tiles`).
- `DRAWBANG_MURAL_COOLDOWNS_TABLE` — DynamoDB table for per-account-
  per-mural publish cooldowns (default `drawbang-mural-cooldowns`).
- `DRAWBANG_USER_STATS_TABLE` — DynamoDB table for per-account streak +
  total counters (#115/#116, default `drawbang-user-stats`).
- `DRAWBANG_USERS_TABLE` — accounts table (default `drawbang-users`).
- `DRAWBANG_USERNAMES_TABLE` — username reservations (default `drawbang-usernames`).
- `JWT_SECRET` — HS256 secret for session + reset JWTs. **Required**: the
  ingest function fails loud at cold start if unset.
- `SES_FROM_ADDRESS` — verified SES sender for reset emails. Optional; when
  empty, reset requests still 200 but no email is sent.

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
  block on `/u/<username>.html` (default `drawbang-user-stats`). Only read
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
   `STRIPE_WEBHOOK_SECRET`, `JWT_SECRET` (required for accounts), and
   `SES_FROM_ADDRESS` (optional, for reset emails).
3. First deploy happens automatically on push to `master`. SAM creates the S3
   bucket, Lambda, HTTP API, DynamoDB tables (orders, mural tiles + cooldowns,
   user-stats, users, usernames), and IAM role.
4. **SES setup** (for password reset): verify a sender identity (domain or
   address) in SES, set `SES_FROM_ADDRESS` to it, and — if the account is in
   the SES sandbox — request production access so resets reach arbitrary
   recipients. Until then, reset links only email pre-verified addresses.

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
  builder-rendered pages, e.g. `/t/<id>`). Styles live in `chrome.css` so
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
