import { tracker } from "./analytics/analytics.js";
import { DEFAULT_PLACEMENT, isValidPlacement, type Placement } from "../merch/placement.js";
import { decodeGif } from "./editor/gif.js";
import { activePaletteToRgb } from "./editor/palette.js";
import { loadMockupImage, paintMockupPreview, type MockupConfig } from "./merch-preview.js";
import mockupsConfigImport from "../config/mockups.json";
const mockupsConfig = ((mockupsConfigImport as unknown as { default?: unknown }).default ??
  mockupsConfigImport) as unknown as { products: Record<string, MockupConfig> };

interface MerchVariant {
  id: number;
  size?: string;
  color?: string;
  base_cost_cents: number;
  retail_cents: number;
}

interface MerchProduct {
  id: string;
  name: string;
  blueprint_id?: number;
  print_provider_id?: number;
  print_area_px?: { width: number; height: number };
  shipping_cents: number;
  variants: MerchVariant[];
}

interface MerchCatalog {
  products: MerchProduct[];
}

interface CheckoutResponse {
  order_id: string;
  checkout_url: string;
}

const INGEST_URL =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_INGEST_URL ?? "/ingest";
const API_BASE = INGEST_URL.replace(/\/ingest\/?$/, "");
const DRAWING_BASE_URL =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_DRAWING_BASE_URL ??
  "/tiles";

// ---------------------------------------------------------------------------
// DOM discovery — tolerant of both SSR and SPA shapes. The SSR template
// lib/templates/product-page.ts renders a page with data-product-page and
// JSON in <script id="product-data">. Hydration only needs to bind events.
// If those nodes are absent (SPA fallback / tests) we fetch the catalog.
// ---------------------------------------------------------------------------

function qs<T extends Element>(sel: string): T | null {
  return document.querySelector<T>(sel);
}

function getRoot(): HTMLElement | null {
  return (
    qs<HTMLElement>("#product-page") ??
    qs<HTMLElement>("[data-product-page]") ??
    qs<HTMLElement>("#product-root") ??
    qs<HTMLElement>("[data-product-root]") ??
    document.body
  );
}

function getProductJsonFromDom(): MerchProduct | null {
  // 1) <script id="product-data" type="application/json">…</script>
  const script = document.getElementById("product-data") as HTMLScriptElement | null;
  if (script?.textContent?.trim()) {
    try {
      const parsed = JSON.parse(script.textContent);
      if (parsed && typeof parsed.id === "string" && Array.isArray(parsed.variants)) {
        return parsed as MerchProduct;
      }
      if (parsed?.product) return parsed.product as MerchProduct;
    } catch {
      // fall through
    }
  }
  // 2) SSR main attrs: data-variants + data-product-id (+ shipping) on #product-page
  const root = getRoot();
  if (root) {
    const variantsAttr = root.getAttribute("data-variants");
    const productId = root.getAttribute("data-product-id");
    const shippingAttr = root.getAttribute("data-shipping-cents");
    if (variantsAttr && productId) {
      try {
        const variants = JSON.parse(variantsAttr) as MerchVariant[];
        if (Array.isArray(variants) && variants.length > 0) {
          const shipping_cents = shippingAttr ? Number.parseInt(shippingAttr, 10) : 0;
          // Name is available in DOM as .pp-title; fallback to id
          const nameEl = document.querySelector<HTMLElement>(".pp-title");
          const name = nameEl?.textContent?.trim() || productId;
          return {
            id: productId,
            name,
            shipping_cents: Number.isFinite(shipping_cents) ? shipping_cents : 0,
            variants,
          } as MerchProduct;
        }
      } catch {
        // ignore, try next fallback
      }
    }
  }
  // 3) data-product attribute on root (JSON-encoded merch product)
  if (root) {
    const attr = root.getAttribute("data-product") ?? root.getAttribute("data-product-json");
    if (attr) {
      try {
        const parsed = JSON.parse(attr);
        if (parsed && typeof parsed.id === "string") return parsed as MerchProduct;
      } catch {
        // ignore
      }
    }
  }
  // 4) window global injected by SSR
  const w = window as unknown as Record<string, unknown>;
  if (w.__PRODUCT__ && typeof (w.__PRODUCT__ as MerchProduct).id === "string") {
    return w.__PRODUCT__ as MerchProduct;
  }
  return null;
}

