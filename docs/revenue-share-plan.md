# Revenue Share Plan — Ledger + Threshold + Stripe Connect

Status: **proposed** · Author: gcappellotto + Muse · Date: 2026-08-21  
Stack: `merch/lambda.ts` + `merch/dispatch.ts` + `merch/orders.ts` + `ingest/user-store.ts` + Stripe (`merch/stripe.ts`)

> Goal: let any artist whose drawing is printed on merch earn a cut, without coupling checkout to payout availability and without re-introducing account-creates-gating-publish.

---

## 1. Summary

Credit a **per-order royalty** to the drawing's author when the order reaches `submitted` (Printify accepted), accumulate it in a **ledger + balance**, and pay out in batches via **Stripe Connect Express** once a threshold is crossed. Anonymous drawings earn nothing until claimed.

This is **Option B** from the exploration: *internal ledger then batched transfer*. It is cheaper to operate than per-checkout `transfer_data` splits and clearer than custom payout rails (Wise/PayPal).

## 2. What we learned about the current system

- **Merch economics** (`config/merch.json`): tees `retail 2289c` vs `base_cost 1099–1450c`, mug `3489c/1450c`, sticker sheets `1499–1999c`. Flat `shipping_cents 499–699c` (todo: replace with Printify `POST /v1/shops/{id}/orders/shipping.json`). Stripe fee ~`2.9%+30c`. Typical net margin `$6–10` before real Printify cost variance.
- **Order lifecycle** (`merch/orders.ts`): `pending → paid (webhook) → submitted (dispatch) → in_production → shipped → delivered | failed | refunded`. `Order { drawing_id, canvas_id?, product_id, variant_id, retail_cents, base_cost_cents, stripe_session_id, printify_* }` — no artist or royalty fields today.
- **Attribution** (`ingest/drawing-store.ts`): `DrawingRow { drawing_id=sha256(gif), user_id, username, parent_id, ... }`. Anonymous publishes use `anonymous / 0…0` (`config/constants.ts:72`).
- **Auth** (`ingest/user-store.ts`): `UserRecord { email(PK), user_id, username, password_hash, token_version, bio/link/follower_counts }` — no payout fields, no Stripe account id.
- **Dispatch idempotency** (`merch/dispatch.ts:52`): `placePrintifyOrder` already guards on `printify_product_id / printify_order_id` + `409` recovery by `external_id` and gates `ProductCountersStore` on the `paid→submitted` transition return — reuse the same gate for royalties.
- **Infrastructure** (`infra/aws/template.yaml`): single `StripeSecretKey / StripeWebhookSecret` pair wired to both Lambdas. No Connect fields yet. Shipping countries today `US, CA, GB` (`merch/lambda.ts:444`).

## 3. Stripe Connect for artists — what they actually need

### 3.1 Which Connect flavor

| Account type | Artist already needs Stripe? | Who handles KYC/bank? | Drawbang effort |
|---|---|---|---|
| **Express** (recommended) | **No** — created for them via API `stripe.accounts.create({type:"express", country, email, capabilities:{transfers:{requested:true}}})` | **Stripe hosted onboarding** (`stripe.accountLinks.create`) + dashboard | ~1 backend file, 2 routes, 1 webhook |
| Standard | **Yes** — OAuth `GET https://connect.stripe.com/oauth/authorize` | Artist's own Stripe dashboard | OAuth dance + extra edge cases |
| Custom | No | Drawbang builds its own forms — *do not use* | 10× complexity |

**Recommendation: Express.** It is literally the case Stripe built it for: marketplace pays creator.

### 3.2 What the artist is asked for (Express hosted flow)

Stripe's hosted onboarding (`accountLinks.url`) collects **once**, with localized forms and instant bank verification (Financial Connections / Plaid) where available:

Required for `payouts_enabled = true`:

- **Email** (prefilled from `UserRecord.email`)
- **Country** (must be a Stripe-supported country — see 3.3)
- **Account type** — `individual` vs `business` (most pick `individual`)
- **Legal name + DOB + home address** (identity verification)
- **Government ID** — US: last 4 of SSN; EU/UK: national ID / address proof if Stripe prompts; some countries request a photo ID scan
- **Bank account** — **yes, required** — account number + routing/sort code/IBAN, or one-click via bank login where supported. Can also add a **debit card** for faster payouts in some markets, but bank is canonical.
- **Phone number** (2FA) and ToS acceptance

