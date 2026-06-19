# CLAUDE.md

Orientation for future Claude sessions on this repo.

## What this is

Drawbang is a pixel art editor + public gallery. The stack is static-shell
+ serverless: a Vite-built browser editor (and a handful of small Vite
SPAs for the auth/merch/order flows), a Lambda that ingests publishes
**and** serves the dynamic gallery / drawing / profile / RSS HTML, an S3
bucket for the gif assets, and CloudFront in front of all of it.

Identity is an **email/password account**. Sessions are stateless HS256
JWTs kept in `localStorage`; the public handle is a chosen **username**
(profiles live at `/u/<username>`). Publishing a drawing requires a
logged-in account. The gallery is publicly viewable and you can draw
locally without an account. See "Identity model".

History: the original Ruby/Sinatra/Redis/RMagick app is archived under
`legacy/` and is not imported by any current code. Several earlier
concepts have been removed and should not be reintroduced absent
intentional discussion: the keypair-anonymous identity scheme,
proof-of-work gating, the multi-tile "canvas" composite, the
collaborative weekly "murals" grid, and the daily static-builder cron
that used to regenerate the gallery HTML.

## Drawing model

One noun: **drawing** (historically called a "tile"; the codebase
still uses `tile` in storage paths and some identifiers). A drawing is
a GIF — 16×16 by default, with a user-pickable size of 8/16/32/64 —
content-addressed by sha256 of the gif bytes:

- `drawing_id = sha256(gif_bytes)` (hex). Same bytes → same id, always.
- Canonical page: `/d/<drawing_id>` (rendered by
  `lib/templates/tile-page.ts` via the dynamic Lambda route).
- Asset: `public/tiles/<drawing_id>.gif` (the file is served at
  `/tiles/<id>.gif` and the legacy `/drawings/<id>.gif` URL is
  rewritten to it at the CloudFront edge).
- OG share image: `public/tiles/<id>-large.gif` — a 960×960 annotated
  variant written next to the original by the publish handler and
  used as `og:image` on the canonical page. When this is missing
  (legacy migrations, encoder failures), use
  `scripts/backfill-large-gifs.ts` (`npm run og:backfill`).

`drawing_id` is keyed by content; **PoW is gone** — the requirement
that gated it is replaced by login.

## Deployment shape

```
  editor + auth/merch/order SPAs + gifs       →  S3 (drawbang-assets,
                                                  us-east-1) fronted by
                                                  CloudFront
  /gallery, /d/<id>, /u/<username>, /feed.rss →  Lambda render handlers
  /products, /products/p/<N>                  →     (same Lambda)
  POST /ingest, POST /auth/*                  →     (same Lambda)
  POST|DELETE /drawings/<id>/like, GET /hydrate →   (same Lambda)
  POST /merch/*, GET /merch/order/{id}        →  Separate merch Lambda
```

Single origin: everything serves from the CloudFront distribution
(e.g. `pixel.drawbang.com` or the assigned `*.cloudfront.net`). The S3
bucket is locked down via Origin Access Control. A CloudFront Function
rewrites clean URLs (`/login`, `/signup`, `/password/*`, `/account`,
`/merch`, `/privacy`, `/404`) to the underlying `*.html` Vite entries,
and rewrites legacy `/drawings/<id>.gif` → `/tiles/<id>.gif` and 301s
`/t/<id>` → `/d/<id>`. The dynamic routes have dedicated cache
behaviours pointing at API Gateway → Lambda.

**No persistent webserver, no daily cron, no GitHub Pages, no
Cloudflare.** The daily-builder cron was removed when the gallery /
drawing / profile / feed routes flipped to be Lambda-rendered (see
Phase 3 commits in the git log).

### Adding a new Lambda-rendered route (checklist — easy to miss)

A new dynamic URL only works once it's wired into **all** of these.
Skipping any one of them gives a hard-to-debug 404 (API Gateway 404s
before Lambda runs; CloudFront 404s before API Gateway runs).

1. **Handler** in `ingest/render-handlers.ts` (or a sibling handler
   file) returning `{ status, contentType, cacheControl, body }`.
2. **Lambda route table** in `ingest/lambda.ts` — add the regex match
   block and call `adaptRender(...)`.
3. **Dev mirror** in `ingest/dev-server.ts` — keep the dev `:8787`
   server in sync so `npm run dev:all` exercises the path.
4. **API Gateway event** in `infra/aws/template.yaml` under the
   ingest function's `Events:` block — every path is registered
   explicitly (`Type: HttpApi`, `Path: /your/{param}/path`). Without
   this, the API returns 404 before Lambda is ever invoked.
5. **CloudFront cache behavior** in `infra/aws/template.yaml` under
   `CacheBehaviors:` — only needed if the new path doesn't already
   match an existing wildcard (`/u/*`, `/products/*`, `/d/*`, etc.).
   When it does match, you get the parent's cache policy "for free";
   add a longer-pattern behavior (and place it **above** the parent
   in the list) only if the new route needs a different policy
   (e.g. auth-forwarded vs public).
6. **Cache invalidation** in `ingest/cache-invalidation.ts` — usually
   covered by an existing `/u/${username}*` / `/d/${id}*` wildcard;
   only extend if the new path needs publish-time invalidation outside
   those.

