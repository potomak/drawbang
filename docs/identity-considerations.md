# Identity considerations

Drawbang's identity is an **email/password account** with stateless JWT
sessions. (This replaced the original anonymous Ed25519 keypair scheme — there
is no per-drawing signing anymore.) This doc records the model and the security
trade-offs deliberately taken.

## Model

- **Account**: email (private, unique, the login key) + password + a chosen
  **username** (public, unique, immutable in v1) + a random 64-hex `user_id`
  (stable internal/public id). Backed by DynamoDB:
  - `drawbang-users` — PK `email`; attrs `user_id`, `username`, `password_hash`,
    `token_version`, `created_at`.
  - `drawbang-usernames` — PK `username`; reserves the handle.
  - `register()` writes both in one `TransactWriteItems`, so email **and**
    username uniqueness are enforced atomically (`ingest/user-store.ts`).
- **Password hashing**: `crypto.scrypt` + per-user 16-byte salt, constant-time
  compare (`ingest/password.ts`). No native dependency; runs inside the Lambda
  budget.
- **Sessions**: HS256 JWT (`ingest/jwt.ts`), payload `{ sub: user_id, un:
  username }`, ~30-day exp, signed with `JWT_SECRET`. Verified by signature +
  exp only — **no DB read per request**. Client stores it in
  `localStorage["drawbang:jwt"]` and mirrors the username to
  `localStorage["drawbang:username"]` (so `static/chrome-identity.js` can
  rewrite the nav link before first paint). Publish/claim send `Authorization:
  Bearer <jwt>`; the route extracts `{ user_id, username }` and passes it into
  the handlers via `cfg.auth`.
- **Password reset**: `POST /auth/reset/request` always returns 200 (no email
  enumeration) and, if the account exists, emails a link carrying a 1-hour
  reset-JWT `{ email, tv: token_version, purpose: "reset" }` via SES
  (`ingest/email.ts`). `POST /auth/reset/confirm` verifies the JWT, requires
  `tv === token_version`, writes the new hash, and **increments
  `token_version`** — which makes the link single-use. There is no signup email
  verification.

## Trade-offs taken (v1)

- **Stateless sessions can't be force-revoked** before their exp. A password
  reset bumps `token_version` (killing outstanding reset links) but session
  JWTs are not checked against it per request — that would reintroduce a DB read
  on every publish. Acceptable given the ~30-day exp; revisit with a
  `token_version` claim + per-request check if "log out everywhere" is needed.
- **JWT in `localStorage` is XSS-exfiltratable.** Mitigated by the site's
  no-third-party-script discipline. An httpOnly-cookie transport was deferred
  because the API Gateway origin differs from the CloudFront origin (cross-site
  cookie + CSRF complexity).
- **Account creation is cheap** (no verification, no PoW on register).
  Anti-abuse for the things that matter is per-action **PoW**, not identity:
  publish PoW gates gallery spam and **claim PoW** gates canvas tile takeover
  (`claim:<canvas_id>:<x>:<y>:<user_id>:<baseline>:<nonce>`). If mass signups
  become a problem, add API Gateway throttling or a PoW on `/auth/register`.
- **Registration leaks taken email/username** (409). Hard to avoid without
  hurting usability; accepted.
- **SES sandbox**: until the AWS account has SES production access, reset emails
  only reach pre-verified recipients. `SES_FROM_ADDRESS` empty → reset requests
  still 200, but nothing is sent (logged for operators).

## Migration note (fresh start)

Drawings published under the old keypair scheme keep their `pubkey`-era inbox
metadata but have no `username`; the builder renders them as "anonymous" with no
profile page and provides no path to claim them. New publishes carry
`user_id` + `username` and roll up under `/u/<username>`.
