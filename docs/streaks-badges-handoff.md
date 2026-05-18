# Streaks & Badges — Session Handoff

Tracks the in-progress state of #115 / #116 ("streaks" and "badges") so the
next session can pick this up without re-deriving context.

## What's already done & merged

1. **Canvas-store fix (commit `800c35f`)** — builder CLI now wires
   `DynamoCanvasStore`, locked canvases re-render every pass from DDB,
   `current-canvas.json` snapshot stops being clobbered with zeros. The next
   deploy will repaint W20 from DDB and the existing CloudFront invalidation
   list (`/canvases/*`) will drop the empty cached page.

2. **Google Analytics injection (commit `916b9e5`)** — `G-5F5HPX6QYC` lands
   in every HTML surface (Vite-served + builder-rendered). Single source of
   truth is `renderAnalytics()` in `src/layout/chrome.ts`. Vite pages
   reference `<!--CHROME:ANALYTICS-->`; builder templates inline
   `${renderAnalytics()}` right after `<head>`. `feed.rss` is XML, skipped.

## Confirmed design decisions (user-approved this session)

- **Canvas participation = 1+ published tile** in that week's canvas. Claims
  alone don't count.
- **Scope = write-side infra only.** No public endpoint, no UI rendering in
  this cut. Profile-page rendering + read APIs land in a follow-up.
- **No backfill.** Stats start at zero on deploy and accumulate from new
  publishes. Existing `inbox/<day>/*.json` history can drive a separate
  one-off script if needed later.

## Confirmed schema (per-pubkey row, one DDB table)

```ts
interface UserStatsRow {
  pubkey: string;
  // Daily-drawings dimension. Bumps once per NEW gif (gated by !alreadyHere
  // upstream — re-publishes of an existing gif do not double-count).
  daily_total: number;
  daily_streak_current: number;
  daily_streak_longest: number;
  daily_last_date: string | null;        // YYYY-MM-DD UTC
  // Weekly-canvas dimension. First publish-into-canvas-X by pubkey bumps the
  // counter; subsequent tiles in the same canvas are no-ops at this layer.
  canvas_total: number;
  canvas_streak_current: number;
  canvas_streak_longest: number;
  canvas_last_id: string | null;         // e.g. "canvas-2026-W21"
  updated_at: string;
}
```

Streak math is read-modify-write — the "yesterday vs other" branch can't be
expressed in a single DDB `UpdateExpression`. The Dynamo impl uses optimistic
concurrency conditioned on the prior `daily_last_date` / `canvas_last_id`
(and `_total` as a defensive tiebreaker) with up to 5 retries.

## Confirmed badge thresholds (derived from totals, no separate storage)

```ts
DAILY_DRAWING_BADGES = [7, 30, 90, 180, 365];  // against daily_total
CANVAS_BADGES        = [10, 26, 52];            // against canvas_total
```

`config/badges.ts` is the planned home for these + an `earnedBadges(stats)`
helper.

## Current code state

- ✅ **`ingest/user-stats-store.ts`** — committed *uncommitted* in the working
  tree. Defines `UserStatsRow`, `UserStatsStore` interface, pure
  `nextDailyState` / `nextCanvasState` reducers (the testable logic),
  `DynamoUserStatsStore` (optimistic-concurrency loop), and
  `MemoryUserStatsStore` for tests/dev. Typechecks clean. Not imported by
  anything yet so it has no runtime effect.
- ⏳ **`config/badges.ts`** — not yet created.
- ⏳ **`ingest/handler.ts`** — needs `userStatsStore?: UserStatsStore` added
  to `HandlerConfig`, plus two hook sites:
  - **Daily:** in the `if (!alreadyHere)` block (around line 301) — call
    `recordDailyDrawing({ pubkey, date_utc: nowISO.slice(0,10), now_iso: nowISO })`
    wrapped in try/catch (stats failures must not surface as publish failures).
  - **Canvas:** in the `req.canvas_claim` branch after `publishTile` +
    `appendCanvasMembership` succeed (around line 382) — call
    `recordCanvasParticipation({ pubkey, canvas_id: cc.canvas_id, now_iso: nowISO })`
    wrapped in try/catch.