Quick mental check before pushing: grep the new path in
`ingest/lambda.ts`, `ingest/dev-server.ts`, and `infra/aws/template.yaml`
— it must appear in all three.

## Pages of the app

Single source of truth. Any cross-page change (new nav link, new shared
asset, new tracking script) must consider every entry below.

| URL                            | Rendered by                                       | Surface |
|--------------------------------|---------------------------------------------------|---------|
| `/`                            | `lib/templates/home.ts` via Lambda                | Dynamic — social feed (cards) |
| `/feed/items?cursor=…`         | `lib/templates/home.ts` (fragment-only)           | Dynamic (infinite scroll) |
| `/draw`                        | `draw.html` + `src/main.ts`                       | Editor (Vite) |
| `/gallery`                     | 301 → `/`                                         | CloudFront Function redirect |
| `/gallery/items`               | 301 → `/feed/items`                               | CloudFront Function redirect |
| `/d/<64hex>`                   | `lib/templates/tile-page.ts` via Lambda           | Dynamic |
| `/embed/<64hex>`               | `lib/templates/embed.ts` via Lambda               | Dynamic — bare iframe player (no chrome, no scripts), click-through to `/d/<id>`, long edge TTL. |
| `/u/<username>`                | `lib/templates/owner.ts` via Lambda               | Dynamic |
| `/u/<username>/items?cursor=…` | gallery fragment via Lambda                       | Dynamic (infinite scroll) |
| `/u/<username>/bookmarks`      | `lib/templates/bookmarks.ts` via Lambda           | Dynamic — owner-only page shell. The body is hydrated client-side via `/me/bookmarks/feed` because browser navs don't carry the Bearer JWT. |
| `/u/<username>/followers`            | `lib/templates/follow-list.ts` via Lambda    | Dynamic — public card list of accounts following `<username>`. |
| `/u/<username>/followers/items?cursor=…` | follow-list fragment via Lambda          | Dynamic (infinite scroll) |
| `/u/<username>/following`            | `lib/templates/follow-list.ts` via Lambda    | Dynamic — public card list of accounts `<username>` follows. |
| `/u/<username>/following/items?cursor=…` | follow-list fragment via Lambda          | Dynamic (infinite scroll) |
| `/products`, `/products/p/<N>` | `lib/templates/products.ts` via Lambda            | Dynamic |
| `/feed.rss`                    | `lib/templates/feed.ts` via Lambda                | Dynamic (RSS, no chrome) |
| `/design`                      | `lib/templates/design.ts` via Lambda              | Dynamic — design-system kitchen-sink, paired with `docs/design-system.md` |
| `/merch?d=<drawing>`           | `merch.html` + `src/merch.ts`                     | Picker (Vite) |
| `/merch/order/<uuid>`          | `order.html` + `src/order.ts`                     | Order status (Vite) |
| `/login`                       | `login.html` + `src/login.ts`                     | Auth (Vite) |
| `/signup`                      | `signup.html` + `src/signup.ts`                   | Auth (Vite) |
| `/password/forgot`             | `password-forgot.html` + `src/password-forgot.ts` | Auth (Vite) |
| `/password/reset`              | `password-reset.html` + `src/password-reset.ts`   | Auth (Vite) |
| `/account`                     | `account.html` + `src/account.ts`                 | Logged-in account (Vite) |
| `/privacy`                     | `privacy.html` + `src/privacy.ts`                 | Static-ish (Vite) |

JSON endpoints (no caching at the edge — `Cache-Control: no-store`):

| URL                            | Method        | Auth | Handler |
|--------------------------------|---------------|------|---------|
| `/hydrate?drawings=<csv>&users=<csv>` | GET    | optional | `ingest/hydrate-handler.ts` — **the** read-side hydration channel. Returns `{drawings: {<id>: {like_count, viewer_liked, viewer_bookmarked}}, users: {<un>: {profile_picture_drawing_id, follower_count, following_count, viewer_follows}}}`. `viewer_*` fields populate when a Bearer JWT is sent, otherwise they're `null`. Every Lambda-rendered page fires one of these via `/hydrate.js` to overlay fresh values on the edge-cached SSR markup. |
| `/drawings/<id>/like`          | POST / DELETE | required | `ingest/likes-handler.ts` — toggle a like (write only). |
| `/drawings/<id>/bookmark`      | POST / DELETE | required | `ingest/bookmarks-handler.ts` — toggle a bookmark (write only). |
| `/me/bookmarks/feed`           | GET           | required | HTML fragment of the caller's bookmarks. Loaded by the inline boot script on `/u/<un>/bookmarks`. |
| `/users/<username>/follow`     | POST / DELETE | required | `ingest/follows-handler.ts` — follow/unfollow. Self-follow → 400, missing target → 404, duplicate → 409. Bumps `follower_count`/`following_count` on the users rows transactionally with the edge write. |
| `/auth/*`                      | POST          | mixed | `ingest/auth-handler.ts` (register/login/forgot/reset/profile-picture). |
| `/users/<user_id>/stats`       | GET           | none | `ingest/user-stats-handler.ts` — public, short max-age. |
| `/subscribe`                   | POST          | none | `ingest/subscribe-handler.ts` — email capture from the home-page hero. Honeypot field `website` → silent 200; idempotent on email (first-seen `created_at` wins). Write-only; digest sending is deferred. |

