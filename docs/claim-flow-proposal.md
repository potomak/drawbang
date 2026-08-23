# Proposal: claiming an anonymous drawing

Status: **proposed, not built.** Written as the follow-up to anonymous
publishing (see "Anonymous publishing" in `CLAUDE.md`), which shipped with
claiming deliberately left out.

## The problem

Publishing no longer requires an account. Someone draws, hits Publish, and
the drawing lands under the `anonymous` sentinel. The success flash invites
them to create an account — and when they do, the drawing they _just made_
still says "anonymous". That's the wrong reward for taking the action we
asked for, and it's the moment we most want to feel good.

Today there is no way to fix it after the fact. `drawing_id` is
`sha256(gif_bytes)`, so re-publishing the same drawing while signed in hits
the idempotency short-circuit in `handleIngest` and returns the existing row,
author untouched.

## The trap: possession of the bytes proves nothing

The obvious design — "let someone claim a drawing by re-uploading the same
GIF" — is wrong, and it's worth being explicit about why, because it's the
first idea everyone has.

The GIF is **public**. Every drawing is served at `/tiles/<id>.gif`, and the
id _is_ the hash of those bytes. Anyone browsing the gallery can download any
drawing and re-upload it byte-for-byte. A claim scheme based on producing the
content is a claim scheme where anyone can steal anything.

Content-addressing means the artifact can never be the secret. The capability
to claim has to be something only the original publisher was handed.

## Recommendation: a purpose-scoped claim token

Mirror the password-reset idiom already in `ingest/auth-handler.ts`: a signed,
expiring, purpose-tagged JWT. No new table, no new secret, no new
infrastructure.

### 1. Issue at publish time

When `handleIngest` completes an anonymous publish, it returns one extra
field:

```jsonc
{
  "id": "<drawing_id>",
  "share_url": "https://…/d/<drawing_id>",
  "claim_token": "<jwt>", // anonymous publishes only
}
```

The token is signed with the existing `JWT_SECRET`:

```ts
interface DrawingClaimClaims extends JwtClaims {
  did: string; // drawing_id this token claims
  purpose: "drawing-claim";
}

signJwt({ did: id, purpose: "drawing-claim" }, cfg.jwtSecret, CLAIM_TTL_S, nowSec);
```

`CLAIM_TTL_S` = **30 days** (proposed). Long enough for "I drew that last
week, let me finally sign up"; short enough that a token leaked through a
shared browser or a log line stops mattering.

An _attributed_ publish returns no token — there is nothing to claim.

### 2. Hold it client-side

`src/submit.ts` returns the token; the editor appends it to a capped,
self-pruning list in `localStorage`:

```jsonc
// drawbang:pending-claims
[{ "id": "<drawing_id>", "token": "<jwt>", "exp": 1234567890 }]
```

Cap at ~20 entries, FIFO, and drop expired ones on every read so the list
can't grow without bound or accumulate dead weight.

This is device-local, self-expiring, and never leaves the browser except at
claim time. It is **not** an identifier for the logged-out user — see
"Rejected: a persistent anonymous device id" below, which is the version that
would have been.

### 3. Redeem after sign-up

`POST /claims`, Bearer JWT required:

```jsonc
// request
{ "tokens": ["<jwt>", "<jwt>"] }        // cap 20

// response 200
{
  "claimed": ["<drawing_id>"],
  "failed":  [{ "id": "<drawing_id>", "reason": "already_claimed" }]
}
```

Batch, because the flow this exists to serve is "I drew four things, _then_
signed up". A single claim is a one-element array.

The redemption point belongs in `src/auth.ts`, after both `register()` **and**
`login()` succeed — someone who already had an account but was signed out
while drawing deserves the same result. Failures here are non-fatal and must
never block the auth flow; the drawings stay anonymous and the user stays
signed in.

### 4. Reassign the row

`DrawingStore` currently exposes only `put` (whole row) and `get`. It needs
one new method:

```ts
// Returns the updated row, or null when the row is gone or is no longer
// anonymous. The condition makes concurrent claims first-writer-wins.
claimForUser(args: {
  drawing_id: string;
  user_id: string;
  username: string;
}): Promise<DrawingRow | null>;
```

DynamoDB: an `UpdateCommand` with

```
ConditionExpression: attribute_exists(drawing_id) AND username = :anon
UpdateExpression:    SET user_id = :uid, username = :un
ReturnValues:        ALL_NEW
```

`ConditionalCheckFailedException` → `null`. Plus the matching
`MemoryDrawingStore` implementation for dev/tests.

**This is also what enforces single use.** Once claimed, the row's username is
no longer `anonymous`, so replaying the token fails the condition. No
revocation table, no `used` flag, no cleanup job.

