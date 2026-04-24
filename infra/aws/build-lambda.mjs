import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outDir = path.join(repoRoot, "dist-lambda");

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

await build({
  entryPoints: [path.join(repoRoot, "ingest", "lambda.ts")],
  outfile: path.join(outDir, "lambda.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  // AWS SDK v3 is preinstalled in the Node 22 Lambda runtime, so leave it
  // external and ship only our code + non-AWS deps. Keeps the zip small.
  external: ["@aws-sdk/*"],
  logLevel: "info",
});