**Adding a new "X is stale on the cached feed" field is a one-liner.** Don't invent another endpoint or another client script. Add the field to `HydrateBody` (in `ingest/hydrate-handler.ts`), populate it in the handler, add a case to the `apply` step in `static/hydrate.js` that updates the right DOM nodes. The SSR templates carry `data-*` attributes the hydrator reads; click handlers stay in their per-action scripts (`like.js`, `bookmark.js`, `follow.js`).

### Layout shell (`src/layout/chrome.ts` → `static/chrome.css`)

Every page that renders the chrome is wrapped in a 3-column **`.app-shell`**:

| Column | Content | Source |
|--------|---------|--------|
| `.rail-left` | NEW DRAWING CTA, primary nav (Products, Followers/Following/Bookmarks/Account/Sign-out — last five owner-only, revealed by `chrome-identity.js`), bottom-anchored secondary group (social + Privacy + Feedback) | `renderLeftRail()` in `src/layout/chrome.ts` |
| `<main>` | Page-specific content | Each template |
| `.rail-right` | Discover modules — Most Liked · 30D + Trending Artists. **Opt-in:** only `/` passes `rightRail: true`. | `renderDiscover()` in `lib/templates/discover.ts`, fed by `loadDiscover()` in `ingest/discover-handler.ts` |

Breakpoints (in `chrome.css`):
- **≥ 1180px** — 3-col (left · main · right).
- **860–1180px** — 2-col, right rail hidden.
- **< 860px** — 1-col; left rail collapses to a drawer that slides in
  on logo tap or hamburger click (`static/chrome-toggle.js`).

The header (`.hdr`) carries the logo + an **auth slot** on the right:
"Sign in" when logged out; profile picture + username link to
`/u/<un>` when logged in. The signed-in branch is rendered hidden by
default and revealed by `static/chrome-identity.js` when
`localStorage["drawbang:username"]` is present. `hydrate.js` stamps the
profile-picture `<img>` once the patcher has set
`data-profile-picture-username`.

Vite-served surfaces get the shell via the `<!--CHROME:HEADER-->` /
`<!--CHROME:FOOTER-->` markers + `vite/plugins/chrome.ts`. Lambda
templates call `renderHeader` / `renderFooter` directly. Pages that
need the full viewport — the editor `/draw` — opt out of the shell
wrapper with `<meta name="drawbang:rails" content="off">`; the
header still renders but `.app-shell` and the rails are suppressed,
so `<main>` (or `#app`) sits directly in the body. `/feed.rss` skips
the chrome entirely (XML).

There is **no `.fab` and no bottom `<footer>`** — both are gone; the
left rail carries the New-drawing CTA and the secondary links.

## Identity model

- **Account** = email (private, unique, login key) + password + a chosen
  **username** (public, unique, immutable in v1) + a stable random 64-hex
  `user_id`. Stored in DynamoDB `drawbang-users` (PK email);
  `drawbang-usernames` reserves the handle. Registration writes both in
  one `TransactWriteItems`.
- **Password hashing**: scrypt (`ingest/password.ts`), built-in, no
  native dep.
- **Sessions**: stateless HS256 JWT (`ingest/jwt.ts`), `{ sub: user_id,
  un: username }`, ~30-day exp, signed with `JWT_SECRET`. Client keeps
  it in `localStorage["drawbang:jwt"]` and mirrors the username to
  `localStorage["drawbang:username"]`. Publish sends
  `Authorization: Bearer <jwt>`; the route verifies signature + exp
  (no DB read) and passes `{ user_id, username }` into the handlers.
- **Password reset**: `ingest/email.ts` sends a link via SES carrying a
  1h reset-JWT (`{ email, tv: token_version, purpose: "password-reset" }`).
  The `/auth/password/reset` handler checks `tv === token_version` then
  bumps `token_version`, making the link single-use. No signup email
  verification. Forgot-password requests always return 200 (no email
  enumeration).
- **Profile picture**: the user can pin one of their own drawings as
  their profile picture. `UserRecord.profile_picture_drawing_id` is a
  `drawing_id`; `POST /auth/profile-picture` validates ownership (the
  drawing's `username` must equal the caller's) and writes the row.
  Rendered as a small `<img class="profile-picture">` next to the
  username on `/d/<id>` and `/u/<username>`. Profile-picture changes
  invalidate `/u/<username>*` on CloudFront; drawing pages absorb the
  change on their own short s-maxage TTL.
- **Auth surface**: `src/auth.ts` (client),
  `ingest/auth-handler.ts` (server), routes
  `POST /auth/{register,login,password/forgot,password/reset,profile-picture}`.
- Drawing rows store `user_id` + `username` (denormalized). Legacy
  pre-account-system drawings were migrated under the sentinel
  username `anonymous`, reserved both in the users table and in
  `RESERVED_USERNAMES` so no real account can claim it.

## Design system

The design system lives in three places, one source per surface:

