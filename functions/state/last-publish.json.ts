/// <reference types="@cloudflare/workers-types" />

interface Env {
  BUCKET: R2Bucket;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const obj = await context.env.BUCKET.get("public/state/last-publish.json");
  const body = obj
    ? await obj.text()
    : JSON.stringify({ last_publish_at: "1970-01-01T00:00:00.000Z", last_difficulty_bits: 20 });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "max-age=5, s-maxage=5",
    },
  });
};
