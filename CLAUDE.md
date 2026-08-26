# CLAUDE.md

Orientation for Claude (and subagents) on this repo. Startup context is capped at 65 KiB — this file is intentionally compact. Deep detail lives in the source; pointers at the bottom tell you where to read on demand.

> **For subagents:** the first section is the contract — respect it. For everything else, follow the deep-reference pointers instead of guessing. If your task touches an area, open the listed source file first; don't infer from this summary alone.

## 0. Critical invariants — read first

These are the rules that silently break the product if violated. Every task, including subagents, must respect them.

- **Drawing id is content-addressed on gif bytes alone.** `drawing_id = hex(sha256(gif_bytes))`. Same bytes → same id, same `/tiles/<id>.gif` asset, regardless of who publishes. Idempotency is correct behavior (second publish of same bytes → 200, not 202).
- **Canonical URLs:** `/d/<64hex>` for pages, `/tiles/<id>.gif` for assets. `/t/<id>` 301s to `/d/<id>`; legacy `/drawings/<id>.gif` rewrites to `/tiles/<id>.gif` at the CloudFront edge. Never reintroduce `/t` as canonical.
- **Identity from the verified JWT only, never the body.** `Authorization: Bearer <jwt>` is verified in `ingest/routes.ts`/`lambda.ts` and passed as `cfg.auth = {user_id, username}` (or `null`). An invalid token → 401. The only route where _missing_ auth is not 401 is `POST /ingest` (falls back to the anonymous sentinel). Everywhere else missing = 401.
- **Anonymous sentinel is a byline, not an account.** `config/constants.ts` defines `ANONYMOUS_USERNAME`/`ANONYMOUS_USER_ID`/`isAnonymousUsername()`. No real account can claim `anonymous` (`RESERVED_USERNAMES` + `drawbang-usernames`). `/u/anonymous` and all sub-routes 404 via `isProfileRoutable()`. Anonymous drawings are readable everywhere (`/`, `/d/<id>`, `/feed.rss`, remixes, likes/bookmarks) but have no streak counters and `DELETE /drawings/<id>` on them is operator-only.
- **Profile pictures only point at own drawings.** `handleSetProfilePicture` requires `drawing.username === auth.username`. Anonymous drawings can never be claimed.
- **DrawingStore is the source of truth for all dynamic pages.** `POST /ingest` dual-writes S3 gif + `drawbang-drawings` row before returning. Render handlers (`ingest/render-handlers.ts`) query the store directly. Invalidations on `/`, `/u/<username>*`, `/feed.rss`, `/d/<id>*` keep the edge in sync.
- **GIF format is fixed.** ≤16 frames; per-drawing delay 80–250 ms (FPS slider 4–12; single-frame exempt); GCT = 32 entries (0..15 = palette, 16 = transparent, 17..31 = 0); `DRAWBANG` app extension (`src/editor/gif.ts`) must be present or `-large.gif` generation fails.
- **Publish response path does only what the response needs.** Sync: validate + hash + `HeadObject` + `PutObject` gif + concurrent DrawingStore row + streak counters + queue tail. Everything else (960×960 `-large.gif`, `-large.mp4` via ffmpeg, CloudFront invalidation) runs in the async tail `PostPublishEvent → runPostPublish` (`ingest/handler.ts`). Tail never throws; queue failure → inline fallback. Don't add sync work.
- **Hydration is the single read-side freshness channel.** `GET /hydrate?drawings=<csv>&users=<csv>` (`ingest/hydrate-handler.ts`, `static/hydrate.js`) patches edge-cached SSR markup with live `like_count`/`viewer_liked`/`viewer_bookmarked`/`follower_count`/`viewer_follows`. Adding a new "stale on feed" field = extend `HydrateBody` + populate handler + add `apply` case in `hydrate.js`. No new endpoint.
- **Proof-of-work gates only `POST /auth/register` and `POST /auth/password/forgot`.** Never gate `POST /ingest` or login. Single-use via `drawbang-challenges` conditional Put (DynamoDB). Failures return 400 with `challenge_*` codes (not 403 — CloudFront maps 403→404 HTML and destroys the body). See `ingest/challenge.ts`.
- **Likes/bookmarks/follows are toggle handlers with optimistic UI.** `ingest/*-store.ts` + `ingest/*-handler.ts` use `TransactWriteItems` to keep denormalized counts consistent. Left behind intentionally when a drawing/account is deleted.
- **Hard deletes, row before object.** `DELETE /drawings/<id>` and `ingest/account-delete.ts` delete the DrawingStore row first, then the three S3 objects (`<id>.gif`, `<id>-large.gif`, `<id>-large.mp4`), then one folded invalidation. Reverse order briefly leaves a broken-image row.
- **No new CloudFront path without API Gateway path.** Every dynamic path must be registered in both `ingest/routes.ts` and `infra/aws/template.yaml` (API Gateway `Events`). CloudFront `CacheBehaviors` only if the wildcard doesn't already cover it. Check both files before pushing.
- **CSS ownership is strict.** `static/chrome.css` owns tokens + chrome + base `.btn`/`.badge`. `src/style.css` owns Vite-page editor/merch/auth styles. `static/gallery-v2.css` owns Lambda-rendered page styles. Don't duplicate across them. See "Shared CSS" pointer below.
- **Deleted history stays deleted.** `legacy/` and the removed concepts (keypair-anonymous, multi-tile canvas, weekly murals, daily static-builder cron, PoW on publish) must not be reintroduced without explicit discussion.