1. **`static/chrome.css` `:root`** — runtime source of truth for every
   token. Light palette (`--paper`/`--ink`/`--line`/`--accent: #00ccff`),
   sans + mono type stacks (`--font-sans` / `--font-mono`), spacing
   (`--tap`/`--pad`/`--border`), type scale (`--t-xs` → `--t-2xl`),
   layout (`--hdr-h`/`--rail-w`/`--rail-right-w`/`--shell-max`). The
   old short names (`--bg`/`--fg`/`--border-c`/`--bg-elev`/`--panel`)
   are kept as backward-compat aliases; new code uses the semantic
   names.
2. **`docs/design-system.md`** — written rules: aesthetic, tokens,
   components, do/don't, breakpoints.
3. **`/design`** (`lib/templates/design.ts`) — live kitchen-sink
   page rendering every shared component (color swatches, type
   scale, buttons, follow button, badge, page chrome). Iterating on
   a token? Check it here first.

**Rule when adding a visible element:** token → markdown →
kitchen-sink, in that order. If the third step is impossible the
component is one-off and probably shouldn't exist.

## Shared CSS (single source of truth)

Three CSS files, each owning a disjoint slice. **Do not duplicate rules
across them.**

| File                       | Owns                                                              | Loaded by                                              |
|----------------------------|-------------------------------------------------------------------|--------------------------------------------------------|
| `static/chrome.css`        | Design tokens (`:root`), base body/typography, header (`.hdr` + `.hdr-auth`), app-shell + rails (`.app-shell`, `.rail-left`, `.rail-right`, `.rail-cta`, `.rail-link`, `.rail-foot`, `.rail-social`, `.rail-scrim`), `main` slot, page chrome (`.page-title`, `.divider`, `.panel-h`, `.lab`, ...), base `.btn` + `.primary` + `.ghost` + `.btn[hidden]`, `.badge` + `.badge.accent`, flash slot. | Both — `src/style.css` and `static/gallery-v2.css` each `@import url("/chrome.css")` at the top. |
| `src/style.css`            | Editor-surface extensions to the base reset (touch-first `user-select: none`, etc.), `.canvas-banner`, `.btn` variants (`.icon`/`.sm`/`.xs`/`[disabled]`/...), and every Vite-served page (editor `.ed-*`, merch `.mc-*`, order, identity). | Vite-served pages only.                                |
| `static/gallery-v2.css`    | Lambda-rendered classes: `.img-grid`, `.dr-*`, `.pr-*`, `.ow-*`, `.feed-card-*`, `.feed-action`, `.like-btn`, `.bookmark-btn`, `.follow-btn`, `.follow-card-*`, `.rr-*` (discover rail), `.st-*` (streak calendar), `.mono-trunc`, `img.profile-picture`. | Lambda templates (`/gallery-v2.css` link tag).         |

Rule of thumb when adding a class:
1. If `src/layout/chrome.ts` renders it → `chrome.css`.
2. If it's on a Vite-served HTML entry (draw/merch/order/auth) → `src/style.css`.
3. If it's only on a `lib/templates/*.ts` page → `static/gallery-v2.css`.

A change that affects both editor and Lambda-rendered surfaces (e.g.
rail width, header height, button hover, badge style) belongs in
`chrome.css`. If you catch yourself editing `.hdr`/`.app-shell`/`.btn`/
`.badge` in `src/style.css` or `static/gallery-v2.css`, stop — it's
the wrong file.

**Drawing well style.** Every surface that renders a drawing (feed
card, profile gallery thumb, drawing detail, streak calendar,
follow-card placeholder, discover rail thumb) frames it with
`border: 1px solid var(--line)` on `background: var(--paper-2)` so
transparent-pixel drawings stay visible against the light page. Don't
revert any single surface to `--canvas-bg` — the dark plinth look
was the pre-#00ccff era.

## Repo layout

