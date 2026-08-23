# Weekly collaborative canvases — plan

## Context

Drawbang today is a solo publish loop: draw 16×16, publish, your drawing
joins the gallery river. Engagement decays after the first novelty pass
because there's no recurring rallying point. **Weekly canvases** introduce
a communal artifact: a 16×16 grid of 256 tiles (each tile is one normal
Drawbang 16×16 drawing) that fills over a week. New canvas every Monday;
the previous one is locked forever. The current canvas becomes a reason
to come back; the archive becomes a long-tail browsing surface.

Naming is fixed: a **canvas** is a weekly grid; a **tile** is one of its
256 cells.

User-facing requirements (already aligned):

- New canvas every Monday 00:00 UTC; old canvases lock permanently.
- Tiles are claimed first, drawn second. Soft-claim with TTL: clicking
  "Claim this tile" reserves the cell for 30 min; if you don't publish
  in time, the tile re-opens.
- **Claim requires PoW** (not just publish). Without this, a takeover
  attacker can keygen → claim → keygen → claim → … for free. PoW makes
  the cost per claim O(work), not O(keygen).
- Per-pubkey-per-canvas cooldown of 15 min between _publishes_ (defense
  in depth on top of claim PoW; mainly throttles single-key burst).
- Editor home page: CTA banner ("This week's canvas — claim a tile →").
- Editor in tile-claim mode (URL `?c=&x=&y=`): banner makes it visually
  obvious that this drawing will land in a canvas.
- Drawing page: list every canvas the drawing has joined.
- New `/canvases` archive page: current canvas on top, then past
  canvases newest-first.

## Architecture

### Source of truth: DynamoDB, not S3 state files

S3 has no native CAS, so two concurrent publishes that both read-modify-
write a `state.json` will clobber. Use DynamoDB as the only source of
truth; serve the live canvas state through a tiny `GET /canvas/{id}/state`
Lambda backed by one DDB Query. CloudFront-cache 10–30 s.

Two new tables (additions to `infra/aws/template.yaml`):

1. **`drawbang-canvas-tiles`** — PK `canvas_id`, SK `tile_key` (`"x,y"`).
   Attrs: `claimed_by` (pubkey hex), `claimed_at`, `claim_expires_at`
   (epoch), `drawing_id?`, `published_at?`.

   - **Claim** = conditional put with
     `attribute_not_exists(claimed_by) OR (claim_expires_at < :now AND attribute_not_exists(drawing_id))`.
   - **Publish** = conditional put with
     `claimed_by = :pubkey AND claim_expires_at > :now AND attribute_not_exists(drawing_id)`.
   - DDB TTL attribute set to `claim_expires_at + 7d` is optional (purely
     for cleanup of abandoned, never-published claims; correctness is in
     the conditional expression, not the TTL — we don't poll TTL, we
     compare `claim_expires_at` inline in the conditional write).

2. **`drawbang-canvas-cooldowns`** — PK `pubkey`, SK `canvas_id`. Attrs
   `last_publish_at`. DDB TTL attribute for auto-cleanup after canvas
   closes. Used only in the publish path's
   `TransactWriteItems(updateCooldown, publishTile)` to make
   "tile + cooldown" a single atomic operation.

S3 stays as the rendering output (HTML pages), not the live state.

### Anti-takeover

- **Claim PoW**: `POST /canvas/claim` body includes `baseline` + `nonce`
  such that `sha256("claim:" ‖ canvas_id ‖ x ‖ y ‖ pubkey ‖ baseline ‖ nonce)`
  has ≥ `required_bits` leading zero bits. Difficulty is the _same_ table
  as publish PoW (`config/pow.json`), keyed on `last_publish_at` of the
  canvas (not the global one) — so a quiet canvas eases off, a busy one
  hardens. Lives next to `last-publish.json` as
  `public/state/canvas/<id>.json` with `{last_claim_at, required_bits}`.