## 1. What this is (30s version)

Drawbang — pixel art editor + public gallery. Static Vite SPAs (editor, auth, merch/order) + S3 + CloudFront + one Lambda for ingest and all dynamic HTML/JSON. Single origin (`pixel.drawbang.com`). S3 locked via OAC. CloudFront Function rewrites clean URLs (`/login`, `/signup`, `/password/*`, `/account`, `/merch`, `/privacy`, `/404` → `*.html`; `/drawings/<id>.gif` → `/tiles/<id>.gif`; `/t/<id>` → `/d/<id>`).

One noun: **drawing** (code still says `tile` in paths). GIF 8/16/32/64, `MAX_FRAMES=16`, `MAX_LAYERS` (64 KiB `layers_json` cap). Default 16×16. See `config/constants.ts`.

History note: Ruby/Sinatra/Redis app in `legacy/` is reference only, never imported.

## 2. Deploy & routing shape

```
editor + auth/merch/order SPAs + gifs          → S3 (us-east-1) + CloudFront
/, /feed/items, /d/<id>, /u/<un>*, /prompts*,
  /products*, /feed.rss, /design, /embed/<id>   → Lambda render handlers
POST /ingest, POST /auth/*, /hydrate,
  POST|DELETE /drawings/<id>/{like,bookmark},
  POST|DELETE /users/<un>/follow, /subscribe    → same Lambda
POST /merch/*, GET /merch/order/<id>            → separate merch Lambda
```

No persistent webserver, no cron, no GH Pages, no Cloudflare.

**Adding a Lambda-rendered route — all or nothing (hard to debug otherwise):**

1. Handler in `ingest/render-handlers.ts` (or sibling) → `{status, contentType, cacheControl, body}`.
2. Entry in `ingest/routes.ts` `createRoutes()` — `{methods, pattern, auth, handler}`. Shared by `lambda.ts` and dev `:8787` server.
3. `test/routes.test.ts` — pin auth gate / params.
4. `infra/aws/template.yaml` → ingest function's `Events:` (`Type: HttpApi`, `Path: /your/{param}/path`). Without it, API Gateway 404s before Lambda.
5. `infra/aws/template.yaml` → `CacheBehaviors:` only if no existing wildcard (`/u/*`, `/products/*`, `/d/*`) already covers it. Longer pattern must be **above** parent.
6. `ingest/cache-invalidation.ts` — only if publish-time invalidation needs a path outside existing `/u/${username}*` / `/d/${id}*` wildcards.

Mental check: new path must appear in both `ingest/routes.ts` and `infra/aws/template.yaml`.

## 3. Request contracts you will touch often

### Publish (`POST /ingest`, `auth: "optional"`)

Body: `{ gif: base64, prompt?: slug (stored only if matches today's ET prompt), layers_json?: string (≤64 KiB), parent_id?: drawing_id }`. Anonymous when no `Authorization`; 401 if a token was sent but fails.

Sync path ~60 ms independent of size (derived work is deferred). Don't add work here.