```
config/               Shared constants
  constants.ts        WIDTH=16, HEIGHT=16, MAX_FRAMES=16, PER_PAGE=36, etc.
  badges.ts           Per-account badge thresholds for #115/#116.
  merch.json          Merch catalog (read by /products + merch picker).

src/                  Vite + TypeScript editor + auth SPAs
  editor/             bitmap, canvas (PixelCanvas), frames, gif, history,
                      palette, share-gif, tools, video (MP4/WebM/GIF
                      compositor + encoder fallback chain via mp4-muxer)
  export-dialog.ts    Export-dialog controller — GIF / MP4 square / MP4
                      Reels picker with WebM fallback, "Made with Draw!"
                      footer toggle, Web Share Level 2.
  content-hash.ts     sha256 helper (Node sync + Web Crypto fallback)
  share.ts            URL-hash share codec
  local.ts            IndexedDB "My drawings" store
  auth.ts             Client session: register / login / forgot / reset,
                      JWT in localStorage, authHeader() for publish.
  layout/asset-version.ts
                      Build-time `?v=<sha>` cache-buster appended to every
                      reference to a non-hashed static asset (gallery-v2.css,
                      like.js, share.js, flash.js, …). DRAWBANG_ASSET_VERSION
                      is inlined into the Lambda bundle by esbuild's define
                      and read by Vite's chrome plugin at build time. CI
                      sets it from $GITHUB_SHA.
  login.ts/signup.ts/password-forgot.ts/password-reset.ts/account.ts
                      Auth page controllers (Vite entries)
  submit.ts           POST /ingest with the gif + Bearer auth.
  merch.ts/merch-preview.ts/order.ts  Merch picker + order status
  main.ts             Editor UI (publish gated on a logged-in session)
  layout/             chrome.ts (header/footer), flash.ts, tracking.ts

ingest/               Lambda + dev-server: ingest, render, auth
  handler.ts          POST /ingest: validate → content-id → write
                      public/tiles/<id>.gif + public/tiles/<id>-large.gif
                      + dual-write a row into DrawingStore. Identity from
                      cfg.auth ({user_id, username}) set by the route
                      after JWT verification. Idempotent on drawing_id.
  render-handlers.ts  GET /gallery, /gallery/items, /d/<id>, /u/<un>,
                      /u/<un>/items, /products, /products/p/<n>,
                      /feed.rss. Each queries DrawingStore (+ UserStore /
                      UserStatsStore where relevant) and returns
                      {status, contentType, cacheControl, body}.
  drawing-store.ts    DDB wrapper for the dynamic gallery/drawing/profile/
                      forks queries. PK = drawing_id, plus GSI1 (gallery,
                      chronological), GSI2 (per-username chronological),
                      GSI3 (forks by parent_id, sparse). MemoryDrawingStore
                      for dev/tests.
  user-store.ts       DDB wrapper for accounts (register via
                      TransactWriteItems, getByEmail, getByUsername,
                      updatePassword, setProfilePicture) + MemoryUserStore.
                      Tables: drawbang-users (PK email),
                      drawbang-usernames (PK username).
  user-stats-store.ts DDB wrapper for per-account streak + total counters
                      (#115/#116) + MemoryUserStatsStore for dev/tests.
  user-stats-handler.ts GET /users/{user_id}/stats — fresh counters + badges.
  likes-store.ts      DDB wrapper for the drawbang-likes table (PK=drawing_id,
                      SK=user_id; GSI1-user inverts for a future "drawings
                      I liked" feed). like/unlike use TransactWriteItems
                      across this table + DrawingsTable so the denormalised
                      `like_count` on DrawingRow stays consistent. Memory
                      variant for dev/tests; AlreadyLikedError /
                      NotLikedError / DrawingNotFoundError surface as 409/404.
  likes-handler.ts    POST /drawings/{id}/like, DELETE /drawings/{id}/like.
                      (Read-side hydration lives in hydrate-handler.ts.)
  hydrate-handler.ts  GET /hydrate?drawings=<csv>&users=<csv> — the single
                      read-side hydration channel. Public, no-store; optional
                      Bearer JWT populates viewer_* fields. See the JSON
                      endpoints table above.
  subscribers-store.ts DDB wrapper for the drawbang-subscribers email-capture
                      table (PK email; idempotent conditional put) +
                      MemorySubscribersStore for dev/tests.
  subscribe-handler.ts POST /subscribe — public email capture from the
                      home-page hero (honeypot `website` → silent 200).
  cache-invalidation.ts CloudFrontInvalidator + path generators
                      (pathsToInvalidateOnPublish,
                      pathsToInvalidateOnProfilePictureChange).
                      NoopInvalidator for tests. Likes deliberately do NOT
                      invalidate — counts catch up at the next s-maxage
                      expiry (5 min on / and /d/<id>).
  jwt.ts              HS256 sign/verify (Node crypto, no dep) for sessions
                      + reset.
  password.ts         scrypt hash/verify.
  email.ts            SES password-reset sender + ConsoleEmailSender
                      (dev stub).
  auth-handler.ts     POST /auth/{register,login,password/forgot,
                      password/reset,profile-picture}.
  gif-validate.ts     GIF89a header check, ≤16 frames, DRAWBANG ext.
  storage.ts          Storage interface + FsStorage (dev/tests).
  s3-storage.ts       S3Storage (Lambda + scripts).
  lambda.ts           API Gateway v2 entry point — routes /ingest,
                      /gallery*, /d/*, /u/*, /feed.rss, /products*,
                      /users/{id}/stats, /auth/*, /hydrate,
                      /drawings/{id}/{like,bookmark} (POST + DELETE),
                      /users/{un}/follow (POST + DELETE),
                      /me/bookmarks/feed, /subscribe (POST, public).
                      Verifies the Bearer JWT for every write route except
                      /subscribe + for /me/bookmarks/feed. /hydrate
                      treats the Bearer JWT as optional (viewer_* fields
                      go null when absent).
  dev-server.ts       Node HTTP shim for `npm run ingest:dev` —
                      Memory* stores + ConsoleEmailSender (reset link
                      logged). Mirrors lambda.ts route table.

lib/templates/        Server-renderer (tagged-literal HTML)
  home.ts             / (the social feed) + /feed/items fragment
                      (infinite-scroll sentinel + observer).
  gallery.ts          Legacy grid template — still exports renderItem +
                      formatItemDate for the tile-page forks section.
                      /gallery itself 301s to / in production.
  tile-page.ts        /d/<id> (drawing detail with author, parent,
                      forks, action buttons, profile picture). Behaviour
                      lives in static/tile-page.js.
  owner.ts            /u/<username> (profile gallery, streak/badges,
                      profile picture). Exports renderProfilePicture()
                      shared with tile-page.ts + home.ts.
  products.ts         /products (merch catalog, ranked by popularity).
  feed.ts             /feed.rss.
  not-found.ts        /404.html shell.
  _time.ts            formatItemDate() — shared by home + gallery +
                      anywhere else that wants short "May 28" / "May 28,
                      2025" date strings.

merch/                Stripe + Printify orders Lambda
  lambda.ts           Entry point + DI wiring.
  printify.ts, stripe.ts, product-counters.ts, … (out of scope here)

infra/aws/
  template.yaml       SAM: Lambdas + HTTP API + S3 bucket + CloudFront
                      + DynamoDB tables + IAM.
  samconfig.toml      sam deploy defaults (stack: drawbang-ingest,
                      us-east-1).
  build-lambda.mjs    esbuild bundler (externals @aws-sdk/*).

static/               Plain JS + CSS shipped as edge assets
  chrome.css          Tokens + chrome + base .btn (see "Shared CSS").
  gallery-v2.css      Classes for Lambda-rendered pages.
  flash.js            Toast/flash UI exposed as window.drawbangShowFlash.
  chrome-identity.js  Identity link rewrite for the chrome + reveals any
                      [data-owner-only-for="<un>"] when the viewer matches.
  chrome-toggle.js    Hamburger toggle for narrow viewports.
  tile-page.js        Drawing-page client behaviour (copy-link, Web Share,
                      GA tracking).
  hydrate.js          **Single read-side hydration channel.** On load (and
                      MutationObserver tick) walks the DOM once to collect
                      [data-like-target] / [data-bookmark-target] (drawing
                      ids) and [data-follow-target] / [data-profile-username]
                      / [data-profile-picture-username] (usernames), fires
                      ONE GET /hydrate?drawings=…&users=… with optional
                      Bearer JWT, then stamps each element: like counts,
                      filled states, follow counts, follow button labels +
                      reveal, profile-picture <img>↔placeholder swaps.
  like.js             Click handler for `[data-like-target]` — optimistic
                      POST/DELETE /drawings/<id>/like, redirect to /login on
                      no/expired session, MutationObserver re-wires
                      infinite-scroll appends. Read-side state lives in
                      hydrate.js.
  bookmark.js         Same shape as like.js for `[data-bookmark-target]`.
  follow.js           Click handler for `[data-follow-target]` — POST/DELETE
                      /users/<un>/follow + optimistic follower-counter bump
                      on the profile page. Hides self-targeted buttons. Same
                      shape as like.js / bookmark.js.
  share.js            Web Share wirer for `[data-share-button]` controls
                      on the feed. navigator.share when supported, falls
                      back to clipboard copy + flash. Loaded by home.ts.
  subscribe.js        Submit handler for the hero email-capture form
                      (`[data-subscribe-form]`) — POST /subscribe + flash
                      feedback. Loaded by home.ts.
  og-logo.png         OG fallback image.

vite/plugins/
  chrome.ts           <!--CHROME:HEADER--> / <!--CHROME:FOOTER--> markers.
  dev-bucket.ts       Dev-only middleware that mirrors the prod
                      CloudFront Function so clean URLs work locally.

test/                 node:test suites
scripts/
  backfill-large-gifs.ts  npm run og:backfill — generate missing -large.gif.
  migrate-tiles.ts        One-shot DDB seeding from S3.
  recover-missing-tiles.ts One-shot for orphaned /tiles/<id>.gif rows.
  reassign-anonymous.ts   Reassigns migrated drawings to a real account.
  smoke-ingest.ts         End-to-end smoke test against a deployed endpoint.

docs/
  identity-considerations.md  Account model: JWT sessions, scrypt, reset
                              flow, and the security trade-offs.
  gotchas.md                  Build / deploy / SDK quirks worth knowing.
  auth-setup.md               SES + secrets bootstrap.

.github/workflows/
  deploy.yml          CI: typecheck + test + sam deploy + lambda:build.

legacy/               Archived Ruby app; read-only reference, never imported
```

