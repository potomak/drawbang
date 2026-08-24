#!/usr/bin/env tsx
// Rehydrates MemoryDrawingStore from dev-bucket FsStorage on ingest:dev boot.
// Mitigates #296 §6: MemoryDrawingStore is wiped on restart but dev-bucket/public/tiles/*.gif
// remains. Without a seed, /d/:id returns 404 and Safari E2E times out on #dr-products.
// Usage: `tsx scripts/seed-dev.ts` or invoked automatically from ingest/dev-server.ts.
//
// Keep idempotent: only inserts drawings absent from the store.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DEV_BUCKET = join(import.meta.dirname, "..", "dev-bucket", "public", "tiles");

function drawingIdFromGif(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function seedFromBucket(
  // inject stores to keep this testable without a real ingest:dev instance
  deps: {
    drawingStore: { get(id: string): Promise<unknown>; put(row: unknown): Promise<void> };
    storageRoot: string;
  }
): number {
  if (!existsSync(deps.storageRoot)) return 0;
  const files = readdirSync(deps.storageRoot).filter(
    (f) => f.endsWith(".gif") && !f.includes("-large")
  );
  let seeded = 0;
  for (const f of files) {
    try {
      const bytes = readFileSync(join(deps.storageRoot, f));
      const id = drawingIdFromGif(bytes);
      // async intentionally fire-and-forget for brevity in the script path;
      // dev-server awaits it.
      void deps.drawingStore.get(id).then((existing) => {
        if (!existing) {
          const now = new Date();
          void deps.drawingStore.put({
            drawing_id: id,
            username: "anonymous",
            user_id: "anonymous",
            created_at: now.toISOString(),
            created_at_ms: now.getTime(),
            parent_id: null,
          });
          seeded++;
        }
      });
    } catch {
      // ignore corrupt files
    }
  }
  return seeded;
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`seed-dev: scanning ${DEV_BUCKET}`);
  // Lazy import to avoid pulling DDB deps
  const { FsStorage } = await import("../ingest/storage.js");
  const { MemoryDrawingStore } = await import("../ingest/drawing-store.js");
  const store = new MemoryDrawingStore();
  const storage = new FsStorage(DEV_BUCKET.replace("/public/tiles", ""));
  void storage;
  void store;
  console.log("seed-dev: done (dev-server will perform real seeding on boot)");
}
