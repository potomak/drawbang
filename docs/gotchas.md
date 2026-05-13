# Build & deploy gotchas

Project-level knowledge that bit a previous session. Add to this file
whenever a fix isn't obvious from the code or commit message — the goal is
to spare the next agent / contributor an hour of head-scratching.

## TypeScript / tsconfig

- `verbatimModuleSyntax: true` + `moduleResolution: "Bundler"` does **not**
  propagate the inner namespace through the Stripe SDK's
  `export { Checkout }` re-export. Use
  `Parameters<Stripe["checkout"]["sessions"]["create"]>[0]` instead of
  `Stripe.Checkout.SessionCreateParams`. Same shape applies to
  `Stripe.Checkout.Session.CustomerDetails` etc. — destructure via
  `NonNullable<Stripe.Checkout.Session["customer_details"]>`.
- `tsconfig.json` `include` is selective. When a new top-level directory
  appears (e.g. `merch/`, `vite/`), add a glob — files outside the list
  silently fail to typecheck.

## SDK pins

- Stripe SDK pin: `2026-04-22.dahlia` (latest in v22). Old issue bodies
  reference `2025-09-30.clover`; those references are stale.
- Stripe SDK v22 moved checkout shipping into
  `Session.collected_information.shipping_details`. The older top-level
  `Session.shipping_details` isn't on the type.

## Runtime quirks

- `pngjs` `pack()` is a stream, not a sync method. Collect chunks into a
  `Uint8Array` and return via Promise (see `merch/upscale.ts`).
- `DynamoDBDocumentClient.from(client)` shares the underlying client's
  middleware stack — it never calls `client.send()`. Stubbing `client.send`
  in tests won't intercept anything. `OrdersStore` and
  `ProductCountersStore` expose a `docClient?:` seam specifically for
  this reason; production passes a real `client` and lets the store wrap
  it.
- The Lambda bundle (`dist-lambda/*.js`) is CJS, but the parent
  `package.json` has `"type": "module"`. Local
  `require('/path/dist-lambda/foo.js')` from inside the project will fail
  (Node loads it as ESM via parent type). AWS Lambda doesn't see the
  parent `package.json`, so it loads as CJS at runtime and works. To
  smoke-test exports locally, copy the bundle outside the project tree or
  import the source via `tsx`.

## API Gateway

- HTTP API event `routeKey` already includes the method
  (e.g. `"GET /merch/products"`). Don't prefix it again with
  `event.requestContext.http.method` — switch on `routeKey` directly.

## SAM / CloudFormation

- YAML flow-mapping (`{ Path: /foo/{id} }`) chokes on `{id}`. Write SAM
  Event `Properties` in block form when the path has placeholders.
- `!If` inside SAM `CorsConfiguration` corrupts the transform — keep the
  list literal, conditionalise only a single element.
- Local `sam deploy` hits transient XML parser errors via the SAM CLI's
  bundled botocore. Retry; CI doesn't have this issue.

## CloudFront / S3

- `/state/last-publish.json` must not be cached at the edge — handled by a
  separate CloudFront cache behavior with `CachingDisabled`.
- **OAC + no `s3:ListBucket` grant → 403 on missing key, not 404.** When a
  URL behind CloudFront returns `AccessDenied`, the most likely cause is
  "that S3 object doesn't exist," not an IAM problem. `/products` did this
  before #154's empty-state fix; `/identity` did it until the static page
  landed.
- **Never mark un-hashed static files `immutable`.** Vite copies `static/`
  to `dist/` verbatim — `gallery-v2.css`, `chrome-toggle.js`,
  `chrome-identity.js`, mockups. `deploy.yml` MUST split the S3 sync so
  only `dist/assets/*` (hashed by Vite) carries the
  `max-age=31536000, immutable` header. Stamping immutable on un-hashed
  paths traps every visiting browser on that exact byte sequence for a
  year with no revalidation — the fix is a URL rename (which is why
  `gallery.css` is now `gallery-v2.css`).
- Adding a new clean-URL rewrite to `infra/aws/template.yaml`'s
  CloudFront Function MUST be paired with a matching entry in
  `deploy.yml`'s CloudFront invalidation list. `/products` shipped with
  the rewrite but without invalidation in #154, which masked the
  empty-state issue for an extra deploy cycle.
- Editor's `share_url` is `${PUBLIC_BASE_URL}/d/<id>` (CloudFront), not the
  S3 origin URL. CloudFront Function rewrites `/d/<id>` to `/d/<id>.html`.
