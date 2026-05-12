# Identity considerations

Notes on the Ed25519 identity scheme (`src/identity.ts`, shipped via #82) when
extending it beyond drawing ownership — e.g. signed-in `/my-orders` (#95) or
any future protected resource.

## Current state — what's already safe

- Ed25519 via Web Crypto, keypair generated client-side, secret persisted in
  IndexedDB.
- Signature is over the drawing id (`sha256(gif_bytes)`), so:
  - **Replay** of `(gif, pubkey, signature)` is structurally inert: same gif →
    same id → idempotency short-circuit at `ingest/handler.ts:137`.
  - **Cross-drawing replay** is impossible: distinct gifs have distinct ids;
    a sig on A won't verify against B.
- PoW reuse is bounded by the 8-slot `baselineHistory` window in
  `ingest/lambda.ts` — once a baseline ages out, any PoW grinder against it
  is permanently dead.
- Owner-pubkey binding on orders (#96) is established by a *fresh signature*
  at checkout, not user assertion — no first-poster grab risk.

## Open issue — domain separation

`verifyDrawingId` (`src/identity.ts:53`) is a generic
"verify Ed25519 over any 32-byte hash" primitive. There's no protocol tag
inside the signed bytes. Right now only one capability uses it (drawing
ownership), so this is latent — not a current exploit.

It becomes a footgun the moment a second capability reuses it. Epic #95
proposes signing `sha256("my-orders:<pk>:<ts>")`. The hash is 32 bytes,
exactly the shape `verifyDrawingId` already accepts — same key, same
primitive, no separator. SHA-256 preimage resistance makes the specific
cross-protocol collision computationally infeasible, but the *credential
primitive itself* can't tell the two contexts apart.

**Recommended fix before #97 ships:** add a labeled-message helper,

```ts
verifySigned(pubkey, "drawbang/v1/my-orders", canonicalBytes, sig)
```

that prepends a fixed protocol tag inside the hash. Distinct labels per
capability. Keep `verifyDrawingId` as a thin wrapper using
`"drawbang/v1/drawing-id"` for back-compat with already-stored signatures.
This is a ~30-line change and makes the credential safe to extend
indefinitely.

## Self-issued timestamps — scope limits

The `/my-orders` design uses a client-picked timestamp (`t`) inside a 5-min
server-enforced window. Acceptable for read-only access to your own data:
the worst replay outcome within the window is re-reading what you already
have access to.

**Do not reuse this scheme for state-changing endpoints** (cancel order,
change shipping address, refund). Those need a server-issued nonce
(`POST /auth/challenge` → DynamoDB row with TTL, consumed on use).

## Pubkey + sig in URL query string

Per #95, the my-orders request is a `GET` with `pubkey`, `t`, `sig` in the
query string. CloudFront access logs (and analytics tables built from them
in #157–#163) will capture those params. They're not secret — the pubkey
is public-key, the sig is time-bounded — but:

- Strip `pubkey` and `sig` before any log-derived analytics surface.
- Don't ever attach a *long-lived* signature to a URL with the same shape.

## Passkeys / WebAuthn — feasibility

**TL;DR:** Not a replacement for the publish signing flow. Plausible as a
*complement* for `/my-orders`, with caveats. The plain Ed25519 design above
is the right answer for drawing ownership.

### Why it's not a fit for publish-flow signing

1. **WebAuthn signs an assertion envelope, not raw bytes.** A passkey
   signature is `signature(authenticatorData ‖ sha256(clientDataJSON))`,
   where `clientDataJSON` includes a server-supplied challenge. To "sign
   the drawing id" you'd put it in the challenge field, and the verify
   path becomes a multi-step parse (challenge match, origin check, RP-ID
   hash, flags, counter, sig). The inbox JSON metadata fattens from
   `64 + 128 hex` to a few hundred bytes per assertion.

2. **Per-publish user gesture.** Every `navigator.credentials.get()`
   requires user consent (biometric/PIN/tap), and can't run in a Web
   Worker. The current publish flow signs silently after PoW completes;
   with passkeys it becomes "grind PoW → biometric prompt → submit."
   Acceptable for one-off ops, friction for an editor that iterates fast.

3. **Server-issued challenges required.** MDN: challenges are nonces
   issued by the RP, valid ~10 min. The stateless "client picks the
   timestamp" pattern doesn't translate — you'd need a stateful
   challenge endpoint (a step backward for an otherwise-stateless
   pipeline).

### What passkeys *would* give you

- Anti-phishing by construction: the origin is bound into
  `clientDataJSON` and verified by the RP.
- iCloud / Google Password Manager sync — solves the "key is gone if the
  user clears IndexedDB" failure mode.
- Built-in revocation hints via the `signal*` static methods on
  `PublicKeyCredential` (sync removed/added credentials to the
  authenticator).

### RP-ID / domain binding

Passkeys are scoped to a relying-party ID — a domain or registrable
suffix of the page's origin. The production origin is `pixel.drawbang.com`,
so the natural RP ID is `drawbang.com`. As long as the app stays anywhere
under `*.drawbang.com` (apex, `pixel.`, `app.`, etc.), credentials remain
valid. A full rebrand to a different apex domain orphans every passkey
with no recovery path — the current Ed25519-in-IndexedDB scheme has no
such constraint.

Implication: if a custom domain change is planned, register passkeys
*after* the move.

### PRF / hmac-secret extension — not a primary option

A "passkey wraps the Ed25519 JWK secret" recovery flow needs the WebAuthn
PRF extension to derive a wrapping key. Shipped in Chrome 132+ and Safari
18, but not yet in MDN's primary passkey docs and has no graceful fallback
on unsupported authenticators. Treat as a *progressive enhancement*,
not the foundation of a recovery story.

## Summary recommendation

- **Keep Ed25519 as the identity primitive.** It does exactly what's
  needed and stays cheap to verify.
- **Add domain separation** before extending `verifyDrawingId` to a
  second capability. This is the one structural change worth doing
  proactively.
- **Self-issued timestamps stay scoped to read-only.** Server nonces
  for anything that mutates state.
- **Passkeys are a future option** for signed-in pages if cross-device
  portability becomes a real pain point — not a replacement for the
  publish flow.