## Critical invariants — don't break these

- **Drawing id is content-addressed on gif bytes alone.**
  `drawing_id = hex(sha256(gif_bytes))`. Same gif → same id, regardless
  of who publishes it.
- **Canonical drawing URL is `/d/<id>`**, not `/t/<id>`. The CloudFront
  Function 301s `/t/<id>` → `/d/<id>` (for stragglers from the
  short-lived tile-unification window). The canonical gif URL is
  `/tiles/<id>.gif`; legacy `/drawings/<id>.gif` rewrites to it at
  the edge.
- **Identity comes from the verified session JWT, never the request body.**
  The route (`ingest/lambda.ts` / `ingest/dev-server.ts`) verifies the
  Bearer JWT and passes `{ user_id, username }` into `handleIngest` /
  `handleSetProfilePicture` via `cfg.auth`. A missing/invalid token is
  a 401 before the handler runs.
- **Profile pictures only point at drawings the caller owns.**
  `handleSetProfilePicture` requires `drawing.username === auth.username`.
  Anonymous-bucketed drawings can't be claimed by anyone since `anonymous`
  is reserved and no real account holds it.
- **DrawingStore is the source of truth for the dynamic routes.** The
  ingest handler dual-writes a row before returning success; the
  render handlers query the store directly, so a newly-published
  drawing is visible immediately. CloudFront invalidations on
  `/gallery*`, `/u/<username>*`, `/feed.rss` keep the edge cache in
  sync.