### Why the index layout already cooperates

Worth stating, because it's the "does this actually work?" question:

- **GSI2** (per-profile gallery) is keyed on `username`. Rewriting that
  attribute moves the row from the `anonymous` partition into the claimer's
  automatically — `/u/<username>` picks it up with no extra work.
- `created_at_ms` is untouched, so the drawing sorts into their profile at
  its original publish time, not at claim time.
- **GSI1** (`GALLERY`), **GSI3** (`parent_id`), **GSI4** (`prompt_id`) don't
  key on author and are unaffected. Feed position, remix chains, and prompt
  grids all survive the reassignment.

### 5. Invalidate

Add to `ingest/cache-invalidation.ts`:

```ts
pathsToInvalidateOnClaim(username: string, drawing_ids: string[]): string[]
```

= the publish path list for `username` (`/`, `/feed/items*`, `/gallery*`,
`/u/<username>*`, `/feed.rss`) plus `/d/<id>*` per claimed drawing, because
the byline on each drawing page changes.

## What claiming will _not_ do

**It will not rebuild streaks.** `recordDailyDrawing` is a read-modify-write
whose consecutive-day branch keys off `daily_last_date`; feeding it arbitrary
past dates would produce wrong `daily_streak_current` values. Claimed
drawings will therefore show up in the gallery and on the profile grid — the
visible thing people care about — while the streak and total counters ignore
them.

The honest fix, if this ever matters, is a `recomputeFromDrawings(user_id)`
that replays a user's rows in order and rewrites the stats row wholesale.
That's a separate piece of work and shouldn't gate the claim flow.

## Rejected alternatives

**Claim by re-publishing the same bytes.** Anyone can download any drawing;
see "The trap" above. It also silently mutates the meaning of the
idempotency short-circuit, which several other behaviours lean on.

**A persistent anonymous device id.** Stamp a random `anon_id` on every
anonymous row, then claim everything matching it at sign-up. Better on paper —
one round trip, nothing for the client to hold — but it means minting a
durable cross-session identifier for logged-out users and storing it against
their content. That's a genuine privacy regression, it would need saying out
loud on `/privacy`, and it needs a new GSI (or a scan) to query by. The token
list buys the same multi-drawing UX with none of it.

**A `claimed_by` column plus an admin review queue.** Solves disputes nobody
is having yet. Revisit only if claim-stealing turns out to be real.

## Wiring checklist

Per the "Adding a new Lambda-rendered route" checklist in `CLAUDE.md` — the
CloudFront step is the one that bites, because there is no `/drawings/*` or
catch-all API behaviour. `/drawings/*/like` and `/drawings/*/bookmark` are
each registered explicitly, and anything unmatched falls through to the S3
origin and 403s instead of reaching Lambda.

1. `ingest/claim-handler.ts` — verify token, check `purpose` + `did`, call
   `claimForUser`, invalidate.
2. `ingest/routes.ts` — `{ methods: ["POST"], pattern: /^\/claims$/, auth:
"required" }`.
3. `test/routes.test.ts` — extend the auth-gate table.
4. `infra/aws/template.yaml` — API Gateway event, `Path: /claims`.
5. `infra/aws/template.yaml` — **new** CloudFront behaviour `PathPattern:
/claims`, api origin, auth forwarded (copy the `/drawings/*/like` block).
6. `ingest/cache-invalidation.ts` — `pathsToInvalidateOnClaim`.

Plus: `DrawingStore.claimForUser` in both the Dynamo and Memory
implementations, `src/claims.ts` for the localStorage list, and the redemption
call in `src/auth.ts`.

## Tests worth writing

- A valid token reassigns the row; the drawing then appears under
  `/u/<username>` and the byline on `/d/<id>` links to the profile.
- Replaying a spent token fails — the row is no longer anonymous.
- A token for drawing A cannot claim drawing B (`did` mismatch).
- A token signed with the wrong secret, an expired token, and a token with
  the wrong `purpose` are all rejected.
- A drawing already owned by a real account cannot be claimed.
- Concurrent claims: exactly one wins.
- A failed claim does not break sign-up — the session is still issued.
- `created_at_ms` and remix lineage survive the reassignment.

## Open questions

1. **Claim window.** 30 days proposed. Shorter is safer, longer converts more.
2. **Claim prompt on `/d/<id>`.** The drawing page could show a "This is
   yours — claim it" button when `localStorage` holds a token whose `did`
   matches `data-drawing-id`. Pure client-side, no new endpoint, and it
   catches people who wander back to their drawing before signing up. Worth
   including in v1?
3. **Do claimed drawings count toward badges?** Follows directly from the
   streak decision above; currently proposed as "no".
