import { contentHashHex } from "../src/content-hash.js";
import renderTilePage from "../builder/templates/tile-page.js";
import { decodeGif } from "../src/editor/gif.js";
import { encodeShareGif } from "../src/editor/share-gif.js";
import { validateGif } from "./gif-validate.js";
import type { Storage } from "./storage.js";
import type { UserStatsStore } from "./user-stats-store.js";

// The authenticated publisher, derived from the verified session JWT by the
// route (lambda.ts / dev-server.ts). The request body never carries identity.
export interface AuthedUser {
  user_id: string; // 64-hex stable account id
  username: string; // public handle, used in /u/<username>
}

export interface IngestRequest {
  gif: string; // base64
  parent?: string;
}

export interface IngestSuccess {
  status: 200 | 202;
  body: {
    id: string;
    share_url: string;
  };
}
export interface IngestError {
  status: 400;
  body: { error: string };
}
export type IngestHandlerResult = IngestSuccess | IngestError;

export interface HandlerConfig {
  storage: Storage;
  publicBaseUrl: string; // e.g. https://drawbang.example
  // Authenticated publisher (from the verified session JWT). The route
  // returns 401 before reaching here when the token is missing/invalid.
  auth: AuthedUser;
  repoUrl?: string;
  now?: () => Date;
  // Per-pubkey streak / total counters (#115, #116). Optional so dev/tests
  // can omit it; when absent the publish proceeds without bumping counters.
  userStatsStore?: UserStatsStore;
}

export interface ChildEntry {
  id: string;
  id_short: string;
  user_id: string;
  username: string;
  created_at: string;
}

interface ChildrenFile {
  drawing_id: string;
  children: ChildEntry[];
}

function childrenFileKey(id: string): string {
  return `public/tiles/${id}.children.json`;
}

async function loadChildren(
  storage: Storage,
  id: string,
): Promise<ChildEntry[]> {
  const f = await storage.getJSON<ChildrenFile>(childrenFileKey(id));
  return f?.children ?? [];
}

async function appendChild(
  storage: Storage,
  parentId: string,
  entry: ChildEntry,
): Promise<ChildEntry[]> {
  const existing = await loadChildren(storage, parentId);
  // De-dupe by child id so a re-publish of the same fork doesn't grow the
  // parent's list. The drawing id is content-addressed, so byte-identical
  // re-forks collapse onto one entry.
  const filtered = existing.filter((e) => e.id !== entry.id);
  filtered.push(entry);
  const payload: ChildrenFile = { drawing_id: parentId, children: filtered };
  await storage.put(
    childrenFileKey(parentId),
    new TextEncoder().encode(JSON.stringify(payload)),
    "application/json",
    "no-store",
  );
  return filtered;
}

export async function handleIngest(req: IngestRequest, cfg: HandlerConfig): Promise<IngestHandlerResult> {
  const now = cfg.now ? cfg.now() : new Date();
  const nowISO = now.toISOString();
  const shareUrlFor = (id: string): string => `${cfg.publicBaseUrl}/t/${id}`;

  // -- 1. Parse gif from base64 and validate structure -----------------------
  let gif: Uint8Array;
  try {
    gif = base64Decode(req.gif);
  } catch (err) {
    return err400(`bad base64: ${errMsg(err)}`);
  }
  try {
    validateGif(gif);
  } catch (err) {
    return err400(`invalid gif: ${errMsg(err)}`);
  }

  // -- 2. Content-addressed id -----------------------------------------------
  // id is derived from the gif bytes alone: same drawing => same id.
  const id = await contentHashHex(gif);
  const author = cfg.auth;

  // -- 3. Idempotency check --------------------------------------------------
  const day = nowISO.slice(0, 10);
  const gifKey = `inbox/${day}/${id}.gif`;
  const jsonKey = `inbox/${day}/${id}.json`;
  const publishedKey = `public/tiles/${id}.gif`;

  const alreadyHere =
    (await cfg.storage.exists(publishedKey)) ||
    (await cfg.storage.exists(gifKey));

  if (alreadyHere) {
    return {
      status: 200,
      body: { id, share_url: shareUrlFor(id) },
    };
  }

  // -- 4. Persist gif + sidecar ----------------------------------------------
  const enc = new TextEncoder();
  const metadata = {
    id,
    created_at: nowISO,
    parent: req.parent ?? null,
    user_id: author.user_id,
    username: author.username,
  };
  await Promise.all([
    cfg.storage.put(gifKey, gif, "image/gif"),
    cfg.storage.put(
      jsonKey,
      enc.encode(JSON.stringify(metadata)),
      "application/json",
    ),
    cfg.storage.put(
      publishedKey,
      gif,
      "image/gif",
      "public, max-age=31536000, immutable",
    ),
  ]);

  // 320×320 annotated share image written next to the original at
  // public/tiles/<id>-large.gif. Used as og:image on the tile page.
  // Wrapped in try/catch — the original gif is already committed and a
  // share-image failure must not surface as a publish error.
  try {
    const decoded = decodeGif(gif);
    if (!decoded.activePalette) {
      throw new Error("decoded gif has no active palette");
    }
    const large = encodeShareGif({
      frames: decoded.frames,
      activePalette: decoded.activePalette,
      delayMs: decoded.delayMs,
    });
    await cfg.storage.put(
      `public/tiles/${id}-large.gif`,
      large,
      "image/gif",
      "public, max-age=31536000, immutable",
    );
  } catch (e) {
    console.error("[ingest] failed to write 320x320 og gif", e);
  }

  // Streak / total counters (#115). Wrapped in try/catch because the gif
  // has already been persisted and a stats failure must not surface as a
  // publish failure.
  if (cfg.userStatsStore) {
    try {
      await cfg.userStatsStore.recordDailyDrawing({
        user_id: author.user_id,
        date_utc: nowISO.slice(0, 10),
        now_iso: nowISO,
      });
    } catch (e) {
      console.error("[ingest] failed to record daily drawing stats", e);
    }
  }

  // -- 4b. Fork lineage: append this drawing to the parent's children list.
  if (
    typeof req.parent === "string" &&
    /^[0-9a-f]{64}$/.test(req.parent) &&
    req.parent !== id
  ) {
    await appendChild(cfg.storage, req.parent, {
      id,
      id_short: id.slice(0, 8),
      user_id: author.user_id,
      username: author.username,
      created_at: nowISO,
    });
  }

  // -- 5. Render tile page ---------------------------------------------------
  const tileHtml = renderTilePage({
    tile_id: id,
    id_short: id.slice(0, 8),
    created_at: nowISO,
    parent: req.parent
      ? { parent: req.parent, parent_short: req.parent.slice(0, 8) }
      : null,
    author: { user_id: author.user_id, username: author.username },
    public_base_url: cfg.publicBaseUrl,
    repo_url: cfg.repoUrl ?? "https://github.com/potomak/drawbang",
  });
  await cfg.storage.put(
    `public/t/${id}.html`,
    enc.encode(tileHtml),
    "text/html",
    "public, max-age=60",
  );

  return {
    status: 202,
    body: { id, share_url: shareUrlFor(id) },
  };
}

function err400(message: string): IngestError {
  return { status: 400, body: { error: message } };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function base64Decode(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