- **GIF format is fixed.** ≤16 frames; per-drawing frame delay
  80–250 ms (editor FPS slider 4–12; legacy drawings sit on 200 ms /
  5 FPS; single-frame gifs exempt from the bounds at ingest); GCT has
  32 entries: slots 0..15 = active palette RGB, slot 16 = transparent,
  17..31 = 0.
- **DRAWBANG Application Extension** (in `src/editor/gif.ts`): app
  identifier `"DRAWBANG"` (8 bytes) + auth `"1.0"` (3 bytes) + one
  16-byte sub-block of base-palette indices. Without it,
  `encodeShareGif` can't generate the `-large.gif` OG image — see
  the publish handler's try/catch and `scripts/backfill-large-gifs.ts`.

## Commands

```
npm run dev            # Vite dev server (editor only)
npm run dev:all        # Vite + ingest dev server together — full e2e loop
npm run build          # tsc -b + vite build -> dist/
npm run typecheck      # tsc -b --noEmit
npm test               # node:test across test/**/*.test.ts
npm run ingest:dev     # Node ingest server on :8787 (FsStorage + Memory* stores)
npm run lambda:build   # esbuild the Lambda → dist-lambda/
npm run lambda:deploy  # lambda:build + sam deploy
npm run og:backfill    # generate missing public/tiles/<id>-large.gif sidecars
```

### Local e2e loop

`npm run dev:all` starts Vite on :5173 and the ingest dev server on
:8787 in one shell. Together they let you exercise the publish + auth
+ profile-picture paths end-to-end against the filesystem + in-memory
stores:

1. Open http://localhost:5173 — visit `/signup` and create an account
   (the dev server uses `MemoryUserStore` + `MemoryDrawingStore`, so
   accounts and drawings reset on restart).
2. Draw, then **Publish** (requires a session; otherwise you're sent
   to `/login`). The ingest server writes the gif to `./dev-bucket/`,
   adds the row to `MemoryDrawingStore`, and the next `/gallery` /
   `/d/<id>` / `/u/<username>` GET picks it up.
3. Visit `/d/<id>` while logged in — the **Set as profile picture**
   button appears next to the other actions and POSTs
   `/auth/profile-picture`. Visit your profile to confirm.
4. **Forgot password**: `/password/forgot` → the ingest dev server
   logs the reset link (which lands you on `/password/reset?token=…`)
   to its console (`[email] password reset for …`).

The Vite config proxies `/ingest`, `/auth`, and the rendered HTML
routes to `:8787`. The merch / order / products surfaces still
depend on DynamoDB and Stripe in prod — they're out of scope for
local e2e.

Tests are fast: `npm test` finishes in a few seconds. Iterate on a
single file with `node --test --import tsx 'test/render-handlers.test.ts'`.

## Environment variables

Editor (build-time):
- `VITE_INGEST_URL` — API Gateway / CloudFront URL for the ingest Lambda.
- `VITE_DRAWING_BASE_URL` — `${cloudfront-domain}/tiles` (drawing/fork/merch gif source).

Lambda (runtime, set via SAM):
- `DRAWBANG_BUCKET` — S3 bucket name.
- `PUBLIC_BASE_URL` — `https://${cloudfront-domain}`. Goes into the
  `share_url` and the password-reset link.