Time: **3–5 min** in happy path. Stripe verifies asynchronously; `account.payouts_enabled` flips to `true` when done. Occasional manual review (ID scan mismatch) takes 1–2 days.

For **Standard**, the above is the same, but the artist must first have (or create) a full Stripe account at `dashboard.stripe.com` and then click "Connect" — heavier.

### 3.3 Difficulty

- **For the artist: low.** No Stripe account pre-req with Express. They do not need to understand Stripe at all — it's a Stripe-branded form linked from `/account`. The hard part is having a **bank account in a supported country** and a valid ID.
- **For Drawbang: low–medium.** One new Stripe surface (`accounts`, `accountLinks`, `transfers` or `payouts`) and one new webhook (`account.updated`). No PCI scope — card data never touches Drawbang.

### 3.4 Geographic coverage — not worldwide

Stripe itself is in **47 countries**; Connect Express/Standard is in **~40 of those** (the intersection is what matters for *receiving* payouts). The platform (Drawbang) must be in a supported country — US qualifies.

**Supported for Connect payouts (covers merch shipping regions):** US, Canada, UK, EU/EEA (FR, DE, IT, ES, NL, SE, etc.), Australia, New Zealand, Japan, Singapore, Hong Kong, Mexico, Brazil* — full list at `stripe.com/global` and `stripe.com/docs/connect/supported-countries`.

**Notably NOT covered or limited:**
- India — invite-only Connect preview, stricter KYC
- Many LATAM/Africa/Middle East countries where Stripe isn't present at all (e.g., Argentina, Egypt, Pakistan) — no payouts possible there without a different rail
- Some countries only support Standard cross-border payouts, not Express, and require extra activation

**Implication for Drawbang:** Today `shippingCountries = ["US","CA","GB"]` — all three are fully supported, so the **author and buyer populations overlap the payout population**. If you expand payouts globally, expect ~20–30% of long-tail creators to be in unsupported countries — for them, fall back to **store credit** (see §5.5) instead of blocking registration.

**Currencies:** Platform charges in `USD` (`stripe.ts:62`). Cross-border Express payouts auto-convert (FX fee ~1–2%) or you can present in local currency (extra work — defer).

---

## 4. Architecture (ledger + threshold)

```
buyer checkout                     artist earnings
─────────────                      ───────────────
POST /merch/checkout  ──► Order{artist_user_id, artist_username} (stamped from DrawingRow)
        │                           ▲
        ▼                           │ drawingStore.get(drawing_id)
stripe webhook paid ──► dispatch ──► if (submitted && !anonymous && !selfPurchase)
                                       royalty_cents = calc(margin)
                                       ledger.credit(orderId)  ─► balances.addPayable()
                                                            │
                                               GET /merch/earnings (hydrates /account)
                                                            │
                                               threshold (e.g. $25) reached?
                                                            ▼
                                               POST /merch/payout/connect → Stripe accountLinks
                                               stripe webhook account.updated → UserRecord{payout_enabled}
                                               operator cron or artist button → stripe.transfers.create
                                                                               → ledger payable→paid
```

**Key invariants:**

- Checkout never fails because an artist hasn't onboarded — `artist_user_id` is informational; credit just no-ops until they connect later (retroactive batch on connect).
- Royalty is idempotent per `(artist_user_id, order_id)` — `ConditionExpression attribute_not_exists(pk)`.
- Reversals on `refunded`/`failed` decrement `payable_cents` before payout; after payout they create a negative adjustment.

## 5. Detailed design

### 5.1 Data model

**Extend `Order` (`merch/orders.ts:22`):**
```ts
artist_user_id?: string;
artist_username?: string;
royalty_cents?: number;
royalty_basis?: string;           // e.g. "margin_30pct_floor300"
printify_actual_cost_cents?: number; // optional, if fetched from Printify
```

**Extend `UserRecord` (`ingest/user-store.ts:19`):**
```ts
stripe_connect_account_id?: string; // acct_xxx
payout_onboarding_completed?: boolean; // mirrors Stripe payouts_enabled
payout_onboarded_at?: string;
```

