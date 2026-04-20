/// <reference types="@cloudflare/workers-types" />
import { R2Storage } from "./r2-storage.js";
import { build } from "../builder/build.js";
import dayGalleryTpl from "../builder/templates/day-gallery.mustache";
import drawingTpl from "../builder/templates/drawing.mustache";
import indexTpl from "../builder/templates/index.mustache";
import feedTpl from "../builder/templates/feed.mustache";

export interface Env {
  BUCKET: R2Bucket;
  PUBLIC_BASE_URL: string;
  BUILD_SECRET?: string;
}

const TEMPLATES = {
  dayGallery: dayGalleryTpl,
  drawing: drawingTpl,
  index: indexTpl,
  feed: feedTpl,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/_build") {
      const secret = url.searchParams.get("secret");
      if (!env.BUILD_SECRET || secret !== env.BUILD_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const force = url.searchParams.get("force") === "1";
      const result = await runBuild(env, force);
      return Response.json(result);
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runBuild(env));
  },
};

async function runBuild(env: Env, forceRerender = false): Promise<{ sweptDrawings: number; touchedDays: string[] }> {
  const result = await build({
    storage: new R2Storage(env.BUCKET),
    publicBaseUrl: env.PUBLIC_BASE_URL,
    templates: TEMPLATES,
    logger: (m) => console.log(m),
    forceRerender,
  });
  console.log(
    `swept ${result.sweptDrawings} drawings, touched days: ${result.touchedDays.join(", ") || "(none)"}`,
  );
  return result;
}