- **Cooldown** (per-pubkey-per-canvas, 15 min between _publishes_) is
  enforced in a single `TransactWriteItems` alongside the publish-tile
  update.
- **Locking** is enforced at _both_ claim and publish entry points
  (canvas-first, claim-TTL second) so a 23:59 Sunday claim can't be
  published Monday 00:01.

### Rollover (and self-healing)

No new cron. The daily 6 AM UTC builder run already exists; it runs a
new "canvas pass":

- If the active canvas's `closes_at` is in the past, lock it (mark in
  registry; re-render its page in its final form) and create next week's
  canvas (deterministic id `canvas-YYYY-Www` from ISO week).
- Re-render `/canvases` archive page and `public/state/current-canvas.json`.

**Self-healing**: the ingest Lambda also lazily `putIfAbsent`s the
current canvas's manifest on every claim/publish, so even if the Monday
6 AM builder run fails, the new canvas opens on the first user action.

### Content-addressing × multiple canvases

Drawing IDs are content-addressed (`sha256(gif_bytes)`), so the same gif
_can_ legitimately appear in two different canvases (different weeks).
The current `handleIngest` early-returns on `exists(publishedKey)` —
that short-circuit must move _below_ the canvas-claim branch.

Drawing metadata gains `canvases: Array<{id, name, x, y, claimed_by}>`
(true array, mutated over time). `claimed_by` is the pubkey of the
user who claimed _this_ tile use — not necessarily the original
drawing author. Each successful canvas publish appends one entry and
**re-renders `public/d/<id>.html`** so the drawing page reflects the
new membership immediately. The drawing page renders each canvas
entry attributed to its `claimed_by`, so when key A puts key B's gif
into a canvas, key B is not implicated — the entry honestly reads
"used in canvas X tile (x, y) by `<key A short>`".

Immutability boundary: only `canvases[]` is mutable after first
publish. `pubkey`, `signature`, `created_at`, `parent`, `pow`,
`nonce`, `baseline` are written once and never touched again. This
bounds the blast radius of the multi-writer scenario.

### Editor / chrome

- New file `src/canvas-banner.ts`:
  - Home mode (no params): "This week's canvas: N/256 tiles claimed —
    [Claim a tile →]". Fetches `/state/current-canvas.json`.
  - Tile-claim mode (`?c=<canvas_id>&x=<x>&y=<y>` in URL): "Drawing
    tile (x, y) of canvas <name> — claim expires in MM:SS". Surfaces
    the claim TTL countdown so users can't be surprised by expiry.
- `src/main.ts` reads tile-claim params, fetches canvas name + claim
  expiry from a tiny `GET /canvas/{id}/state` response (or claim
  response if we just arrived), and feeds the banner.
- `src/submit.ts` includes optional `canvas_claim: {canvas_id, x, y}`
  in the ingest payload when tile-claim mode is active.
- `src/layout/chrome.ts` `NAV_LINKS` gains `{href: "/canvases",
label: "Canvases", id: "canvases"}`.

### Pages added

