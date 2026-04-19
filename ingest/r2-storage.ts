/// <reference types="@cloudflare/workers-types" />
import type { Storage } from "./storage.js";

// Cloudflare R2-backed Storage. Mirrors FsStorage's semantics so the
// handler/builder can run unchanged against either backend.
export class R2Storage implements Storage {
  constructor(private readonly bucket: R2Bucket) {}

  async putIfAbsent(
    key: string,
    bytes: Buffer | Uint8Array,
    contentType: string,
  ): Promise<boolean> {
    if (await this.exists(key)) return false;
    await this.put(key, bytes, contentType);
    return true;
  }

  async put(key: string, bytes: Buffer | Uint8Array, contentType: string): Promise<void> {
    await this.bucket.put(key, asUint8(bytes), {
      httpMetadata: { contentType },
    });
  }

  async getJSON<T>(key: string): Promise<T | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return (await obj.json()) as T;
  }

  async exists(key: string): Promise<boolean> {
    const head = await this.bucket.head(key);
    return head !== null;
  }

  // R2 list is flat; we use delimiter="/" so the result matches what readdir
  // would return — direct children only, with trailing slashes stripped.
  async listPrefix(prefix: string): Promise<string[]> {
    const normalized = prefix.endsWith("/") ? prefix : prefix + "/";
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({
        prefix: normalized,
        delimiter: "/",
        cursor,
        limit: 1000,
      });
      for (const obj of page.objects) out.push(obj.key);
      for (const dir of page.delimitedPrefixes) out.push(dir.replace(/\/$/, ""));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}

function asUint8(b: Buffer | Uint8Array): Uint8Array {
  return b instanceof Uint8Array ? b : new Uint8Array(b);
}
