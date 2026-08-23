# Build & deploy gotchas

Project-level knowledge that bit a previous session. Add to this file
whenever a fix isn't obvious from the code or commit message — the goal is
to spare the next agent / contributor an hour of head-scratching.

## TypeScript / tsconfig

- `verbatimModuleSyntax: true` + `moduleResolution: "Bundler"` does **not**
  propagate the inner namespace through the Stripe SDK's
  `export { Checkout }` re-export. Use
  `Parameters<Stripe["checkout"]["sessions"]["create"]>[0]` instead of
  `Stripe.Checkout.SessionCreateParams`. Same shape applies to
  `Stripe.Checkout.Session.CustomerDetails` etc. — destructure via
  `NonNullable<Stripe.Checkout.Session["customer_details"]>`.
- `tsconfig.json` `include` is selective. When a new top-level directory
  appears (e.g. `merch/`, `vite/`), add a glob — files outside the list
  silently fail to typecheck.

## SDK pins

- Stripe SDK pin: `2026-04-22.dahlia` (latest in v22). Old issue bodies
  reference `2025-09-30.clover`; those references are stale.
- Stripe SDK v22 moved checkout shipping into
  `Session.collected_information.shipping_details`. The older top-level
  `Session.shipping_details` isn't on the type.

## Runtime quirks

- `pngjs` `pack()` is a stream, not a sync method. Collect chunks into a
  `Uint8Array` and return via Promise (see `merch/upscale.ts`).
- `DynamoDBDocumentClient.from(client)` shares the underlying client's
  middleware stack — it never calls `client.send()`. Stubbing `client.send`
  in tests won't intercept anything. `OrdersStore` and
  `ProductCountersStore` expose a `docClient?:` seam specifically for
  this reason; production passes a real `client` and lets the store wrap
  it.
- The Lambda bundle (`dist-lambda/*.js`) is CJS, but the parent
  `package.json` has `"type": "module"`. Local
  `require('/path/dist-lambda/foo.js')` from inside the project will fail
  (Node loads it as ESM via parent type). AWS Lambda doesn't see the
  parent `package.json`, so it loads as CJS at runtime and works. To
  smoke-test exports locally, copy the bundle outside the project tree or
  import the source via `tsx`.

## API Gateway

- HTTP API event `routeKey` already includes the method
  (e.g. `"GET /merch/products"`). Don't prefix it again with
  `event.requestContext.http.method` — switch on `routeKey` directly.

## SAM / CloudFormation

- YAML flow-mapping (`{ Path: /foo/{id} }`) chokes on `{id}`. Write SAM
  Event `Properties` in block form when the path has placeholders.
- `!If` inside SAM `CorsConfiguration` corrupts the transform — keep the
  list literal, conditionalise only a single element.
- Local `sam deploy` hits transient XML parser errors via the SAM CLI's
  bundled botocore. Retry; CI doesn't have this issue.

## CloudFront / S3

- `/state/last-publish.json` must not be cached at the edge — handled by a
  separate CloudFront cache behavior with `CachingDisabled`.
- **OAC + no `s3:ListBucket` grant → 403 on missing key, not 404.** When a
  URL behind CloudFront returns `AccessDenied`, the most likely cause is
  "that S3 object doesn't exist," not an IAM problem. `/products` did this
  before #154's empty-state fix; `/identity` did it until the static page
  landed.
- **Never mark un-hashed static files `immutable`.** Vite copies `static/`
  to `dist/` verbatim — `gallery-v2.css`, `chrome-toggle.js`,
  `chrome-identity.js`, mockups. `deploy.yml` MUST split the S3 sync so
  only `dist/assets/*` (hashed by Vite) carries the
  `max-age=31536000, immutable` header. Stamping immutable on un-hashed
  paths traps every visiting browser on that exact byte sequence for a
  year with no revalidation — the fix is a URL rename (which is why
  `gallery.css` is now `gallery-v2.css`).
- **Every served URL pattern MUST be in `deploy.yml`'s CloudFront
  invalidation list.** The "day/key/drawing pages are immutable per
  builder invariant" reasoning is true for _daily incremental builds_
  but **false on any template-wide refactor** (chrome, footer, logo,
  global CSS, etc.). When a refactor changes the rendered HTML for
  existing pages, omitting `/d/*` / `/days/*` / `/keys/*` from the
  invalidation list traps CloudFront edges on the pre-refactor HTML
  for up to 24h (the default edge TTL when origin sends no
  `Cache-Control`). #102 hit this — the chrome shipped, the HTML in
  S3 was correct, but `/keys/<pk>` rendered the old layout at one
  user's edge POP. Fix: invalidate every path on every deploy.
  Wildcards count as one path each, so the cost is negligible.