| URL                     | Rendered by                             | Notes                                                                                                                                                                                                                                             |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/canvases`             | `builder/templates/canvases-archive.ts` | Index: current canvas card + past canvases newest-first.                                                                                                                                                                                          |
| `/canvases/<canvas_id>` | `builder/templates/canvas.ts`           | 16×16 grid of tile slots. For **active** canvas, page ships an inline script that hydrates tile states from `GET /canvas/{id}/state` (so it's live). For **locked** canvas, the final state is baked into the HTML by the builder — no JS needed. |

CloudFront Function (existing) gains `/canvases` → `/canvases.html` and
`/canvases/<id>` → `/canvases/<id>.html` rewrites. The `/canvas/*` API
paths (note: singular for the Lambda routes, plural for static pages)
route to API Gateway.

### Drawing page integration

`builder/templates/drawing.ts` gains a "Canvases" definition-list entry
when `canvases.length > 0`: each entry links to
`/canvases/<id>#tile-<x>-<y>` and shows the tile claimant's pubkey
short-hash (so the original drawing author isn't implicated).

The same render call is invoked from `ingest/handler.ts` after a
canvas publish, so the page is live at publish time.

## Endpoints (new)

| Method + path             | Purpose                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /canvas/claim`      | Validate Ed25519 sig over `claim:<canvas>:<x>:<y>`, verify claim PoW against canvas's required bits, conditional-put tile in DDB. Returns `{claim_expires_at, edit_url}`.                                                                                     |
| `GET /canvas/{id}/state`  | One DDB Query → `{tiles: [{x, y, drawing_id?, claimed_by?, claim_expires_at?}], required_bits, last_claim_at, closes_at}`. CloudFront 15-s cache.                                                                                                             |
| `POST /ingest` (extended) | Accept optional `canvas_claim: {canvas_id, x, y}`. Reorder so canvas branch runs _before_ idempotency short-circuit. `TransactWriteItems` for publish-tile + cooldown. On success, push entry into drawing's `canvases[]` and re-render `public/d/<id>.html`. |

## Files

**New**

- `config/canvases.ts` — `TILES_PER_SIDE = 16`, `CLAIM_TTL_S = 1800`,
  `PUBLISH_COOLDOWN_S = 900`, `canvasIdForDate(d)` returning
  `canvas-YYYY-Www`, opens/closes from ISO week.
- `ingest/canvas-store.ts` — DDB wrapper (`claimTile`,
  `publishTile`, `getTiles`, `cooldownGuard`). All multi-row writes via
  `TransactWriteItems`.
- `ingest/canvas-handler.ts` — `POST /canvas/claim`, `GET /canvas/{id}/state`.
- `builder/canvas-pass.ts` — rollover + lock + re-render archive.
- `builder/templates/canvas.ts` — single canvas page.
- `builder/templates/canvases-archive.ts` — archive index.
- `src/canvas-banner.ts` — editor CTA + tile-claim banner.

**Modified**

- `ingest/handler.ts` — accept `canvas_claim`; reorder idempotency;
  thread `canvases[]` into metadata; re-render drawing page with
  canvas info.
- `ingest/lambda.ts` — route `/canvas/*` to canvas handler.
- `ingest/dev-server.ts` — same routes locally (FsStorage backend can
  use an in-memory map for the DDB calls behind the canvas-store
  interface).
- `ingest/storage.ts` — no changes; canvas state is not in Storage.
- `infra/aws/template.yaml` — `CanvasTilesTable`, `CanvasCooldownsTable`,
  IAM grants on `IngestFunction`, route additions.
- `builder/build.ts` — invoke `canvas-pass.ts` early; reconcile any
  drift between DDB and rendered pages.
- `builder/templates/drawing.ts` — render canvas memberships.
- `src/main.ts` — parse `?c=&x=&y=`; show canvas-banner; pass to submit.
- `src/submit.ts` — include `canvas_claim` in payload.
- `src/layout/chrome.ts` — `Canvases` nav link.
- `vite/plugins/dev-bucket.ts` — clean-URL rewrites for `/canvases` and
  `/canvases/<id>`.
- `vite.config.ts` — proxy `/canvas/*` to `:8787`.
- CloudFront Function (in `infra/aws/template.yaml`) — `/canvases`
  rewrites.
- `.github/workflows/deploy.yml` — CloudFront invalidation paths for
  `/canvases*`.
- `CLAUDE.md` — note the canvas DDB tables + new state files + the
  reordered ingest idempotency.

## Reuse / existing utilities

- PoW: `src/pow.ts` (`requiredBits`, sha256 PoW format) — extend for
  the claim PoW so the worker reuses the same `pow.worker.ts` solver.
- Ed25519: `ingest/handler.ts` already verifies signatures; reuse the
  same key encoding + verify helper for `/canvas/claim`.
- Storage: `S3Storage`/`FsStorage` for HTML output only (`builder/`
  templates write through it).
- DynamoDB: existing `@aws-sdk/client-dynamodb` integration from the
  merch stack — copy the client wiring from wherever ProductCounters
  is read.
- Templates: model `canvases-archive.ts` on
  `builder/templates/products.ts` (pagination + card grid); model the
  single canvas page on `owner.ts` (per-key static page with embedded
  data).
- Chrome: `src/layout/chrome.ts` `renderHeader`/`renderFooter` —
  Vite-served editor banner sits inside the existing main element;
  no new chrome surface needed.

## Verification

**Unit / handler tests** (in `test/canvas.test.ts`):

- Claim PoW: insufficient bits → 400; correct PoW + free tile → 201;
  expired prior claim by user B → user A can reclaim.
- Concurrent claim of same tile (run two `claimTile` calls in parallel)
  → exactly one succeeds (DDB ConditionExpression contract).
- Cooldown: publish, then immediately publish again to a different
  tile → 429; advance clock 15 min → succeeds.
- Locked canvas: claim against `closes_at < now` → 403; publish
  against an expired claim → 403; publish straddling rollover (claim
  pre-lock, publish post-lock) → 403.
- Same gif into two different canvases → both succeed; drawing's
  `canvases[]` has two entries; `public/d/<id>.html` lists both with
  the correct `claimed_by` per entry.
- Builder rollover idempotency: run builder twice on Monday →
  identical output, no duplicate canvas in registry.

**E2E** (`npm run dev:all`):

1. Generate identity, open editor home — see CTA banner with `0/256`.
2. Click "Claim a tile" → `/canvases/<current>` shows empty grid.
3. Click an empty tile → editor loads with tile banner; draw; publish.
4. Verify `/canvases/<current>` shows the tile thumbnail and CTA count
   ticks to `1/256`.
5. Visit `/d/<id>` — "Canvases" section shows the canvas link with
   the tile claimant attribution.
6. Re-publish a different gif within 15 min → cooldown error surfaced
   in editor.
7. `DRAWBANG_TODAY=<next-monday> npm run builder` — verify the active
   canvas locks, a new one opens, archive page lists both.

## Riskiest part — where to invest test time

The interaction between **content-addressed IDs**, **idempotent ingest**,
and **per-canvas claim state**. The current `handleIngest` early-return
on `exists(publishedKey)` is the single most dangerous line; reordering
it is the one change most likely to cause regressions in the
non-canvas path. The `test/ingest.test.ts` suite must keep passing
unchanged after the reorder; if any non-canvas test changes behavior,
the reorder is wrong.

Secondary risk: the `TransactWriteItems` for "publish + cooldown" — if
this isn't atomic, a power user can race two publishes through the
gap. Test under parallel load with `Promise.all` of N publish calls
from the same pubkey.

## Phased rollout (GitHub epic + issues)

Sequenced for clean PRs, each green on its own:

**Phase 0 — config + identity helpers** (no infra changes)

1. `config/canvases.ts` + ISO-week helpers + unit tests.
2. Claim-PoW codec in `src/pow.ts` + worker support + tests.

**Phase 1 — infra** 3. SAM: `CanvasTilesTable` + `CanvasCooldownsTable` + IAM grants + TTL. 4. `ingest/canvas-store.ts` + an in-memory implementation for dev/tests.

**Phase 2 — ingest API** 5. `POST /canvas/claim` (lambda + dev-server + tests). 6. `GET /canvas/{id}/state` (lambda + dev-server + tests). 7. Extend `POST /ingest`: accept `canvas_claim`, reorder idempotency,
transact-write cooldown, mutate `canvases[]`, re-render drawing
page. **(Riskiest PR — review carefully.)**

**Phase 3 — builder** 8. `builder/canvas-pass.ts` rollover + lock + reconciliation. 9. `builder/templates/canvas.ts` + integration into build pipeline. 10. `builder/templates/canvases-archive.ts` + `/canvases` route. 11. Patch `builder/templates/drawing.ts` for canvas memberships.

**Phase 4 — editor** 12. `src/canvas-banner.ts` (home CTA + tile-claim banner). 13. `src/main.ts` URL-param parsing + banner wiring. 14. `src/submit.ts` canvas-claim payload. 15. `src/layout/chrome.ts` "Canvases" nav link.

**Phase 5 — wiring + ship** 16. CloudFront Function rewrites + deploy.yml invalidations. 17. `vite.config.ts` proxy + `dev-bucket` clean-URL rewrites. 18. E2E test in `test/canvas.test.ts` (full claim→publish loop). 19. CLAUDE.md update.

Each issue lands as its own PR. Phases 0–1 are pure additions; the
risky one is issue 7. Phases 3–4 can run in parallel after Phase 2
ships.

## Issue tracker

Updated after each `gh issue create`. Format: `[ ]` not created, `[x]`
created with link.

- [x] Epic: Weekly collaborative canvases — [#173](https://github.com/potomak/drawbang/issues/173)
- [x] #1 — config/canvases.ts + ISO-week helpers + unit tests — [#174](https://github.com/potomak/drawbang/issues/174)
- [x] #2 — Claim-PoW codec in src/pow.ts + worker support + tests — [#175](https://github.com/potomak/drawbang/issues/175)
- [x] #3 — SAM: CanvasTilesTable + CanvasCooldownsTable + IAM + TTL — [#176](https://github.com/potomak/drawbang/issues/176)
- [x] #4 — ingest/canvas-store.ts + in-memory impl for dev/tests — [#177](https://github.com/potomak/drawbang/issues/177)
- [x] #5 — POST /canvas/claim (lambda + dev-server + tests) — [#178](https://github.com/potomak/drawbang/issues/178)
- [x] #6 — GET /canvas/{id}/state (lambda + dev-server + tests) — [#179](https://github.com/potomak/drawbang/issues/179)
- [x] #7 — Extend POST /ingest with canvas_claim (riskiest) — [#180](https://github.com/potomak/drawbang/issues/180)
- [x] #8 — builder/canvas-pass.ts rollover + lock + reconciliation — [#181](https://github.com/potomak/drawbang/issues/181)
- [x] #9 — builder/templates/canvas.ts + integration — [#182](https://github.com/potomak/drawbang/issues/182)
- [x] #10 — builder/templates/canvases-archive.ts + /canvases route — [#183](https://github.com/potomak/drawbang/issues/183)
- [x] #11 — Patch builder/templates/drawing.ts for canvas memberships — [#184](https://github.com/potomak/drawbang/issues/184)
- [x] #12 — src/canvas-banner.ts (home CTA + tile-claim banner) — [#185](https://github.com/potomak/drawbang/issues/185)
- [x] #13 — src/main.ts URL-param parsing + banner wiring — [#186](https://github.com/potomak/drawbang/issues/186)
- [x] #14 — src/submit.ts canvas-claim payload — [#187](https://github.com/potomak/drawbang/issues/187)
- [x] #15 — src/layout/chrome.ts "Canvases" nav link — [#188](https://github.com/potomak/drawbang/issues/188)
- [x] #16 — CloudFront Function rewrites + deploy.yml invalidations — [#189](https://github.com/potomak/drawbang/issues/189)
- [x] #17 — vite.config.ts proxy + dev-bucket clean-URL rewrites — [#190](https://github.com/potomak/drawbang/issues/190)
- [x] #18 — E2E test in test/canvas.test.ts (full claim→publish loop) — [#191](https://github.com/potomak/drawbang/issues/191)
- [x] #19 — CLAUDE.md update for canvas tables + state files + reorder — [#192](https://github.com/potomak/drawbang/issues/192)
