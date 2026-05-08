// One-shot read-only probe: hits the catalog endpoints for our 3 blueprints
// and dumps every field that could be a bare-product mockup or a print-area
// rect. Used to decide whether we can drop the magenta-marker workflow in
// favour of canonical Printify catalog imagery.
//
// Run with: PRINTIFY_API_TOKEN=… npx tsx scripts/probe-printify-catalog.ts
//
// Token only needs catalog.read scope; no writes happen.

import merch from "../config/merch.json" with { type: "json" };

interface MerchProduct {
  id: string;
  blueprint_id: number;
  print_provider_id: number;
  variants: { id: number }[];
}

const TOKEN = process.env.PRINTIFY_API_TOKEN;
if (!TOKEN) {
  console.error("error: PRINTIFY_API_TOKEN env var is required");
  process.exit(2);
}

async function get(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await r.text();
  if (!r.ok) {
    return { __error: `HTTP ${r.status}`, body: text.slice(0, 400) };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text.slice(0, 400) };
  }
}

function summariseBlueprint(b: any) {
  return {
    id: b?.id,
    title: b?.title,
    images: Array.isArray(b?.images) ? b.images : "(none)",
    keys: b && typeof b === "object" ? Object.keys(b) : "(not object)",
  };
}

function summariseVariants(v: any, sampleId: number) {
  const list = v?.variants ?? v;
  if (!Array.isArray(list)) return { keys: v && typeof v === "object" ? Object.keys(v) : "(not list)" };
  const sample = list.find((x: any) => x?.id === sampleId) ?? list[0];
  return {
    count: list.length,
    sample_keys: sample ? Object.keys(sample) : "(empty)",
    sample_placeholders: sample?.placeholders,
    sample_options: sample?.options,
    sample_image_fields: sample
      ? Object.fromEntries(
          Object.entries(sample).filter(([k]) =>
            /image|mockup|preview|src|url|photo|render/i.test(k),
          ),
        )
      : {},
  };
}

async function main() {
  for (const product of (merch as { products: MerchProduct[] }).products) {
    console.log(`\n=========== ${product.id} (blueprint ${product.blueprint_id}, provider ${product.print_provider_id}) ===========`);

    const blueprint = await get(
      `https://api.printify.com/v1/catalog/blueprints/${product.blueprint_id}.json`,
    );
    console.log("\n-- /catalog/blueprints/{id}.json --");
    console.log(JSON.stringify(summariseBlueprint(blueprint), null, 2));

    const variants = await get(
      `https://api.printify.com/v1/catalog/blueprints/${product.blueprint_id}/print_providers/${product.print_provider_id}/variants.json`,
    );
    console.log("\n-- /catalog/blueprints/{id}/print_providers/{pid}/variants.json --");
    console.log(JSON.stringify(summariseVariants(variants, product.variants[0].id), null, 2));

    // Speculative: is there an undocumented per-blueprint mockup endpoint?
    const guessUrls = [
      `https://api.printify.com/v1/catalog/blueprints/${product.blueprint_id}/print_providers/${product.print_provider_id}.json`,
      `https://api.printify.com/v1/catalog/blueprints/${product.blueprint_id}/images.json`,
    ];
    for (const u of guessUrls) {
      const body = await get(u);
      console.log(`\n-- ${u.replace("https://api.printify.com", "")} --`);
      const isErr = (body as any)?.__error;
      if (isErr) {
        console.log(`  ${isErr}`);
      } else if (body && typeof body === "object") {
        const top = Object.keys(body as object);
        console.log(`  top keys: ${top.join(", ")}`);
        console.log(JSON.stringify(body, null, 2).slice(0, 1500));
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
