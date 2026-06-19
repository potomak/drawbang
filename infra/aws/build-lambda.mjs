import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outDir = path.join(repoRoot, "dist-lambda");

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

// Build-time asset version: bakes DRAWBANG_ASSET_VERSION (the short git SHA
// in CI) into the bundle so the templates' assetUrl() helper appends a
// `?v=<sha>` cache-buster to every script/link tag. Without it the browser
// can hold stale gallery-v2.css / like.js / etc. for up to max-age (5 min)
// after a deploy. CI sets the env before `npm run lambda:build`.
const ASSET_VERSION = process.env.DRAWBANG_ASSET_VERSION || "";

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  // AWS SDK v3 is preinstalled in the Node 22 Lambda runtime, so leave it
  // external and ship only our code + non-AWS deps. Keeps the zip small.
  external: ["@aws-sdk/*"],
  define: {
    "process.env.DRAWBANG_ASSET_VERSION": JSON.stringify(ASSET_VERSION),
  },
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: [path.join(repoRoot, "ingest", "lambda.ts")],
  outfile: path.join(outDir, "lambda.js"),
});

await build({
  ...shared,
  entryPoints: [path.join(repoRoot, "merch", "lambda.ts")],
  outfile: path.join(outDir, "merch.js"),
});

// Ship the arm64 linux ffmpeg binary alongside the handler so
// ingest/share-mp4.ts (which resolves the binary relative to its own
// __dirname) can spawn it at runtime. The @ffmpeg-installer/linux-arm64
// package is a leaf tarball — its install isn't gated by the host
// platform, so CI's x86_64 runner still ends up with the arm64 binary
// Lambda needs.
const require = createRequire(import.meta.url);
const ffmpegBin = require.resolve("@ffmpeg-installer/linux-arm64/ffmpeg");
const ffmpegDst = path.join(outDir, "ffmpeg");
await fs.copyFile(ffmpegBin, ffmpegDst);
await fs.chmod(ffmpegDst, 0o755);