**New table `drawbang-royalty-ledger` (on-demand, PK `artist_user_id`, SK `order_id`):**
```ts
RoyaltyLedgerRow {
  artist_user_id: string;  // PK
  order_id: string;        // SK
  drawing_id: string;
  product_id: string;
  variant_id: number;
  royalty_cents: number;
  basis: string;
  status: "pending" | "payable" | "paid" | "reversed" | "blocked_self_purchase";
  created_at: string;
  paid_at?: string;
  transfer_id?: string;    // tr_xxx when paid
}
GSI: order_id-index (lookup by order for admin/refund) 
```

**New table `drawbang-artist-balances` (PK `artist_user_id`):**
```ts
ArtistBalance {
  artist_user_id: string;  // PK
  username: string;
  payable_cents: number;   // gated on ledger status payable
  pending_cents: number;   // if you add a refund window before payable
  lifetime_cents: number;
  lifetime_orders: number;
  last_payout_at?: string;
  updated_at: string;
}
```
*Alternatives considered: single-table design on `drawbang-users` — rejected: hot partition + scan pressure; separate tables keep admin cost isolated.*

### 5.2 Royalty calculation

Option A (recommended for MVP): **max(floor(margin * 30%), 300c) capped at margin - 100c** where `margin = retail_cents - effective_cost_cents`. `effective_cost_cents` starts as `base_cost_cents` from catalog, swaps to `printify_actual_cost_cents` when available.

Option B (simpler audit): flat `500c` per fulfilled order — no margin dependency, trivial to explain.

Code location: new `merch/royalty.ts:calcRoyalty(order, product, actualCost?) → royalty_cents`. Tested in `test/royalty.test.ts`.

Guard: `if (isAnonymousUsername(artist_username) || isSelfPurchase(order.customer_email, artist.email)) royalty_cents = 0` — log `blocked_self_purchase` ledger row for observability.

### 5.3 New routes (follow `CLAUDE.md:81` checklist)

| Method | Path | Auth | Handler | Notes |
|---|---|---|---|---|
| `GET` | `/merch/earnings` | required (JWT) | `ingest/earnings-handler.ts` | Returns `{ balance, ledger: RoyaltyLedgerRow[] }`. Private. |
| `POST` | `/merch/payout/connect` | required | `merch/connect-handler.ts` | Creates/reuses `stripe.accounts.create`, then `stripe.accountLinks.create({ account, refresh_url, return_url, type:"account_onboarding"})` → `{ url }`. |
| `GET` | `/merch/payout/refresh` | required | same | Re-issues account link if onboarding expired (Stripe links are short-lived). |
| `GET` | `/merch/payout/return` | required | same | Stripe redirects here; handler verifies `stripe.accounts.retrieve(id).payouts_enabled` then flips `UserRecord.payout_onboarding_completed`. |
| `POST` | `/merch/payout/request` | required (threshold-gated) | `merch/payout-handler.ts` | Artist-triggered or cron-triggered transfer. Conditional on `payable_cents >= threshold && payout_onboarding_completed`. |
| `POST` | `/merch/webhook/connect` | Stripe sig | `merch/stripe.ts` extension | Listens for `account.updated` to flip `payout_onboarding_completed` without requiring the return-URL hit. |

Each gets: entry in `ingest/routes.ts:createRoutes()` + `infra/aws/template.yaml` `Events:` + CloudFront behavior if not covered by existing wildcard + `test/routes.test.ts` entry.

### 5.4 Withdrawal / threshold

- **MVP threshold:** `2500c ($25)` — balances Stripe's `$0.25`/payout + FX minima and avoids $0.42 payouts.
- **Trigger:** artist button on `/account` ("Connect payouts" → after onboarding → "Request payout $X.XX" when `payable >= threshold`) + nightly operator cron `scripts/payout-eligible.ts` that pages balances where `payable >= threshold && payout_enabled`.
- **Transfer:** `stripe.transfers.create({ amount: payable_cents, currency:"usd", destination: acct_xxx, transfer_group: "drawbang_royalties_${yyyy-mm}" })` — then atomically `balances.payable_cents -= amount; ledger rows payable→paid batch`. *On failure, leave payable untouched for retry.*
- **Refunds after payout:** create a negative ledger row; next payout nets it, or if balance negative, require covering deposit — defer to manual admin for V1.

