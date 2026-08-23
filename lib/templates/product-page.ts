import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { esc } from "./_escape.js";
import { renderHtmlShell } from "./_html-shell.js";
import { assetUrl } from "../../src/layout/asset-version.js";

export interface ProductPageView {
  drawing_id: string;
  drawing_id_short: string;
  product_id: string;
  product_name: string;
  // Full product variant list — template derives pills from it.
  variants: ReadonlyArray<{
    id: number;
    size?: string;
    color?: string;
    base_cost_cents: number;
    retail_cents: number;
  }>;
  default_variant_id: number;
  /** Zero-based frame index selected via ?frame= */
  selected_frame: number;
  price_dollars: string;
  shipping_dollars: string;
  total_dollars: string;
  shipping_cents: number;
  repo_url: string;
  public_base_url: string;
}

function uniqueAxisValues(
  variants: ReadonlyArray<{ size?: string; color?: string }>,
  axis: "size" | "color"
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of variants) {
    const val = v[axis];
    if (val && !seen.has(val)) {
      seen.add(val);
      out.push(val);
    }
  }
  return out;
}

function findDefaultVariant(
  variants: ReadonlyArray<{ id: number; size?: string; color?: string; retail_cents: number }>,
  defaultId: number
) {
  return variants.find((v) => v.id === defaultId) ?? variants[0] ?? null;
}

export default function renderProductPage(v: ProductPageView): string {
  const defaultVariant = findDefaultVariant(v.variants, v.default_variant_id);
  const sizes = uniqueAxisValues(v.variants, "size");
  const colors = uniqueAxisValues(v.variants, "color");
  const showSize = sizes.length > 1;
  const showColor = colors.length > 1;
  const sizeSection = showSize
    ? `      <section class="pp-step" id="pp-step-size">
        <h2 class="pp-step-h">Size</h2>
        <div id="pp-size-picker" class="mc-pills" data-testid="size-picker">
${sizes
  .map(
    (s) =>
      `          <button type="button" class="btn sm" data-axis="size" data-value="${esc(s)}" aria-pressed="${s === defaultVariant?.size ? "true" : "false"}">${esc(s)}</button>`
  )
  .join("\n")}
        </div>
      </section>`
    : "";
  const colorSection = showColor
    ? `      <section class="pp-step" id="pp-step-color">
        <h2 class="pp-step-h">Color</h2>
        <div id="pp-color-picker" class="mc-pills" data-testid="color-picker">
${colors
  .map(
    (c) =>
      `          <button type="button" class="btn sm" data-axis="color" data-value="${esc(c)}" aria-pressed="${c === defaultVariant?.color ? "true" : "false"}">${esc(c)}</button>`
  )
  .join("\n")}
        </div>
      </section>`
    : "";

  const variantJson = JSON.stringify(v.variants);
  const ogImage = `${esc(v.public_base_url)}/tiles/${esc(v.drawing_id)}.gif`;
  const ogUrl = `${esc(v.public_base_url)}/products/${esc(v.drawing_id)}/${esc(v.product_id)}`;
  const extraHead = `<meta property="og:type" content="product" />
    <meta property="og:title" content="${esc(v.product_name)} — Draw!" />
    <meta property="og:url" content="${ogUrl}" />
    <meta property="og:image" content="${ogImage}" />
    <link rel="canonical" href="${ogUrl}" />`;

  return renderHtmlShell({
    title: `Draw! · ${esc(v.product_name)} · ${esc(v.drawing_id_short)}`,
    extraHead,
    body: `    ${renderHeader({ active: "products" })}
    <main id="product-page" data-drawing-id="${esc(v.drawing_id)}" data-product-id="${esc(v.product_id)}" data-variant-id="${esc(v.default_variant_id)}" data-frame="${esc(v.selected_frame)}" data-variants='${esc(variantJson)}' data-shipping-cents="${esc(v.shipping_cents)}">
      <a class="pp-back" href="/d/${esc(v.drawing_id)}">← Back to drawing</a>
      <div class="pp-grid">
        <div class="pp-media">
          <canvas id="pp-preview" aria-label="drawing preview" width="320" height="320"></canvas>
          <div id="pp-mockup" class="pp-mockup-wrap">
            <canvas id="pp-mockup-canvas" aria-label="${esc(v.product_name)} mockup"></canvas>
          </div>
        </div>
        <div class="pp-config">
          <h1 class="page-title">${esc(v.product_name)}</h1>
          <p class="pp-drawing">Drawing <a href="/d/${esc(v.drawing_id)}">${esc(v.drawing_id_short)}</a> · frame ${esc(v.selected_frame)}</p>
${sizeSection}
${colorSection}
          <section class="pp-price" id="pp-price" data-testid="price">
            <div class="mc-summary-row"><span>Price</span><span id="pp-price-value">$${esc(v.price_dollars)}</span></div>
            <div class="mc-summary-row"><span>Shipping</span><span id="pp-shipping-value">${v.shipping_cents > 0 ? `$${esc(v.shipping_dollars)}` : "Free"}</span></div>
            <div class="mc-summary-row total"><span>Total</span><span id="pp-total-value">$${esc(v.total_dollars)}</span></div>
          </section>
          <button id="pp-add" class="btn primary full" type="button" data-testid="add-to-checkout" data-variant-id="${esc(v.default_variant_id)}">Continue to checkout</button>
          <p class="mc-disclaim">Printed on demand · ships in 5–7 days</p>
          <p id="pp-status" class="merch-status" role="status"></p>
        </div>
      </div>
    </main>
    ${renderFooter({ active: "products", repoUrl: v.repo_url })}
    <script type="module" src="${assetUrl("/src/product.ts")}"></script>`,
  });
}
