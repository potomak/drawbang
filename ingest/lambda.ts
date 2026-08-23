import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from "aws-lambda";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  encodeShareMp4FromStorage,
  isEncodeShareMp4Event,
  isPostPublishEvent,
  runPostPublish,
  type EncodeShareMp4Event,
  type PostPublishEvent,
  type PostPublishJob,
} from "./handler.js";
import {
  authFromBearer,
  createRoutes,
  dispatch,
  type RouteRequest,
  type RouteResult,
} from "./routes.js";
import { S3Storage } from "./s3-storage.js";
import { DynamoUserStatsStore } from "./user-stats-store.js";
import { DynamoUserStore } from "./user-store.js";
import { DynamoDrawingStore } from "./drawing-store.js";
import { DynamoLikesStore } from "./likes-store.js";
import type { LikesHandlerConfig } from "./likes-handler.js";
import { DynamoBookmarksStore } from "./bookmarks-store.js";
import type { BookmarksHandlerConfig } from "./bookmarks-handler.js";
import { DynamoFollowsStore } from "./follows-store.js";
import type { FollowsHandlerConfig } from "./follows-handler.js";
import type { HydrateHandlerConfig } from "./hydrate-handler.js";
import { CloudFrontInvalidator } from "./cache-invalidation.js";
import { SesEmailSender } from "./email.js";
import { DynamoSubscribersStore } from "./subscribers-store.js";
import { DynamoChallengeStore } from "./challenge-store.js";
import type { SubscribeHandlerConfig } from "./subscribe-handler.js";
import type { AuthHandlerConfig } from "./auth-handler.js";
import type { RenderHandlersConfig } from "./render-handlers.js";
import { ProductCountersStore } from "../merch/product-counters.js";
import type { MerchCatalog } from "../merch/lambda.js";
import merchCatalogJson from "../config/merch.json" with { type: "json" };
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { handleAdminRoute, type AdminHandlerConfig } from "./admin-handler.js";
import { FlagsStore } from "../merch/flags-store.js";
import { OrdersStore } from "../merch/orders.js";
import { logBoot } from "./log-outcome.js";
import { FFMPEG_PATH } from "./share-mp4.js";
import { statSync, constants as fsConstants, accessSync } from "node:fs";

const bucket = required("DRAWBANG_BUCKET");
const publicBaseUrl = required("PUBLIC_BASE_URL");
const repoUrl = required("REPO_URL");
const userStatsTable = required("DRAWBANG_USER_STATS_TABLE");
const usersTable = required("DRAWBANG_USERS_TABLE");
const usernamesTable = required("DRAWBANG_USERNAMES_TABLE");
const drawingsTable = required("DRAWBANG_DRAWINGS_TABLE");
const likesTable = required("DRAWBANG_LIKES_TABLE");
const bookmarksTable = required("DRAWBANG_BOOKMARKS_TABLE");
const followsTable = required("DRAWBANG_FOLLOWS_TABLE");
const subscribersTable = required("DRAWBANG_SUBSCRIBERS_TABLE");
const challengesTable = required("DRAWBANG_CHALLENGES_TABLE");
// Optional: when unset (e.g. local dev), publish skips CF invalidation —
// cached pages refresh at s-maxage instead.
const cfDistributionId = process.env.CF_DISTRIBUTION_ID ?? "";
// /products feeds off this table (drawing_id × product_id → count) which
// the merch dispatch increments on each paid-→-submitted transition.
const productCountersTable =
  process.env.DRAWBANG_PRODUCT_COUNTERS_TABLE ?? "drawbang-product-counters";
