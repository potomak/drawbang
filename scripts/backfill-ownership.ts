import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  importIdentity,
  pubKeyHex,
  signDrawingId,
  verifyDrawingId,
  type DrawbangIdentity,
} from "../src/identity.js";
import { S3Storage } from "../ingest/s3-storage.js";
import type { Storage } from "../ingest/storage.js";

// Backfill the operator's signature onto every legacy drawing whose
// per-day index.jsonl row is missing a pubkey/signature, so /d/<id> pages
// and /keys/<pk> galleries cover the whole historical corpus uniformly
// after running `DRAWBANG_FORCE_RERENDER=1 npm run builder`.

interface DrawingMetadata {
  id: string;
  pow: string;
  created_at: string;
  required_bits: number;
  solve_ms: number | null;
  bench_hps: number | null;
  parent: string | null;
  pubkey: string | null;
  signature: string | null;
}

export interface BackfillDeps {
  storage: Storage;
  operator: DrawbangIdentity;
  operatorPubHex: string;
  force?: boolean;
  log?: (msg: string) => void;
}

export interface BackfillReport {
  daysScanned: number;
  daysModified: number;
  signedCount: number;
  alreadySignedCount: number;
  foreignSkippedCount: number;
  foreignResignedCount: number;
}

export async function backfillOwnership(deps: BackfillDeps): Promise<BackfillReport> {
  const log = deps.log ?? (() => {});
  const dec = new TextDecoder();
  const enc = new TextEncoder();

  const dayPaths = (await deps.storage.listPrefix("public/days"))
    .map((p) => p.split("/").pop()!)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  const report: BackfillReport = {
    daysScanned: 0,
    daysModified: 0,
    signedCount: 0,
    alreadySignedCount: 0,
    foreignSkippedCount: 0,
    foreignResignedCount: 0,
  };

  for (const day of dayPaths) {
    const indexKey = `public/days/${day}/index.jsonl`;
    const bytes = await deps.storage.getBytes(indexKey);
    if (!bytes || bytes.length === 0) continue;

    report.daysScanned++;
    const lines = dec.decode(bytes).split("\n").filter((l) => l.length > 0);
    const out: string[] = [];
    let modified = false;

    for (const line of lines) {
      let entry: DrawingMetadata;
      try {
        entry = JSON.parse(line) as DrawingMetadata;
      } catch {
        log(`  ${day}: skip unparseable line`);
        out.push(line);
        continue;
      }

      const hasOwner =
        typeof entry.pubkey === "string" && typeof entry.signature === "string";

      if (hasOwner) {
        const valid = await verifyDrawingId(entry.pubkey!, entry.id, entry.signature!);
        if (valid) {
          if (entry.pubkey === deps.operatorPubHex) {
            report.alreadySignedCount++;
          } else {
            // Real-user submission — not ours to overwrite by default.
            if (deps.force) {
              entry.pubkey = deps.operatorPubHex;
              entry.signature = await signDrawingId(deps.operator, entry.id);
              modified = true;
              report.foreignResignedCount++;
              log(`  ${day}: force re-sign ${entry.id.slice(0, 8)} (was foreign)`);
            } else {
              report.foreignSkippedCount++;
            }
          }
          out.push(JSON.stringify(entry));
          continue;
        }

        // Has pubkey + signature but doesn't verify. Could be corruption or a
        // wrong-keypair scenario. Default: warn + leave untouched.
        if (deps.force) {
          entry.pubkey = deps.operatorPubHex;
          entry.signature = await signDrawingId(deps.operator, entry.id);
          modified = true;
          report.foreignResignedCount++;
          log(`  ${day}: force re-sign ${entry.id.slice(0, 8)} (invalid sig)`);
          out.push(JSON.stringify(entry));
        } else {
          log(
            `  ${day}: WARN ${entry.id.slice(0, 8)} has pubkey/signature that does not verify — left untouched (use --force to overwrite)`,
          );
          report.foreignSkippedCount++;
          out.push(line);
        }
        continue;
      }

      // No owner attached — backfill it.
      entry.pubkey = deps.operatorPubHex;
      entry.signature = await signDrawingId(deps.operator, entry.id);
      modified = true;
      report.signedCount++;
      out.push(JSON.stringify(entry));
    }

    if (modified) {
      const merged = out.join("\n") + "\n";
      await deps.storage.put(indexKey, enc.encode(merged), "application/jsonl");
      report.daysModified++;
      log(`  ${day}: rewrote index.jsonl (${out.length} entries)`);
    }
  }

  return report;
}

interface ExportedIdentityFile {
  jwk_public: JsonWebKey;
  jwk_secret: JsonWebKey;
}

export async function loadOperatorIdentity(
  jwkPath: string,
): Promise<{ operator: DrawbangIdentity; operatorPubHex: string }> {
  const raw = await fs.readFile(jwkPath, "utf8");
  const parsed = JSON.parse(raw) as ExportedIdentityFile;
  if (!parsed?.jwk_public || !parsed?.jwk_secret) {
    throw new Error(`${jwkPath} is missing jwk_public or jwk_secret`);
  }
  const operator = await importIdentity({
    jwk_public: parsed.jwk_public,
    jwk_secret: parsed.jwk_secret,
  });
  const operatorPubHex = await pubKeyHex(operator);
  return { operator, operatorPubHex };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "secret-jwk": { type: "string", short: "k" },
      "bucket": { type: "string", short: "b" },
      "force": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (!values["secret-jwk"]) {
    console.error("usage: tsx scripts/backfill-ownership.ts --secret-jwk <path> [--bucket <name>] [--force]");
    process.exit(2);
  }

  const bucket = values.bucket ?? process.env.DRAWBANG_S3_BUCKET;
  if (!bucket) {
    console.error("error: --bucket or DRAWBANG_S3_BUCKET is required");
    process.exit(2);
  }

  const { operator, operatorPubHex } = await loadOperatorIdentity(values["secret-jwk"]);
  console.log(`operator pubkey: ${operatorPubHex}`);
  console.log(`bucket:          ${bucket}`);
  console.log(`force:           ${values.force ? "yes" : "no"}`);

  const storage = new S3Storage({ bucket });
  const report = await backfillOwnership({
    storage,
    operator,
    operatorPubHex,
    force: values.force,
    log: (m) => console.log(m),
  });

  console.log("---");
  console.log(`days scanned:        ${report.daysScanned}`);
  console.log(`days modified:       ${report.daysModified}`);
  console.log(`newly signed:        ${report.signedCount}`);
  console.log(`already operator:    ${report.alreadySignedCount}`);
  console.log(`foreign skipped:     ${report.foreignSkippedCount}`);
  console.log(`foreign re-signed:   ${report.foreignResignedCount}`);
  console.log("");
  console.log(
    `Backfilled ${report.signedCount + report.foreignResignedCount} drawings across ${report.daysModified} days. Now run:`,
  );
  console.log("  DRAWBANG_FORCE_RERENDER=1 npm run builder");
  console.log("to re-render every /d/<id>.html and freshly populate /keys/<pk>.html.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
