import { hashHex } from "./pow.js";

// Drawbang ownership identity. Ed25519 keypair generated client-side via Web
// Crypto. The drawing id (sha256 of the gif bytes, hex-encoded) is what gets
// signed; the server verifies with the public key alone.
export interface DrawbangIdentity {
  pubKey: CryptoKey;
  secretKey: CryptoKey;
}

export interface ExportedIdentity {
  jwk_public: JsonWebKey;
  jwk_secret: JsonWebKey;
}

const ALG = { name: "Ed25519" } as const;

export async function generateIdentity(): Promise<DrawbangIdentity> {
  const pair = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  return { pubKey: pair.publicKey, secretKey: pair.privateKey };
}

export async function exportIdentity(id: DrawbangIdentity): Promise<ExportedIdentity> {
  const [jwk_public, jwk_secret] = await Promise.all([
    crypto.subtle.exportKey("jwk", id.pubKey),
    crypto.subtle.exportKey("jwk", id.secretKey),
  ]);
  return { jwk_public, jwk_secret };
}

export async function importIdentity(payload: ExportedIdentity): Promise<DrawbangIdentity> {
  const [pubKey, secretKey] = await Promise.all([
    crypto.subtle.importKey("jwk", payload.jwk_public, ALG, true, ["verify"]),
    crypto.subtle.importKey("jwk", payload.jwk_secret, ALG, true, ["sign"]),
  ]);
  return { pubKey, secretKey };
}

export async function pubKeyHex(id: DrawbangIdentity): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", id.pubKey);
  return hashHex(new Uint8Array(raw));
}

export async function signDrawingId(
  id: DrawbangIdentity,
  drawingIdHex: string,
): Promise<string> {
  const bytes = bytesFromHex(drawingIdHex);
  const sig = await crypto.subtle.sign(ALG, id.secretKey, bytes as BufferSource);
  return hashHex(new Uint8Array(sig));
}

export async function verifyDrawingId(
  pubKeyHexStr: string,
  drawingIdHex: string,
  sigHex: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(pubKeyHexStr)) return false;
  if (!/^[0-9a-f]{64}$/.test(drawingIdHex)) return false;
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return false;
  const pubKey = await crypto.subtle.importKey(
    "raw",
    bytesFromHex(pubKeyHexStr) as BufferSource,
    ALG,
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    ALG,
    pubKey,
    bytesFromHex(sigHex) as BufferSource,
    bytesFromHex(drawingIdHex) as BufferSource,
  );
}

export function bytesFromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("bytesFromHex: odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`bytesFromHex: bad byte at ${i}`);
    out[i] = byte;
  }
  return out;
}