const jwtSecret = required("JWT_SECRET");
// Optional: until SES is wired, password-reset emails fail at send time
// (caught + logged in the handler) but the rest of ingest stays up.
const sesFromAddress = process.env.SES_FROM_ADDRESS ?? "";
const flagsTable = process.env.FLAGS_TABLE ?? process.env.DRAWBANG_FLAGS_TABLE ?? "drawbang-flags";
// Comma-separated usernames allowed to view /admin. Empty (the default)
// means nobody can — every /admin request returns 403. Update the value
// via the SAM parameter `AdminUsernames` (GitHub repository variable
// `ADMIN_USERNAMES`); the change takes effect on next deploy.
const adminUsernames = new Set(
  (process.env.ADMIN_USERNAMES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
// Log group queried by the /admin page. Defaults to the conventional
// `/aws/lambda/<function>` location; override via env when the Lambda
// is reused for testing against a different log stream.
const ingestLogGroup = process.env.INGEST_LOG_GROUP ?? "/aws/lambda/drawbang-ingest";

// Reused across invocations in a warm Lambda container. Cold start pays the
// SDK init cost once; subsequent requests reuse the connection pool.
const storage = new S3Storage({ bucket });
const userStatsStore = new DynamoUserStatsStore({
  tableName: userStatsTable,
});
const userStore = new DynamoUserStore({ usersTable, usernamesTable });
const drawingStore = new DynamoDrawingStore({ tableName: drawingsTable });
const likesStore = new DynamoLikesStore({
  likesTable,
  drawingsTable,
});
const likesConfig: LikesHandlerConfig = { likesStore };
const bookmarksStore = new DynamoBookmarksStore({
  bookmarksTable,
  drawingStore,
});
const bookmarksConfig: BookmarksHandlerConfig = { bookmarksStore };
const followsStore = new DynamoFollowsStore({
  followsTable,
  usersTable,
});
const followsConfig: FollowsHandlerConfig = { followsStore, userStore };
const subscribersStore = new DynamoSubscribersStore({
  tableName: subscribersTable,
});
const subscribeConfig: SubscribeHandlerConfig = { subscribersStore };
const hydrateConfig: HydrateHandlerConfig = {
  likesStore,
  bookmarksStore,
  followsStore,
  userStore,
};
const cacheInvalidator = cfDistributionId
  ? new CloudFrontInvalidator({ distributionId: cfDistributionId })
  : undefined;
// Async self-invoke for the deferred post-publish tail (share sidecars +
// CloudFront invalidation). Named explicitly
// (not !GetAtt) to avoid a circular SAM dependency — same pattern as the
// merch function's MERCH_FUNCTION_NAME. The Event-type invoke resolves as
// soon as Lambda queues the payload (a few ms), so awaiting it doesn't
// hold the publish response.
const ingestFunctionName = process.env.INGEST_FUNCTION_NAME ?? "drawbang-ingest";
const lambdaClient = new LambdaClient({});
const deferPostPublish = async (job: PostPublishJob): Promise<void> => {
  const payload: PostPublishEvent = { kind: "post-publish", ...job };
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: ingestFunctionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    })
  );
};
// One cold-start snapshot per container. "Was the ffmpeg binary actually
// present in this container?" was the question that took longest to answer
// during the missing -large.mp4 investigation; it is now one query away.
(() => {
  let present = false;
  let bytes: number | undefined;
  let executable: boolean | undefined;
  try {
    bytes = statSync(FFMPEG_PATH).size;
    present = true;
    try {
      accessSync(FFMPEG_PATH, fsConstants.X_OK);
      executable = true;
    } catch {
      executable = false;
    }
  } catch {
    present = false;
  }
  logBoot({
    function_name: process.env.AWS_LAMBDA_FUNCTION_NAME,
    function_version: process.env.AWS_LAMBDA_FUNCTION_VERSION,
    memory_mb: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE
      ? Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE)
      : undefined,
    node_version: process.version,
    arch: process.arch,
    ffmpeg_path: FFMPEG_PATH,
    ffmpeg_present: present,
    ...(bytes !== undefined ? { ffmpeg_bytes: bytes } : {}),
    ...(executable !== undefined ? { ffmpeg_executable: executable } : {}),
  });
})();

const productCountersStore = new ProductCountersStore({ tableName: productCountersTable });
const merchCatalog = merchCatalogJson as MerchCatalog;
const flagsStore = new FlagsStore({ tableName: flagsTable });
const ordersTable = process.env.ORDERS_TABLE ?? "drawbang-orders";
const ordersStore = new OrdersStore({ tableName: ordersTable });
// Lazily created — both clients are only used by /admin, so cold-start
// for every other route stays cheap. Lambda's container reuse keeps the
// connection pool warm once the first /admin hits.
let adminCfgCache: AdminHandlerConfig | null = null;
function adminCfg(): AdminHandlerConfig {
  if (adminCfgCache) return adminCfgCache;
  adminCfgCache = {
    ddbClient: new DynamoDBClient({}),
    cwLogsClient: new CloudWatchLogsClient({}),
    drawingStore,
    userStore,
    userStatsStore,
    usersTable,
    drawingsTable,
    logGroup: ingestLogGroup,
    flagsStore,
  };
  return adminCfgCache;
}
const renderConfig: RenderHandlersConfig = {
  drawingStore,
  publicBaseUrl,
  repoUrl,
  productCountersSource: { listAll: () => productCountersStore.listAll() },
  merchCatalog,
  userStatsStore,
  userStore,
  bookmarksStore,
  followsStore,
};
const authConfig: AuthHandlerConfig = {
  userStore,
  email: new SesEmailSender({ fromAddress: sesFromAddress }),
  jwtSecret,
  publicBaseUrl,
  drawingStore,
  // Account deletion cascades to the account's drawings + their objects.
  storage,
  cacheInvalidator,
  // Challenge signing keys are derived from JWT_SECRET (domain-separated
  // inside challenge.ts), so there's no extra secret to provision.
  challenge: {
    secret: jwtSecret,
    challengeStore: new DynamoChallengeStore({ tableName: challengesTable }),
  },
};

