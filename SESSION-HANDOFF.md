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

## Open epic — drawing ownership via Ed25519 keypair

Tracking: **#82** (umbrella). 9 sub-issues. Full design in `.claude/plans/now-i-want-you-quizzical-hopcroft.md`.

- ✅ **X1** `src/identity.ts` — Ed25519 wrapper (generate / export / import / sign / verify). Shipped on master @ **8f65125**.
- #83 — **X2**: Verify Ed25519 signatures in the ingest handler
- #84 — **X3**: Add `pubkey` / `signature` to per-day `index.jsonl` schema
- #85 — **X4**: Editor IndexedDB identity store + sign-on-publish
- #86 — **X5**: First-visit modal + settings dialog
- #87 — **X6**: Render owner badge + link on `/d/<id>`
- #88 — **X7**: Per-owner gallery `/keys/<pk>` (template + builder sweep)
- #89 — **X8**: CloudFront rewrite for `/keys/<64hex>` → `.html`
- #90 — **X9**: Operator backfill — sign legacy drawings + force re-render

Dependency order: X2 → X3 → {X4 → X5} || {X6, X7 → X8} → X9. A fresh agent should take the lowest-numbered open sub-issue whose dependencies are met.

## Open epic — merch storefront

Tracking: **#59** (umbrella). 15 sub-issues, ordered by dependency:

### Phase 0 — account setup
- #64 Printify account + API access *(external; needs human)*
- #66 Stripe account in test mode *(external; needs human)*
- #67 Pick initial product catalog → commits `config/merch.json` *(needs `PRINTIFY_API_TOKEN`)*

### Phase 1 — backend
- ✅ #68 `merch/printify.ts` wrapper — shipped on master @ 9ce68d6
- ✅ #69 `merch/stripe.ts` helper (adds `stripe` dep) — shipped on master @ de0330c
- ✅ #70 `merch/upscale.ts` (adds `pngjs` dep) — shipped on master @ 6db5a9f
- ✅ #71 `merch/orders.ts` + DynamoDB `drawbang-orders` table — table grant + env var hooked up by #72.
- ✅ #72 `merch/lambda.ts` + 4 HTTP API routes (`/merch/products`, `/checkout`, `/webhook/stripe`, `/order/{id}`) on the existing `IngestApi` — shipped pending **manual setup**:
  - `config/merch.json` is a placeholder `{"products":[]}` until #67 lands real catalog data. `/merch/products` will return `{"products":[]}` and `/merch/checkout` will 400 on every call until then.
  - GH secrets needed in the `prod` environment: `PRINTIFY_API_TOKEN`, `PRINTIFY_SHOP_ID`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. SAM Parameters default to `""` so the deploy stays green without them, but `MerchFunction` will fail at init for any route except `/merch/products` until they are set.
  - After the first deploy with secrets, point the Stripe dashboard webhook at the new endpoint: `<MerchEndpoint>/webhook/stripe` (CFN output `MerchEndpoint`).

### Phase 2 — UI
- #73 "Make merch" button in editor + drawing page
- #74 `merch.html` product picker page
- #75 Frame picker for multi-frame drawings
- #76 Wire picker → `/merch/checkout` → Stripe redirect (note: server must substitute `{ORDER_ID}` in success_url)

### Phase 3 — fulfillment
- ✅ #77 Stripe webhook signature verify + dispatch — `checkout.session.completed` → orders.transition pending→paid (captures email + shipping); `payment_intent.payment_failed` → pending→failed; idempotent (transition returns null on replay); dispatch errors swallowed so Stripe doesn't retry.
- ✅ #78 `placePrintifyOrder` (`merch/dispatch.ts`) — fetches gif from S3, decodes, upscales the chosen frame to the largest print-area dim rounded down to a multiple of 16, uploads to Printify, creates product + order, transitions paid→submitted. On any error transitions paid→failed (best-effort). Wired into the webhook via `MerchHandlerDeps.dispatch`; bootDeps captures a closure over `S3Storage.getBytes('public/drawings/<id>.gif')`.
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

