import type { Storage } from "./storage.js";
import type { DrawingCanvasMembership } from "../builder/templates/drawing.js";

// Sidecar storing each drawing's canvas memberships. Lives next to the gif
// at public/drawings/<id>.canvases.json. Attribution is `claimed_by` (the
// pubkey that placed this drawing in a canvas tile), NOT the drawing
// author — see CLAUDE.md's "Drawing's canvas memberships live in ..."
// invariant.
//
// Two consumers:
//   - ingest/handler.ts writes the sidecar in the canvas_claim branch.
//   - builder/build.ts reads it when rendering /d/<id>.html so a forced
//     re-render doesn't wipe the canvas section that ingest set on publish.

interface CanvasesFile {
  drawing_id: string;
  canvases: DrawingCanvasMembership[];
}

export function canvasesFileKey(id: string): string {
  return `public/drawings/${id}.canvases.json`;
}

export async function loadCanvases(
  storage: Storage,
  id: string,
): Promise<DrawingCanvasMembership[]> {
  const f = await storage.getJSON<CanvasesFile>(canvasesFileKey(id));
  return f?.canvases ?? [];
}

export async function appendCanvasMembership(
  storage: Storage,
  id: string,
  entry: DrawingCanvasMembership,
): Promise<DrawingCanvasMembership[]> {
  const existing = await loadCanvases(storage, id);
  // De-dupe by (canvas_id, x, y) so an idempotent re-publish doesn't grow
  // the list. Last writer wins on claimant attribution (which shouldn't
  // happen given DDB's drawing_id-set constraint, but be defensive).
  const filtered = existing.filter(
    (e) => !(e.id === entry.id && e.x === entry.x && e.y === entry.y),
  );
  filtered.push(entry);
  const payload: CanvasesFile = { drawing_id: id, canvases: filtered };
  await storage.put(
    canvasesFileKey(id),
    new TextEncoder().encode(JSON.stringify(payload)),
    "application/json",
    "no-store",
  );
  return filtered;
}
