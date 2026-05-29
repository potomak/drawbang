// One-shot: backfill drawbang-drawings from the legacy inbox/days indexes.
//
// Reads every public/days/<YYYY-MM-DD>/index.jsonl from S3, decodes each tile
// gif to recover its size + frame count, and PutItem-s a DrawingRow into
// drawbang-drawings. The drawing id is content-addressed
// (sha256(gif_bytes)), so the script is idempotent: re-running it overwrites
// each row with the same content. Skips drawings that already exist in DDB
// when --skip-existing is passed.
//
// Usage (run from your dev machine with prod AWS creds):
//   AWS_REGION=us-east-1 \
//   DRAWBANG_BUCKET=drawbang-assets \
//   DRAWBANG_DRAWINGS_TABLE=drawbang-drawings \
//   npx tsx scripts/migrate-tiles.ts [--dry-run] [--skip-existing]

import { S3Storage } from "../ingest/s3-storage.js";
import {
  DynamoDrawingStore,
  type DrawingRow,
} from "../ingest/drawing-store.js";
import { decodeGif } from "../src/editor/gif.js";

interface InboxRow {
  id: string;
  created_at: string;
  parent: string | null;
  user_id: string | null;
  username: string | null;
}

const bucket = required("DRAWBANG_BUCKET");
const drawingsTable = required("DRAWBANG_DRAWINGS_TABLE");
const dryRun = process.argv.includes("--dry-run");
const skipExisting = process.argv.includes("--skip-existing");

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

const storage = new S3Storage({ bucket });
const store = new DynamoDrawingStore({ tableName: drawingsTable });

async function main(): Promise<void> {
  console.log(`s3://${bucket} → ${drawingsTable}${dryRun ? " (DRY RUN)" : ""}`);

  // Walk every day partition.
  const dayKeys = await storage.listPrefix("public/days");
  const days = [
    ...new Set(
      dayKeys
        .map((k) => k.split("/").pop()!)
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
    ),
  ].sort();
  console.log(`found ${days.length} day partitions`);

  let written = 0;
  let skipped = 0;
  let failed = 0;
  for (const day of days) {
    const indexBytes = await storage.getBytes(
      `public/days/${day}/index.jsonl`,
    );
    if (!indexBytes) {
      console.log(`  ${day}: no index.jsonl, skipping`);
      continue;
    }
    const text = new TextDecoder().decode(indexBytes);
    const rows: InboxRow[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        rows.push(JSON.parse(t) as InboxRow);
      } catch (e) {
        console.warn(`  ${day}: skip malformed jsonl row: ${(e as Error).message}`);
      }
    }
    console.log(`  ${day}: ${rows.length} drawings`);

    for (const row of rows) {
      if (!/^[0-9a-f]{64}$/.test(row.id)) {
        console.warn(`    skip ${row.id}: not 64-hex`);
        failed++;
        continue;
      }
      if (!row.user_id || !row.username) {
        // Legacy anonymous (pre-account) drawings. The dynamic gallery
        // assumes a username for the /u/<username> link and as the GSI2
        // partition key. Skip them — they remain reachable via S3 if
        // anyone has a direct /t/<id> bookmark and we still 301 it.
        console.warn(`    skip ${row.id.slice(0, 8)}: legacy anonymous (no username)`);
        skipped++;
        continue;
      }
      if (skipExisting) {
        const existing = await store.get(row.id);
        if (existing) {
          skipped++;
          continue;
        }
      }
      const gif = await storage.getBytes(`public/tiles/${row.id}.gif`);
      if (!gif) {
        console.warn(`    skip ${row.id.slice(0, 8)}: gif missing in /tiles`);
        failed++;
        continue;
      }
      let size = 16;
      let frames = 1;
      try {
        const decoded = decodeGif(gif);
        size = decoded.size;
        frames = decoded.frames.length;
      } catch (e) {
        console.warn(`    decode ${row.id.slice(0, 8)} failed: ${(e as Error).message}`);
        failed++;
        continue;
      }
      const created_at_ms = Date.parse(row.created_at);
      if (!Number.isFinite(created_at_ms)) {
        console.warn(`    skip ${row.id.slice(0, 8)}: bad created_at`);
        failed++;
        continue;
      }
      const ddbRow: DrawingRow = {
        drawing_id: row.id,
        size,
        created_at: row.created_at,
        created_at_ms,
        user_id: row.user_id,
        username: row.username,
        parent_id: row.parent,
        frames,
        gif_size_bytes: gif.length,
      };
      if (dryRun) {
        console.log(`    DRY: ${row.id.slice(0, 8)} → ${row.username} (${size}x${size}, ${frames}f, ${gif.length}b)`);
      } else {
        await store.put(ddbRow);
      }
      written++;
    }
  }
  console.log(`done. wrote ${written}, skipped ${skipped}, failed ${failed}`);
}

void main();
