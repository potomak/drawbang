import { promises as fs } from "node:fs";
import path from "node:path";

export interface Storage {
  putIfAbsent(
    key: string,
    bytes: Buffer | Uint8Array,
    contentType: string,
    cacheControl?: string,
  ): Promise<boolean>;
  put(
    key: string,
    bytes: Buffer | Uint8Array,
    contentType: string,
    cacheControl?: string,
  ): Promise<void>;
  getJSON<T>(key: string): Promise<T | null>;
  exists(key: string): Promise<boolean>;
  listPrefix(prefix: string): Promise<string[]>;
  getBytes(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
}

// Filesystem-backed storage for local dev and for the builder to sweep the
// inbox. Layout mirrors the eventual S3 bucket.
export class FsStorage implements Storage {
  constructor(private readonly root: string) {}

  private full(key: string): string {
    return path.join(this.root, key);
  }

  async putIfAbsent(
    key: string,
    bytes: Buffer | Uint8Array,
    contentType: string,
    cacheControl?: string,
  ): Promise<boolean> {
    if (await this.exists(key)) return false;
    await this.put(key, bytes, contentType, cacheControl);
    return true;
  }

  // FsStorage drops contentType + cacheControl — they're metadata the
  // filesystem doesn't carry. Real HTTP serving happens through S3Storage.
  async put(
    key: string,
    bytes: Buffer | Uint8Array,
    _contentType: string,
    _cacheControl?: string,
  ): Promise<void> {
    const full = this.full(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, bytes);
  }

  async getJSON<T>(key: string): Promise<T | null> {
    try {
      const text = await fs.readFile(this.full(key), "utf8");
      return JSON.parse(text) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.full(key));
      return true;
    } catch {
      return false;
    }
  }

  async listPrefix(prefix: string): Promise<string[]> {
    const full = this.full(prefix);
    try {
      const entries = await fs.readdir(full);
      return entries.map((e) => path.posix.join(prefix, e));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    try {
      return await fs.readFile(this.full(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await fs.unlink(this.full(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
