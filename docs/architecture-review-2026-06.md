# Architecture review — June 2026

Consolidated suggestions registry. Supersedes `code-review-todos.md`
(2026-06-07 review pass); its open items are carried over below.

Each `## #hashtag` section with a **code marker** maps to a
`// TODO (#hashtag):` comment grep-able in source — search the repo for
the tag to jump to the affected lines:

```
grep -rn "TODO (#" src ingest lib static config docs
```

Items marked **no code marker** are doc-only (infra, process, or
cross-cutting items with no single natural anchor in source).

All entries below are open. When one ships, remove the matching code
TODO markers and either delete the section here or mark it as resolved
with the commit SHA.

---

## #dev-server-drift — high

`ingest/lambda.ts` (752 lines) and `ingest/dev-server.ts` (582 lines)
hand-mirror the same route table: every dynamic route's regex, auth
gating, and dispatch logic is written twice. Beyond the routes,
`extractAuth()` and the `json()` / `jsonWithHeaders()` response helpers
are duplicated near-verbatim. The "Adding a new Lambda-rendered route"
checklist in CLAUDE.md exists *because* of this drift hazard — a route
added to one entry point but not the other works in prod and 404s in
dev (or vice versa), which is exactly the class of bug that's hard to
notice until it bites.

**Files**
- `ingest/lambda.ts` (route table ~lines 213–380, `extractAuth` ~619,
  `json` helpers ~711)
- `ingest/dev-server.ts` (route table ~lines 135–482, `extractAuth`
  ~498, helpers ~514)

**Suggested fix.** Extract a shared route-definition module
(`ingest/routes.ts`): an ordered list of
`{ method, pattern, auth: "required" | "optional" | "none", handler }`
entries plus the shared `extractAuth()` and JSON helpers. `lambda.ts`
and `dev-server.ts` keep only their event-adaptation layers (API
Gateway event vs Node `http.IncomingMessage`). A new route then lands
in one file and both servers pick it up — and a single route-table test
covers both (see `#test-gaps`).

---

## #type-safety — high

*(Carried over from the 2026-06-07 pass.)*

`JSON.parse(...) as T` casts at request/JWT boundaries trust shape
blindly. A malformed body with the right keys still flows through to
handlers.

**Files**
- `ingest/dev-server.ts:150` — `let parsed: any` + `JSON.parse(body)` →
  handler. Validate the parsed object shape before dispatch.
- `ingest/lambda.ts:526` — `parseJson(event) as IngestRequest` (and the
  register/login/profile-picture analogues). Each route should validate
  its expected keys' types.
- `ingest/jwt.ts:55` — `JSON.parse(payload) as T` trusts the claims
  shape. `exp` is checked, but `sub` / `un` / `purpose` / `tv` are read
  elsewhere without `typeof` guards.

**Suggested fix.** Lightweight per-route validators (`typeof` checks,
no new dependency) or one shared `assertShape(input, schema)` helper.
Keep validators colocated with their request types. Pairs naturally
with `#dev-server-drift`: validators attached to the shared route
definitions run identically in both servers.

---

## #split-render-handlers — medium

*(Carried over from the 2026-06-07 pass.)*

`ingest/render-handlers.ts` is 891 lines and mixes every dynamic route
the Lambda serves: home/feed, tile page, profile, follow lists,
bookmarks, products, design, feed.rss, not-found.

**Files**
- `ingest/render-handlers.ts`

**Suggested fix.** Split by domain:

```
ingest/
  render-shared.ts        # RenderHandlersConfig, notFound(), …
  render-home.ts          # / + /feed/items
  render-tile.ts          # /d/<id>
  render-profile.ts       # /u/<un>, /u/<un>/items
  render-follow-list.ts   # /u/<un>/{followers,following}
  render-bookmarks.ts     # /u/<un>/bookmarks
  render-products.ts      # /products
  render-feed.ts          # /feed.rss
  render-design.ts        # /design
```

Keep `lambda.ts` thin — it already routes per-path; physical separation
just follows the route boundaries it already enforces.

---

## #shared-escape — medium

