# Drawbang

A 16×16 pixel-art editor with an anonymous public gallery and merch
checkout. Live at <https://pixel.drawbang.com>.

The stack is **static-first**: a browser editor builds the GIF locally, a
small ingest Lambda accepts proof-of-work-gated submissions, and a daily
batch job regenerates the gallery as static HTML on S3. Merch flows
through a separate Lambda that talks to Stripe + Printify.

```
  editor + gallery + GIFs            →  S3 (us-east-1) behind CloudFront
  POST /ingest                       →  Lambda + API Gateway
  POST /merch/checkout, /merch/...   →  Lambda + Stripe + Printify
  daily gallery rebuild              →  GitHub Actions cron
```

## Prerequisites

| Tool      | Version | Why                                    |
| --------- | ------- | -------------------------------------- |
| **Node.js** | **22.x** | Vite, the toolchain, and CI all run on 22 |
| **npm**   | bundled with Node | dependency install + scripts            |
| Git       | any     | obvious                                |
| AWS CLI   | v2 (optional) | poke at S3 / Lambda / DynamoDB during ops |
| SAM CLI   | latest (only if deploying) | `npm run lambda:deploy` calls `sam deploy` |

You only need AWS / SAM if you're deploying. The editor, tests, and
local dev servers run with just Node + npm.

### Install Node on macOS

```bash
# homebrew (simplest)
brew install node@22

# or with nvm if you juggle versions
brew install nvm
nvm install 22
nvm use 22
```

### Install Node on Linux

```bash
# Debian / Ubuntu — NodeSource is the most reliable source for current Node
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Arch
sudo pacman -S nodejs npm

# Fedora
sudo dnf install nodejs:22

# or with nvm anywhere
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22
nvm use 22
```

Confirm with `node --version` — should print `v22.x`.

### (Optional) AWS + SAM tools — for deploys only

```bash
# macOS
brew install awscli aws-sam-cli

# Linux (awscli)
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscli.zip
unzip awscli.zip && sudo ./aws/install

# Linux (sam) — homebrew on linux works, or follow:
# https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html
```

Configure AWS once: `aws configure` (takes an access key, secret,
region — region must be `us-east-1`).

## Clone & install

```bash
git clone https://github.com/potomak/drawbang.git
cd drawbang
npm install
```

That's it. Everything below runs from the repo root.

## Common workflows

### Run the editor locally

```bash
npm run dev
```

Vite serves the editor at <http://localhost:5173>. Hot-reload works for
the editor / merch / share / order pages.

### Run the ingest endpoint locally (against the filesystem)

```bash
npm run ingest:dev
```

Spins up a Node HTTP shim on `:8787` that accepts the same `POST /ingest`
the production Lambda does, but stores under `./dev-bucket/` instead of
S3. Pair with the editor by setting `VITE_INGEST_URL=http://localhost:8787`
in a `.env.local` before `npm run dev`.

### Run the gallery builder locally

```bash
# operates on ./dev-bucket/ if DRAWBANG_S3_BUCKET is unset
npm run builder
```

Sweeps any drawings in `dev-bucket/inbox/<day>/` into the static HTML
under `dev-bucket/public/`.

### Type-check & test

```bash
npm run typecheck   # tsc -b --noEmit, fast
npm test            # node:test across test/**/*.test.ts
```

Most tests run in <2 seconds. The proof-of-work tests (`test/ingest.*`)
do real PoW at 16 bits and take 30–60 seconds each — for tight loops:

```bash
node --test --import tsx \
  'test/gif.test.ts' 'test/pow.test.ts' 'test/share.test.ts' \
  'test/builder.test.ts' 'test/drawing-template.test.ts' \
  'test/upscale.test.ts' 'test/dispatch.test.ts' \
  'test/printify.test.ts' 'test/brand-logo.test.ts' \
  'test/merch-lambda.test.ts' 'test/merch-webhook.test.ts'
```

### Production build (sanity check before deploy)

```bash
npm run build         # tsc + vite build → dist/
npm run lambda:build  # esbuild → dist-lambda/{ingest,merch}.js
```

Both should print zero errors and finish in a couple of seconds.

## Deploying

**You probably don't need to deploy manually.** Pushing to `master` runs
`.github/workflows/deploy.yml` which:

1. Type-checks + tests
2. `sam deploy`s the Lambda + DynamoDB + IAM
3. Builds the editor (`npm run build`) and `aws s3 sync`s it to the
   assets bucket
