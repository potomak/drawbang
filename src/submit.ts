import { MAX_LAYERS_JSON_BYTES } from "../config/constants.js";
import { authHeader, getSession } from "./auth.js";

export { MAX_LAYERS_JSON_BYTES };

export interface IngestResponse {
  id: string;
  share_url: string;
}

// Per-frame, per-layer pixel data + layer metadata. Optional sidecar to
// the GIF: the published artifact is still the content-addressed gif
// bytes, but the server records the layer hierarchy alongside the row
// so future "fork & edit layers" flows can rehydrate the editor state.
export interface LayersPayloadLayer {
  name: string;
  visible: boolean;
}

export interface LayersPayload {
  v: 1;
  // Ordered bottom→top; aligns 1:1 with each frame's per-layer slot.
  layers: LayersPayloadLayer[];
  // frames[frameIdx][layerIdx] is base64(Uint8Array) of that bitmap.
  frames: string[][];
}

export interface SubmitOptions {
  ingestUrl: string;
  gif: Uint8Array;
  parent?: string;
  prompt?: string;
  // When provided, sent as `layers_json` in the publish body so the
  // server can store the per-layer pixel data on the DrawingRow. Omit
  // for flat (single-layer) drawings to save the byte cost.
  layers?: LayersPayload;
  signal?: AbortSignal;
}

// MAX_LAYERS_JSON_BYTES (config/constants.ts) is the soft cap for the
// layers sidecar. Keeps the publish JSON well under the API Gateway limit
// even at the worst-case canvas size. Anything larger drops the layer
// field client-side (the GIF still publishes).

export class MissingSessionError extends Error {
  constructor() {
    super("sign in to publish");
    this.name = "MissingSessionError";
  }
}

export async function submit(opts: SubmitOptions): Promise<IngestResponse> {
  const session = getSession();
  if (!session) throw new MissingSessionError();

  let layers_json: string | undefined;
  if (opts.layers) {
    const encoded = JSON.stringify(opts.layers);
    // Drop the field rather than reject the publish — the GIF is the
    // canonical artifact; layers are metadata we'd rather lose than
    // block on. The local IndexedDB draft still has everything.
    if (encoded.length <= MAX_LAYERS_JSON_BYTES) layers_json = encoded;
  }

  const res = await fetch(opts.ingestUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({
      gif: base64(opts.gif),
      parent: opts.parent,
      prompt: opts.prompt,
      layers_json,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const bodyText = await res.text();
    let parsed: { error?: string } = {};
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // Non-JSON body — fall through.
    }
    const msg = parsed.error ?? bodyText;
    if (res.status === 401) throw new MissingSessionError();
    throw new Error(`ingest rejected: ${res.status} ${msg}`);
  }
  return (await res.json()) as IngestResponse;
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