- Adding a new clean-URL rewrite to `infra/aws/template.yaml`'s
  CloudFront Function MUST also add a matching entry in the
  invalidation list — same rule, narrower case (new URL pattern, not
  just refactored content).
- Editor's `share_url` is `${PUBLIC_BASE_URL}/d/<id>` (CloudFront), not the
  S3 origin URL. CloudFront Function rewrites `/d/<id>` to `/d/<id>.html`.

## Local dev server (`npm run dev:all`)

- **The dev-bucket middleware runs BEFORE Vite's proxy.** Its clean-URL
  404 (anything whose last path segment has no `.`) fires first, so a
  path that `vite.config.ts` means to proxy gets a 404 page instead.
  Two facets are fixed — non-GET methods are exempt (`POST /ingest` was
  404ing, which broke the entire documented publish loop) and `/@…`
  paths are exempt (`/@vite/client` was 404ing, which broke HMR _and_
  stopped page scripts evaluating, so `/login` and `/signup` fell back to
  native GET form submits that put the password in the URL bar).
- **Still unfixed:** proxied _GET_ routes (`/d/<id>`, `/u/<un>`, `/`) are
  shadowed by the same rule. Read those off `localhost:8787` directly.
  Fixing it properly means teaching the plugin about the proxy table.

## Proof-of-work gate (ALTCHA) on register + forgot-password

- **The counter in a solution is not the proof.** In deterministic mode
  `verifySolution()` checks an HMAC over `solution.derivedKey` against the
  `keySignature` in the signed challenge and never looks at
  `solution.counter`. A test that mutates the counter and expects a
  rejection will fail — mutate `derivedKey` instead. (Tampering with the
  challenge _parameters_ is caught separately, by the challenge HMAC.)
- **`verifySolution()` does not stop replay.** It has no idea whether a
  solution was already spent. `ingest/challenge-store.ts` is what enforces
  single use; without it the gate is decoration. Don't "simplify" it away.
- **Two constants multiply.** Solver cost is roughly (counter value) x
  (PBKDF2 cost). Sweeping only one of them while holding the other fixed
  gives nonsense timings — that's how a first calibration pass landed on
  30-second solves.
- The widget (`altcha` npm) is v3 and the server lib (`altcha-lib`) is v2;
  they interoperate — v2 of the lib is the version that speaks v3's PoW
  format. The `v1` API is still exported at `altcha-lib/v1` and is a
  _different_, incompatible scheme.
- **The widget renders a `required` checkbox inside your form.** On a form
  without `novalidate`, native constraint validation blocks submission
  before any JS submit handler runs — no request, no error message,
  nothing in the console. That's what broke the editor's publish dialog;
  every auth form in this repo now carries `novalidate` and validates in
  the handler + on the server.
- `hidefooter` / `hidelogo` are `Configuration` fields in widget v3, not
  observed HTML attributes. Putting them on `<altcha-widget>` does
  nothing — set them via `$altcha.defaults.set()` or `.configure()`.
- Tests floor the difficulty via `ChallengeConfig.difficulty`
  (`test/support/challenge.ts`). At that floor a "weakened" challenge can
  be byte-identical to the original, so a tampering test has to mint above
  the floor to have something to weaken.

## CloudFront turns origin 403s into a 404 HTML page