### Working pattern this session has used

- One issue per branch: `claude/issue-<N>-<slug>`.
- Implement, run `npm run typecheck` + the fast subset (`node --test --import tsx 'test/gif.test.ts' 'test/pow.test.ts' 'test/share.test.ts' 'test/builder.test.ts' 'test/upscale.test.ts' 'test/stripe.test.ts' 'test/printify.test.ts' 'test/orders.test.ts' 'test/merch-lambda.test.ts'`).
- Push the branch, then **fast-forward `master`** to it and `git push origin master`. CI auto-deploys on `master`. (Avoid PR ceremony for solo merch work; revisit if collaboration starts.)
- Comment a DoD-summary on the issue (don't close — the user closes after review).
- Update this file's Phase-1 list with `✅` + commit hash, and append any manual follow-ups the human still has to do.

### Known type/build gotchas

- `verbatimModuleSyntax: true` + `moduleResolution: "Bundler"` does **not** propagate the inner namespace through the Stripe SDK's `export { Checkout }` re-export. Use `Parameters<Stripe["checkout"]["sessions"]["create"]>[0]` instead of `Stripe.Checkout.SessionCreateParams`.
- `tsconfig.json` `include` had to gain `merch/**/*` when that dir was first created — anything else outside the listed roots will need the same.
- Stripe SDK pin in this repo: `2026-04-22.dahlia` (latest in v22). The merch issues' bodies still mention older `2025-09-30.clover`; they are stale and the latest pin is correct.
- `pngjs` `pack()` is a stream — collect chunks into a `Uint8Array` and return via Promise (see `merch/upscale.ts`).
- `DynamoDBDocumentClient.from(client)` shares the underlying client's middleware stack, so it never calls `client.send()`. Stubbing `client.send` won't intercept anything. `OrdersStore` exposes a `docClient?:` test seam for that reason — use it in unit tests; production code still passes `client` and lets `OrdersStore` wrap it.
- The Lambda bundle (`dist-lambda/*.js`) is CJS, but the parent `package.json` has `"type": "module"`. Local `require('/path/dist-lambda/foo.js')` from inside the project will fail (Node loads it as ESM via parent type). AWS Lambda runtime doesn't see the parent package.json, so it loads the file as CJS and works. To smoke-test exports locally, copy the bundle outside the project tree or import the source directly via `tsx`.
- HTTP API event `routeKey` already includes the method (e.g. `"GET /merch/products"`); don't prefix it again with `event.requestContext.http.method` — switch on `routeKey` directly.
- YAML flow-mapping (`{ Path: /foo/{id} }`) chokes on `{id}` — write SAM Event `Properties` in block form when the path has placeholders.
- Stripe SDK v22 moved checkout shipping to `Session.collected_information.shipping_details` (the older top-level `Session.shipping_details` referenced in some merch issue bodies isn't on the type). Same `verbatimModuleSyntax` namespace gotcha applies — use `NonNullable<Stripe.Checkout.Session["customer_details"]>` etc. instead of `Stripe.Checkout.Session.CustomerDetails`.

## Credentials available

- AWS creds are in the **prod** GitHub environment (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`).
- IAM user `Claude-Drawbang` has Lambda, S3, API Gateway, CloudFormation, IAM, CloudFront, ACM full access. Add ones missing for new services as they come up.
- Cloudflare R2 is no longer in use; the old bucket is preserved as backup but read-only.

## Things that broke during the prior session and how they were fixed

- **`!If` inside SAM `CorsConfiguration`** corrupts the transform — keep the literal list, only conditionalize a single element.
- **Local `sam deploy`** hits transient XML parser errors via the SAM CLI's botocore. Retry; CI doesn't have this issue.
- **`/state/last-publish.json`** must not be cached at the edge — handled by a separate CloudFront cache behavior with `CachingDisabled`.
- **Editor's `share_url`** used to point at S3 directly; now that everything's same-origin via CloudFront, it's `${PUBLIC_BASE_URL}/d/<id>` and resolves through the CloudFront Function rewrite.
