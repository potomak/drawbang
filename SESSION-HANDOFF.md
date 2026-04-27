# Session handoff

Snapshot of where things stand so a fresh session can pick up without re-reading the whole transcript. Delete this file after the merch epic is done.

## Live infrastructure

- **Editor + gallery**: https://pixel.drawbang.com/ (CloudFront `d3te69flws96uk.cloudfront.net`, distribution `E6J784BTWEBRC`)
- **Bucket**: `s3://drawbang-assets/` (locked to CloudFront via OAC)
- **Ingest Lambda**: `https://0blf98navf.execute-api.us-east-1.amazonaws.com/ingest`
- **CFN stack**: `drawbang-ingest` (us-east-1)
- **DNS**: `pixel.drawbang.com` CNAME → CloudFront, plus the ACM validation CNAME, both at Porkbun.
- **GH workflow**: `.github/workflows/deploy.yml` — `test` → `deploy-lambda` (push only) → `build-and-publish` → `deploy-pages` (no longer used; the Pages step was removed when we moved to S3+CloudFront).
- **Daily cron**: `0 6 * * *` runs the builder against S3 and invalidates the rolling pages.

## Repo layout (current)

See `CLAUDE.md` — already up to date as of the CloudFront migration.

## What just shipped (recent commits, master)

- #55 content-addressed drawing IDs
- #54 reset editor after publish
- #53 footer with repo link
- #56 single-origin S3 + CloudFront migration (off GH Pages)
- #57 custom domain `pixel.drawbang.com`
- #58 fork link 404 fix (extra `/drawings/` segment)
- font: switched to JetBrains Mono with system mono fallback

All issues 53–58 are closed.

## Open epic — merch storefront

Tracking: **#59** (umbrella). 15 sub-issues, ordered by dependency:

### Phase 0 — account setup
- #64 Printify account + API access
- #66 Stripe account in test mode
- #67 Pick initial product catalog → commits `config/merch.json`

### Phase 1 — backend
- #68 `merch/printify.ts` wrapper
- #69 `merch/stripe.ts` helper (adds `stripe` dep)
- #70 `merch/upscale.ts` (adds `pngjs` dep)
- #71 `merch/orders.ts` + DynamoDB `drawbang-orders` table
- #72 `merch/lambda.ts` + new SAM function + 4 routes (`/merch/products`, `/checkout`, `/webhook/stripe`, `/order/{id}`)

### Phase 2 — UI
- #73 "Make merch" button in editor + drawing page
- #74 `merch.html` product picker page
- #75 Frame picker for multi-frame drawings
- #76 Wire picker → `/merch/checkout` → Stripe redirect (note: server must substitute `{ORDER_ID}` in success_url)

### Phase 3 — fulfillment
- #77 Stripe webhook signature verify + dispatch
- #78 `placePrintifyOrder` (decode gif → upscale → upload → create product → create order)
- #79 `order.html` status page (CloudFront rewrite for `/merch/order/<id>` needs updating)

### Phase 4 — polish
- #80 refunds, mockup preview, shipping preview, tax, live-mode flip + Secrets Manager

## Decisions baked into the issues

- DynamoDB for order store (atomic conditional updates → idempotent webhooks)
- No SES in v1 (Stripe sends a built-in receipt)
- Stripe **test mode** at launch; live-mode flip is in #80
- Pricing: `retail = round(base_cost * 2)`
- Anonymous checkout (Stripe collects email + shipping)
- Server-side upscale (pure JS via `pngjs`, no native deps)
- Test-mode secrets via SAM `parameter_overrides` → Lambda env vars (move to Secrets Manager when going live)

## What a fresh session needs to know

The user assigns sub-issues to weaker-model sessions one at a time. Each issue is self-contained with file paths, function signatures, API URLs, env vars, and a "definition of done" checklist. The umbrella (#59) tracks completion.

When picking up, start by checking which sub-issues are still open:
```
gh issue list --label "" --state open
```
…and tackle them in dependency order (Phase 0 first; within a phase, anything not blocked).

## Credentials available

- AWS creds are in the **prod** GitHub environment (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`).
- IAM user `Claude-Drawbang` has Lambda, S3, API Gateway, CloudFormation, IAM, CloudFront, ACM full access. Add ones missing for new services as they come up.
- Cloudflare R2 is no longer in use; the old bucket is preserved as backup but read-only.

## Things that broke during the prior session and how they were fixed

- **`!If` inside SAM `CorsConfiguration`** corrupts the transform — keep the literal list, only conditionalize a single element.
- **Local `sam deploy`** hits transient XML parser errors via the SAM CLI's botocore. Retry; CI doesn't have this issue.
- **`/state/last-publish.json`** must not be cached at the edge — handled by a separate CloudFront cache behavior with `CachingDisabled`.
- **Editor's `share_url`** used to point at S3 directly; now that everything's same-origin via CloudFront, it's `${PUBLIC_BASE_URL}/d/<id>` and resolves through the CloudFront Function rewrite.
