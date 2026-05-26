# Auth setup: JWT_SECRET + SES

Operational steps to turn on the email/password account system in production.
Everything runs in **us-east-1** (the Lambda's region, stack `drawbang-ingest`).
The deploy job is pinned to GitHub `environment: prod`, so secrets go there.

Wiring is already in place:
GitHub secret → `.github/workflows/deploy.yml` → SAM param → Lambda env var.

| GitHub config             | SAM param       | Lambda env var     | Required? |
|---------------------------|-----------------|--------------------|-----------|
| `JWT_SECRET` (secret)     | `JwtSecret`     | `JWT_SECRET`       | Yes — ingest Lambda fails at cold start if empty |
| `SES_FROM_ADDRESS` (variable) | `SesFromAddress`| `SES_FROM_ADDRESS` | No — reset still returns 200, just sends no email |

---

## 1. JWT_SECRET (required)

HMAC key that signs every session + password-reset JWT (HS256).

Generate a strong 256-bit value:

```bash
openssl rand -base64 48
```

Add it to the **prod** environment:

- UI: repo → Settings → Environments → **prod** → *Add environment secret* →
  name `JWT_SECRET`, value = generated string.
- or CLI:
  ```bash
  gh secret set JWT_SECRET --env prod --body "$(openssl rand -base64 48)"
  ```

Next push to `master` deploys with it. Manual deploys: append
`--parameter-overrides "JwtSecret=<value>"` to `sam deploy`.

**Rotation:** changing this value logs everyone out (invalidates all sessions)
and kills any outstanding reset links. That's the intended kill-switch.

---

## 2. SES (optional — for password-reset emails)

The IAM grant (`ses:SendEmail` / `ses:SendRawEmail`) is already in the template.
You need to: (a) verify a sender, (b) set `SES_FROM_ADDRESS`, (c) leave the
SES sandbox. Do all of it in **us-east-1**.

### a) Verify a sender identity (pick one)

**Domain (recommended — any address @domain + DKIM):**
```bash
# TXT token for _amazonses.drawbang.com
aws ses verify-domain-identity --domain drawbang.com --region us-east-1
# 3 DKIM CNAME tokens
aws ses verify-domain-dkim --domain drawbang.com --region us-east-1
```
Add the DNS records at your provider, then wait until the identity shows
**Verified** in SES → Verified identities.

**Single email (quick, no DNS):**
```bash
aws ses verify-email-identity --email-address no-reply@drawbang.com --region us-east-1
```
Click the confirmation link AWS emails to that address.

(Console: SES → Verified identities → Create identity → Domain or Email address.)

### b) Set SES_FROM_ADDRESS

Must be covered by the verified identity (e.g. `no-reply@drawbang.com`). It's the
email's From address; the reset link origin comes from `PUBLIC_BASE_URL`.

```bash
gh variable set SES_FROM_ADDRESS --env prod --body "no-reply@drawbang.com"
```
(or add it as a prod environment **variable** in the UI). It's a public From
address, not a secret — `deploy.yml` reads it from `vars.SES_FROM_ADDRESS`.

### c) Leave the SES sandbox

New SES accounts are sandboxed: they can only email **verified** recipients at a
low rate. Real password resets need production access:

- SES console (us-east-1) → **Account dashboard** → **Request production access**
  → describe the use case (transactional — "password-reset emails for app
  users"). Approval is usually quick.

Until granted, reset links only deliver to addresses you've separately verified.

### Verify it works

After deploy, `POST /auth/reset/request` for a real account → check the inbox.
Locally (`npm run dev:all`), SES is not used — the reset link is printed to the
ingest dev-server console (`[email] password reset for …`).

---

## Notes

- The `pubkey` → `user_id` key rename on `drawbang-user-stats` and
  `drawbang-canvas-cooldowns` makes CloudFormation **replace** those two tables
  on first deploy of this change (acceptable — fresh start, no real users yet).
- New tables created by this stack: `drawbang-users` (PK `email`),
  `drawbang-usernames` (PK `username`).