// The shared route table (ingest/routes.ts) is the single source of truth
// for paths, auth gates, and dispatch — dev-server.ts builds the same
// table from Memory*/Fs configs. This file only adapts API Gateway events
// to RouteRequest and RouteResult back to APIGatewayProxyResultV2.
const routes = createRoutes({
  renderConfig,
  likesConfig,
  bookmarksConfig,
  followsConfig,
  hydrateConfig,
  subscribeConfig,
  deleteConfig: { drawingStore, storage, cacheInvalidator },
  backfillConfig: {
    drawingStore,
    storage,
    enqueue: deferPostPublish,
    runNow: (job) =>
      runPostPublish(job, {
        storage,
        cacheInvalidator,
        log: { requestId: `backfill-${job.drawing_id.slice(0, 12)}`, invocation: "inline" },
      }),
  },
  authConfig,
  ingestConfig: {
    storage,
    publicBaseUrl,
    repoUrl,
    userStatsStore,
    drawingStore,
    cacheInvalidator,
    deferPostPublish,
  },
  userStatsStore,
  admin: {
    isAllowed: (username) => adminUsernames.has(username),
    renderData: ({ range, adminUsername }) =>
      handleAdminRoute({ cfg: adminCfg(), range, adminUsername }),
    flagsStore,
    ordersStore,
  },
  repoUrl,
});

export async function handler(
  event: APIGatewayProxyEventV2 | PostPublishEvent | EncodeShareMp4Event,
  context: Context
): Promise<APIGatewayProxyResultV2 | void> {
  // Async self-invoke events carry no requestContext.http, so they must
  // be detected before any HTTP routing touches the event shape.
  if (isPostPublishEvent(event)) {
    await runPostPublish(event, {
      storage,
      cacheInvalidator,
      log: {
        requestId: context?.awsRequestId ?? "async",
        invocation: "async",
        remainingMs: () => context?.getRemainingTimeInMillis?.() ?? -1,
      },
    });
    return;
  }
  // Legacy event kind, still handled so anything queued by the previous
  // version completes across a deploy.
  if (isEncodeShareMp4Event(event)) {
    await encodeShareMp4FromStorage(storage, event.drawing_id);
    return;
  }
  // Normalise HEAD → GET so uptime monitors, link checkers, and the
  // CDN-cache validators that issue HEAD requests don't 404. RFC says a
  // HEAD response MAY include a body but the client MUST ignore it, so
  // returning the GET body here is harmless — and CloudFront knows to
  // strip it before forwarding to the viewer.
  const rawMethod = event.requestContext.http.method;
  const method = rawMethod === "HEAD" ? "GET" : rawMethod;
  const path = event.rawPath ?? event.requestContext.http.path ?? "";

  // Memoized so the Bearer JWT is verified at most once per request even
  // when the matched route and its handler both ask for the session.
  let authMemo: ReturnType<typeof authFromBearer> | undefined;
  const authHeader = () => event.headers?.authorization ?? event.headers?.Authorization ?? null;
  const req: RouteRequest = {
    method,
    path,
    query: (name) => event.queryStringParameters?.[name] ?? null,
    body: async () => rawBody(event),
    auth: () => {
      if (authMemo === undefined) {
        authMemo = authFromBearer(authHeader(), jwtSecret);
      }
      return authMemo;
    },
    hasAuthHeader: () => (authHeader() ?? "").trim().length > 0,
    requestId: event.requestContext.requestId,
    t0: Date.now(),
  };
  return adaptResult(await dispatch(routes, req), event);
}

function adaptResult(result: RouteResult, event: APIGatewayProxyEventV2): APIGatewayProxyResultV2 {
  switch (result.kind) {
    case "render":
      return {
        statusCode: result.response.status,
        headers: {
          "Content-Type": result.response.contentType,
          "Cache-Control": result.response.cacheControl,
        },
        body: result.response.body,
      };
    case "json":
      return {
        statusCode: result.status,
        headers: { "Content-Type": "application/json", ...(result.headers ?? {}) },
        body: JSON.stringify(result.body),
      };
    case "text":
      return {
        statusCode: result.status,
        headers: { "Content-Type": "text/plain" },
        body: result.body,
      };
    case "redirect301": {
      // Preserve any cursor querystring so /gallery/items?cursor=… reaches
      // /feed/items?cursor=… intact.
      const qs = event.rawQueryString;
      const target = qs ? `${result.location}?${qs}` : result.location;
      return {
        statusCode: 301,
        headers: { Location: target, "Cache-Control": "public, max-age=3600" },
        body: "",
      };
    }
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

function rawBody(event: APIGatewayProxyEventV2): string {
  return event.isBase64Encoded && event.body
    ? Buffer.from(event.body, "base64").toString("utf8")
    : (event.body ?? "");
}
