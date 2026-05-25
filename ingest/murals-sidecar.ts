import type { Storage } from "./storage.js";
import type { TileMuralMembership } from "../builder/templates/tile-page.js";

// Sidecar storing each tile's mural memberships. Lives next to the gif at
// public/tiles/<id>.murals.json. Attribution is `claimed_by` (`user_id`) +
// `claimed_by_username` — the account that placed this tile in a mural cell.
// See CLAUDE.md's "Drawing's mural memberships live in ..." invariant.
//
// Two consumers:
//   - ingest/handler.ts writes the sidecar in the mural_claim branch.
//   - builder/build.ts + the canvas publish path read it when rendering
//     /t/<id>.html so a re-render doesn't wipe the mural section.

interface MuralsFile {
  tile_id: string;
  murals: TileMuralMembership[];
}

export function muralsFileKey(id: string): string {
  return `public/tiles/${id}.murals.json`;
}

export async function loadMurals(
  storage: Storage,
  id: string,
): Promise<TileMuralMembership[]> {
  const f = await storage.getJSON<MuralsFile>(muralsFileKey(id));
  return f?.murals ?? [];
}

export async function appendMuralMembership(
  storage: Storage,
  id: string,
  entry: TileMuralMembership,
): Promise<TileMuralMembership[]> {
  const existing = await loadMurals(storage, id);
  // De-dupe by (mural_id, x, y) so an idempotent re-publish doesn't grow
  // the list. Last writer wins on claimant attribution (which shouldn't
  // happen given DDB's drawing_id-set constraint, but be defensive).
  const filtered = existing.filter(
    (e) => !(e.id === entry.id && e.x === entry.x && e.y === entry.y),
  );
  filtered.push(entry);
  const payload: MuralsFile = { tile_id: id, murals: filtered };
  await storage.put(
    muralsFileKey(id),
    new TextEncoder().encode(JSON.stringify(payload)),
    "application/json",
    "no-store",
  );
  return filtered;
}
