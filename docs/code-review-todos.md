# Code-review TODOs

Tracked items surfaced by the 2026-06-07 review pass. Each `## #hashtag`
section maps to a `// TODO (#hashtag):` marker grep-able in source —
search the repo for the tag to jump to the affected lines.

```
grep -rn "TODO (#" src ingest lib static config docs
```

All entries below are open. When one ships, remove the matching code
TODO markers and either delete the section here or mark it as resolved
with the commit SHA.

---

## #dead-code

Exported symbols with zero importers anywhere in the repo. Verified by
`grep -rn` excluding `legacy/`, `dist/`, `dist-lambda/`, `node_modules/`.

**Files**
- `src/format.ts` — `formatDuration()` is only referenced by its own
  test file. Delete the helper (and its test).
- `src/layout/asset-version.ts` — `assetVersion()` has no callers;
  `assetUrl()` is the live API. Remove the export (and `VERSION` can
  collapse into `assetUrl` if there's no other consumer).
- `config/badges.ts` — `ALL_BADGES` is never imported; the renderer
  uses `DAILY_DRAWING_BADGES` and `earnedBadges()`. Delete.
- `lib/products-cards.ts` — `relativeTimeLabel` is exported but only
  used by `productCardsFromCounters` in the same file. Drop the
  `export` keyword.

---

## #shared-handler-utils

The three toggle-style ingest handlers (likes, bookmarks, follows)
reimplement the same scaffolding, and request validators are scattered.

**Files**
- `ingest/likes-handler.ts`
- `ingest/bookmarks-handler.ts`
- `ingest/follows-handler.ts`
- `ingest/hydrate-handler.ts` (regex constants only)
- `ingest/auth-handler.ts` (regex constants only)
- `ingest/render-handlers.ts` (regex constants + `CC_*` cache strings)

**Suggested fix.**
1. Extract `ingest/handler-utils.ts` with `Auth`/`Config`/`Result` base
   shapes, `ok()`/`err(status, message)` factories, and the
   `AlreadyXxxError`/`NotXxxError` → 409 try/catch helper.
2. Move `DRAWING_ID_RE`, `USERNAME_RE`, and `EMAIL_RE` into
   `config/constants.ts` so every handler imports the same source of
   truth.
3. Move `CC_GALLERY` / `CC_DRAWING_PAGE` / `CC_PROFILE` / `CC_FEED` /
   `CC_NOT_FOUND` / `CC_FOLLOW_LIST` / `CC_FOLLOW_THUMBS` / `CC_PRODUCTS`
   / `CC_DESIGN` into `config/constants.ts` too; cache-control becomes a
   single grep.

---

## #shared-form-utils

The five auth/account controllers each repeat ~30 LOC of form-submit
boilerplate: `getElementById` + cast cluster, `addEventListener("submit")`
with `e.preventDefault()`, `submitEl.disabled = true/false` busy toggle,
and the flash-on-result flow.

**Files**
- `src/login.ts`
- `src/signup.ts`
- `src/password-forgot.ts`
- `src/password-reset.ts`
- `src/account.ts` (edit-profile form)

**Suggested fix.** New `src/form-utils.ts` exporting
`createFormSubmitter({ formId, submitId, fields, handler })` returning a
wired submit listener that manages busy state, gathers values, and
surfaces flash output. Each page is a 5-line call instead of a 30-line
block.

---

## #shared-toggle-utils

`static/like.js`, `static/bookmark.js`, `static/follow.js` are ~125 lines
each of nearly identical vanilla JS — localStorage JWT guard,
`isPressed`/`setPressed`, optimistic toggle + revert-on-error,
MutationObserver re-wiring for infinite scroll, 401 → `/login?next=`
redirect.

**Files**
- `static/like.js`
- `static/bookmark.js`
- `static/follow.js`

**Suggested fix.** New `static/toggle-handler.js` exposing
`createToggleHandler({ endpoint, targetAttr, wiredAttr, onSetPressed,
onRevert })`. Each of the three becomes a thin config call.

---

## #shared-template-utils

Every Lambda-rendered template duplicates: (1) the HTML head/shell
(`<!doctype>`, `<html lang>`, `<meta>`, `<title>`, `assetUrl` link,
analytics + Meta Pixel snippets, `renderHeader`/`renderFooter` wrap),
and (2) — for paginated surfaces — the inline `<script>` IntersectionObserver
block that watches `[data-feed-sentinel]` and appends fragments.

**Files**
- HTML shell duplicated in: `home.ts`, `gallery.ts`, `owner.ts`,
  `tile-page.ts`, `follow-list.ts`, `bookmarks.ts`, `products.ts`,
  `design.ts`. (RSS `feed.ts` has its own XML shell — lower priority.)
- Infinite-scroll script duplicated in: `home.ts`, `gallery.ts`,
  `follow-list.ts`, `bookmarks.ts`.

**Suggested fix.**
1. `lib/templates/_html-shell.ts#renderHtmlShell({ title, description,
   ogMeta, body, header?, footer?, extraHead?, extraScripts? })`.
2. Extract the observer into `static/infinite-scroll.js` (loaded via a
   single `<script src="/infinite-scroll.js">` tag rendered by the shell
   when `paginated: true`).

---

## #shared-localstorage

The same `try { localStorage.{get,set,remove}Item } catch {}` boilerplate
appears across seven surfaces — TS and plain JS.

**Files**
- `src/auth.ts`
- `src/order.ts` (`hasPurchaseFired`/`markPurchaseFired`)
- `src/main.ts` (palette persistence)
- `src/privacy.ts`
- `static/like.js`
- `static/bookmark.js`
- `static/follow.js`

**Suggested fix.** `src/storage-utils.ts` with `safeGet(key)`,
`safeSet(key, value)`, `safeRemove(key)`. Mirror as
`static/storage-utils.js` (or fold into `static/toggle-handler.js` from
#shared-toggle-utils) for plain-JS consumers. Quota/private-mode
behaviour stays the same; call sites collapse to one line.

---

## #inline-styles

Inline `style="..."` attributes that should be CSS classes.

**Files**
- `src/main.ts` — the `<span style="margin-left:6px">` icon-label spans
  on the Copy / Paste / Play / Pause editor buttons. Replace with a
  `.btn-icon-label` rule in `src/style.css`.

**Considered but kept as-is** (not flagged in code):
- `lib/templates/design.ts` — the swatch/type/spacing rows use inline
  `style="background: var(${t.name});"` etc. The inline value is
  literally what each row demonstrates; lifting to CSS would obscure
  the showroom intent. Leave alone.
- `lib/templates/feed.ts` — `style="image-rendering:pixelated"` inside
  an RSS `<description>`. Most readers strip inline styles regardless;
  removal is fine as a follow-up but doesn't materially help.

---

## #type-safety

`JSON.parse(...) as T` casts at request/JWT boundaries trust shape blindly.
A malformed body with the right keys still flows through to handlers.

**Files**
- `ingest/dev-server.ts` — `let parsed: any` + `JSON.parse(body)` →
  handler. Validate the parsed object shape before dispatch.
- `ingest/lambda.ts` — `parseJson(event) as IngestRequest` (and the
  register/login/profile-picture analogues). Each route should validate
  its expected keys' types.
- `ingest/jwt.ts` — `JSON.parse(payload) as T` trusts the claims shape.
  `exp` is checked, but `sub` / `un` / `purpose` / `tv` are read
  elsewhere without `typeof` guards.

**Suggested fix.** Lightweight per-route validators (`typeof` checks,
no new dependency) or one shared `assertShape(input, schema)` helper.
Keep validators colocated with their request types.

---

## #split-render-handlers

`ingest/render-handlers.ts` is ~900 lines and mixes every dynamic route
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
