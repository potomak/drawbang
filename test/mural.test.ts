// End-to-end loop: claim → publish → state → builder render → archive page.
// Uses the in-memory mural store + FsStorage in a tmp dir so the test runs
// without AWS. Targets the same code paths the dev-server hits when
// `npm run dev:all` rebuilds after a publish.

import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import { INITIAL_STATE, requiredBits, solve, solveClaim } from "../src/proof-of-work.js";
import { handleIngest, type IngestRequest } from "../ingest/handler.js";
import { handleMuralClaim, handleMuralState } from "../ingest/mural-handler.js";
import { MemoryMuralStore } from "../ingest/mural-store.js";
import { FsStorage } from "../ingest/storage.js";
import { muralIdForDate } from "../config/murals.js";
import { muralPass } from "../builder/mural-pass.js";

async function tmpStorage(): Promise<FsStorage> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-e2e-"));
  return new FsStorage(root);
}

function makeGif(): Uint8Array {
  const frame = new Bitmap();
  for (let i = 0; i < 16; i++) frame.set(i, i, 4);
  return encodeGif({ frames: [frame], activePalette: DEFAULT_ACTIVE_PALETTE });
}

describe("mural E2E", () => {
  test("claim → publish → state → builder render → archive", async () => {
    const storage = await tmpStorage();
    const muralStore = new MemoryMuralStore();
    const auth = { user_id: "a".repeat(64), username: "alice" };
    const now = new Date("2026-05-13T12:00:00Z");
    const muralId = muralIdForDate(now);

    // 1. Run the builder mural pass once so manifest + registry exist.
    await muralPass({ storage, muralStore, now });
    const beforeArchive = await storage.getBytes("public/murals.html");
    assert.ok(beforeArchive, "archive page should exist after first pass");

    // 2. Claim a tile via the handler.
    const baseline = INITIAL_STATE.last_publish_at;
    const bits = requiredBits(Number.POSITIVE_INFINITY);
    const claimSolve = await solveClaim(
      { muralId, x: 5, y: 12, userId: auth.user_id },
      baseline,
      bits,
    );
    const claimResult = await handleMuralClaim(
      {
        mural_id: muralId,
        x: 5,
        y: 12,
        baseline,
        nonce: claimSolve.nonce,
      },
      {
        storage,
        muralStore,
        publicBaseUrl: "https://example.test",
        auth,
        now: () => now,
      },
    );
    assert.equal(claimResult.status, 201);

    // 3. Publish the drawing with mural_claim.
    const gif = makeGif();
    const publishSolve = await solve(gif, baseline, bits);
    const ingestReq: IngestRequest = {
      gif: Buffer.from(gif).toString("base64"),
      nonce: publishSolve.nonce,
      baseline,
      solve_ms: publishSolve.solveMs,
      bench_hps: 10_000,
      mural_claim: { mural_id: muralId, x: 5, y: 12 },
    };
    const publishResult = await handleIngest(ingestReq, {
      storage,
      publicBaseUrl: "https://example.test",
      auth,
      muralStore,
      now: () => now,
    });
    assert.equal(publishResult.status, 202);

    // 4. /mural/{id}/state reflects the publish.
    const stateResult = await handleMuralState(muralId, {
      storage,
      muralStore,
      publicBaseUrl: "https://example.test",
      now: () => now,
    });
    assert.equal(stateResult.status, 200);
    const stateBody = stateResult.body as {
      tiles: Array<{ x: number; y: number; drawing_id?: string }>;
    };
    const tile = stateBody.tiles.find((t) => t.x === 5 && t.y === 12);
    assert.ok(tile?.drawing_id, "tile should have drawing_id after publish");

    // 5. Builder mural pass re-renders the mural page with the new tile.
    const passResult = await muralPass({ storage, muralStore, now });
    assert.equal(passResult.current_mural, muralId);

    const muralPageBytes = await storage.getBytes(
      `public/murals/${muralId}.html`,
    );
    assert.ok(muralPageBytes, "mural page should be rendered");
    const muralPage = new TextDecoder().decode(muralPageBytes);
    if (publishResult.status === 202) {
      assert.match(
        muralPage,
        new RegExp(`/tiles/${publishResult.body.id}.gif`),
        "mural page should contain the published tile's gif",
      );
    }

    // 6. Tile page lists mural membership with attribution.
    if (publishResult.status === 202) {
      const drawingPage = await storage.getBytes(
        `public/t/${publishResult.body.id}.html`,
      );
      assert.ok(drawingPage);
      const html = new TextDecoder().decode(drawingPage);
      assert.match(html, /Murals/);
      assert.match(html, new RegExp(`/murals/${muralId}`));
      assert.match(html, new RegExp(`/u/${auth.username}`));
    }

    // 7. /state/current-mural.json reflects the count.
    const currentState = await storage.getJSON<{
      tiles_published: number;
    }>("public/state/current-mural.json");
    assert.equal(currentState?.tiles_published, 1);

    // 8. Archive page lists the mural.
    const archive = await storage.getBytes("public/murals.html");
    assert.ok(archive);
    const archiveHtml = new TextDecoder().decode(archive);
    assert.match(archiveHtml, new RegExp(`/murals/${muralId}`));
  });
});
