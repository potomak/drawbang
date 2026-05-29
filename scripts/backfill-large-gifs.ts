// One-shot backfill: every tile at public/tiles/<id>.gif needs a 320×320
// annotated sibling at <id>-large.gif (the OG image used by Reddit / X /
// Slack / Discord previews — see commit 956d8d0 and issue #195). Forward-
// only writes from ingest cover new publishes; this script walks S3 once
// to fill in tiles whose -large.gif never landed (migrated rows from
// scripts/migrate-tiles.ts + scripts/recover-missing-tiles.ts, plus any
// publish-time failures the try/catch silently swallowed).
//
// Idempotent by default: skips any <id>.gif whose <id>-large.gif already
// exists. Pass --force to re-encode and overwrite existing -large.gifs
// (use when the encoder output format changes).
//
// Usage:
//   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_DEFAULT_REGION=us-east-1 \
//   DRAWBANG_S3_BUCKET=drawbang-assets \
//   npx tsx scripts/backfill-large-gifs.ts [--dry-run] [--force] [--concurrency=10]
//
// Existing CloudFront /tiles/* edge caches won't refresh until the
// max-age=31536000 TTL expires; that's acceptable for a one-time cosmetic
// upgrade. New uploads land at fresh keys regardless.

import { S3Storage } from "../ingest/s3-storage.js";
import { decodeGif } from "../src/editor/gif.js";
import { encodeShareGif } from "../src/editor/share-gif.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

const bucket = required("DRAWBANG_S3_BUCKET");
const dryRun = process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const concurrencyArg = process.argv.find((a) => a.startsWith("--concurrency="));
const CONCURRENCY = concurrencyArg
  ? Math.max(1, parseInt(concurrencyArg.split("=")[1], 10))
  : 10;

const storage = new S3Storage({ bucket });

const ID_RE = /^public\/tiles\/([0-9a-f]{64})\.gif$/;

interface Result {
  upscaled: number;
  alreadyHad: number;
  skippedNonId: number;
  failed: number;
}

async function run(): Promise<Result> {
  console.log(
    `[backfill] bucket=${bucket} dryRun=${dryRun} force=${force} concurrency=${CONCURRENCY}`,
  );
  const keys = await storage.listPrefix("public/tiles");
  console.log(`[backfill] listed ${keys.length} keys under public/tiles/`);

  // Original 16×16 (or higher-res) gifs only — skip already-upscaled
  // sidecars and anything that doesn't match the content-addressed name.
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
          const largeKey = `public/tiles/${id}-large.gif`;
          try {
            if (!force && (await storage.exists(largeKey))) {
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
            const large = encodeShareGif({
              frames: decoded.frames,
              activePalette: decoded.activePalette,
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