Tail (`runPostPublish`, `ingest/handler.ts`) does the expensive derived work with a 30 s timeout — invalidation runs **concurrently** with encodes, not after them. Measured on prod arm64/1024 MB (via targeted backfill `outcome`):

| Drawing          | `-large.gif` | `-large.mp4` (ffmpeg, fixed 6s 1080p30) | invalidation | total |
| ---------------- | ------------ | --------------------------------------- | ------------ | ----- |
| 32×32, 6 frames  | 684 ms       | 4851 ms                                 | 604 ms       | 5.5 s |
| 16×16, 16 frames | 1281 ms      | 4434 ms                                 | 1204 ms      | 5.7 s |
| 64×64, 16 frames | 1576 ms      | 5159 ms                                 | 1485 ms      | 6.7 s |

Tail never throws; queue failure → inline fallback. Logs `kind="tail"` on success _and_ failure (see `ingest/log-outcome.ts`). Known gap: `og:image`/`og:video` missing for ~1.5 s / ~6 s after publish until tail finishes — repairable via `POST /backfill/sidecars?drawing=<id>` which runs the tail synchronously and returns an `outcome`. See `ingest/backfill-handler.ts`.

### Auth & sessions

Email (private, unique, PK) + password (scrypt, `ingest/password.ts`) + username (public, unique, immutable v1) + random 64-hex `user_id`. Two tables: `drawbang-users` (PK email) and `drawbang-usernames` (PK username), written together via `TransactWriteItems`. Client: `localStorage["drawbang:jwt"]` (HS256, ~30d, `JWT_SECRET`) + `localStorage["drawbang:username"]`. See `ingest/jwt.ts`, `ingest/user-store.ts`, `src/auth.ts`.

Password reset: SES link with 1h JWT `{email, tv: token_version, purpose:"password-reset"}` (`ingest/email.ts`); `tv` check + bump makes it single-use. Forgot always returns 200 (no enumeration). Dev stub logs link to console (`ConsoleEmailSender`, `ingest/dev-server.ts`).

