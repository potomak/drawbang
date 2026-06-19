// One-shot backfill: every drawing at public/tiles/<id>-large.gif needs a
// matching Instagram-shareable <id>-large.mp4 sibling. Forward-only writes
// from ingest cover new publishes; this script walks S3 once to fill in
// drawings whose -large.mp4 never landed (any publish-time ffmpeg failure
// the try/catch silently swallowed, plus the historical fleet from before
// the MP4 sidecar shipped).
//
// Idempotent by default: skips any <id>-large.gif whose <id>-large.mp4
// already exists. Pass --force to re-encode and overwrite (use when the
// encoder args change in a way we want to roll out to history).
//
// Usage:
//   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_DEFAULT_REGION=us-east-1 \
//   DRAWBANG_S3_BUCKET=drawbang-assets \
//   DRAWBANG_FFMPEG_PATH=node_modules/@ffmpeg-installer/linux-arm64/ffmpeg \
//   npx tsx scripts/backfill-share-mp4.ts [--dry-run] [--force] [--concurrency=4]
//
// Concurrency default is lower than the gif backfill because ffmpeg is
// CPU-bound — 4 workers saturate a modest box. Existing CloudFront
// /tiles/* edge caches won't refresh until max-age=31536000 expires;
// that's fine for a one-time fleet-wide sidecar add.

import { S3Storage } from "../ingest/s3-storage.js";
import { encodeShareMp4 } from "../ingest/share-mp4.js";

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
  : 4;

const storage = new S3Storage({ bucket });

const LARGE_GIF_RE = /^public\/tiles\/([0-9a-f]{64})-large\.gif$/;

interface Result {
  encoded: number;
  alreadyHad: number;
  skippedNonId: number;
  failed: number;
}

async function run(): Promise<Result> {
  console.log(
    `[backfill-mp4] bucket=${bucket} dryRun=${dryRun} force=${force} concurrency=${CONCURRENCY}`,
  );
  const keys = await storage.listPrefix("public/tiles");
  console.log(`[backfill-mp4] listed ${keys.length} keys under public/tiles/`);

  // -large.gif sidecars only — those are the inputs to ffmpeg. Skip
  // originals, the new -large.mp4 outputs, and anything off-pattern.
  const candidates: string[] = [];
  let skippedNonId = 0;
  for (const k of keys) {
    if (!k.endsWith("-large.gif")) continue;
    if (!LARGE_GIF_RE.test(k)) {
      skippedNonId++;
      continue;
    }
    candidates.push(k);
  }
  console.log(
    `[backfill-mp4] ${candidates.length} candidate -large.gifs; ${skippedNonId} keys skipped (non-id path)`,
  );

  const result: Result = {
    encoded: 0,
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
          const id = LARGE_GIF_RE.exec(key)![1];
          const mp4Key = `public/tiles/${id}-large.mp4`;
          try {
            if (!force && (await storage.exists(mp4Key))) {
              result.alreadyHad++;
              continue;
            }
            const large = await storage.getBytes(key);
            if (!large) {
              console.warn(`[backfill-mp4] ${id}: -large.gif vanished mid-run`);
              result.failed++;
              continue;
            }
            const mp4 = await encodeShareMp4(large);
            if (dryRun) {
              result.encoded++;
              continue;
            }
            await storage.put(
              mp4Key,
              mp4,
              "video/mp4",
              "public, max-age=31536000, immutable",
            );
            result.encoded++;
          } catch (err) {
            console.error(`[backfill-mp4] ${id}: ${(err as Error).message ?? err}`);
            result.failed++;
          }
          const processed = result.encoded + result.alreadyHad + result.failed;
          if (processed % 50 === 0) {
            console.log(
              `[backfill-mp4] progress ${processed}/${total} (encoded=${result.encoded} already=${result.alreadyHad} failed=${result.failed})`,
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
      `[backfill-mp4] done in ${dt}s — encoded=${r.encoded} alreadyHad=${r.alreadyHad} skippedNonId=${r.skippedNonId} failed=${r.failed}${dryRun ? " (DRY RUN — nothing written)" : ""}`,
    );
  })
  .catch((err) => {
    console.error("[backfill-mp4] fatal:", err);
    process.exit(1);
  });
