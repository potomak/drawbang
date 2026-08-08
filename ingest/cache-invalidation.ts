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
export function pathsToInvalidateOnPublish(
  // null for an anonymous publish: there is no /u/<username> page to flush,
  // so the profile path is dropped rather than pointed at the sentinel.
  username: string | null,
  opts?: { promptTagged?: boolean },
): string[] {
  const paths = [
    "/",
    "/feed/items*",
    "/gallery*",
    ...(username !== null ? [`/u/${username}*`] : []),
    "/feed.rss",
  ];
  // Prompt pages only churn when the publish actually carried today's tag;
  // untagged publishes keep the path list (and invalidation cost) unchanged.
  if (opts?.promptTagged) paths.push("/prompts*");
  return paths;
}

// Invalidates the profile so an edit (profile picture, bio, link, …)
// appears immediately. Drawing pages absorb profile-picture changes on
// their own s-maxage TTL (we keep that short for the same reason).
export function pathsToInvalidateOnProfileChange(
  username: string,
): string[] {
  return [`/u/${username}*`];
}

// A sidecar backfill doesn't change any page — the drawing was already
// live — so the feed/profile set would be pure waste (and invalidation
// paths cost money past the free tier). What DOES need flushing is the two
// sidecar URLs themselves: they previously 404'd, and the edge may have
// cached that negative response.
export function pathsToInvalidateOnSidecarBackfill(drawing_id: string): string[] {
  return [`/tiles/${drawing_id}-large.gif`, `/tiles/${drawing_id}-large.mp4`];
}

// Deleting a drawing has to flush everywhere it could still be rendered,
// which is the publish set PLUS the drawing's own page — a publish never
// needs `/d/<id>` (the page can't be cached before the id exists), but a
// delete very much does, or the removed drawing keeps serving from the
// edge for up to its s-maxage.
export function pathsToInvalidateOnDelete(
  username: string | null,
  drawing_id: string,
): string[] {
  return [...pathsToInvalidateOnPublish(username), `/d/${drawing_id}*`];
}

// Note on follows: follower_count / following_count on the profile page
// ride the same long CC_PROFILE TTL, but we DON'T invalidate on each
// follow event. Instead `/follows/counts?targets=<csv>` ships fresh
// per-user counts on every page load (no-store), and `/follow.js`
// rewrites the SSR'd numbers from that response — same shape as the
// `/likes/counts` hydration path. That avoids paying for an
// invalidation on every follow click.