function getDrawingIdFromDom(_fallbackProduct: MerchProduct | null): string | null {
  const root = getRoot();
  const fromData = root?.getAttribute("data-drawing-id") ?? root?.dataset.drawingId ?? null;
  if (fromData && /^[0-9a-f]{64}$/.test(fromData)) return fromData;
  const urlId =
    new URL(location.href).searchParams.get("d") ??
    new URL(location.href).searchParams.get("drawing_id");
  if (urlId && /^[0-9a-f]{64}$/.test(urlId)) return urlId;
  // Canonical /products/:drawingId/:productId — path segments
  const parts = location.pathname.split("/").filter(Boolean);
  // /products/<drawingId>/<productId> or /merch/<product>/<drawingId>
  for (const p of parts) {
    if (/^[0-9a-f]{64}$/.test(p)) return p;
  }
  return null;
}

function getProductIdFromDom(): string | null {
  const root = getRoot();
  const fromData =
    root?.getAttribute("data-product-id") ??
    root?.dataset.productId ??
    root?.getAttribute("data-product") ??
    null;
  // data-product-id is the product id string; data-product is JSON — distinguish
  if (fromData && !fromData.trim().startsWith("{")) return fromData;
  const urlProd =
    new URL(location.href).searchParams.get("product") ??
    new URL(location.href).searchParams.get("product_id");
  if (urlProd) return urlProd;
  const parts = location.pathname.split("/").filter(Boolean);
  // /products/:drawingId/:productId → last segment is productId
  // /merch/:product/:drawingId → first merch segment is product
  if (parts[0] === "products" && parts.length >= 3) return parts[2];
  if (parts[0] === "merch" && parts.length >= 3) return parts[1];
  if (parts.length === 1 && parts[0] !== "products") return parts[0];
  // fallback to embedded product id
  const prod = getProductJsonFromDom();
  if (prod) return prod.id;
  return null;
}

