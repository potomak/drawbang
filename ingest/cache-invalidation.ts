import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";

// Fire-and-forget CloudFront invalidation. The publish handler calls this
// after a successful write so the gallery + the author's profile + the
// RSS pick up the new drawing within seconds instead of waiting for
// CloudFront's s-maxage TTL to expire. Failures are logged but do NOT
// surface as publish errors — the row is already in DDB + S3, and the
// next TTL expiry will resync the cache anyway.
//
// Cost: a single CreateInvalidation with N paths counts as N paths against
// the 1000/month free allowance, then $0.005/path. At our publish volume
// we stay deep inside the free tier.

export interface CacheInvalidator {
  invalidate(paths: string[]): Promise<void>;
}

export class CloudFrontInvalidator implements CacheInvalidator {
  private readonly client: CloudFrontClient;
  private readonly distributionId: string;

  constructor(opts: { distributionId: string; client?: CloudFrontClient }) {
    this.client = opts.client ?? new CloudFrontClient({});
    this.distributionId = opts.distributionId;
  }

  async invalidate(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    try {
      await this.client.send(
        new CreateInvalidationCommand({
          DistributionId: this.distributionId,
          InvalidationBatch: {
            CallerReference: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            Paths: { Quantity: paths.length, Items: paths },
          },
        }),
      );
    } catch (e) {
      console.error("[cache] invalidation failed", { paths, err: e });
    }
  }
}

// Test seam: records the paths that would have been invalidated.
export class NoopInvalidator implements CacheInvalidator {
  readonly calls: string[][] = [];
  async invalidate(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    this.calls.push([...paths]);
  }
}

// The set of paths a freshly-published drawing should invalidate. Kept as a
// pure function so tests can pin the exact paths emitted.
export function pathsToInvalidateOnPublish(username: string): string[] {
  return [
    "/",
    "/feed/items*",
    "/gallery*",
    `/u/${username}*`,
    "/feed.rss",
  ];
}

// Invalidates the profile so the new avatar appears immediately. Drawing
// pages absorb the change on their own s-maxage TTL (we keep that short
// for the same reason).
export function pathsToInvalidateOnAvatarChange(username: string): string[] {
  return [`/u/${username}*`];
}