- ⏳ **`ingest/lambda.ts`** — wire `DynamoUserStatsStore` from
  `DRAWBANG_USER_STATS_TABLE` (default `drawbang-user-stats`), thread into
  each handler invocation.
- ⏳ **`infra/aws/template.yaml`** — new resource:

  ```yaml
  UserStatsTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: drawbang-user-stats
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - { AttributeName: pubkey, AttributeType: S }
      KeySchema:
        - { AttributeName: pubkey, KeyType: HASH }
  ```

  Plus `DRAWBANG_USER_STATS_TABLE: !Ref UserStatsTable` in the Lambda env and
  `- DynamoDBCrudPolicy: { TableName: !Ref UserStatsTable }` in the Lambda
  policies. Outputs section gets `UserStatsTableName` for parity with the
  other tables.
- ⏳ **Tests:**
  - `test/user-stats-store.test.ts` — pure reducer tests (no DDB):
    same-day re-publish, consecutive day streak, broken streak, consecutive
    canvas weeks, skipped canvas weeks, longest-streak monotonicity.
  - Extend `test/canvas-ingest.test.ts` so its `TestEnv` includes a
    `MemoryUserStatsStore` and at least one happy-path test asserts the
    canvas+daily counters bumped after a publish.

## Hook ordering & idempotency notes (don't re-derive these)

Studied this with the current handler in mind:

- The early-return at `handler.ts:287` (`alreadyHere && !req.canvas_claim`)
  means re-publishes of an existing gif WITHOUT canvas_claim never reach our
  hooks. ✓ No daily double-count.
- Re-publish of an existing gif WITH canvas_claim flows through to the
  canvas branch (the gif itself is not re-persisted, but the canvas tile is
  newly placed). We MUST gate the daily hook on `!alreadyHere` so this path
  doesn't bump `daily_total` for the same gif. The canvas hook fires
  normally — placing an existing gif into a fresh canvas tile IS canvas
  participation.
- Same gif re-placed into the SAME canvas is blocked upstream by DDB's
  `attribute_not_exists(drawing_id)` condition on `publishTile`. So we won't
  reach the canvas hook for a same-tile re-publish. But if a user publishes
  multiple tiles into the same canvas (different x,y), each successful
  `publishTile` returns and we'd hit the canvas hook each time. The store's
  `canvas_last_id === canvas_id` short-circuit handles that as a no-op.
- Both hooks must be wrapped in `try { ... } catch (e) { console.error(...) }`
  — the publish has already committed and stats failures are non-fatal. Same
  pattern as the snapshot refresh at `handler.ts:392-420`.

## Next-session checklist

1. Read this file.
2. Create `config/badges.ts`.
3. Wire `userStatsStore` into `handler.ts` at the two sites described above.
4. Add `DRAWBANG_USER_STATS_TABLE` to `lambda.ts`, construct
   `DynamoUserStatsStore`, pass it via `HandlerConfig`.
5. Add the SAM resource + Lambda env + IAM policy + stack output.
6. Write `test/user-stats-store.test.ts` (pure reducer tests).
7. Extend `test/canvas-ingest.test.ts` to assert the hook fires.
8. `npm run typecheck && node --test --import tsx 'test/gif.test.ts' 'test/pow.test.ts' 'test/share.test.ts' 'test/builder.test.ts' 'test/canvas-pass.test.ts' 'test/user-stats-store.test.ts' 'test/canvas-ingest.test.ts'`.
9. Commit + push. The deploy workflow will create the DDB table on first
   apply (SAM handles it). No backfill needed; stats start at zero.

## Out of scope (deferred, not lost)

- Public read endpoint (`GET /keys/<pubkey>/stats`).
- Builder reading stats and embedding into `/keys/<pubkey>.html`.
- Profile-page UI (badge icons, streak display).
- One-off backfill script that walks `inbox/<day>/*.json` to seed historic
  stats.
- "Achievements beyond counters" (e.g. theme winner, first animation) —
  not in this session's scope; the storage shape leaves room for more
  attributes if needed.
