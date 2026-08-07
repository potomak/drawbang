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
- **Password reset**: `POST /auth/password/forgot` always returns 200 (no email
  enumeration) and, if the account exists, emails a link to `/password/reset`
  carrying a 1-hour reset-JWT `{ email, tv: token_version, purpose:
  "password-reset" }` via SES (`ingest/email.ts`). `POST /auth/password/reset`
  verifies the JWT, requires `tv === token_version`, writes the new hash, and
  **increments `token_version`** — which makes the link single-use. There is
  no signup email verification.

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

## Anonymous publishing

Publishing does not require an account. `POST /ingest` is `auth: "optional"`:
with no `Authorization` header the drawing is stored under the sentinel
identity `ANONYMOUS_USERNAME` / `ANONYMOUS_USER_ID` (`config/constants.ts`).

The security properties that matter here:

- **No silent downgrade.** A request that carries an `Authorization` header
  which fails verification gets a 401, not an anonymous publish. `auth()`
  collapses "absent" and "invalid" into `null`, so the ingest route consults
  `req.hasAuthHeader()` to tell them apart. Without that, rotating
  `JWT_SECRET` would quietly re-attribute every in-flight publish to the
  sentinel.
- **The sentinel is not an account.** `anonymous` is in `RESERVED_USERNAMES`
  with a matching row in `drawbang-usernames`, so the registration
  `TransactWriteItems` condition blocks anyone from claiming the handle and
  inheriting the byline. `/u/anonymous` and its sub-routes 404.
- **Nothing accrues to it.** No per-account streak/total counters are
  recorded against the shared sentinel `user_id`, and no `/u/` cache
  invalidation is issued on an anonymous publish.
- **Likes and bookmarks are unaffected.** Both are keyed by the *viewer's*
  `user_id` against a `drawing_id`, so an anonymous drawing is liked and
  bookmarked exactly like any other. Those actions still require a session —
  it's the author who may be anonymous, not the actor.
- **Profile pictures stay owner-gated.** `handleSetProfilePicture` requires
  `drawing.username === auth.username`; since no account can hold
  `anonymous`, anonymous drawings can't be adopted as anyone's avatar.

**Abuse surface.** Removing the login gate removes the main cost of
publishing junk. There is no rate limiting on `POST /ingest` today — content
addressing dedupes byte-identical spam, but not varied spam. If it becomes a
problem the lever is a per-IP limit at the edge, not restoring the gate.

## Migration note (fresh start)

Drawings published under the old keypair scheme keep their `pubkey`-era inbox
metadata but have no `username`; they were migrated under the same
`anonymous` sentinel that present-day anonymous publishes use, so both render
with an unlinked "anonymous" byline and no profile page. Because
`drawing_id` is content-addressed, there is no path to claim either one after
the fact — re-publishing the same bytes while signed in hits the idempotency
short-circuit and keeps the original author. Attributed publishes carry
`user_id` + `username` and roll up under `/u/<username>`.
