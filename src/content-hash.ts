// Content-addressed identity for drawings: SHA-256 of the bytes, hex-encoded.
// Same input bytes -> same id, regardless of who publishes.

// Node vs browser: Node's sync `crypto.createHash` is faster than the async
// Web Crypto digest for small inputs (no microtask overhead). Load it once
// up front.
const nodeCreateHash: ((buf: Uint8Array) => Uint8Array) | null = (() => {
  if (typeof process !== "undefined" && process.versions?.node) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createHash } = require("node:crypto") as typeof import("node:crypto");
      return (buf: Uint8Array) =>
        new Uint8Array(createHash("sha256").update(buf).digest());
    } catch {
      return null;
    }
  }
  return null;
})();

export async function contentHash(gif: Uint8Array): Promise<Uint8Array> {
  if (nodeCreateHash) return nodeCreateHash(gif);
  const digest = await crypto.subtle.digest("SHA-256", gif as BufferSource);
  return new Uint8Array(digest);
}

export function hashHex(hash: Uint8Array): string {
  let s = "";
  for (let i = 0; i < hash.length; i++) s += hash[i].toString(16).padStart(2, "0");
  return s;
}

export async function contentHashHex(gif: Uint8Array): Promise<string> {
  return hashHex(await contentHash(gif));
}