PoW: `GET /auth/challenge` mints HMAC-signed PBKDF2/SHA-256 challenge; `POST /auth/register` validates fields _then_ gates (so a typo doesn't burn a ~600 ms solve), `POST /auth/password/forgot` gates _first_. Difficulty at `cost:1000`, counter 1000–5000: solve ~630 ms mean / ~880 ms max, verify ~1 ms (HMAC, not re-derive). Re-measure if constants change in `ingest/challenge.ts`. Client widget (`src/altcha.ts`) is dynamically imported (saves ~34 kB gzipped on editor load) and solves a fresh challenge per submit — replay → 400 `challenge_replayed`. Surfaces needing it: `/signup`, `/password/forgot`, and the inline form in `src/publish-dialog.ts` (easy to miss).

Failures return 400 `challenge_missing/_malformed/_expired/_invalid/_replayed` (not 403 — CloudFront maps 403→404 HTML). Signing keys derive from `JWT_SECRET` with domain separation, so no new secret.

### Anonymous publishing

Publish dialog (`src/publish-dialog.ts`) when signed out: "Publish anonymously" vs inline `register()`/`login()` then attributed publish. Never navigate away (`/login?next=/draw` was removed for this reason). Errors render in `#publishStatus` (not `showFlash`, hidden behind the dialog), and `[hidden]` needs `display:none` override in `src/style.css` for `.auth-field` toggles. Anonymous `drawing_id` can't be retroactively claimed (content-addressed idempotency is intentional); see `docs/claim-flow-proposal.md` for the proposed capability design.

### Deletion

- `DELETE /drawings/<id>` — author or `ADMIN_USERNAMES`. Anonymous drawings → operator-only. API-origin only (no CloudFront behavior; `/drawings/*.gif` would collide). Row → S3 objects → invalidation with `/d/<id>*`. Likes/bookmarks intentionally left behind (read paths tolerate missing rows).
- `POST /auth/account/delete` (self, needs current password) and `DELETE /admin/users/{username}` (operator, allowlist in `routes.ts`). Both cascade via `ingest/account-delete.ts`: sweep drawings (re-query first page each round, `MAX_DRAWINGS=1000`, `MAX_DRAWING_PATHS=50` → fallback `/d/*` wildcard), then `TransactWriteItems` drop users + username reservation (conditioned on `user_id`). Frees handle safely — follow edges key on `user_id`; orphaned `UserStats` rows left behind.
- `DELETE /admin/users/*` needs its own CloudFront behavior above the GET-only `/admin*` behavior or the DELETE never reaches Lambda.

### Hydration & interactions

`GET /hydrate` (`ingest/hydrate-handler.ts`) is public, `no-store`, optional JWT → `viewer_*` null when anonymous. `static/hydrate.js` walks DOM (`[data-like-target]`, `[data-bookmark-target]`, `[data-follow-target]`, etc.) and does one fetch. Click handlers (`static/like.js`, `bookmark.js`, `follow.js` via `toggle-handler.js`) do optimistic `POST`/`DELETE` with 401→`/login` redirect and `MutationObserver` rewiring for infinite scroll. `subscribe.js`, `share.js`, `infinite-scroll.js` follow the same pattern.

Adding a new "stale on feed" field is a one-liner: extend `HydrateBody` in `ingest/hydrate-handler.ts`, populate it, add an `apply` case in `static/hydrate.js`. No new endpoint.

### Pages — where they render

Canonical map lives in `ingest/routes.ts` and `lib/templates/*.ts`. Highlights:

- `/` (`lib/templates/home.ts`) — social feed with `?sort=top` (today's likes); `/feed/items?cursor=…` fragment.
- `/draw` (`draw.html` + `src/main.ts`) — editor; opts out of rails via `<meta name="drawbang:rails" content="off">`.
- `/gallery` → 301 `/`; `/gallery/items` → 301 `/feed/items`.
- `/d/<id>` (`lib/templates/tile-page.ts`), `/embed/<id>` (bare iframe, `lib/templates/embed.ts`), `/u/<username>` (`lib/templates/owner.ts`) + `/items`, `/bookmarks` (owner-only shell hydrated via `/me/bookmarks/feed`), `/followers`/`/following` (`lib/templates/follow-list.ts`) + thumbs (`/follow-thumbs`), `/streak` (`lib/templates/streak.ts`), `/prompts*` (`lib/templates/prompts.ts`), `/products*` (`lib/templates/products.ts`), `/feed.rss` (`lib/templates/feed.ts`), `/design` (`lib/templates/design.ts`), `/admin` (`lib/templates/admin.ts` with `/admin/data` fragment).
- Vite pages: `/merch?d=<id>`, `/merch/order/<uuid>`, `/login`, `/signup`, `/password/forgot`, `/password/reset`, `/account`, `/privacy`. Full table is `ingest/routes.ts`; templates are `lib/templates/`.

JSON endpoints (`Cache-Control: no-store`; `auth` column is the source of truth for new clients):

| URL                                                             | Method        | Auth     | Notes                                                                          |
| --------------------------------------------------------------- | ------------- | -------- | ------------------------------------------------------------------------------ |
| `/hydrate?drawings=<csv>&users=<csv>`                           | GET           | optional | Hydration channel; `viewer_*` null when anonymous. `ingest/hydrate-handler.ts` |
| `/drawings/<id>`                                                | DELETE        | required | Author or `ADMIN_USERNAMES`; API-origin only.                                  |
| `/drawings/<id>/like`                                           | POST / DELETE | required | `ingest/likes-handler.ts`                                                      |
| `/drawings/<id>/bookmark`                                       | POST / DELETE | required | `ingest/bookmarks-handler.ts`                                                  |
| `/users/<username>/follow`                                      | POST / DELETE | required | 400 self-follow, 404 missing, 409 duplicate.                                   |
| `/me/bookmarks/feed`                                            | GET           | required | Fragment for `/u/<un>/bookmarks` boot script                                   |
| `/auth/challenge`                                               | GET           | none     | `private, no-store`; single-use PoW                                            |
| `/auth/*` (register/login/forgot/reset/profile-picture/profile) | POST          | mixed    | `register` + `forgot` need PoW; see above                                      |
| `/auth/profile`                                                 | GET / POST    | required | Bio + link edit                                                                |
| `/auth/account/delete`                                          | POST          | required | Self only, needs password                                                      |
| `/admin/users/<username>`                                       | DELETE        | required | Operator (`ADMIN_USERNAMES`)                                                   |
| `/admin/data`                                                   | GET           | required | Only surface that renders emails (`ADMIN_USERNAMES` gate in `lambda.ts`)       |
| `/users/<user_id>/stats`                                        | GET           | none     | Short max-age                                                                  |
| `/u/<username>/follow-thumbs?limit=N`                           | GET           | none     | Thumb grid JSON                                                                |
| `/backfill/sidecars`                                            | POST          | required | `?drawing=<id>` sync; default own; `?scope=all` operator only; API-origin only |
| `/subscribe`                                                    | POST          | none     | Honeypot `website`→200; idempotent on email                                    |

## 4. Editor essentials

Sizes `8/16/32/64` (`DRAWING_SIZES`), `MAX_FRAMES=16`, frames = one `Bitmap` per layer, `composeFrame` flattens. Tools: Pencil (B), Eraser (E), Fill (G), Line (L, `src/editor/tools.ts` `drawLine` Bresenham with ghost on `pointermove`, `mirrorX` when `symmetryH`), Move (V); `PixelPerfectStroke` for other strokes.

Draft autosave: every `persist()` writes IndexedDB (`src/local.ts` `drawbang` DB) _and_ `localStorage` `drawbang:draft:{size}` (`{v,size,ts,frames:string[][], layers, activePalette, delayMs, localId, opLog}` ≤64 KiB). On boot without `?fork`/`#d`, `readDraft(size)` shows `draftRestoreBanner`; clear on empty canvas / `resetEditor` / successful publish. Guards: `beforeunload` + `visibilitychange` hidden → `writeDraft`. Prefs in `localStorage`: `drawbang:palette`, `grid`, `pixel-perfect`, `symmetry-h` (all `try/catch`).

Details: `src/main.ts`, `src/editor/*`, `src/local.ts`, `src/publish-dialog.ts`.

## 5. Frontend system (tokens, layout, CSS)

- Tokens in `static/chrome.css` `:root` (`--paper`/`--ink`/`--line`/`--accent:#00ccff` etc.). Written rules in `docs/design-system.md`, live gallery at `/design` (`lib/templates/design.ts`). Add tokens → update all three.
- Shell: `.app-shell` 3-col (`src/layout/chrome.ts` → `static/chrome.css`) — `.rail-left` (CTA + nav), `<main>`, `.rail-right` (Discover, opt-in on `/` only via `renderDiscover()`/`loadDiscover()`). Breakpoints: ≥1180 3-col, 860–1180 2-col (right hidden), <860 drawer (`static/chrome-toggle.js`). Header `.hdr` auth slot + `chrome-identity.js`.
- CSS ownership (single source): `static/chrome.css` = tokens + chrome + base `.btn`/`.badge`; `src/style.css` = editor/Vite pages + `.btn` variants (`.icon/.sm/.xs`); `static/gallery-v2.css` = Lambda-rendered pages (`.img-grid`, `.dr-*`, `.pr-*`, `.ow-*`, etc.). Lambda + Vite shells each import `chrome.css`. Drawing wells use `border:1px solid var(--line)` on `background:var(--paper-2)`.
- Component rule: token → `docs/design-system.md` → `/design` kitchen sink. Cross-surface JS → lift to `static/*.js` + `chrome.css` + `window.drawbang*` (see `flash.js`, `chrome-identity.js`, `tile-page.js`). Confirm reuse before inventing new UI.

## 6. Repo map (condensed)

```
config/         constants.ts (WIDTH/HEIGHT/MAX_FRAMES/PER_PAGE etc.), badges.ts, prompts.ts (ET-day rotation), palettes.ts, merch.json, mockups.json
src/            Vite + TS editor + auth SPAs — editor/ (bitmap/canvas/frames/gif/history/palette/share-gif/tools/video), main.ts, publish-dialog.ts, submit.ts (POST /ingest), auth.ts, content-hash.ts, share.ts, local.ts, export-dialog.ts, layout/{chrome.ts,flash.ts,tracking.ts,asset-version.ts}, login/signup/password-*/account/merch/order entries
ingest/         Lambda + dev server — handler.ts (ingest + runPostPublish), render-handlers.ts, routes.ts (route table), lambda.ts (APIGW wiring), dev-server.ts (Memory* + FsStorage + ConsoleEmailSender), hydrate/likes/bookmarks/follows/subscribers/user/drawing/challenge stores, auth/challenge/jwt/password/email/gif-validate/s3-storage/cache-invalidation/share-mp4/admin/cloudwatch-logs, handler-utils/log-outcome
lib/templates/  Server HTML — home/gallery/tile-page/owner/products/feed/prompts/streak/admin/embed/design/bookmarks/follow-list/discover/not-found (+ _escape/_html-shell/_time)
merch/          Stripe + Printify orders Lambda (separate)
infra/aws/      template.yaml (SAM: Lambdas + HTTP API + S3 + CloudFront + DDB + IAM), samconfig.toml, build-lambda.mjs (esbuild)
static/         chrome.css, gallery-v2.css, flash.js, chrome-identity.js, chrome-toggle.js, tile-page.js, hydrate.js, like/bookmark/follow/share/subscribe/infinite-scroll/toggle-handler.js, fonts/, mockups/, og-logo.png
test/           node:test + tsx  •  scripts/ backfill-large-gifs|share-mp4, migrate-tiles, recover-missing-tiles, reassign-anonymous, smoke-ingest
docs/           identity-considerations.md, claim-flow-proposal.md, gotchas.md, auth-setup.md, design-system.md  •  vite/plugins/ chrome.ts, dev-bucket.ts
```

## 7. Commands

```sh
npm run dev            # Vite editor only
npm run dev:all        # Vite :5173 + ingest :8787 — full loop
npm run build          # tsc -b + vite build → dist/
npm run typecheck      # tsc -b --noEmit
npm test               # node:test across test/**/*.test.ts
npm run ingest:dev     # ingest on :8787 (FsStorage + Memory* stores)
npm run lambda:build   # esbuild → dist-lambda/
npm run lambda:deploy  # build + sam deploy
npm run og:backfill    # scripts/backfill-large-gifs.ts
```

Local e2e (`npm run dev:all`): open `:5173`, `/signup` → draw → Publish (signed-in = direct, signed-out = Publish dialog → anonymous or inline auth → publish). Gifs land in `./dev-bucket/`; render routes on `:8787` (Vite proxy shadows proxied GETs — read `/d/<id>`/ `/u/<un>` off `:8787` directly). `/password/forgot` link is logged to the dev server console.

Tests: `npm test` in seconds; single file: `node --test --import tsx 'test/render-handlers.test.ts'`.

Env: `VITE_INGEST_URL`, `VITE_DRAWING_BASE_URL` (editor build); Lambda runtime `DRAWBANG_BUCKET`, `PUBLIC_BASE_URL`, `REPO_URL`, `JWT_SECRET` (required, fails loud if unset), `SES_FROM_ADDRESS`, `ADMIN_USERNAMES`, `CF_DISTRIBUTION_ID`, `DRAWBANG_*_TABLE` (users/usernames/drawings/likes/bookmarks/follows/challenges/subscribers/product-counters/user-stats). Backfill scripts: `DRAWBANG_S3_BUCKET`. All wired in `infra/aws/template.yaml`.

## 8. Conventions

- TypeScript strict; don't loosen `tsconfig.json`.
- No WHAT comments — WHY only when non-obvious.
- Tests: `node:test` + `tsx`, no new framework.
- Storage via `Storage` interface (`FsStorage` ↔ `S3Storage` interchangeable).
- All changes via PR — do not push directly to `master`. End-of-task flow: `typecheck` → `test` (iterate to green) → commit → push branch → open PR → merge after green → smoke-check `pixel.drawbang.com` after deploy. Ask only for destructive actions (force-push, data removal).
- Naming: kebab-case files, PascalCase types (`UserRecord`), camelCase fns/vars (`activePalette`, `is/has/can/should` for booleans), `UPPER_SNAKE_CASE` constants (`MAX_FRAMES`), namespaced CSS (`.dr-`, `.ow-`, `.pr-`, `.ed-`, `.mc-`), `*.worker.ts`/`*.test.ts` when relevant. On rename, update imports + docs + run `typecheck` in same commit.
- UI consistency: search the repo before adding any visible affordance; reuse `src/layout/flash.ts` / `static/flash.js`, `src/layout/chrome.ts` markers, `.btn`/`.ghost`/`.primary` in `chrome.css`, `src/layout/tracking.ts`. If a Lambda page needs a Vite helper, lift to `static/*.js` + `chrome.css` + `window.drawbang*` rather than duplicating.

## 9. Observability & prod verification (no AWS keys needed)

_Structured logs_ (`ingest/log-outcome.ts` is the shape source): `kind="outcome"` (every route, status/latency), `kind="tail"` (every `runPostPublish`, success and failure — don't remove success line; absence is the signal), `kind="boot"` (cold start: ffmpeg presence, arch, memory). Insights queries:

```
# tail failures (ffmpeg stderr in .error)
fields @timestamp, drawing_id, invocation, large_mp4.error
| filter kind="tail" and large_mp4.ok=0 | sort @timestamp desc
# tail health by hour    → filter kind="tail" | stats count() as runs, sum(large_gif.ok) as gif_ok, sum(large_mp4.ok) as mp4_ok by bin(1h)
# this drawing's tail?   → filter kind="tail" and drawing_id="<id>"
# ffmpeg present?         → filter kind="boot" | stats count() by ffmpeg_present, ffmpeg_bytes, arch
```

`remaining_ms` near zero + failure = timeout, not encoder; `ms` + `bytes` per step distinguish quick fail vs slow fail; `invocation` = `async` vs `inline` vs `backfill` (spike in `inline` = queue failure).

Prod check uses the **`execute-api` host** baked into the editor bundle — `POST /ingest` / `DELETE /drawings/<id>` / `POST /backfill/sidecars` have no CloudFront behavior and 404 on `pixel.drawbang.com`:

```sh
curl -s https://pixel.drawbang.com/draw | grep -o '/assets/draw-[^"]*\.js'
curl -s "https://pixel.drawbang.com/assets/draw-<hash>.js" | grep -o 'https://[a-z0-9]*\.execute-api\.[^"]*/ingest'
```

`/auth/*` is on CloudFront, so works on either host.

Self-serve loop (leaves nothing behind): `POST /auth/register` → JWT → `POST /ingest` (vary bytes; same bytes → idempotent 200, not 202) → verify → `DELETE /drawings/<id>` per drawing → `POST /auth/account/delete` (409 until drawings are gone, so delete drawings first). Don't leave test drawings on the public feed; sandbox latency is noisy (190–550 ms baseline for a 400) and sidecars take ~6 s to appear — checking sooner is a false failure.

---

## Deep references — read on demand

Don't load these unless your task touches the area. Prefer the source file over a summary. For subagents: if your task touches an area, **read the listed source first**.

- Publish & tail: `ingest/handler.ts` (`handleIngest`, `runPostPublish`, `PostPublishEvent`), `ingest/share-mp4.ts`, `ingest/cache-invalidation.ts`, `ingest/log-outcome.ts`
- Auth / session / PoW: `ingest/challenge.ts`, `ingest/challenge-store.ts`, `ingest/jwt.ts`, `ingest/password.ts`, `ingest/email.ts`, `ingest/auth-handler.ts`, `src/altcha.ts`, `src/auth.ts`, `src/publish-dialog.ts`, `config/constants.ts`
- Deletions & backfill: `ingest/delete-handler.ts`, `ingest/account-delete.ts`, `ingest/backfill-handler.ts`, `scripts/backfill-large-gifs.ts`
- Stores: `ingest/drawing-store.ts`, `user-store.ts`, `user-stats-store.ts`, `likes-store.ts`, `bookmarks-store.ts`, `follows-store.ts`, `subscribers-store.ts`
- Rendering & routes: `ingest/routes.ts` (route table — canonical), `ingest/render-handlers.ts`, `ingest/hydrate-handler.ts`, `lib/templates/*.ts`
- Layout & design: `src/layout/chrome.ts`, `static/chrome.css`, `static/gallery-v2.css`, `src/style.css`, `docs/design-system.md`
- Infra & deploy: `infra/aws/template.yaml`, `infra/aws/build-lambda.mjs`, `docs/gotchas.md`, `docs/auth-setup.md`, `docs/identity-considerations.md`
- Anonymous claim (proposal, not built): `docs/claim-flow-proposal.md`
- Full pre-optimization reference: `CLAUDE.md.bak` (79 KiB, 1307 lines) — kept for deep history if needed
