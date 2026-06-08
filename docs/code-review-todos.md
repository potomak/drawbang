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
- `static/toggle-handler.js` (shared JWT read)
- `static/follow.js` (viewer-username read)

**Suggested fix.** `src/storage-utils.ts` with `safeGet(key)`,
`safeSet(key, value)`, `safeRemove(key)`. Mirror as
`static/storage-utils.js` for plain-JS consumers. Quota/private-mode
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
