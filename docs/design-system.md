# Drawbang design system

The written counterpart to `static/chrome.css` `:root` (the runtime
source of truth) and `/design` (the visual reference). When you add a
new visible element to the site, the rule is:

> **token → markdown → kitchen-sink**, in that order.

That means: add or reuse a token in `chrome.css`, document the rule
here, render an example on `/design`. If you can't do the third step,
you're inventing UI that nothing else will share.

---

## 1. Aesthetic

Modern gallery, brutalist-minimal. The pixel art is the only content;
everything else recedes.

- **Light walls, generous emptiness.** Use whitespace to focus the
  drawings. Don't fill it.
- **Hairlines, not boxes.** Borders are `1px`, solid, `var(--line)`.
  No drop-shadows, no soft cards, no rounded corners on app
  furniture.
- **One accent, rationed.** Cyan `#00ccff` belongs on the primary CTA,
  on active states, and on the `:hover` of meaningful links — almost
  nowhere else. If you find yourself using accent for emphasis, use a
  hairline rule or uppercase-mono label instead.
- **Monospaced micro-labels.** All section captions, counts, and
  meta-labels are mono, uppercase, `0.1em` tracking, `var(--t-xs)`.
- **Sans-serif body.** Prose, button text, and form fields use
  `var(--font-sans)`. The mono face is reserved for labels and
  numeric tabular data.

---

## 2. Tokens (source: `static/chrome.css` `:root`)

### Color

| Token         | Value      | Use |
|---------------|------------|-----|
| `--paper`     | `#ffffff`  | page background — "the wall" |
| `--paper-2`   | `#f7f7f5`  | recessed surfaces, rail background, code blocks |
| `--ink`       | `#0a0a0a`  | primary text, logo, dense type |
| `--fg-muted`  | `#6b6b6b`  | secondary text, labels |
| `--fg-dim`    | `#9c9c9c`  | tertiary text, disabled glyphs |
| `--line`      | `#e6e6e3`  | hairlines, dividers, default borders |
| `--line-strong` | `#cfccbf` | hover/focus borders |
| `--accent`    | `#00ccff`  | CTA, active link, focus ring |
| `--accent-on` | `#001218`  | text on accent surfaces |
| `--accent-dim`| `#00ccff1e`| tinted accent background (active nav) |

Drawing surfaces (`canvas`, `<img>` of GIFs) opt out of this palette
— they render their own colors. Keep `--canvas-bg` and `--canvas-grid`
neutral against the drawings, not against the page.

### Type

| Token         | Value | Use |
|---------------|-------|-----|
| `--font-sans` | `"Inter", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif` | body, buttons, form fields |
| `--font-mono` | `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace` | labels, counts, code |

Scale:

| Token   | Value | Use |
|---------|-------|-----|
| `--t-xs`  | `11px` | micro-labels (`.lab`, `.panel-h`) |
| `--t-sm`  | `13px` | secondary text, button text |
| `--t-md`  | `14px` | body default |
| `--t-lg`  | `16px` | page title |
| `--t-xl`  | `20px` | rare — section landmarks |
| `--t-2xl` | `28px` | rare — profile handle, hero numbers |

Body line-height: `1.5`. Label line-height: `1`.

### Spacing

| Token       | Value | Use |
|-------------|-------|-----|
| `--tap`     | `40px` | minimum interactive height (buttons, drawer rows) |
| `--pad`     | `16px` | default padding, rail gutter |
| `--pad-sm`  | `8px`  | tight padding (icon-only controls, chips) |
| `--border`  | `1px`  | every visible rule (do not vary) |

Layout gutters use `clamp()` directly inline (not a token) because they
scale with viewport.

### Breakpoints (no tokens; written rules only)

| Width      | Layout |
|------------|--------|
| `≥ 1180px` | 3-column (left rail · center · right rail) |
| `860–1180px` | 2-column (left rail · center). Right rail hidden. |
| `< 860px`  | 1-column. Left rail collapses to a logo-triggered drawer. |

---

## 3. Components

Each is implemented once. Don't fork; extend the variant set on the
existing class.

### `.btn` (chrome.css)

Base button. `inline-flex`, `var(--tap)` tall, `1px solid var(--line)`,
sans, `var(--t-sm)`.

Variants: `.primary` (filled accent), `.ghost` (transparent), `.icon`
(square, label hidden), `.sm` / `.xs` (height ramps). Pressed state
nudges `translate(2px, 2px)`.

### `.lab` (chrome.css)

The single label voice. `var(--font-mono)`, `var(--t-xs)`, uppercase,
`0.1em` tracking, `color: var(--fg-muted)`. Use for every
micro-label: section headers, counts, status. **Don't write
uppercase headings without this class.**