Three independent HTML-escaping implementations across the Vite and
Lambda worlds. They agree today; nothing keeps them agreeing (e.g. one
gaining backtick/`'` escaping while the others don't).

**Files**
- `lib/templates/_escape.ts` — `esc()`, used by all Lambda templates.
- `src/layout/chrome.ts:182` — local `esc()`, same body, redefined.
- `src/order.ts:78` — local `escapeHtml()`, third copy.

**Suggested fix.** One shared module imported by all three. Since
`src/layout/chrome.ts` is already imported by Lambda templates (the
chrome renders on both surfaces), the Vite/Lambda build boundary
demonstrably allows sharing — either point `lib/templates/_escape.ts`
at a `src/escape.ts` re-export or vice versa; pick one canonical home
and delete the other two bodies.

---

## #admin-inline-styles — medium

`lib/templates/admin.ts` ships a ~24-line inline `<style>` block
(`ADMIN_STYLES`, the `.adm-*` classes) via `extraHead`. This violates
the three-CSS-file rule (CLAUDE.md "Shared CSS"): Lambda-template
classes belong in `static/gallery-v2.css`, where they're versioned and
cached with the asset instead of re-sent on every page load.

**Files**
- `lib/templates/admin.ts:51` — `ADMIN_STYLES`.

**Suggested fix.** Move the `.adm-*` rules to `static/gallery-v2.css`
and drop `ADMIN_STYLES`. (`lib/templates/design.ts`'s inline swatch
styles stay exempt — the inline value is literally what each showroom
row demonstrates; ruled "kept as-is" in the 2026-06-07 pass.)

---

## #shared-localstorage — medium

*(Carried over from the 2026-06-07 pass.)*

The same `try { localStorage.{get,set,remove}Item } catch {}`
boilerplate appears across seven surfaces — TS and plain JS.

**Files**
- `src/auth.ts`
- `src/order.ts` (`hasPurchaseFired`/`markPurchaseFired`)
- `src/main.ts` (palette persistence)
- `src/privacy.ts`
- `static/toggle-handler.js` (shared JWT read)
- `static/follow.js` (viewer-username read)

**Suggested fix.** `src/storage-utils.ts` with `safeGet(key)`,
`safeSet(key, value)`, `safeRemove(key)`. Mirror as
`static/storage-utils.js` for plain-JS consumers. Quota/private-mode
behaviour stays the same; call sites collapse to one line.

---

## #test-gaps — medium · no code marker

Coverage is broad (45 test files; auth, the publish path, jwt,
password, all the stores, and gif validation are covered). The
remaining gaps:

- **Route tables** — `ingest/lambda.ts` / `ingest/dev-server.ts` have
  no route-level test: per-route status codes, auth gating (401 before
  handler), 404 fallthrough. Highest-value gap; becomes a single table
  test once `#dev-server-drift` lands.
- `ingest/discover-handler.ts` — feeds the right rail; untested.
- `ingest/log-outcome.ts`, `ingest/cloudwatch-logs.ts` — the new
  observability layer; untested.
- `ingest/user-stats-handler.ts` / `user-stats-store.ts` — streak +
  badge counters (#115/#116). `streak-render.test.ts` covers rendering
  only, not the store's date math.

**Accepted gaps** (thin AWS wrappers, low value to fake):
`ingest/email.ts`, `ingest/s3-storage.ts`.

---

## #observability-alarms — medium · no code marker

`infra/aws/template.yaml` defines no CloudWatch alarms. The `/admin`
overview (per-request outcome logs + Insights queries) is pull-based —
nothing notifies on a 5xx spike, Lambda throttling, or DynamoDB
throttles; you find out when you next open `/admin`.

**Suggested fix.** A small alarm set in the SAM template + one SNS
topic with an email subscription:
- Lambda `Errors` / `Throttles` on the ingest + merch functions
- API Gateway 5xx rate
- DynamoDB `ThrottledRequests` (or rely on PAY_PER_REQUEST headroom and
  skip)

Note: CloudWatch **log retention** is intentionally managed out-of-band
(`aws logs put-retention-policy`, 90 days — see the comment in
`template.yaml`), because CFN can't adopt Lambda-auto-created log
groups without an import. Don't re-add a `LogGroup` resource.

---

## #dependabot — medium · no code marker

`npm audit` (2026-06-10): **4 vulnerabilities — 2 moderate, 2
critical** — all in dev-only dependency chains, nothing shipped to
prod bundles:

- **esbuild ≤0.24.2** (moderate, GHSA-67mh-4wv8-2f99) via `vite` ≤6.x —
  dev server can be made to proxy requests for any website. Fix is
  `vite@8` (breaking; plugin API + config review needed).
- **shell-quote 1.1.0–1.8.3** (critical, GHSA-w7jw-789q-3m8p) via
  `concurrently@9` — `quote()` doesn't escape newlines in `.op` values.
  ✅ **Done** (d7102b6, 2026-07-15): bumped to `concurrently@10`, drop-in
  for `npm run dev:all`; the shell-quote critical is gone from
  `npm audit`.

**Suggested fix.** ~~Bump `concurrently` first (cheap, kills the
critical).~~ Done — see above. Schedule the `vite@8` migration
separately — it drags the esbuild fix along and needs a real pass over
`vite/plugins/*` and the build output. Exposure in both cases is local
dev only.

---

## #inline-styles — low

*(Carried over from the 2026-06-07 pass.)*

Inline `style="..."` attributes that should be CSS classes.

**Files**
- `src/main.ts:164` — the `<span style="margin-left:6px">` icon-label
  spans on the Copy / Paste / Play / Pause editor buttons. Replace with
  a `.btn-icon-label` rule in `src/style.css`.

**Considered but kept as-is** (not flagged in code):
- `lib/templates/design.ts` — the swatch/type/spacing rows use inline
  `style="background: var(${t.name});"` etc. The inline value is
  literally what each row demonstrates; lifting to CSS would obscure
  the showroom intent. Leave alone.
- `lib/templates/feed.ts` — `style="image-rendering:pixelated"` inside
  an RSS `<description>`. Most readers strip inline styles regardless;
  removal is fine as a follow-up but doesn't materially help.

---

## #now-idiom — low

Two idioms for the same injectable-clock test seam:

- `ingest/likes-handler.ts:37`, `ingest/bookmarks-handler.ts:36` —
  `cfg.now ? cfg.now() : new Date()`
- `ingest/auth-handler.ts:125,170,192,222` —
  `(cfg.now ?? (() => new Date()))()`

**Suggested fix.** Standardise on the nullish-coalesce form (or a tiny
`nowOf(cfg)` helper in `handler-utils.ts`). Cosmetic, but the kind of
divergence that multiplies as handlers get copied.

---

## #draw-rename — low · no code marker

Pending site-wide user-facing copy rename **"Drawbang" → "Draw!"**.
Scope: visible copy only (page titles, headings, footer, emails, OG
tags). Internal identifiers stay `drawbang` (env vars, DDB table names,
`localStorage["drawbang:*"]` keys, CSS namespaces, repo name).

---

# Consistency observations (no action)

Surveyed 2026-06-10; recorded so future reviews don't re-litigate.

- **Template shell** — all Lambda templates route through
  `renderHtmlShell()` (`lib/templates/_html-shell.ts`); the 404-drift
  class of bug is closed.
- **Error shape** — JSON endpoints consistently return
  `{ error: string }` with sensible statuses via
  `ingest/handler-utils.ts` (`err`/`ok`/`toggleAction`).
- **Model patterns to imitate** — `static/toggle-handler.js` (one
  factory behind like/bookmark/follow) and `static/hydrate.js` (single
  read-side hydration round trip) are the reference implementations
  for any new client behaviour.
- **"tile" vs "drawing" naming** — historical drift, documented in
  CLAUDE.md; storage paths intentionally keep `tiles/`. Not worth a
  migration.
- **Product-level TODOs living in their own homes** (referenced, not
  moved here): merch shipping calc stub (`merch/lambda.ts:43`), share
  links 16×16-only (`src/main.ts:724`), SVG icon swap
  (`src/main.ts:83`).
