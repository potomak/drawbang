# AWS cost audit — June 2026

A $11.60 charge on the May 2026 AWS bill for "CloudFront: Invalidations"
prompted this audit. The bleed has already been fixed; this doc records
what was investigated, why, and what monitoring we put in place so the
next anomaly surfaces within a day instead of at quarter-end.

## What the $11.60 actually was

AWS bills CloudFront invalidations at $0.005 per *requested path* beyond
the first 1,000 paths per month per account. Wildcards count as one path
each (verified via `aws cloudfront get-invalidation`: a `/*` invalidation
returns `Paths.Quantity = 1`).

May 2026 breakdown (computed from `list-invalidations` +
`get-invalidation` against distribution `E6J784BTWEBRC`):

| Month | Total paths | Billable (>1,000) | Cost |
|---|---|---|---|
| 2026-04 | 93 | 0 | $0 |
| 2026-05 | **3,319** | 2,319 | **$11.60** |
| 2026-06 (so far) | 14 | 0 | $0 |

The May total is bimodal: a handful of small runtime invalidations from
the Lambda (publish: 5 paths each, profile-picture change: 1 path each),
and **77 large invalidations of 29 paths each = 2,233 paths** — 67% of
the month's total — coming from a single source.

## Root cause: hardcoded path list in deploy.yml

Before May 29, the `Invalidate CloudFront cache` step in
`.github/workflows/deploy.yml` invalidated a list of 29 specific paths on
every deploy:

```
"/" "/index.html" "/gallery" "/gallery.html" "/feed.rss"
"/products" "/products.html" "/products/p/*"
"/canvases" "/canvases.html" "/canvases/*"
"/state/current-canvas.json" "/state/canvas/*"
"/merch" "/merch.html" "/order.html" "/merch/order/*"
"/share" "/share.html" "/identity" "/identity.html"
"/d/*" "/days/*" "/keys/*"
"/gallery.css" "/gallery-v2.css"
"/chrome-toggle.js" "/chrome-identity.js" "/mockups/*"
```

77 deploys × 29 paths = 2,233 paths — well over the 1,000/month free
tier. Commit `96419331` (May 29, 2026 — "Phase 3c: delete the daily
builder") replaced it with `--paths "/*"` (1 path/deploy) as a side
effect of removing the gallery builder. The cost win was incidental, not
the headline; this doc is the place that fact is recorded.

## Runtime invalidations are fine

Two Lambda code paths still invalidate at runtime:

- `ingest/handler.ts` publish path: 5 paths via
  `pathsToInvalidateOnPublish(username)` — `/`, `/feed/items*`,
  `/gallery*`, `/u/<un>*`, `/feed.rss`.
- `ingest/auth-handler.ts` profile-picture change: 1 path via
  `pathsToInvalidateOnProfilePictureChange(username)` — `/u/<un>*`.

At current publish volume (~10 publishes/month observed, ~50 path-
invalidations/month total), runtime invalidations stay well under the
1,000-path free tier indefinitely. We considered removing them anyway
for code simplicity but kept them: removing publishes would leave the
author's own `/u/<username>` profile up to 24h stale after publishing
(s-maxage is 86,400 on that route — see `infra/aws/template.yaml`).

## Why caching stays, even at 0% hit rate

CloudWatch's `CacheHitRate` for the distribution has been ~0% throughout
May. With <800 CF requests/day and many unique URLs (each `/d/<id>` is
its own cache key), most cached responses expire before a second viewer
hits them — caching saves essentially nothing in steady-state dollars.

We kept it anyway because **CloudFront cache storage costs $0**. The
only positive cost case for caching at our scale is bot-burst insurance:
a 100× scraper spike with no cache would route ~80K req/day straight to
Lambda + DDB (~$10–15/mo); with the current short TTLs the same burst
flattens to ~1 origin hit per unique URL per TTL window.

## Steady-state cost (May 2026 actuals)

Computed from CloudWatch + CloudFront APIs, no Cost Explorer:

| Service | Usage | Cost |
|---|---|---|
| CloudFront requests | 25,567 | $0.019 |
| CloudFront egress | 0.089 GB | $0.008 |
| Lambda (`drawbang-ingest`, 256 MB) | 1,409 invs, 822 ms avg | $0.005 |
| DynamoDB (9 tables, on-demand) | 3,640 RCU + ~few hundred WCU | $0.001 |
| Invalidations (runtime, post-fix) | ~50–100 paths/mo | $0 |
| **Total runtime, post-fix** | | **~$0.04/mo** |

## Pricing constants used

us-east-1, current as of 2026-06. Kept in sync with
`scripts/cost-report.ts`:

```
CF requests        $0.0075 / 10,000 HTTPS requests
CF egress          $0.085 / GB (first 10 TB tier)
CF invalidations   $0.005 / path beyond 1,000/month free
Lambda request     $0.0000002 / request
Lambda compute     $0.0000166667 / GB-second
DDB on-demand read $0.25 / million read units
DDB on-demand write $1.25 / million write units
```

## Daily monitor

`scripts/cost-report.ts` runs daily from cron on the Pi and posts a
month-to-date summary to the flint-bot Discord channel. It uses
CloudWatch + CloudFront control-plane APIs only — both are free at our
query volume. Cost Explorer was rejected: `ce:GetCostAndUsage` costs
$0.01/request, ~$0.30/mo at one query/day — 7× the app's own runtime
cost.

Run manually:

```
DRY_RUN=1 npm run cost:report -- --env-file /home/pi/flint_and_flag/config/.env
npm run cost:report -- --env-file /home/pi/flint_and_flag/config/.env
```

Cron entry (one-time setup; replace the node path with the local one
from `which node` if it differs):

```
30 9 * * * cd /home/pi/drawbang && PATH=/home/pi/.nvm/versions/node/v24.15.0/bin:$PATH npm run cost:report -- --env-file /home/pi/flint_and_flag/config/.env >> /home/pi/drawbang/logs/cost-report.log 2>&1
```

The script persists yesterday's MTD to
`~/.local/state/drawbang-cost-report/last.json` so each report can show a
day-over-day daily-rate delta. Flags raised in the message when:

- MTD total exceeds `$5` (override via `MTD_ALERT_THRESHOLD` env var)
- Invalidation paths exceed 800 (80% of free tier)
- Today's daily rate is more than 3× yesterday's

A missed run is harmless — the next day's report still shows MTD.

## If costs do spike

Check `scripts/cost-report.ts` constants first — AWS occasionally
restructures pricing tiers. Then re-run the historical query that
reconciled the May bill:

```bash
aws cloudfront list-invalidations --distribution-id E6J784BTWEBRC \
  --max-items 1000 --output json \
  | jq '.InvalidationList.Items[] | {id: .Id, time: .CreateTime}'
```

Then sample `get-invalidation` against suspicious entries to see the
`Paths.Quantity` and the actual path patterns — the same approach that
identified the deploy-time list as the May driver.