4. Runs the gallery builder against the live S3 bucket
5. Invalidates the CloudFront cache for changed paths

The workflow needs these GitHub Actions secrets (Settings → Secrets):

- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- `PRINTIFY_API_TOKEN`, `PRINTIFY_SHOP_ID`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

### Manual deploy (only if CI is broken)

```bash
# AWS creds need to be active in your shell for both halves
export AWS_PROFILE=drawbang   # or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY directly

# Lambda + infra
npm run lambda:deploy

# Editor static build → S3
npm run build
aws s3 sync dist/ s3://drawbang-assets/public/ --delete \
  --exclude "*.html" --cache-control "public,max-age=31536000,immutable"
# HTML entries get a short cache so we can re-deploy quickly
for html in dist/*.html; do
  aws s3 cp "$html" "s3://drawbang-assets/public/$(basename "$html")" \
    --cache-control "public,max-age=60,must-revalidate"
done

# Builder run + CloudFront invalidation
DRAWBANG_S3_BUCKET=drawbang-assets npm run builder
aws cloudfront create-invalidation --distribution-id <cf-id> --paths "/*"
```

The first-ever deploy on a fresh AWS account also needs the IAM
permissions listed in `CLAUDE.md` (search for "AWS deployment").

## Project structure

```
config/             Shared constants + PoW difficulty + product catalog
  constants.ts      WIDTH, HEIGHT, MAX_FRAMES, PER_PAGE, …
  merch.json        Tee / mug / sticker variants, prices, blueprints
  mockups.json      Static mockup PNG paths + placeholder rects
src/                Vite editor (browser TS)
  editor/           bitmap, canvas, tools, history, palette, gif
  pow.ts, pow.worker.ts
  share.ts, submit.ts, local.ts, main.ts
  merch.ts, merch-preview.ts, share-page.ts, order.ts
ingest/             Ingest Lambda + dev shim
builder/            Daily batch job; renders static HTML
  templates/        Page render functions (drawing, gallery, owner, products, feed)
merch/              Merch Lambda
  printify.ts       Printify HTTP client (retries, slow-retry on 8502)
  brand-logo.ts     Inside-neck DRAW! wordmark generator
  upscale.ts        Bitmap → SVG (uploaded as the print asset)
  dispatch.ts       Order placement pipeline
  orders.ts         DynamoDB orders store
  stripe.ts, webhook.ts, lambda.ts
infra/aws/          SAM template + esbuild bundler
.github/workflows/  CI / deploy
test/               node:test suites (no test framework dependency)
scripts/            Operator scripts (smoke tests, mockup fetch, …)
legacy/             Archived Ruby+Sinatra prototype, never imported
```

## Where to read next

- **`CLAUDE.md`** — design invariants, the GIF format we ship, the PoW
  contract, deployment shape, conventions. Read this before changing
  anything in `ingest/`, `builder/`, or `src/editor/`.
- **`HANDOFF.md`** — short-lived notes for in-flight work between
  sessions. May or may not exist.
- **`.github/workflows/deploy.yml`** — the canonical deploy script;
  manual deploys mirror its steps.

## Conventions

- **TypeScript strict.** Don't loosen `tsconfig.json` without a reason.
- **No comments explaining *what* the code does** — only *why*, and only
  when non-obvious.
- **Tests use `node:test` + `tsx`**, no Jest / Vitest dependency.
- **Storage operations go through the `Storage` interface** so
  `FsStorage` (dev/tests) and `S3Storage` (Lambda/builder) stay
  interchangeable.
- **Merge directly to `master`** when typecheck + tests pass. The deploy
  workflow runs on every push to `master`. No long-lived feature
  branches.

## Troubleshooting

- **`tsc` fails after `npm install`**: delete `node_modules` and
  `package-lock.json`, re-run `npm install`. Old optional deps
  (`@types/...`) sometimes get pinned wrong on minor Node version
  bumps.
- **`npm test` hangs on the ingest tests**: those are doing real
  PoW. They're slow on purpose. Use the focused test list above for
  iteration.
- **`sam deploy` fails with "stack does not exist"**: first deploy
  needs `--guided` once. Re-run as `cd infra/aws && sam deploy
  --guided`.
- **Editor loads but `/merch` or `/share` show "missing drawing id"**:
  expected — those pages need a real `?d=<sha256-hex>` query. Open the
  editor, draw something, hit "publish to gallery" first.