### 5.5 Anonymous + claim + non-supported-country fallback

- Anonymous (`username === "anonymous"`): no credit. Draw a ledger row with `status=blocked_self_purchase` reason `anonymous` for audit only.
- Claim: once `docs/claim-flow-proposal.md` ships, a claimed drawing's future orders automatically route to the new author (checkout re-reads `DrawingRow`). No retroactive re-attribution for V1 — keeps ledger monotonic.
- Unsupported country: `POST /merch/payout/connect` returns `400 { error:"unsupported_country", supported: [...] }`. `/account` shows "Earnings available as store credit" instead — credit applied as a Stripe `coupon` or `promotion_code` at next checkout (`merch/stripe.ts` extension). Prevents dead-end onboarding loops.

### 5.6 Frontend

- `/account` (Vite `src/account.ts`): new **Earnings** card — `Balance $X.XX · Lifetime $Y · Connect payouts →` / `Payouts enabled ✓ · Request payout`. Polls `GET /merch/earnings` on load (same pattern as bookmarks: Bearer fetch + inline boot). State driven by `hydrate.js` — add `earnings` to `HydrateBody` if you want SSR hydration (#315).
- `/d/<id>` + `/u/<un>`: optional badge "earns on merch" — *defer*; keeps scope tight.
- Analytics: track `earnings_viewed`, `connect_started`, `connect_completed`, `payout_requested` via existing `src/analytics`.

### 5.7 Infrastructure

`infra/aws/template.yaml` delta:

```yaml
Parameters:
  StripeConnectWebhookSecret: { Type: String, NoEcho: true, Default: "" }
Resources:
  RoyaltyLedgerTable: { Type: AWS::DynamoDB::Table, BillingMode: PAY_PER_REQUEST, ... }
  ArtistBalancesTable: { Type: AWS::DynamoDB::Table, BillingMode: PAY_PER_REQUEST, ... }
  # IAM: add dynamodb:* on those two ARNs to both Ingest + Merch Lambdas
  # Env: add STRIPE_CONNECT_WEBHOOK_SECRET, ROYALTY_BPS/ROYALTY_FIXED_CENTS, PAYOUT_THRESHOLD_CENTS
```

Add `stripe` `connect` capability — no infra dependency, just platform Dashboard toggle: **Settings → Connect → Enable**. Set `Platform country = US`, `Business type = Marketplace`.

---

## 6. Implementation plan (PR sliced)

> Each PR merges to `master` → deploy workflow runs; no long-lived branches (README.md:244).

**PR 0 — Docs + constants (0.5 d)**
- This file + `config/constants.ts` add `ROYALTY_*` defaults (`ROYALTY_BPS`, `ROYALTY_FLOOR_CENTS`, `PAYOUT_THRESHOLD_CENTS`).

**PR 1 — Ledger + balances + royalty calc (2 d)**
- Files: `merch/royalty.ts`, `merch/royalty-ledger.ts`, `merch/artist-balances.ts`, `merch/orders.ts` (optional fields), `ingest/user-store.ts` (optional fields), `infra/aws/template.yaml` (2 tables + env), `test/royalty.test.ts`, `test/royalty-ledger.test.ts`.
- Extend `merch/dispatch.ts` to credit on `paid→submitted` gate. Idempotency: `ConditionExpression attribute_not_exists(artist_user_id)`.
- Verification: `npm run typecheck && npm test` (focused: `test/dispatch.test.ts test/orders.test.ts`); manual via `POST /ingest` + `POST /merch/checkout` + webhook replay with `stripe trigger checkout.session.completed` stub.

**PR 2 — Earnings API + connect onboarding (2 d)**
- Files: `ingest/earnings-handler.ts`, `merch/connect-handler.ts`, `merch/stripe.ts` (add `createConnectAccount`, `createAccountLink`, `retrieveAccount`, `createTransfer`), `ingest/routes.ts`, `infra/aws/template.yaml` (Events + CloudFront behaviors), `test/earnings-handler.test.ts`, `test/connect-handler.test.ts`.
- Secrets: `STRIPE_CONNECT_WEBHOOK_SECRET` via GitHub Actions.
- Verification: e2e via Stripe test mode — `stripe trigger account.updated` + hosted onboarding link rendered in test harness.

**PR 3 — Payout execution + operator cron (1.5 d)**
- Files: `merch/payout-handler.ts`, `scripts/payout-eligible.ts`, `.github/workflows/payout-cron.yml` (or reuse daily builder pattern), `test/payout-handler.test.ts`.
- Threshold `2500c` via `config/constants.ts`; admin view extend `ingest/admin-handler.ts` to show balances + recent ledger rows (behind `ADMIN_USERNAMES` gate — same as `/admin/data`).
- Verification: end-to-end payout in test mode against `acct_xxx` with `payouts_enabled`.

**PR 4 — /account UI (1 d)**
- Files: `src/account.ts`, `account.html` (earnings card), `static/chrome-identity.js` (optional badge), `vite/plugins/chrome.ts` if needed, analytics events.
- Verification: manual login → draw → merch order → see `GET /merch/earnings` update after webhook.

**PR 5 — Hardening (0.5 d)**
- Self-purchase guard (lookup artist email via `userStore.getByUsername`), refund webhook (`charge.refunded` → ledger reversal), unsupported-country store-credit fallback (Stripe coupon), `boot` log fields for Connect presence, cost-report guard for new DDB tables.

**Total: ~7 engineering days** wall-clock with review. PRs 1–2 can overlap review; Stripe Dashboard approval for Connect (business verification) should be requested in PR 0 to avoid gating PR 2.

---

## 7. Testing

- Unit: `node --test --import tsx test/royalty*.test.ts test/dispatch.test.ts test/merch-*.test.ts` — cover `anonymous → 0`, `self-purchase → 0`, `retry idempotency`, `refund reversal`, `threshold gating`.
- Integration: `stripe-cli` fixture `test/fixtures/stripe-account-updated.json` → `test/connect-handler.test.ts`.
- Smoke (no AWS): existing `POST /auth/register → POST /ingest → POST /merch/checkout → webhook stub → GET /merch/earnings` loop in `scripts/smoke-merch-royalties.ts`.

---

## 8. Alternatives & why not chosen now

| Alternative | When to prefer |
|---|---|
| Per-order `transfer_data` split at checkout | Real-time artist gratification, but blocks checkout if artist not onboarded and couples retry logic to Printify |
| Wise / PayPal payouts | Covers non-Stripe countries (India, etc.) without Stripe — heavier KYC, manual FX, higher fraud surface |
| Store credit only | Zero KYC/tax, fastest to ship — ship this as the unsupported-country branch of the plan |
| Tips/donations (no merch tie) | Lower legal bar — flat donation via Stripe Payment Links; no royalty math |

---

## 9. Open decisions (need owner before PR 1)

1. **Rate:** `30% margin` vs `flat $3–5` — affects copy and margin guard.
2. **Threshold:** `$10` (faster gratification) vs `$25` (fewer transfers, cleaner 1099s) — recommend $25.
3. **Self-purchase:** pay or block? Recommend **block** with transparent `blocked_self_purchase` ledger reason.
4. **Retroactivity:** credit anonymous-era orders when a drawing is later claimed? Recommend **no** for V1.
5. **Platform country:** confirm Drawbang legal entity country for Connect (US expected).
6. **Tax owner:** who files 1099-K/1099-MISC when threshold crossed — Stripe Express handles 1099-K in US if `transfers` capability, but operator must confirm with accountant.

---

## 10. Rollout & rollback

- **Direct rollout:** tables go live on deploy; royalties accrue from the first order after deploy since traffic is negligible. No backfill — ledger is append-only; pre-existing orders stay at `0`.
- **Rollback:** revert the dispatch credit call; ledger stops appending but existing balances remain queryable for manual payout. No data deletion.
- **Observability:** extend `ingest/log-outcome.ts` with `outcome.kind=royalty { artist_user_id, royalty_cents, basis }` + CloudWatch alarm on `ledger credit failure`.

