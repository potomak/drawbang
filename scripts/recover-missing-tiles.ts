// One-shot: backfill the 10 tiles that sat in public/tiles/ without ever
// reaching the drawings table. They were published in the window between
// the Phase 3a deploy (dual-write to DDB) and today's parent_id-null fix
// (DynamoDrawingStore.put now strips null before PutItem). The migration
// script reads from public/days/<date>/index.jsonl, which the deleted
// builder never updated for these recent publishes — so they were
// invisible.
//
// We don't have per-tile metadata sidecars for most of them (the inbox
// jsons either never existed or were swept long ago). Use the S3
// LastModified as created_at, hardcode the only-active-account-at-the-time
// (potomak) as the author, and decode the gif for size + frames. The
// canvas.json sitting in inbox/2026-05-28 gives us the one exception
// (drawing 112ba983…) where we know the exact created_at.
//
// Usage:
//   AWS_REGION=us-east-1 DRAWBANG_BUCKET=drawbang-assets \
//   DRAWBANG_DRAWINGS_TABLE=drawbang-drawings \
//   npx tsx scripts/recover-missing-tiles.ts

import { S3Storage } from "../ingest/s3-storage.js";
import { DynamoDrawingStore, type DrawingRow } from "../ingest/drawing-store.js";
import { decodeGif } from "../src/editor/gif.js";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";

const POTOMAK_USER_ID = "6dedb2698b5ba4d9b8c066d7187274f9450c114e6841faea4e4acbd2e9d96c30";
const POTOMAK_USERNAME = "potomak";

// drawing_id, optional override of created_at (from a known sidecar)
const MISSING: Array<[string, string?]> = [
  // The canvas.json in inbox/2026-05-28 gives us this drawing's exact
  // created_at; the others fall back to S3 LastModified.
  ["112ba983a50960541bd0e4bcb98418b1ed825838637be005b54bdd5f4125a016", "2026-05-28T14:16:06.543Z"],
  ["62fbd2dbba9d105c51408ba7847bf41badcba302deb0036f7c0eb8ba6b8499be"],
  ["678757ac43db89181c5b50ec4faff5411fa88e36fc8122e3b10f7514171b05a8"],
  ["7f1e7cb652adc0fd2c59b9ac0a19f1f3eff7987070ae4d4b623a1ffa9c60f28e"],
  ["8690954826cc171940bc03a8347e932287725e312df9359c97a47622ee7e5841"],
  ["a696923cd01b29d3fbccc37316ce3693e932c511f0db6f30787315403c922ceb"],
  ["e249d09eacec12bffdd5a7e5acfd84a6fc775459a78bc68474619db46de56f7d"],
  ["efbbb1fac0664d6e641738635652a86360c167bb5c9970909600bf667b69a1df"],
  ["f12f6f48de0783cdb490cad647924d185d7f3d7ffce23cb96d9ce5409c9c2f69"],
  ["f6eda6da9a44cf73510b56900ee5f402988d4c04ebdb0f12152685837b8d780d"],
];

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

const bucket = required("DRAWBANG_BUCKET");
const drawingsTable = required("DRAWBANG_DRAWINGS_TABLE");

const storage = new S3Storage({ bucket });
const store = new DynamoDrawingStore({ tableName: drawingsTable });
const s3 = new S3Client({});

async function lastModifiedMs(key: string): Promise<number> {
  const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return r.LastModified ? new Date(r.LastModified).getTime() : Date.now();
}

async function main(): Promise<void> {
  let wrote = 0;
  for (const [id, overrideIso] of MISSING) {
    const gif = await storage.getBytes(`public/tiles/${id}.gif`);
    if (!gif) {
      console.warn(`skip ${id.slice(0, 8)}: gif missing`);
      continue;
    }
    const decoded = decodeGif(gif);
    const ms = overrideIso
      ? Date.parse(overrideIso)
      : await lastModifiedMs(`public/tiles/${id}.gif`);
    const iso = new Date(ms).toISOString();
    const row: DrawingRow = {
      drawing_id: id,
      size: decoded.size,
      created_at: iso,
      created_at_ms: ms,
      user_id: POTOMAK_USER_ID,
      username: POTOMAK_USERNAME,
      parent_id: null,
      frames: decoded.frames.length,
      gif_size_bytes: gif.length,
    };
    await store.put(row);
    console.log(`wrote ${id.slice(0, 8)} (${decoded.size}x${decoded.size}, ${decoded.frames.length}f, ${iso})`);
    wrote++;
  }
  console.log(`done. wrote ${wrote}`);
}

void main();