`CustomErrorResponses` in `infra/aws/template.yaml` maps **both** 404 and
403 from the origin to `/404.html` with status 404, distribution-wide
(they can't be scoped per cache behaviour). So any JSON API on a
CloudFront-routed path that answers 403 has its body replaced by the 404
page before the client sees it.

Bitten twice:

- the proof-of-work gate on `/auth/register` — a legitimate expired
  challenge became an unparseable HTML 404, so it now answers **400**;
- `/admin/data` for a non-allowlisted user — the boot script's
  `res.status === 403` branch is unreachable through the CDN, so the
  operator sees "Couldn't load admin data" instead of "Not authorised".
  Cosmetic, still unfixed.

To see what the origin _really_ returned, hit the `execute-api` URL
directly (see "Verifying against production" in CLAUDE.md).

## Vite dev server shadows proxied GET routes

`vite/plugins/dev-bucket.ts` runs **ahead** of vite's proxy, so any
extensionless path it doesn't recognise gets its clean-URL 404 page
instead of being forwarded to the ingest dev-server on :8787. Two
symptoms already caused by this:

- `POST /ingest` 404ing (fixed by exempting non-GET methods),
- `GET /auth/challenge` 404ing, which broke signup entirely in dev.

The proxied path list now lives in `vite.config.ts` as `DEV_PROXY_PATHS`
and is passed to both the proxy and the plugin. **Add new dev-server
routes there**, not to the proxy alone.

## Draft autosave + `beforeunload` + `visibilitychange`

- The canvas has **two** draft stores: async IndexedDB (`src/local.ts` `drawbang` DB — the "My drawings" history) and sync `localStorage` `drawbang:draft:{size}` (the reload guard). The sync store must stay **synchronous** — `visibilitychange`/`beforeunload` have no time to `await` IndexedDB, so `writeDraft()` does a single `localStorage.setItem` and `persist()` calls it without awaiting.
- Cap is `MAX_LAYERS_JSON_BYTES` (64 KiB). `writeDraft` measures `JSON.stringify(payload).length` and **skips** the write if it would exceed the cap; it does not truncate — a truncated JSON would not parse on restore. A drawing that exceeds the cap simply has no reload guard for that stroke (rare at 16×16).
- `hasUnsavedContent()` is the gate for both guards. It checks for any non-transparent pixel **or** `frames.length>1`/`layers.length>1`. A blank multi-frame document still counts as unsaved — that’s intentional, losing a second frame is still data loss.
- `beforeunload` must set **both** `e.preventDefault()` and `e.returnValue = ""` — some browsers require one, some the other, and Safari mobile only shows its dialog when `returnValue` is set to a non-null string. Don’t add a custom message string; modern browsers ignore it and show a generic prompt.
- The restore banner (`#draftRestoreBanner`) only appears when **neither** `?fork=` nor `#d=` is present. In those cases the URL is the source of truth and a stale local draft would be wrong to surface. `readDraft` is keyed by `currentSize`, so a 32×32 draft never restores into a 16×16 session.
- `resetEditor` clears the draft **before** re-applying the palette and calling `persist()` — `persist()` would otherwise see the fresh blank canvas, see `hasUnsavedContent()==false`, and remove the key anyway, but clearing explicitly makes the intent obvious and covers the publish path (`clearDraft()` before `resetEditor({keepPublishedId:true})`).

## Vite entries at nested clean URLs need absolute asset paths

`/password/forgot` and `/password/reset` are the only Vite entries whose
clean URL has a nested path segment. With relative asset paths
(`./src/foo.ts`) the browser resolves them against `/password/`, giving
`/password/src/foo.ts` → 404, so the page's script never runs. The form
then falls back to a **native GET submit**, putting field values in the
URL. Both files use root-absolute `/src/...` paths for this reason;
don't "tidy" them back to relative.

## Reproducing a Lambda-only encode failure locally

The Lambda runs **arm64** and resolves ffmpeg at `/var/task/ffmpeg`
(vendored by `infra/aws/build-lambda.mjs`). A dev box is usually x64, so
`encodeShareMp4` fails locally with `spawn ffmpeg ENOENT` and tells you
nothing about prod.

To run the _exact_ prod command on real bytes:

```
npm install --no-save --force @ffmpeg-installer/linux-x64
# binary lands at node_modules/@ffmpeg-installer/linux-x64/ffmpeg
# then run the args from ffmpegArgs() in ingest/share-mp4.ts against a
# -large.gif downloaded from /tiles/<id>-large.gif
```

`--no-save` keeps `package.json` and the lockfile clean — verify with
`git diff HEAD --stat -- package.json package-lock.json` before committing.

`npm run lambda:build` fails locally for the same reason (it wants the
arm64 package). CI vendors it explicitly; don't chase this locally.

## Investigating a missing `-large.gif` / `-large.mp4`

One drawing published 2026-06-27 lost its `-large.mp4`. What that cost
three attempts to learn, so you don't repeat it:

- **Measure before theorising.** Coverage across the whole gallery was
  96/97 — a ~1% gap, not the systemic failure a six-drawing sample
  suggested. `/feed.rss` + a `HEAD` per `/tiles/<id>-large.mp4` surveys
  everything with no credentials.
- **Ruled out:** a corrupt source gif (it decoded fine, DRAWBANG ext
  present); ffmpeg rejecting the content (the exact `-large.gif` encoded
  to a valid 18 KB mp4 locally); the Lambda timeout (worst-case tail is
  6.7 s against 30 s — see "Publish latency" in CLAUDE.md).
- **Confirmed:** the tail _was_ running — each retry rewrote
  `-large.gif`, moving its `Last-Modified` while the `ETag` stayed
  identical (the re-render is deterministic). So the gif step succeeded
  and the mp4 step failed silently, twice, only via the async
  self-invoke. Running the same code synchronously
  (`POST /backfill/sidecars?drawing=<id>`) succeeded first try.
- **Never root-caused**, because the telemetry didn't exist yet. It does
  now (`kind: "tail"`, see "Observability" in CLAUDE.md) — start there,
  not from a hypothesis.

## GitHub Actions

- **Find a deploy run via the workflow, not the repo.**
  `/actions/runs?branch=master` returns the newest run of _any_ workflow,
  so a CodeQL run that raced your push will be picked instead and you'll
  watch the wrong jobs. Use
  `/actions/workflows/deploy.yml/runs?branch=master`.
