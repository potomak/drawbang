import { authHeader, getSession } from "./auth.js";

export interface IngestResponse {
  id: string;
  share_url: string;
}

export interface SubmitOptions {
  ingestUrl: string;
  gif: Uint8Array;
  parent?: string;
  prompt?: string;
  signal?: AbortSignal;
}

export class MissingSessionError extends Error {
  constructor() {
    super("sign in to publish");
    this.name = "MissingSessionError";
  }
}

export async function submit(opts: SubmitOptions): Promise<IngestResponse> {
  const session = getSession();
  if (!session) throw new MissingSessionError();

  const res = await fetch(opts.ingestUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({
      gif: base64(opts.gif),
      parent: opts.parent,
      prompt: opts.prompt,
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
