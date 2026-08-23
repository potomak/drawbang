# Merch Test Runbook — Stripe test mode + Printify dry-run

How to exercise the full `POST /merch/checkout` → Stripe Checkout → `POST /merch/webhook/stripe` → `placePrintifyOrder` loop without spending real money or creating a live Printify product.

## Preconditions

* Feature is behind the runtime flag `merch_dry_run` in `drawbang-flags` (DynamoDB `FLAGS_TABLE`). When `true` the merch Lambda uses the **test** Stripe keys and the dispatch path short-circuits before any Printify API call.
* Infra: `drawbang-flags` table, dual Stripe env vars `STRIPE_SECRET_KEY_LIVE`/`STRIPE_SECRET_KEY_TEST` + `STRIPE_WEBHOOK_SECRET_LIVE`/`STRIPE_WEBHOOK_SECRET_TEST` (see `infra/aws/template.yaml`), `merch/flags-store.ts` (5 s cache), admin `GET`/`POST /admin/merch/flags`.
* Secrets: GitHub `STRIPE_SECRET_KEY_TEST` / `STRIPE_WEBHOOK_SECRET_TEST` are wired to the SAM params `StripeSecretKeyTest` / `StripeWebhookSecretTest` by `deploy.yml`. Live keys stay in `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` (or the `…_LIVE` variants).

## 1. Toggle dry-run

Operator toggle (no deploy):

```
GET  /admin/merch/flags  → { merch_dry_run: true|false, updated_at, updated_by }
POST /admin/merch/flags  { merch_dry_run: true|false }  (admin JWT required, same gate as /admin)
```

Or from `/admin` UI — Merch card → Dry-run switch. Expect 5 s cache staleness across Lambda containers (`FLAGS_TABLE` `CACHE_TTL_MS=5000`); a second toggle within 5 s will still read stale on a warm container — wait 5 s or cold-start the merch function.

To force dry-run off via deploy (rare):

```sh
sam deploy --parameter-overrides MerchDryRun=false StripeSecretKey=sk_live_… StripeWebhookSecret=whsec_live_…
```

## 2. Local test (no AWS deploy)

```sh
npm run dev:all   # Vite :5173 + ingest :8787 (merch uses Memory* stores)
# In another shell, forward Stripe test webhooks to local:
stripe login
stripe listen --forward-to http://localhost:8787/merch/webhook/stripe
# Trigger a test event without a browser:
stripe trigger checkout.session.completed
```

Local `MemoryFlagsStore` defaults `merch_dry_run=true` when no row is seeded, so the loop is dry-run safe out of the box.

## 3. Prod dry-run test (real Lambda, test Stripe)

1. Set flag dry-run on:
   ```sh
   curl -X POST https://pixel.drawbang.com/admin/merch/flags \
     -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
     -d '{"merch_dry_run":true}'
   ```
2. Verify merch helper is test:
   ```sh
   curl https://pixel.drawbang.com/admin/merch/flags
   # → {"merch_dry_run":true,...}
   ```
3. Create a checkout (any published drawing, e.g. via `/merch?d=<64hex>` picker or raw):
   ```sh
   curl -X POST https://0blf98navf.execute-api.us-east-1.amazonaws.com/merch/checkout \
     -H "Content-Type: application/json" -d '{
       "drawing_id":"<64hex>","frame":0,
       "product_id":"tee","variant_id":12125,
       "success_url":"https://pixel.drawbang.com/merch/order/{ORDER_ID}?ok=1",
       "cancel_url":"https://pixel.drawbang.com/merch?d=<64hex>"
     }'
   # → { order_id, checkout_url: "https://checkout.stripe.com/c/test_…" }
   ```
   When dry-run is on the session is created with `sk_test_…` and `checkout_url` contains `/c/test_`.
4. Pay with a Stripe test card on the returned `checkout_url`:
   * Success: `4242 4242 4242 4242` exp `12/34` cvc `123` zip `12345`
   * Decline: `4000 0000 0000 9995`
   * Auth required: `4000 0025 0000 3155`
5. Stripe sends `checkout.session.completed` to `POST /merch/webhook/stripe` (API Gateway → merch Lambda). The Lambda validates with `whsec_test_…`, does `pending → paid` + `shipping_address`, then `dispatchSync` sees `dryRun=true` and does `paid → submitted` **without** calling `uploadImage`/`createProduct`/`createOrder`/`sendToProduction`. Check CloudWatch `/aws/lambda/drawbang-merch` for `placePrintifyOrder dry-run: order submitted without Printify` and `dry_run:true`.
6. Poll the order:
   ```sh
   curl https://0blf98navf.execute-api.us-east-1.amazonaws.com/merch/order/<order_id>
   # → { status:"submitted", printify_product_id:"dry-run", … }
   ```
   No `stripe_session_id` / `printify_*` ids are exposed to the caller (sanitized in `merch/lambda.ts:sanitize`).

Repeat step 4 with a decline card → order lands in `failed` via `payment_intent.payment_failed`.

## 4. Going live

Flip `merch_dry_run=false` via `/admin` (or deploy override). The next checkout uses `sk_live_…`/`whsec_live_…` and the real `placePrintifyOrder` path (`POST /v1/shops/{shop_id}/…`). The flag row stays in `drawbang-flags` for audit (`updated_at`/`updated_by`).

## Troubleshooting

* `400 bad signature` on webhook → Stripe secret mismatch. Confirm `StripeSecretKeyTest`/`StripeWebhookSecretTest` match Dashboard → Developers → API keys / Webhooks, and that `merch_dry_run` is `true` (otherwise live secret is used to verify).
* Order stuck `pending` → webhook never arrived. For local, check `stripe listen` is still running. For prod, check Stripe Dashboard → Webhooks → Recent deliveries.
* Order `paid` but never `submitted` → dispatch self-invoke failed. CloudWatch `placePrintifyOrder failed` will have the error; the order was still flipped to `failed` only if the failure happened while still `paid`.
* 5 s flag staleness → toggle appears to not take effect. Wait 5 s or force cold start.

## Related

* `merch/flags-store.ts` — flag store + `MERCH_DRY_RUN_FLAG`
* `merch/dispatch.ts:placePrintifyOrder` — `dryRun` early-return (+ counter increment)
* `merch/lambda.ts:bootDeps` / `isDryRunFlag` / `resolveStripeHelper` — per-request live vs test selection
* `infra/aws/template.yaml:FlagsTable` / `StripeSecretKeyLive|Test`
* `ingest/admin-handler.ts:handleGetMerchFlags` / `handleSetMerchFlags`
* Issues #274 (master), #275/#276 (investigations, now closed), #278 (this runbook)
