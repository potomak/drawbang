/// <reference types="@cloudflare/workers-types" />

interface Env {
  BUCKET: R2Bucket;
}

// Serves everything the daily builder writes under `public/` in R2. Paths that
// don't map to R2 fall through to the editor's static assets (dist/), which
// is how `/`, `/assets/*`, etc. get served.
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const pathname = url.pathname;
  const key = r2KeyFor(pathname);
  if (!key) return context.next();

  const obj = await context.env.BUCKET.get(key);
  if (!obj) return context.next();

  const contentType = obj.httpMetadata?.contentType ?? "application/octet-stream";
  const cacheControl = pathname.startsWith("/drawings/")
    ? "public, max-age=31536000, immutable"
    : "public, max-age=60";
  return new Response(obj.body, {
    headers: { "Content-Type": contentType, "Cache-Control": cacheControl },
  });
};

function r2KeyFor(pathname: string): string | null {
  if (pathname === "/gallery") return "public/index.html";
  if (pathname === "/feed.rss") return "public/feed.rss";
  if (pathname.startsWith("/drawings/")) return `public${pathname}`;
  if (pathname.startsWith("/d/")) return `public${pathname}.html`;
  if (pathname.startsWith("/days/")) return `public${pathname}.html`;
  return null;
}
