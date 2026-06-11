# KPI measurement

How to measure the four repositioning KPIs (plan: "Draw! Repositioning",
M1). Reviewed weekly — Sunday metric review, per the ops appendix. GA4
property: `G-5F5HPX6QYC` (id in `src/layout/tracking.ts`).

| KPI                  | Target | Source                          |
|----------------------|--------|---------------------------------|
| Activation           | >25%   | GA4 funnel exploration          |
| Remix rate           | >15%   | `/admin` card + GA4 dimension   |
| D7 creator retention | >20%   | GA4 cohort exploration          |
| Export rate          | >40%   | GA4 event counts (manual ratio) |

General caveat: GA4 excludes DNT and opted-out visitors (the gate in
`src/layout/tracking.ts` no-ops gtag + fbq for them). Server-side
numbers (`/admin`) count everything — expect small GA-vs-admin gaps.

## Activation

**Definition:** share of new users who publish at least one drawing =
users firing `publish_success` ÷ new users.

**Events:** `first_visit` (GA4 automatic) → `publish_success`.

**Where:** GA4 → Explore → the saved "Activation" funnel exploration
(`first_visit` step 1, `publish_success` step 2 — see setup checklist).
Read the step-2 completion rate for the review window.

## Remix rate

**Definition:** share of publishes that are remixes (forks of an
existing drawing).

Two sources, slightly different denominators — report both:

1. **Server truth:** the "Product KPIs" card on `/admin` — remix rate
   over the last 200 drawings, computed from stored rows with a
   `parent_id`. This is the authoritative number.
2. **GA4 flow-level:** `publish_success` events with `remix=true` ÷ all
   `publish_success`. GA4 → Reports → Events → `publish_success`,
   break down by the registered `remix` dimension.

GA measures the *publish flow* (did this session start from
`/draw?fork=<id>`); `/admin` measures *stored rows*. Opt-outs, ad
blockers, and abandoned-then-retried publishes make them differ
slightly. When they disagree, trust `/admin`.

## D7 creator retention

**Definition:** share of new users who publish again 7 days after first
touch.

**Events:** return criterion `publish_success`.

**Where:** GA4 → Explore → the saved "D7 creator retention" cohort
exploration. Read the Day 7 cell of the cohort that is now ≥7 days old
(younger cohorts read low because the window hasn't closed).

## Export rate

**Definition:** exports per publish =
(`gif_download_click` + `video_export_click`) ÷ `publish_success`.

**Where:** GA4 → Reports → Engagement → Events — pull the three event
counts for the window and divide. (No built-in ratio report; the
arithmetic is the review step.)

Caveats:

- `video_export_click` ships with the video-export milestone (M4).
  Until then the metric is GIF-only and **undercounts export intent**
  — note this next to the number in early reviews.
- `gif_download_click` fires with `source: editor` *and*
  `source: drawing_page`. Viewer downloads from `/d/<id>` inflate the
  creator-export reading; filter to `source=editor` if you want strict
  creator behaviour.

## Event inventory

Tracker methods live in `src/analytics/analytics.ts` (GA via gtag;
merch ecommerce events also fan out to Meta Pixel). Plain-JS surfaces
(`static/tile-page.js`, `static/like.js`, …) fire guarded
`window.gtag(...)` calls directly.

Shipped:

| Event                   | Params                  | Notes |
|-------------------------|-------------------------|-------|
| `tool_click`            | `tool`                  | |
| `frame_add_click`       | `total_after`           | |
| `frame_delete_click`    | `total_after`           | |
| `publish_click`         | `frames`                | |
| `publish_success`       | `frames`, `solve_ms`    | Gains `remix`, `prompt` (below) |
| `gif_download_click`    | `source`, `frames?`     | `source`: `editor` \| `drawing_page` |
| `copy_share_link_click` | —                       | |
| `share_click`           | `target`                | reddit / x / threads / web_share |
| `fork_click`            | `drawing_id`            | **Historical name — this is the user-facing "Remix" action.** Kept for GA continuity; do not rename. |
| `make_merch_click`      | `drawing_id`            | |
| `merch_*_click`, `view_item`, `begin_checkout`, `purchase`, `order_status_view` | various | Merch funnel; out of KPI scope |

Added by M1 (and later milestones; if `analytics.ts` looks mid-edit,
this list is the contract):

| Event                | Params                  | Lands with |
|----------------------|-------------------------|------------|
| `publish_success`    | + `remix` (boolean), `prompt` (slug \| null) | M1 |
| `like_click`         | `drawing_id`            | M1 |
| `bookmark_click`     | `drawing_id`            | M1 |
| `follow_click`       | `username`              | M1 |
| `video_export_click` | `format`, `duration_s`  | M4 |
| `embed_copy_click`   | —                       | M5 |
| `prompt_cta_click`   | `slug`                  | M3 |
| `prompt_banner_view` | —                       | M3 |

## GA4 setup checklist (one-time)

Do this **before** launch traffic — custom dimensions only populate
from registration onward, no backfill.

- [ ] Register custom dimensions (Admin → Custom definitions → Create
      custom dimension, scope **Event**):
      - `remix` (on `publish_success`)
      - `prompt` (on `publish_success`)
      - `format` (on `video_export_click`)
- [ ] Build the activation funnel: Explore → Funnel exploration —
      step 1 `first_visit`, step 2 `publish_success`, open funnel off.
      Save as **"Activation"**.
- [ ] Build the retention cohort: Explore → Cohort exploration —
      inclusion: first touch (acquisition date); return criterion:
      event `publish_success`; granularity daily. Save as
      **"D7 creator retention"**.
- [ ] Verify new events in GA4 DebugView (publish a fork locally with
      the GA debugger on): `publish_success{remix,prompt}`,
      `like_click`, `video_export_click`, `embed_copy_click`,
      `prompt_cta_click`.
- [ ] Meta Pixel parity: not needed. Both snippets live in
      `src/layout/tracking.ts`, but the Pixel only carries `PageView` +
      merch ecommerce (`ViewContent`, `InitiateCheckout`). KPI events
      are GA-only by design — don't mirror them to fbq.

## Weekly review checklist (Sunday)

Date range: last 7 days (cohort: the cohort that just closed).

- [ ] **Activation >25%** — "Activation" funnel, step-2 rate.
- [ ] **Remix rate >15%** — `/admin` Product KPIs card; cross-check
      GA4 `publish_success` by `remix`.
- [ ] **D7 creator retention >20%** — "D7 creator retention"
      exploration, Day 7 cell of the closed cohort.
- [ ] **Export rate >40%** — (`gif_download_click` +
      `video_export_click`) ÷ `publish_success` from the Events
      report. Flag "GIF-only" while M4 is unshipped.
- [ ] Record the four numbers + publishes/day (also on `/admin`) in
      the review notes so trends survive GA's sampling and retention
      windows.
