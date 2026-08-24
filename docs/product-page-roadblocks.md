# Product page — roadblock removal before re-attempt

> Companion to [#296](https://github.com/potomak/drawbang/issues/296).
> The 14-commit product-page effort (`429e539` → `7d37f42`) was reverted
> in `c43fd15`. This doc translates every retrospective point into a
> concrete, shippable action item, notes what was fixed on the
> `chore/product-page-roadblocks` branch, and lays the plan for the next
> attempt so the current `/merch` flow is never disrupted.
>
> **Branch for these mitigations:** `chore/product-page-roadblocks`
> (PR required; never push to `master` directly — see § PR workflow).

---

## 0. Direct answers

### Is `vite + AWS Lambdas` too confusing?

No. The shape is small and documented (`CLAUDE.md:2` + `ingest/routes.ts` +
`infra/aws/template.yaml`), but it is _brittle_ — one file can 404 the
other. The fixes below don't simplify the architecture; they make the
brittle coupling checkable locally (`scripts/check-*.js`, `--force`).

If the prompt was "should an autonomous agent ship Lambda routes without
the two-file checklist", the answer would be "not yet" — that's why the
checklist exists. With the guards in place, the env is workable.

### Tote bag image

You are right — `static/mockups/tote.jpg` (`33955` bytes, `15b0086`)
was an abstract geometric rendering with no tote silhouette. It went out
in `c43fd15` and is not coming back as-is. Next attempt must replace it
with a real product photo (see § Tote bag asset).

---

## 1. Feedback → root cause → action items

| #   | Retrospective theme                                           | Root cause (from #296)                                                                                                                                                                                                                                                               | Concrete action                                                                                                                                                                                                                                                    | Status on roadblocks branch                                                                                                                                                                                           |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CSS ownership violated → invisible defaults 13/14 commits     | SSR rendered `.mc-pills` + `aria-pressed="true"` correctly, but only `.pp-pills .btn[aria-pressed="true"]` was styled in `gallery-v2.css`/`style.css`. No single token owned the pressed state.                                                                                      | Add **one** source in `static/chrome.css`: `.pill-group` + `.pill-group .btn[aria-pressed="true"]` (accent fill). Future product page uses `pill-group`; `/merch` migrates to it. Do not reintroduce `.mc-pills`/`.pp-pills`.                                      | **Done** — `static/chrome.css:572` (`pill-group` block).                                                                                                                                                              |
| 2   | Vite proxy too greedy → blank canvas / 404 module             | `vite.config.ts:50` `^/merch/.*` proxied `/_/merch/placement.ts` module imports to ingest → 404 → `Importing a module script failed`.                                                                                                                                                | Tighten proxy intent: `DEV_PROXY_PATHS` only lists API + dynamic HTML; mockup preview stays on Vite. Add negative test `scripts/check-proxy.js` that fails CI if any proxy pattern matches `src/**` or `merch/**` imports. Also `dev:all` now runs `vite --force`. | **Done** — `scripts/check-proxy.js` + `package.json:lint` + `dev:all --force`. No `/merch` proxy entry in current `DEV_PROXY_PATHS` (revert removed it, intentional).                                                 |
| 3   | Same-origin CORS + canvas taint                               | `loadMockupImage` always set `img.crossOrigin="anonymous"` even for same-origin `mockup.jpg`, tainting the canvas and aborting `paintMockupPreview`. Extra: `CENTER_PIXEL 0,0,0,0` left Safari black well.                                                                           | Only set `crossOrigin` for cross-origin URLs (`new URL(url, location.origin).origin !== location.origin`). Centralise in `src/merch-preview.ts`. Add unit test for `isCrossOrigin` logic (future).                                                                 | **Done** — `src/merch-preview.ts:116` (`isCrossOrigin` + conditional `crossOrigin`).                                                                                                                                  |
| 4   | Vite dep cache staleness (`omggif 504 Outdated Optimize Dep`) | `npm ci` left stale `node_modules/.vite`, breaking `src/editor/gif.ts` → `Bitmap` null → preview unavailable. Manual `rm -rf` was the fix.                                                                                                                                           | Run Vite with `--force` in `dev:all` so every `npm run dev:all` busts the optimised-deps cache. Document `rm -rf node_modules/.vite` as fallback in `docs/gotchas.md`.                                                                                             | **Done** — `package.json:dev:all` is now `vite --force`.                                                                                                                                                              |
| 5   | SSR ↔ hydration default divergence                            | Server `defaultVariant()` → M Black (`12125`), client `pickDefaultVariant()` → `variants[0]` S Black (`12126`), hydration flip + `[data-value]` vs `[data-axis-value]` selector mismatch.                                                                                            | Extract **one** `defaultVariant(variants)` in `merch/catalog.ts` (M Black → cheapest → color-rank → size-rank) and have both SSR and hydration import it. Unify selector to `[data-value]` + `.pill-group`. Remove duplicated `pickDefaultVariant`.                | **Done** — new `merch/catalog.ts` with `defaultVariant`, `formatUsd`, re-exports. Not yet wired into `/merch` SSR (no product page to hydrate yet) — wiring is first commit of next product-page PR (no merch break). |
| 6   | Dev store volatility + no seed                                | `MemoryDrawingStore` wipes on ingest:dev restart; `dev-bucket/public/tiles/*.gif` survives but `/d/:id` 404s → `TimeoutError: #dr-products`. Re-injection was manual.                                                                                                                | Add `scripts/seed-dev.ts` that scans `dev-bucket/public/tiles/*.gif`, hashes each to `drawing_id` (same `hex(sha256(gif))` as prod), and re-inserts missing rows on `ingest/dev-server.ts` boot. Keep idempotent.                                                  | **Done** — `scripts/seed-dev.ts` scaffold (pure scan + hash + `drawingStore.get` guard). Hook into `ingest/dev-server.ts` boot is next PR's first commit (behind a flag so prod is unaffected).                       |
| 7   | Prettier gate discovered late                                 | `prettier --check` (`printWidth:100`) blocks deploy, but was only documented in `9b1e19c` and needed 4 fixup commits. Local `npm test`/`tsc` didn't enforce it.                                                                                                                      | Wire `format:check` into the pre-push gate: `npm run lint` is shareable and CI already runs `format:check` (`deploy.yml:test`). Recommend local `husky pre-push` or `npm run lint` alias; document in `CLAUDE.md:Commands`.                                        | **Done** — `deploy.yml` already runs `format:check`; `package.json:lint` now runs the two proxy/route checks alongside. Full local gate is `typecheck && build && format:check && test && lint`.                      |
| 8   | No per-commit E2E gate; infra coupling unchecked              | E2E (SafariDriver → 5 pr-cards, compositing pixel check, `pressed=true` on M/Black, price, mobile 390) ran episodically. Infra: every new Lambda path needs both `ingest/routes.ts` + `infra/aws/template.yaml:Events` (+ possibly `CacheBehaviors`). Missing one = API Gateway 404. | Provide `scripts/check-routes.js` (heuristic compare of `createRoutes()` patterns vs `template.yaml` `Path:` entries) for CI (`lint`). Require per-commit local gate: `typecheck && build && format:check && test && curl -s :8787/products/...                    | grep -q 'aria-pressed="true"'`. Future product page adds SafariDriver pixel check + mobile 390 + `pill-group`accent diff +`Continue to checkout` enabled.                                                             | **Done** — `scripts/check-routes.js` + `package.json:lint`. Per-commit E2E remains manual until SafariDriver is in CI; document in `docs/merch-test-runbook.md`. |
| 9   | History — direct `master` pushes + over-broad revert          | 14 commits on `master` with `push --force` later blocked → compensating revert `c43fd15` also reverted unrelated `429e539 fix(admin): /admin/orders shell`.                                                                                                                          | From now on **no direct `master` pushes**. Every change (including roadblock branch) ships via PR. Require status checks on `master` (see § PR workflow).                                                                                                          | **Proposed** — GitHub Ruleset (see below). Roadblocks branch itself is opened as a PR, not pushed to `master`.                                                                                                        |

---

## 2. What was changed on `chore/product-page-roadblocks`

Small, merch-safe prep — no `/products/:id/:product` route, no mockup asset,
no variant picker UI. Each file lists the invariant it protects:

- **`src/merch-preview.ts`** — `loadMockupImage` now only sets
  `crossOrigin="anonymous"` for cross-origin URLs (same-origin stays
  taint-free). Fixes merch preview taint in dev (issue §3). No API change.

- **`merch/catalog.ts` (new)** — `defaultVariant`, `formatUsd`,
  `priceDollars`, re-exports `DEFAULT_PLACEMENT`/`isValidPlacement`.
  Single source for the M-Black default; prevents SSR↔hydration drift
  (§5). Not yet imported by `/merch` or templates — first consumer is the
  next product-page PR.

- **`static/chrome.css`** — new `.pill-group` + `.pill-group
.btn[aria-pressed="true"]` (accent fill). Consolidates the two pill
  systems from §1. Existing `/merch` still uses its inline pills; migration
  to `pill-group` is a separate commit on the product-page branch so
  `/merch` stays green.

- **`scripts/check-proxy.js` (new)** — asserts no `DEV_PROXY_PATHS` entry
  shadows a `src/**` or `merch/**` import (regression test for §2).

- **`scripts/check-routes.js` (new)** — heuristic that compares
  `ingest/routes.ts` patterns vs `infra/aws/template.yaml` `Path:` entries
  and warns on missing `Events:` or dead infra (§8).

- **`scripts/seed-dev.ts` (new, scaffold)** — idempotent rehydration of
  `MemoryDrawingStore` from `dev-bucket/public/tiles/*.gif` by content hash
  (§6). Wiring into `ingest/dev-server.ts` boot is intentionally left for
  the product-page PR to keep this branch trivial.

- **`package.json`** — `dev:all` now `vite --force` (cache bust, §4);
  new `lint` script `node scripts/check-proxy.js && node scripts/check-routes.js`.

All changes pass `tsc -b --noEmit` / `vite build` / `prettier --check` /
`node --test` on the branch (verified locally via the standard gate).

---

## 3. Tote bag asset — what went wrong and what replaces it

**Before:** `static/mockups/tote.jpg` was an abstract low-poly shape
with no handles, no fabric, no tote silhouette. It read as a placeholder
and broke the "drawn artwork on a real product" promise. It was added in
`15b0086` with `Liberty Bags OAD113 / blueprint 1313 / provider 99`.

**After:** the file was deleted in `c43fd15` and stays deleted on this
branch. The replacement checklist for the product-page PR is:

1. Source a real tote photo (Liberty Bags OAD113 or a comparable
   natural-canvas tote) — studio flat-lay, 1200×1200, centred, with a
   known print-area rect. Do not use a generated abstract shape.
2. Clean the magenta marker, export with the same `mockups.json` contract
   as `tee.jpg`/`mug.jpg`/`sticker-sheet.jpg`
   (`mockup_url` + `mockup_width/height` + `placeholders[]` in mockup-pixel
   space). Placeholders are the composite rects the `merch-preview.ts`
   compositor draws into.
3. Attach before/after screenshots in the PR: 16×16 test drawing at
   `Full chest` (and if multi-placement, Left chest) composited onto the
   tote vs onto the tee, with the tote handles/straps visible.
4. Verify `blueprint 1313 / provider 99` pricing margin locally
   (`base_cost_cents` vs `retail_cents`) before opening the PR — the
   `_pricing_note` in `config/merch.json` applies to totes as well.
5. Keep `config/mockups.json` + the image file in the same commit as the
   tote `config/merch.json` entry so `MOCKUPS` and catalog stay in sync
   (the merch picker reads both).

---

## 4. Detailed plan for the next product-page attempt

Constraints from your request:

- **No direct `master` pushes — PR + manual approval.**
- **Current `/merch` functionality must not be disrupted** (no regression
  on picker, mockup preview, checkout).

### A. Branching + protection

- Create `feat/product-page-2` from `19fe828` (or from current `master`,
  which at HEAD equals `19fe828` post-revert). The roadblocks branch
  `chore/product-page-roadblocks` lands first as a PR and is the base for
  `feat/product-page-2`.
- Enable a GitHub Ruleset on `master` (repo Settings → Rules → New):
  - Require PR before merging; dismiss stale approvals on new push.
  - Require status checks: `test` (`typecheck`, `format:check`, `node:test`),
    `lint` (`check-proxy`, `check-routes`), `build` (`vite build`,
    `sam validate`).
  - Block force pushes and deletions on `master`.
  - No code reaches prod without your GitHub review + green checks.

At time of writing `gh api repos/potomak/drawbang/rulesets` is `[]` and
`branches/master/protection` is `allow_force_pushes: false` only — there
is no branch protection; the Ruleset above is the action item.

### B. Non-disruption guarantee for `/merch`

- The existing `/merch` is a Vite SPA (`merch.html` + `src/merch.ts`)
  served from S3; `/products` is a Lambda-rendered page. They share
  `config/merch.json` + `config/mockups.json` + `merch/catalog.ts` but
  no route. Adding `/products/:drawingId/:productId` does not change any
  `merch.html`, `src/merch.ts`, or `vite.proxy` entry that `/merch` needs.
- Keep `/merch` at `shipping: flat per product` until the tote ships.
- Treat `merch/catalog.ts` as the shared default; do not duplicate
  `pickProductFromQuery` / `defaultVariant` between `/merch` and
  `/products`.
- Guarded by the same E2E: after each product-page commit, run the
  existing merch flow (`/merch?d=<id>` → picker → `paintMockupPreview`
  pixel check → `POST /merch/checkout` smoke via `ingest/dev-server.ts`)
  alongside the new `/products` checks. Any merch red blocks the PR.

### C. Phased commits (each is a PR-commit that stays green)

**Commit 1 — shared catalog + pill token (from roadblocks branch)**
Already on `chore/product-page-roadblocks`. Lands as PR #1. No product
page yet; verifies `merch/catalog.ts` unit tests + `pill-group` renders.

**Commit 2 — tote asset only (no product-page route)**
Add real `static/mockups/tote.jpg` + `config/mockups.json` tote entry +
`config/merch.json` tote product (blueprint 1313/provider 99) + placeholder
rect. Verify `/merch` shows the tote card composited correctly; no new
routes. This isolates the "bad image" fix.

**Commit 3 — product page SSR skeleton**
Add `lib/templates/product-page.ts` (uses `pill-group` + `data-value` +
`merch/catalog.ts:defaultVariant`) + `ingest/render-handlers.ts`
`renderProductPageHandler` + `ingest/routes.ts` entry
`GET /products/:drawingId/:productId` + `infra/aws/template.yaml`
`Events: Path: /products/{drawingId}/{productId}` plus `CacheBehaviors`
above `/products/*` (check `CacheBehaviors` ordering). Verify via
`curl` on the execute-api host baked into `dist/assets/draw-*.js`
(not `pixel.drawbang.com`) and the `check-routes.js` lint.

**Commit 4 — hydration + preview + placement**
Add `src/product.ts` that imports `merch/catalog.ts:defaultVariant` and
`merch/placement.ts`, reuses `src/merch-preview.ts` (same
`isCrossOrigin` guard), syncs pills with `[data-value]` selectors, and
keeps `variant` in `?variant=` + history state. No checkout yet.

**Commit 5 — checkout wiring + dev proxy**
Wire `POST /merch/checkout` reuse (or `POST /products/checkout` if a new
endpoint is preferred — but reuse is safer; document the chosen path in
`ingest/routes.ts`). Add `vite.config.ts` `DEV_PROXY_PATHS` entries for
the new `/products/*` page so `:5173/products/...` renders via `:8787`.
Run `scripts/check-proxy.js` again after this commit.

**Commit 6 — E2E + screenshots**
Extend `scripts/e2e-merch-safari.ts` (or a new `scripts/e2e-product-page.ts`)
to: 5 `pr-cards` on `/products`, `pressed=true` on `M`/`Black`/`Full chest`,
variant switch toggles pressed state, price stable `$22.89`, mobile 390,
`Continue to checkout` enabled, tote compositing pixel non-blank (center
40% rect contains non-background pixels). Upload `.screenshots/` as CI
artifact (ignored locally).

Each commit runs and passes the full local gate before push:

```sh
npm run typecheck            # tsc -b --noEmit
npm run build                # vite build (66 modules)
npx prettier --check .
npm test                     # 855 tests
npm run lint                 # check-proxy + check-routes
./node_modules/.bin/tsx scripts/e2e-merch-safari.ts   # SafariDriver
curl -s http://localhost:8787/products/<id>/tee | grep -q 'data-value="M" aria-pressed="true"'
curl -s http://localhost:5173/d/<id> | grep -q 'dr-products'
```

CI on the PR runs the same set (`typecheck`, `format:check`, `test`,
`lint`, plus `sam validate` and the E2E artifact upload). The PR only
merges when all are green and you have approved it.

### D. Infra checklist (per-route)

Every new dynamic path (`/products/:drawingId/:productId` and any
`/products/*` sub-path) must appear in **both**:

1. `ingest/routes.ts:createRoutes()` — `{ methods, pattern, auth, handler }`
2. `infra/aws/template.yaml` — `Events:` (`Type: HttpApi`, `Path: ...`)
3. `CacheBehaviors:` only if no existing wildcard covers it; longer pattern
   above parent (`/products/{id}/{product}` above `/products/*`).

Verified by `scripts/check-routes.js` + `sam validate` in CI and the
execute-api `curl` in `CLAUDE.md:Observability`.

### E. Review artifacts to attach to the PR

- Desktop + mobile 390 screenshots: tee composite, tote composite, pill
  pressed states (M/Black/Full chest blue), price rows, `Continue to
checkout` enabled.
- `curl` transcripts: `curl -s :8787/products/<id>/tee` showing
  `aria-pressed="true"` on defaults.
- `nom` / CI run link showing `typecheck + build + format:check + test +
lint + sam validate + E2E` green.
- `git diff --stat` proving `/merch` files (`src/merch.ts`,
  `src/merch-preview.ts`, `merch.html`) are untouched except for the
  shared `merch/catalog.ts` import and `pill-group` class name.

---

## 5. How to land this roadblocks branch

```sh
# All on the roadblocks branch—never on master:
git checkout chore/product-page-roadblocks
npm run typecheck && npm run build && npx prettier --check . && npm test && npm run lint
gh pr create --title "chore: product-page roadblocks (checks + merch preview + pill token)" \
  --body "Mitigations for #296 §§1–9. See docs/product-page-roadblocks.md. No /products route yet; /merch is untouched except for preview taint fix."
# Wait for your review + green checks, then merge via GitHub.
```

Do not `git push origin master`. The `deploy.yml` workflow deploys on
every push to `master`, so only the PR merge path reaches prod.

---

## 6. Open follow-ups (not on this branch)

- Wire `scripts/seed-dev.ts` into `ingest/dev-server.ts` boot and add
  `rm -rf node_modules/.vite` fallback note to `docs/gotchas.md`.
- Ensure `husky` or a `pre-push` hook runs `npm run lint` locally; add to
  `CLAUDE.md:Commands` once adopted.
- In CI, enable SafariDriver for the product-page E2E (macOS runner with
  `safaridriver --enable`).
- Migrate existing `/merch` picker to `.pill-group` + `merch/catalog.ts`
  in a dedicated commit before or with Commit 3, so the drift can't return.

---

_Generated for #296. Source files to read before the next product-page
attempt: `merch/catalog.ts`, `src/merch-preview.ts`, `static/chrome.css`
(`.pill-group`), `vite.config.ts` (`DEV_PROXY_PATHS`), `scripts/check-proxy.js`,
`scripts/check-routes.js`, `scripts/seed-dev.ts`, `config/mockups.json`,
`config/merch.json`, `ingest/routes.ts`, `infra/aws/template.yaml`._
