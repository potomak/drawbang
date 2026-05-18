// One-shot backfill: every drawing in public/drawings/<id>.gif now needs a
// 320×320 sibling at <id>-large.gif (the OG image used by Reddit/X/Slack/
// Discord previews — see commit 956d8d0). Forward-only writes from ingest
// cover new publishes; this script walks S3 once to fill in the historical
// corpus.
//
// Idempotent: skips any <id>.gif whose <id>-large.gif already exists, so
// re-running is safe.
//
// Usage:
//   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_DEFAULT_REGION=us-east-1 \
//   DRAWBANG_S3_BUCKET=drawbang-assets \
//   npx tsx scripts/backfill-large-gifs.ts [--dry-run] [--concurrency=10]
//
// After it finishes the existing CloudFront /drawings/* cache behaviour
// serves the new objects directly — no invalidation needed (each key is
// brand-new, not a replacement).

import { S3Storage } from "../ingest/s3-storage.js";
import { decodeGif } from "../src/editor/gif.js";
import { encodeScaledGif } from "../src/editor/scaled-gif.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

const bucket = required("DRAWBANG_S3_BUCKET");
const dryRun = process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");
const concurrencyArg = process.argv.find((a) => a.startsWith("--concurrency="));
const CONCURRENCY = concurrencyArg
  ? Math.max(1, parseInt(concurrencyArg.split("=")[1], 10))
  : 10;

const storage = new S3Storage({ bucket });

const ID_RE = /^public\/drawings\/([0-9a-f]{64})\.gif$/;

interface Result {
  upscaled: number;
  alreadyHad: number;
  skippedNonId: number;
  failed: number;
}

async function run(): Promise<Result> {
  console.log(
    `[backfill] bucket=${bucket} dryRun=${dryRun} concurrency=${CONCURRENCY}`,
  );
  const keys = await storage.listPrefix("public/drawings");
  console.log(`[backfill] listed ${keys.length} keys under public/drawings/`);

  // Original 16×16 gifs only — skip already-upscaled, sidecars, and any
  // accidentally non-conforming keys.
  const candidates: string[] = [];
  let skippedNonId = 0;
  for (const k of keys) {
    if (!k.endsWith(".gif")) continue;
    if (k.endsWith("-large.gif")) continue;
    if (!ID_RE.test(k)) {
      skippedNonId++;
      continue;
    }
    candidates.push(k);
  }
  console.log(
    `[backfill] ${candidates.length} candidate gifs; ${skippedNonId} keys skipped (non-id path)`,
  );

  const result: Result = {
    upscaled: 0,
    alreadyHad: 0,
    skippedNonId,
    failed: 0,
  };

  let cursor = 0;
  const total = candidates.length;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(
      (async () => {
        while (cursor < total) {
          const my = cursor++;
          const key = candidates[my];
          const id = ID_RE.exec(key)![1];
          const largeKey = `public/drawings/${id}-large.gif`;
          try {
            if (await storage.exists(largeKey)) {
              result.alreadyHad++;
              continue;
            }
            const gif = await storage.getBytes(key);
            if (!gif) {
              console.warn(`[backfill] ${id}: original gif vanished mid-run`);
              result.failed++;
              continue;
            }
            const decoded = decodeGif(gif);
            if (!decoded.activePalette) {
              console.warn(
                `[backfill] ${id}: no DRAWBANG palette extension — skipping`,
              );
              result.failed++;
              continue;
            }
            const large = encodeScaledGif({
              frames: decoded.frames,
              activePalette: decoded.activePalette,
              scale: 20,
              delayMs: decoded.delayMs,
            });
            if (dryRun) {
              result.upscaled++;
              continue;
            }
            await storage.put(
              largeKey,
              large,
              "image/gif",
              "public, max-age=31536000, immutable",
            );
            result.upscaled++;
          } catch (err) {
            console.error(`[backfill] ${id}: ${(err as Error).message ?? err}`);
            result.failed++;
          }
          const processed = result.upscaled + result.alreadyHad + result.failed;
          if (processed % 100 === 0) {
            console.log(
              `[backfill] progress ${processed}/${total} (upscaled=${result.upscaled} already=${result.alreadyHad} failed=${result.failed})`,
            );
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  return result;
}

const t0 = Date.now();
run()
  .then((r) => {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `[backfill] done in ${dt}s — upscaled=${r.upscaled} alreadyHad=${r.alreadyHad} skippedNonId=${r.skippedNonId} failed=${r.failed}${dryRun ? " (DRY RUN — nothing written)" : ""}`,
    );
  })
  .catch((err) => {
    console.error("[backfill] fatal:", err);
    process.exit(1);
  });
