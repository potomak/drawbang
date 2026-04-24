import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { Storage } from "./storage.js";

export interface S3StorageOptions {
  bucket: string;
  client?: S3Client;
  clientConfig?: S3ClientConfig;
}

// S3-backed Storage. Same API surface as FsStorage and R2Storage. Also works
// against Cloudflare R2 via its S3-compatible endpoint by passing an endpoint
// URL + region "auto" in clientConfig.
export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: S3StorageOptions) {
    this.bucket = opts.bucket;
    this.client = opts.client ?? new S3Client(opts.clientConfig ?? {});
  }

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
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: asUint8(bytes),
        ContentType: contentType,
      }),
    );
  }

  async getJSON<T>(key: string): Promise<T | null> {
    const bytes = await this.getBytes(key);
    if (!bytes) return null;
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async listPrefix(prefix: string): Promise<string[]> {
    const normalized = prefix.endsWith("/") ? prefix : prefix + "/";
    const out: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: normalized,
          Delimiter: "/",
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of page.Contents ?? []) if (obj.Key) out.push(obj.Key);
      for (const p of page.CommonPrefixes ?? []) if (p.Prefix) out.push(p.Prefix.replace(/\/$/, ""));
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return out;
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!res.Body) return null;
      const bytes = await res.Body.transformToByteArray();
      return new Uint8Array(bytes);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function asUint8(b: Buffer | Uint8Array): Uint8Array {
  return b instanceof Uint8Array ? b : new Uint8Array(b);
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NoSuchKey" || e.name === "NotFound" || e.$metadata?.httpStatusCode === 404;
}