### Page chrome (`.page-title`, `.divider`, `.panel-h`)

`.page-title` is the only large text most pages use. `.divider` is a
1px hairline rule. `.panel-h` is the small-cap header above grouped
content.

### Feed card (`.feed-card-*` in gallery-v2.css)

The center column's only card. Has its own internal layout
(profile-picture + author header + art + actions). **Do not vary.**
If a new feed concept needs a different card, it's a different
concept — talk before forking.

### App shell (`.app-shell`, `.rail-left`, `.rail-right`)

Grid wrapper rendered by `src/layout/chrome.ts`. Default 2-col
(`rail-left + main`). The shell wears `.has-rail-right` only when a
template opts in via `rightRail: true` (only `/` does today).
Surfaces don't open this themselves; they live inside the `<main>`
slot.

Left rail blocks:
- `.rail-cta` — the primary "New drawing" button (1 per shell).
- `.rail-nav` — primary links list (Products + owner-only:
  `Followers · N`, `Following · N`, Bookmarks, Account, Sign out).
- `.rail-foot` — bottom-anchored secondary group (social row +
  Privacy + Feedback).

Right rail blocks (`/` only):
- `.rr-module` — Most Liked · 30D + Trending Artists.
  `.rr-h` (mono uppercase header) + `.rr-list` of `.rr-row` ranked
  rows (`.rr-rank` + `.rr-thumb` + `.rr-author` + `.rr-like-count`
  or `.rr-meta`).

### Profile picture (`.profile-picture`)

`<img class="profile-picture">`, square, `image-rendering: pixelated`,
pulled from a drawing GIF. Stamped client-side by `hydrate.js` once
the user's `profile_picture_drawing_id` is known.

### Drawing well (cross-surface)

Every surface that renders a drawing frames it identically: `border:
1px solid var(--line)` on `background: var(--paper-2)`. Keeps
transparent-pixel drawings visible against the light page. Applies
to `.feed-card-art`, `.img-grid li`, `.dr-art-wrap img`, `.st-day` +
`.st-day-thumb`, the `.follow-card-pp` placeholder, and the
`.rr-thumb`. Don't revert any one of these to `--canvas-bg`.

### Follow button (`.follow-btn`)

Filled `--accent` when unfollowed (the action). Outlined (transparent
+ `--line-strong` border) when `aria-pressed="true"` (the state).
The button ships hidden — `static/follow.js` reveals it once
`hydrate.js` knows whether the viewer follows.

### Badge (`.badge`)

Inline label for accomplishments, statuses, counts. Hairline border
on `--paper-2`, mono micro-label (uppercase, `.04em` tracking,
`--t-xs`). `.badge.accent` for highlighted variants. `.ow-badges li`
inherits this style.

### Flash (`.flash` in chrome.css)

Singleton notification overlay below the sticky header. Fire from
`window.drawbangShowFlash(message, options)`. **Don't render inline
error paragraphs.** See feedback memory.

---

## 4. Do / don't

- **Do** stick to one accent. The hue is the brand; multiplying it
  makes it stop meaning anything.
- **Do** put labels in mono, all caps, `.10em` letter-spacing.
- **Do** use `clamp()` for outer gutters and large gaps so the layout
  breathes at every viewport.
- **Do** keep the center feed column **single column** at every
  breakpoint. The redesign reshapes the rails around the center; the
  center stays.
- **Don't** introduce drop-shadows, glassmorphism, gradients, or
  rounded-corner cards. The site reads cleaner without them.
- **Don't** add a new color outside the `--accent`/ink ramp without
  raising it explicitly — even semantic colors (errors, warnings)
  borrow from the existing palette unless they really can't.
- **Don't** mirror chrome content into a page template. The shell
  (`renderHeader` / `renderFooter`) owns the rails; templates only
  render the `<main>` content.
- **Don't** widen the type scale. Six steps cover everything; another
  step is a sign something's wrong.

---

## 5. Surfaces

| File | Owns |
|------|------|
| `static/chrome.css` | Tokens, base type, header/footer chrome, rails, `.btn`, `.lab`, `.page-title`, `.flash`. |
| `static/gallery-v2.css` | Lambda-rendered page classes (`.feed-card-*`, `.img-grid`, `.dr-*`, `.pr-*`, `.ow-*`, `.follow-card-*`). |
| `src/style.css` | Vite-served surfaces (editor `.ed-*`, merch `.mc-*`, auth, order). |
| `/design` (Lambda) | Live visual reference rendering every class in this file. |

If you touch the header/footer/rails/buttons, you're in `chrome.css`.
If you're editing `.hdr` or `.btn` in either consumer file, stop.