function getFrameFromDom(): number {
  const root = getRoot();
  const raw =
    root?.getAttribute("data-frame") ??
    root?.dataset.frame ??
    new URL(location.href).searchParams.get("frame");
  const n = raw !== null ? Number.parseInt(String(raw), 10) : 0;
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function getPlacementFromDom(): Placement {
  const root = getRoot();
  const raw =
    root?.getAttribute("data-placement") ?? new URL(location.href).searchParams.get("placement");
  if (raw && isValidPlacement(raw)) return raw;
  return DEFAULT_PLACEMENT;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function variantLabel(v: MerchVariant): string {
  const parts = [v.size, v.color].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(" / ") : `Variant ${v.id}`;
}

export function pickDefaultVariant(product: MerchProduct): MerchVariant | null {
  if (!product.variants.length) return null;
  return product.variants[0];
}

function lowestPrice(product: MerchProduct): number {
  return product.variants.reduce((min, v) => Math.min(min, v.retail_cents), Infinity);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let product: MerchProduct | null = null;
let drawingId: string | null = null;
let frame = 0;
let selectedVariant: MerchVariant | null = null;
let selectedPlacement: Placement = DEFAULT_PLACEMENT;
let checkoutInFlight = false;

// Mockup + drawing bitmap state for product preview
let mockupConfig: MockupConfig | null = null;
let mockupImage: HTMLImageElement | null = null;
let drawingBitmap: import("./editor/bitmap.js").Bitmap | null = null;
let drawingPalette: import("./editor/palette.js").RGB[] | null = null;

function initStateFromDom(): void {
  if (typeof document === "undefined") return;
  if (!product) product = getProductJsonFromDom();
  if (!drawingId) drawingId = getDrawingIdFromDom(product);
  frame = getFrameFromDom();
  selectedPlacement = getPlacementFromDom();
  if (!selectedVariant && product) selectedVariant = pickDefaultVariant(product);
  // Also sync placement from DOM attribute
  const root = getRoot();
  if (root) {
    const p = root.getAttribute("data-placement");
    if (p && isValidPlacement(p)) selectedPlacement = p;
  }
}

// DOM refs discovered at boot — not at module top-level so JSDOM tests can
// inject HTML before boot() runs.
let variantSelectEl: HTMLSelectElement | null = null;
let variantPillsEl: HTMLElement | null = null;
let sizePickerEl: HTMLElement | null = null;
let colorPickerEl: HTMLElement | null = null;
let placementPickerEl: HTMLElement | null = null;
let priceEl: HTMLElement | null = null;
let subtotalEl: HTMLElement | null = null;
let shippingEl: HTMLElement | null = null;
let totalEl: HTMLElement | null = null;
let checkoutBtn: HTMLButtonElement | null = null;
let statusEl: HTMLElement | null = null;
let mockupCanvasEl: HTMLCanvasElement | null = null;
let mockupImgEl: HTMLImageElement | null = null;
let previewImgEl: HTMLImageElement | null = null;

function resolveElements(): void {
  // Variant selector — support <select> or pill container
  variantSelectEl =
    qs<HTMLSelectElement>("#variantSelect") ??
    qs<HTMLSelectElement>("#variant-select") ??
    qs<HTMLSelectElement>("[data-variant-select]") ??
    qs<HTMLSelectElement>("select[name='variant']") ??
    null;

  variantPillsEl =
    qs<HTMLElement>("#variantPicker") ??
    qs<HTMLElement>("#variant-picker") ??
    qs<HTMLElement>("[data-variant-picker]") ??
    qs<HTMLElement>(".pp-pills") ??
    qs<HTMLElement>(".mc-pills") ??
    null;

  // Split-axis pickers (tee size/color) — reused from merch.ts pattern
  sizePickerEl =
    qs<HTMLElement>("#pp-size-picker") ??
    qs<HTMLElement>("#sizePicker") ??
    qs<HTMLElement>("[data-size-picker]") ??
    null;
  colorPickerEl =
    qs<HTMLElement>("#pp-color-picker") ??
    qs<HTMLElement>("#colorPicker") ??
    qs<HTMLElement>("[data-color-picker]") ??
    null;

  placementPickerEl =
    qs<HTMLElement>("#pp-placement-picker") ??
    qs<HTMLElement>("[data-placement-picker]") ??
    qs<HTMLElement>("#placementPicker") ??
    null;

  priceEl =
    qs<HTMLElement>("#price") ??
    qs<HTMLElement>("#pp-price") ??
    qs<HTMLElement>("#priceDisplay") ??
    qs<HTMLElement>("[data-price]") ??
    qs<HTMLElement>(".pp-price-value") ??
    null;
  subtotalEl =
    qs<HTMLElement>("#sumSubtotal") ??
    qs<HTMLElement>("#pp-subtotal") ??
    qs<HTMLElement>("[data-subtotal]") ??
    null;
  shippingEl =
    qs<HTMLElement>("#sumShipping") ??
    qs<HTMLElement>("#pp-shipping") ??
    qs<HTMLElement>("[data-shipping]") ??
    null;
  totalEl =
    qs<HTMLElement>("#sumTotal") ??
    qs<HTMLElement>("#pp-total") ??
    qs<HTMLElement>("[data-total]") ??
    null;
  checkoutBtn =
    qs<HTMLButtonElement>("#pp-checkout") ??
    qs<HTMLButtonElement>("#pp-add") ??
    qs<HTMLButtonElement>("#checkoutBtn") ??
    qs<HTMLButtonElement>("[data-checkout]") ??
    qs<HTMLButtonElement>("#checkout-btn") ??
    null;
  statusEl =
    qs<HTMLElement>("#status") ??
    qs<HTMLElement>("#pp-status") ??
    qs<HTMLElement>("[data-status]") ??
    null;

  mockupCanvasEl =
    qs<HTMLCanvasElement>("#pp-mockup-canvas") ?? qs<HTMLCanvasElement>("#mockupCanvas") ?? null;
  mockupImgEl = qs<HTMLImageElement>("#pp-mockup-img") ?? null;
  previewImgEl = qs<HTMLImageElement>("#pp-preview-img") ?? null;
}

function setStatus(msg: string): void {
  if (statusEl) statusEl.textContent = msg;
}

// ---------------------------------------------------------------------------
// Mockup preview — product image with drawing composited
// ---------------------------------------------------------------------------

function supportsPlacement(productId: string): boolean {
  return productId === "tee" || productId === "tee-softstyle" || productId === "tote";
}

function getMockupConfig(productId: string): MockupConfig | null {
  const all = (mockupsConfig as { products: Record<string, MockupConfig> }).products;
  return all?.[productId] ?? null;
}

async function loadDrawingBitmap(): Promise<void> {
  if (!drawingId) return;
  try {
    const url = `${DRAWING_BASE_URL}/${drawingId}.gif`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`fetch drawing failed: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const decoded = decodeGif(buf);
    if (!decoded.frames[frame]) throw new Error(`frame out of range: ${frame}`);
    drawingBitmap = decoded.frames[frame];
    if (decoded.activePalette) {
      drawingPalette = activePaletteToRgb(
        decoded.activePalette
      ) as unknown as import("./editor/palette.js").RGB[];
    } else {
      drawingPalette = null;
    }
    if (previewImgEl) {
      previewImgEl.src = url;
      previewImgEl.hidden = false;
    }
  } catch (err) {
    console.warn("loadDrawingBitmap failed", err);
  }
}

async function initMockup(): Promise<void> {
  if (!product) return;
  mockupConfig = getMockupConfig(product.id);
  if (!mockupConfig || !mockupCanvasEl) return;
  // Update the static img fallback to the correct product's mockup (SPA case)
  if (mockupImgEl && mockupConfig.mockup_url) {
    if (!mockupImgEl.src.includes(mockupConfig.mockup_url)) {
      mockupImgEl.src = mockupConfig.mockup_url;
    }
    mockupImgEl.alt = `${product.name} mockup`;
  }
  try {
    // Load mockup and drawing in parallel — either may finish first.
    const mockupPromise = loadMockupImage(mockupConfig.mockup_url);
    const drawingPromise =
      drawingBitmap && drawingPalette ? Promise.resolve() : loadDrawingBitmap();
    const [mockup] = await Promise.all([mockupPromise, drawingPromise]);
    mockupImage = mockup;
    if (drawingBitmap && drawingPalette && mockupImage && mockupConfig) {
      repaintMockup();
    } else {
      console.warn("initMockup: missing bitmap/palette after load", {
        hasBitmap: !!drawingBitmap,
        hasPalette: !!drawingPalette,
        hasMockup: !!mockupImage,
      });
      setStatus("preview unavailable — drawing failed to load");
    }
  } catch (err) {
    console.warn("initMockup failed", err);
    setStatus(`preview failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function repaintMockup(): void {
  if (!mockupCanvasEl || !mockupImage || !mockupConfig || !drawingBitmap || !drawingPalette) return;
  const placement =
    product && supportsPlacement(product.id) ? selectedPlacement : DEFAULT_PLACEMENT;
  try {
    paintMockupPreview({
      canvas: mockupCanvasEl,
      mockup: mockupImage,
      config: mockupConfig,
      frame: drawingBitmap,
      palette: drawingPalette,
      placement,
    });
    if (mockupImgEl) mockupImgEl.hidden = true;
    mockupCanvasEl.hidden = false;
  } catch (err) {
    console.warn("paintMockupPreview failed", err);
  }
}

function syncPlacementSelection(): void {
  if (!placementPickerEl) return;
  for (const el of placementPickerEl.querySelectorAll<HTMLElement>("[data-placement]")) {
    const val = el.getAttribute("data-placement");
    el.setAttribute("aria-pressed", val === selectedPlacement ? "true" : "false");
  }
  // Reflect in root data attribute for persistence
  const root = getRoot();
  if (root) root.setAttribute("data-placement", selectedPlacement);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderVariantSelect(): void {
  if (!product) return;

  // Product has split axes (size + color) and SSR already rendered the two pickers?
  // In that case just sync aria-pressed, don't create the full-variant grid fallback.
  const splitSizes = uniqueAxis(product, "size");
  const splitColors = uniqueAxis(product, "color");
  const hasSplit = splitSizes.length > 1 && splitColors.length > 1;
  if (hasSplit && sizePickerEl && colorPickerEl) {
    // SSR rendered #pp-size-picker / #pp-color-picker with data-axis pills; hydrate.
    syncPillSelection();
    syncPlacementSelection();
    return;
  }

  // If SSR already rendered pills with data-variant-id, hydrate selection instead of re-rendering.
  const existingPills = variantPillsEl?.querySelectorAll<HTMLElement>("[data-variant-id]") ?? [];
  if (existingPills.length > 0) {
    syncPillSelection();
    syncPlacementSelection();
    return;
  }

  // Unified variant <select> — preferred when a <select> exists.
  if (variantSelectEl) {
    variantSelectEl.innerHTML = "";
    for (const v of product.variants) {
      const opt = document.createElement("option");
      opt.value = String(v.id);
      opt.textContent = `${variantLabel(v)} — ${formatUsd(v.retail_cents)}`;
      if (selectedVariant && v.id === selectedVariant.id) opt.selected = true;
      variantSelectEl.appendChild(opt);
    }
    // Select default if nothing selected yet
    if (!selectedVariant && product.variants[0]) {
      selectedVariant = product.variants[0];
      variantSelectEl.value = String(selectedVariant.id);
    } else if (selectedVariant) {
      variantSelectEl.value = String(selectedVariant.id);
    }
    return;
  }

  // Pill buttons fallback — one button per variant, or split axes if product has size/color.
  if (variantPillsEl) {
    // Heuristic: if product has both size and color axes with >1 distinct value,
    // render two separate pill groups like merch.ts does. Otherwise single group.
    const sizes = uniqueAxis(product, "size");
    const colors = uniqueAxis(product, "color");
    const hasSplitAxes = sizes.length > 1 && colors.length > 1;

    if (hasSplitAxes && sizePickerEl && colorPickerEl) {
      // Delegate to split rendering
      renderSplitPickers();
      return;
    }

    variantPillsEl.innerHTML = "";
    for (const v of product.variants) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn sm";
      btn.dataset.variantId = String(v.id);
      btn.textContent = `${variantLabel(v)} — ${formatUsd(v.retail_cents)}`;
      btn.setAttribute(
        "aria-pressed",
        selectedVariant && v.id === selectedVariant.id ? "true" : "false"
      );
      btn.addEventListener("click", () => selectVariantById(v.id));
      variantPillsEl.appendChild(btn);
    }
    return;
  }

  // No container found — create pills inline inside root if possible (fallback for tests / minimal SSR)
  const root = getRoot();
  if (root && product.variants.length > 1) {
    let container = root.querySelector<HTMLElement>("[data-auto-variant-picker]");
    if (!container) {
      container = document.createElement("div");
      container.setAttribute("data-auto-variant-picker", "");
      container.className = "pp-pills";
      // Insert before checkout button if present, else append
      if (checkoutBtn?.parentElement)
        checkoutBtn.parentElement.insertBefore(container, checkoutBtn);
      else root.appendChild(container);
      variantPillsEl = container;
    }
    variantPillsEl!.innerHTML = "";
    for (const v of product.variants) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn sm";
      btn.dataset.variantId = String(v.id);
      btn.textContent = `${variantLabel(v)} — ${formatUsd(v.retail_cents)}`;
      btn.setAttribute(
        "aria-pressed",
        selectedVariant && v.id === selectedVariant.id ? "true" : "false"
      );
      btn.addEventListener("click", () => selectVariantById(v.id));
      variantPillsEl!.appendChild(btn);
    }
  }
}

function uniqueAxis(product: MerchProduct, axis: "size" | "color"): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of product.variants) {
    const val = v[axis];
    if (val && !seen.has(val)) {
      seen.add(val);
      out.push(val);
    }
  }
  return out;
}

function renderSplitPickers(): void {
  if (!product || !sizePickerEl || !colorPickerEl) return;
  const sizes = uniqueAxis(product, "size");
  const colors = uniqueAxis(product, "color");

  // Size pills
  sizePickerEl.innerHTML = "";
  const selSize = selectedVariant?.size ?? null;
  for (const s of sizes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn sm";
    btn.dataset.axisValue = s;
    btn.textContent = s;
    btn.setAttribute("aria-pressed", s === selSize ? "true" : "false");
    btn.addEventListener("click", () => {
      // Pick first variant with this size and current color if compatible
      const desiredColor = selectedVariant?.color ?? null;
      const candidate =
        product!.variants.find((v) => v.size === s && v.color === desiredColor) ??
        product!.variants.find((v) => v.size === s) ??
        null;
      if (candidate) selectVariantById(candidate.id);
    });
    sizePickerEl.appendChild(btn);
  }

  // Color pills
  colorPickerEl.innerHTML = "";
  const selColor = selectedVariant?.color ?? null;
  for (const c of colors) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn sm";
    btn.dataset.axisValue = c;
    btn.textContent = c;
    btn.setAttribute("aria-pressed", c === selColor ? "true" : "false");
    btn.addEventListener("click", () => {
      const desiredSize = selectedVariant?.size ?? null;
      const candidate =
        product!.variants.find((v) => v.color === c && v.size === desiredSize) ??
        product!.variants.find((v) => v.color === c) ??
        null;
      if (candidate) selectVariantById(candidate.id);
    });
    colorPickerEl.appendChild(btn);
  }
}

function syncPillSelection(): void {
  if (!selectedVariant) return;
  // Sync variant pills if container exists
  if (variantPillsEl) {
    for (const el of variantPillsEl.querySelectorAll<HTMLElement>("[data-variant-id]")) {
      el.setAttribute(
        "aria-pressed",
        el.dataset.variantId === String(selectedVariant.id) ? "true" : "false"
      );
      el.classList.toggle("selected", el.dataset.variantId === String(selectedVariant.id));
    }
  }
  // Sync split pickers aria — always, even if variantPillsEl is absent
  if (sizePickerEl) {
    for (const el of sizePickerEl.querySelectorAll<HTMLElement>("[data-axis-value]")) {
      el.setAttribute(
        "aria-pressed",
        el.dataset.axisValue === selectedVariant?.size ? "true" : "false"
      );
    }
    for (const el of sizePickerEl.querySelectorAll<HTMLElement>("[data-value]")) {
      el.setAttribute(
        "aria-pressed",
        el.dataset.value === selectedVariant?.size ? "true" : "false"
      );
    }
  }
  if (colorPickerEl) {
    for (const el of colorPickerEl.querySelectorAll<HTMLElement>("[data-axis-value]")) {
      el.setAttribute(
        "aria-pressed",
        el.dataset.axisValue === selectedVariant?.color ? "true" : "false"
      );
    }
    for (const el of colorPickerEl.querySelectorAll<HTMLElement>("[data-value]")) {
      el.setAttribute(
        "aria-pressed",
        el.dataset.value === selectedVariant?.color ? "true" : "false"
      );
    }
  }
  // Also sync SSR data-value pills (pp-size-picker uses data-value)
  syncPlacementSelection();
  if (variantSelectEl) {
    variantSelectEl.value = String(selectedVariant.id);
  }
}

function selectVariantById(id: number): void {
  if (!product) return;
  const v = product.variants.find((x) => x.id === id) ?? null;
  if (!v) return;
  selectedVariant = v;
  // Analytics — size/color separate for funnel
  if (v.size) tracker.merchSizeClick({ product_id: product.id, size: v.size });
  if (v.color) tracker.merchColorClick({ product_id: product.id, color: v.color });
  syncPillSelection();
  updatePrice();
  updateCheckoutButton();
  // Variant change doesn't affect mockup placement, but keep mockup in sync
  repaintMockup();
}

export function updatePrice(): void {
  if (!product) return;
  const variant = selectedVariant;
  const sub = variant ? variant.retail_cents : lowestPrice(product);
  const ship = product.shipping_cents;
  const total = sub + ship;

  if (priceEl) {
    // Single price display — show total or from-price before selection
    priceEl.textContent = variant ? formatUsd(sub) : `from ${formatUsd(sub)}`;
  }
  if (subtotalEl) subtotalEl.textContent = variant ? formatUsd(sub) : `from ${formatUsd(sub)}`;
  if (shippingEl) shippingEl.textContent = ship > 0 ? formatUsd(ship) : "Free";
  if (totalEl) totalEl.textContent = variant ? formatUsd(total) : `from ${formatUsd(total)}`;

  // Also update inline checkout button price hint if it has data-price slot
  if (checkoutBtn && checkoutBtn.dataset.priceTarget !== undefined) {
    // e.g. button text like "Buy — $24.99"
  }
}

function updateCheckoutButton(): void {
  if (!checkoutBtn) return;
  const ready = !!(drawingId && selectedVariant && !checkoutInFlight && product);
  checkoutBtn.disabled = !ready;
  if (!checkoutInFlight) {
    // Preserve price suffix if caller set it, else generic
    const base = checkoutBtn.dataset.label ?? "Buy now";
    if (selectedVariant && product) {
      const total = selectedVariant.retail_cents + product.shipping_cents;
      // Keep button text stable for a11y; price lives in separate priceEl.
      checkoutBtn.textContent = checkoutBtn.dataset.keepText
        ? checkoutBtn.textContent
        : `${base} — ${formatUsd(total)}`;
      // If no custom label, use Stripe CTA
      if (!checkoutBtn.dataset.label) checkoutBtn.textContent = "Continue to checkout";
    } else {
      checkoutBtn.textContent = base;
    }
  } else {
    checkoutBtn.textContent = "Redirecting…";
  }
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

function handlePlacementSelect(placement: Placement): void {
  if (!product || !supportsPlacement(product.id)) return;
  if (!isValidPlacement(placement)) return;
  selectedPlacement = placement;
  if (product) tracker.merchPlacementClick({ product_id: product.id, placement });
  syncPlacementSelection();
  repaintMockup();
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

async function handleCheckout(): Promise<void> {
  if (!product || !drawingId || !selectedVariant || checkoutInFlight) return;
  checkoutInFlight = true;
  updateCheckoutButton();
  setStatus("creating checkout session…");

  // Ecommerce begin_checkout — fire at intent so network failures are captured
  const variantLabelStr = variantLabel(selectedVariant);
  const checkoutValue = (selectedVariant.retail_cents + product.shipping_cents) / 100;
  tracker.beginMerchCheckout({
    value: checkoutValue,
    items: [
      {
        item_id: product.id,
        item_name: product.name,
        price: selectedVariant.retail_cents / 100,
        quantity: 1,
        ...(variantLabelStr ? { item_variant: variantLabelStr } : {}),
      },
    ],
    pixel: {
      content_ids: [product.id],
      content_name: product.name,
      num_items: 1,
      contents: [{ id: product.id, item_price: selectedVariant.retail_cents / 100, quantity: 1 }],
    },
  });

  try {
    const successUrl = `${location.origin}/merch/order/{ORDER_ID}`;
    const cancelUrl = `${location.origin}/products/${encodeURIComponent(drawingId)}/${encodeURIComponent(product.id)}?frame=${frame}`;
    const res = await fetch(`${API_BASE}/merch/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        drawing_id: drawingId,
        frame,
        product_id: product.id,
        variant_id: selectedVariant.id,
        ...(selectedPlacement !== DEFAULT_PLACEMENT && supportsPlacement(product.id)
          ? { placement: selectedPlacement }
          : {}),
        success_url: successUrl,
        cancel_url: cancelUrl,
      }),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()) || res.statusText}`);
    const body = (await res.json()) as CheckoutResponse;
    if (!body.checkout_url) throw new Error("server returned no checkout_url");
    location.href = body.checkout_url;
  } catch (err) {
    checkoutInFlight = false;
    updateCheckoutButton();
    setStatus(`checkout failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Catalog fetch fallback (SPA / tests)
// ---------------------------------------------------------------------------

async function fetchCatalog(): Promise<MerchCatalog> {
  const res = await fetch(`${API_BASE}/merch/products`, { cache: "no-store" });
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);
  return (await res.json()) as MerchCatalog;
}

async function ensureProduct(): Promise<void> {
  if (product) return;
  const desiredId = getProductIdFromDom();
  if (!desiredId) return;
  try {
    const catalog = await fetchCatalog();
    product = catalog.products.find((p) => p.id === desiredId) ?? catalog.products[0] ?? null;
    if (product && !selectedVariant) selectedVariant = pickDefaultVariant(product);
  } catch {
    // keep null, status will surface error
  }
}

// ---------------------------------------------------------------------------
// Boot — exported for tests; auto-run in browser
// ---------------------------------------------------------------------------

export async function boot(): Promise<void> {
  resolveElements();
  initStateFromDom();

  // If product still missing, try catalog fetch by product_id in URL/path
  if (!product) {
    setStatus("loading product…");
    await ensureProduct();
  }

  if (!product) {
    setStatus("product not found");
    updateCheckoutButton();
    return;
  }

  // Default selected — already set to first variant; reflect in UI
  renderVariantSelect();
  // Placement picker — hydrate if SSR rendered it
  if (placementPickerEl && supportsPlacement(product.id)) {
    // Ensure default placement is reflected
    syncPlacementSelection();
  }
  updatePrice();
  updateCheckoutButton();
  setStatus("");

  // Load drawing + mockup preview — product image with drawing composited
  void initMockup();

  // View item analytics (SSR price reports cheapest; hydrate confirms actual default)
  const viewPrice = (selectedVariant?.retail_cents ?? lowestPrice(product)) / 100;
  tracker.viewMerchItem({
    item_id: product.id,
    item_name: product.name,
    price: viewPrice,
  });

  // Wire events
  if (variantSelectEl) {
    variantSelectEl.addEventListener("change", () => {
      const id = Number.parseInt(variantSelectEl!.value, 10);
      if (Number.isInteger(id)) selectVariantById(id);
    });
  }
  // Pill clicks are bound in renderVariantSelect; for SSR-pre-rendered pills, bind here as fallback
  if (variantPillsEl) {
    for (const el of variantPillsEl.querySelectorAll<HTMLElement>("[data-variant-id]")) {
      if ((el as unknown as { __bound?: boolean }).__bound) continue;
      (el as unknown as { __bound: boolean }).__bound = true;
      el.addEventListener("click", () => {
        const id = Number.parseInt(el.dataset.variantId ?? "", 10);
        if (Number.isInteger(id)) selectVariantById(id);
      });
    }
  }
  // Size/color SSR pills — ensure clicks work when SSR rendered them
  if (sizePickerEl) {
    for (const el of sizePickerEl.querySelectorAll<HTMLElement>(
      "[data-axis], [data-value], [data-axis-value]"
    )) {
      if ((el as unknown as { __bound?: boolean }).__bound) continue;
      (el as unknown as { __bound: boolean }).__bound = true;
      el.addEventListener("click", () => {
        const v = (el as HTMLElement).dataset.value ?? (el as HTMLElement).dataset.axisValue ?? "";
        // Determine which picker this is
        const isSizePicker = sizePickerEl!.contains(el);
        if (isSizePicker) {
          const desiredColor = selectedVariant?.color ?? null;
          const candidate =
            product!.variants.find((x) => x.size === v && x.color === desiredColor) ??
            product!.variants.find((x) => x.size === v) ??
            null;
          if (candidate) selectVariantById(candidate.id);
        } else {
          const desiredSize = selectedVariant?.size ?? null;
          const candidate =
            product!.variants.find((x) => x.color === v && x.size === desiredSize) ??
            product!.variants.find((x) => x.color === v) ??
            null;
          if (candidate) selectVariantById(candidate.id);
        }
      });
    }
  }
  if (colorPickerEl) {
    for (const el of colorPickerEl.querySelectorAll<HTMLElement>(
      "[data-axis], [data-value], [data-axis-value]"
    )) {
      // Already handled above when sizePickerEl contains it? This duplicates for color
      // but the loop above already covers both pickers if they share selector. Keep for safety
      if ((el as unknown as { __bound?: boolean }).__bound) continue;
      // Handled in previous block
    }
  }
  // Placement picker
  if (placementPickerEl) {
    for (const el of placementPickerEl.querySelectorAll<HTMLElement>("[data-placement]")) {
      if ((el as unknown as { __bound?: boolean }).__bound) continue;
      (el as unknown as { __bound: boolean }).__bound = true;
      el.addEventListener("click", () => {
        const p = el.dataset.placement ?? "";
        if (isValidPlacement(p)) handlePlacementSelect(p as Placement);
      });
    }
  }

  if (checkoutBtn) {
    checkoutBtn.addEventListener("click", () => {
      void handleCheckout();
    });
  }

  // bfcache restore — browser back from Stripe keeps checkoutInFlight true
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    checkoutInFlight = false;
    setStatus("");
    updateCheckoutButton();
  });
}

// Auto-boot in browser, but not during node --test (where caller imports and drives boot manually)
if (typeof window !== "undefined" && typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void boot();
    });
  } else {
    void boot();
  }
}

// Test / SSR re-entry helpers
export function __resetForTest(opts: {
  product?: MerchProduct | null;
  drawingId?: string | null;
  frame?: number;
  selectedVariantId?: number | null;
}): void {
  product = opts.product ?? null;
  drawingId = opts.drawingId ?? null;
  if (typeof opts.frame === "number") frame = opts.frame;
  if (opts.product && typeof opts.selectedVariantId === "number") {
    selectedVariant =
      opts.product.variants.find((v) => v.id === opts.selectedVariantId!) ??
      pickDefaultVariant(opts.product);
  } else if (opts.product) {
    selectedVariant = pickDefaultVariant(opts.product);
  } else {
    selectedVariant = null;
  }
  checkoutInFlight = false;
  selectedPlacement = DEFAULT_PLACEMENT;
  resolveElements();
  renderVariantSelect();
  updatePrice();
  updateCheckoutButton();
}

export function __getSelectedVariant(): MerchVariant | null {
  return selectedVariant;
}

export function __getSelectedPlacement(): Placement {
  return selectedPlacement;
}