- `REPO_URL` — for the footer link.
- `DRAWBANG_USER_STATS_TABLE` — DDB table for per-account streak +
  total counters (#115/#116, default `drawbang-account-stats`).
- `DRAWBANG_USERS_TABLE` — accounts table (default `drawbang-users`).
- `DRAWBANG_USERNAMES_TABLE` — username reservations (default
  `drawbang-usernames`).
- `DRAWBANG_DRAWINGS_TABLE` — DDB source of truth for the dynamic
  gallery / drawing / profile / forks routes (default
  `drawbang-drawings`).
- `DRAWBANG_LIKES_TABLE` — DDB table for ❤️ likes (default
  `drawbang-likes`).
- `DRAWBANG_BOOKMARKS_TABLE` — DDB table for per-user bookmarks (default
  `drawbang-bookmarks`).
- `DRAWBANG_FOLLOWS_TABLE` — DDB table for follow edges between accounts
  (default `drawbang-follows`).
- `DRAWBANG_SUBSCRIBERS_TABLE` — DDB table for the email-capture list
  (default `drawbang-subscribers`).
- `DRAWBANG_PRODUCT_COUNTERS_TABLE` — feeds `/products` (default
  `drawbang-product-counters`).
- `CF_DISTRIBUTION_ID` — CloudFront distribution id for publish-time
  invalidations. Optional: empty skips invalidation (cached pages
  refresh at s-maxage instead).
- `JWT_SECRET` — HS256 secret for session + reset JWTs. **Required**:
  the ingest function fails loud at cold start if unset.
- `SES_FROM_ADDRESS` — verified SES sender for reset emails. Optional;
  when empty, reset requests still 200 but no email is sent.

Backfill scripts:
- `DRAWBANG_S3_BUCKET` — bucket the script reads/writes.

## AWS deployment

One-time setup:
1. Create IAM user with `AWSLambda_FullAccess`, `AmazonS3FullAccess`,
   `AmazonAPIGatewayAdministrator`, `AWSCloudFormationFullAccess`,
   `IAMFullAccess`, `AmazonDynamoDBFullAccess`, `CloudFrontFullAccess`,
   and `AmazonSESFullAccess`.
2. GitHub secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
   `PRINTIFY_API_TOKEN`, `PRINTIFY_SHOP_ID`, `STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET`, and `JWT_SECRET`.
   Prod environment **variable** (non-secret): `SES_FROM_ADDRESS`.
3. First deploy happens automatically on push to `master`. SAM
   creates the S3 bucket, Lambda, HTTP API, DynamoDB tables (orders,
   product counters, user-stats, users, usernames, drawings),
   CloudFront distribution, and IAM role.
4. **SES setup** (for password reset): verify a sender identity in
   SES, set `SES_FROM_ADDRESS` to it, and — if the account is in the
   SES sandbox — request production access so resets reach arbitrary
   recipients.

## Conventions

- TypeScript strict; don't loosen `tsconfig.json` without a reason.
- No comments explaining WHAT — only WHY, and only when non-obvious.
- Tests use `node:test` + `tsx`; don't introduce a test framework
  dependency.
- Storage operations must go through the `Storage` interface so
  `FsStorage` (dev/tests) and `S3Storage` (Lambda/scripts) stay
  interchangeable.
- **Merge directly to `master`** when a change is green (typecheck
  + tests pass). No PR review gate, no long-lived feature branches.
  The deploy workflow runs on every push to `master`.
- **Default end-of-task flow when implementing a feature/fix**:
  `npm run typecheck` → `npm test` (keep iterating until green) →
  commit → push → smoke-check in prod (pixel.drawbang.com) once
  the GH Actions deploy finishes. Don't pause to ask between these
  steps unless something fails or the diff is non-obviously
  destructive. Reserve confirmation for actions outside this loop
  (force-push, removing data, etc.).

## UI / UX consistency (paramount)

Before introducing any visible UI affordance — toast, modal, button
variant, status strip, banner, picker, page title style, link
hover, etc. — **search the repo first** for an existing
implementation. Reuse beats new.

Specifically:
- Cross-surface notifications: `src/layout/flash.ts` (Vite consumers)
  + `static/flash.js` (`window.drawbangShowFlash`, loaded as a plain
  script by Lambda-rendered pages). Styles live in `chrome.css` so
  every surface picks them up via the existing import chain.
- Cross-surface chrome (header, footer, nav, identity link,
  hamburger toggle): `src/layout/chrome.ts` + the
  `<!--CHROME:HEADER-->` / `<!--CHROME:FOOTER-->` markers for Vite
  pages; `renderHeader` / `renderFooter` called directly from
  `lib/templates/*.ts`.
- Buttons: `.btn` / `.primary` / `.ghost` / `.btn[hidden]` in
  `chrome.css` (works on both `<a>` and `<button>`). Variants
  `.icon` / `.sm` / `.xs` in `src/style.css` (Vite surfaces only).
- Tracking: `src/layout/tracking.ts` (`renderAnalytics`,
  `renderMetaPixel`) is the single source for both GA and Meta
  Pixel snippets.

When you find that a new surface (e.g. a Lambda-rendered page)
doesn't have access to a Vite-only helper, **prefer lifting it to
the shared layer over writing a parallel implementation**. The
lift pattern: hand-port to `static/<name>.js` (plain JS, exposes a
`window.drawbang*` global or reads `data-*` attributes), move its
CSS to `chrome.css`, load via `<script src="/<name>.js">`. See
`chrome-toggle.js`, `chrome-identity.js`, `flash.js`,
`tile-page.js`.

If reuse genuinely isn't viable (e.g. the surface needs a different
interaction model), say so explicitly in the commit message and ask
before proceeding — divergent UX is harder to walk back than a
slightly bigger refactor.

## Naming conventions

- **Files**: kebab-case for all source files (`render-handlers.ts`,
  `tile-page.ts`). Avoid abbreviations; spell out domain terms.
- **Modules**: file name matches the primary export. One concept per
  file.
- **Types / Interfaces**: PascalCase (`UserRecord`, `DrawingRow`).
  Suffix with `Config`, `View`, `Options` when appropriate.
- **Functions / Variables**: camelCase (`activePalette`,
  `handleSetProfilePicture`). Booleans start with `is/has/can/should`.
- **Constants**: `UPPER_SNAKE_CASE` for true compile-time constants
  (`MAX_FRAMES`, `WIDTH`). Config objects exported from `config/`
  use `PascalCase` export names.
- **CSS classes**: kebab-case with namespace prefix (`dr-` for
  drawing detail, `ow-` for owner profile, `pr-` for products,
  `ed-` for editor, `mc-` for merch, `hdr`/`ftr` for chrome).
  Shared chrome classes live in `chrome.css`.
- **Worker files**: `*.worker.ts` suffix (none right now; reserve
  for future).
- **Test files**: `*.test.ts` mirrors source name where useful.
- **Avoid**: Hungarian notation, single-letter names except loop
  indices, cryptic abbreviations.
- **Renames**: When renaming a public module, update all imports,
  config references, and documentation in the same commit. Run
  `npm run typecheck` before pushing.
