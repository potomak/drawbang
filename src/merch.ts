import { Bitmap } from "./editor/bitmap.js";
import { PixelCanvas } from "./editor/canvas.js";
import { decodeGif } from "./editor/gif.js";
import { activePaletteToRgb, DEFAULT_ACTIVE_PALETTE } from "./editor/palette.js";
import {
  loadMockupImage,
  paintMockupPreview,
  type MockupConfig,
} from "./merch-preview.js";
import { pickProductFromQuery } from "./merch-query.js";
import {
  DEFAULT_PLACEMENT,
  NAMED_PRESETS,
  PATTERN_PRESETS,
  type Placement,
} from "../merch/placement.js";
import mockupsConfig from "../config/mockups.json" with { type: "json" };

interface MerchVariant {
  id: number;
  label: string;
  base_cost_cents: number;
  retail_cents: number;
}

interface MerchProduct {
  id: string;
  name: string;
  blueprint_id: number;
  print_provider_id: number;
  print_area_px: { width: number; height: number };
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

const INGEST_URL = import.meta.env.VITE_INGEST_URL ?? "/ingest";
const DRAWING_BASE_URL = import.meta.env.VITE_DRAWING_BASE_URL ?? "/drawings";
const API_BASE = INGEST_URL.replace(/\/ingest\/?$/, "");

const PREVIEW_PIXEL_SIZE = 16;
const THUMB_PIXEL_SIZE = 4;

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const productGridEl = document.getElementById("productGrid") as HTMLDivElement;
const placementPickerEl = document.getElementById("placementPicker") as HTMLDivElement;
const variantPickerEl = document.getElementById("variantPicker") as HTMLDivElement;
const checkoutBtn = document.getElementById("checkoutBtn") as HTMLButtonElement;
const previewCanvasEl = document.getElementById("preview") as HTMLCanvasElement;
const frameStripEl = document.getElementById("frameStrip") as HTMLDivElement;
const stepPlacementEl = document.getElementById("step-placement") as HTMLElement | null;
const stepVariantEl = document.getElementById("step-variant") as HTMLElement | null;
const shippingNoteEl = document.getElementById("shippingNote") as HTMLParagraphElement | null;
const sumSubtotalEl = document.getElementById("sumSubtotal") as HTMLElement | null;
const sumShippingEl = document.getElementById("sumShipping") as HTMLElement | null;
const sumTotalEl = document.getElementById("sumTotal") as HTMLElement | null;

interface MockupsFile {
  products: Record<string, MockupConfig>;
}
const MOCKUPS: MockupsFile = mockupsConfig as MockupsFile;

// Per-product card preview state — repainted whenever the user changes
// frames or placement so each card shows the currently-selected frame
// composited onto that product's mockup. productId is tracked so the
// placement (which only applies to the SELECTED product) only re-renders
// that card; siblings stay at their default full-bleed.
interface CardPreview {
  canvas: HTMLCanvasElement;
  config: MockupConfig;
  mockup: HTMLImageElement;
  productId: string;
}
const cardPreviews: CardPreview[] = [];

let frames: Bitmap[] = [];
let activePalette: Uint8Array = new Uint8Array(DEFAULT_ACTIVE_PALETTE);
let drawingId: string | null = null;
let currentFrame = 0;
let selectedProduct: MerchProduct | null = null;
let selectedVariant: MerchVariant | null = null;
let selectedPlacement: Placement = DEFAULT_PLACEMENT;
let checkoutInFlight = false;
let previewCanvas: PixelCanvas | null = null;

// Tees support every placement. Other products keep the original
// full-bleed-only behaviour — a "left chest" pattern doesn't make sense
// on a sticker, and the mug wrap is one continuous print.
const PLACEMENT_PRODUCTS = new Set<string>(["tee"]);

const PLACEMENT_LABELS: Record<Placement, string> = {
  "full-chest": "Full chest",
  "left-chest": "Left chest",
  "right-chest": "Right chest",
  "center-pocket": "Center pocket",
  "pattern-2x2": "Pattern · 2×2 (4)",
  "pattern-3x3": "Pattern · 3×3 (9)",
  "pattern-4x4": "Pattern · 4×4 (16)",
  "pattern-5x5": "Pattern · 5×5 (25)",
  "pattern-6x6": "Pattern · 6×6 (36)",
  "pattern-7x7": "Pattern · 7×7 (49)",
  "pattern-8x8": "Pattern · 8×8 (64)",
};

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function paletteRgb() {
  return activePaletteToRgb(activePalette);
}

function renderPreview(): void {
  if (!previewCanvas) {
    previewCanvas = new PixelCanvas(previewCanvasEl, {
      pixelSize: PREVIEW_PIXEL_SIZE,
      showGrid: false,
      gridColor: "",
    });
  }
  previewCanvas.draw(frames[currentFrame], paletteRgb());
}

function renderFrameStrip(): void {
  if (frames.length <= 1) {
    frameStripEl.hidden = true;
    frameStripEl.innerHTML = "";
    return;
  }
  frameStripEl.hidden = false;
  frameStripEl.innerHTML = "";
  const palette = paletteRgb();
  frames.forEach((frame, idx) => {
    const wrap = document.createElement("button");
    wrap.type = "button";
    wrap.className = "mc-frame-thumb" + (idx === currentFrame ? " selected" : "");
    const cv = document.createElement("canvas");
    const thumb = new PixelCanvas(cv, {
      pixelSize: THUMB_PIXEL_SIZE,
      showGrid: false,
      gridColor: "",
    });
    thumb.draw(frame, palette);
    wrap.appendChild(cv);
    const label = document.createElement("span");
    label.textContent = String(idx + 1);
    wrap.appendChild(label);
    wrap.addEventListener("click", () => selectFrame(idx));
    frameStripEl.appendChild(wrap);
  });
}

function selectFrame(idx: number): void {
  if (idx < 0 || idx >= frames.length || idx === currentFrame) return;
  currentFrame = idx;
  renderPreview();
  renderFrameStrip();
  // Per-card thumbnails track the selected frame so each preview shows the
  // exact image that'll be printed if the user buys that product now.
  repaintCardPreviews();
  if (drawingId) {
    const url = new URL(location.href);
    url.searchParams.set("d", drawingId);
    url.searchParams.set("frame", String(currentFrame));
    history.replaceState(null, "", url.toString());
  }
}

function lowestPrice(p: MerchProduct): number {
  return p.variants.reduce((min, v) => Math.min(min, v.retail_cents), Infinity);
}

function renderCatalog(catalog: MerchCatalog): void {
  productGridEl.innerHTML = "";
  cardPreviews.length = 0;
  if (catalog.products.length === 0) {
    productGridEl.innerHTML = "<p class=\"muted\">No products available yet.</p>";
    return;
  }
  for (const product of catalog.products) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "mc-product";
    card.dataset.productId = product.id;

    const cfg = MOCKUPS.products[product.id];
    let mockupCanvas: HTMLCanvasElement | null = null;
    if (cfg) {
      const mockWrap = document.createElement("div");
      mockWrap.className = "mc-product-mock";
      mockupCanvas = document.createElement("canvas");
      mockupCanvas.style.aspectRatio = `${cfg.mockup_width} / ${cfg.mockup_height}`;
      mockWrap.appendChild(mockupCanvas);
      card.appendChild(mockWrap);
    }

    const name = document.createElement("span");
    name.className = "mc-product-name";
    name.textContent = product.name;
    const price = document.createElement("span");
    price.className = "mc-product-price";
    const min = lowestPrice(product);
    price.textContent =
      product.shipping_cents > 0
        ? `from ${formatUsd(min)} + ${formatUsd(product.shipping_cents)} shipping`
        : `from ${formatUsd(min)}`;
    card.append(name, price);
    card.addEventListener("click", () => selectProduct(product));
    productGridEl.appendChild(card);

    if (mockupCanvas && cfg) {
      // Fire-and-forget: load the base mockup, paint the current frame onto
      // it, register for future repaints when the user changes frames.
      // Asset-load failure leaves the card text-only — no broken state.
      const canvas = mockupCanvas;
      const productId = product.id;
      void loadMockupImage(cfg.mockup_url)
        .then((mockup) => {
          cardPreviews.push({ canvas, config: cfg, mockup, productId });
          if (frames.length > 0) {
            paintMockupPreview({
              canvas,
              mockup,
              config: cfg,
              frame: frames[currentFrame],
              palette: paletteRgb(),
              placement: placementForCard(productId),
            });
          }
        })
        .catch(() => {
          canvas.remove();
        });
    }
  }
}

function selectProduct(product: MerchProduct): void {
  selectedProduct = product;
  selectedVariant = null;
  // Switching to a product that doesn't support placement (mug, sticker)
  // forces the placement back to the default so the request body stays
  // honest if the user keeps clicking through.
  if (!PLACEMENT_PRODUCTS.has(product.id)) {
    selectedPlacement = DEFAULT_PLACEMENT;
  }
  document.querySelectorAll<HTMLButtonElement>(".mc-product").forEach((el) => {
    el.classList.toggle("selected", el.dataset.productId === product.id);
  });
  renderPlacementPicker();
  renderVariantPicker();
  updateCheckoutButton();
  updateSummary();
  repaintCardPreviews();
}

function placementForCard(productId: string): Placement {
  return selectedProduct?.id === productId ? selectedPlacement : DEFAULT_PLACEMENT;
}

function repaintCardPreviews(): void {
  if (frames.length === 0) return;
  const palette = paletteRgb();
  const frame = frames[currentFrame];
  for (const c of cardPreviews) {
    paintMockupPreview({
      canvas: c.canvas,
      mockup: c.mockup,
      config: c.config,
      frame,
      palette,
      placement: placementForCard(c.productId),
    });
  }
}

function renderPlacementPicker(): void {
  placementPickerEl.innerHTML = "";
  if (!selectedProduct || !PLACEMENT_PRODUCTS.has(selectedProduct.id)) {
    if (stepPlacementEl) stepPlacementEl.hidden = true;
    return;
  }
  if (stepPlacementEl) stepPlacementEl.hidden = false;

  const presets: Placement[] = [...NAMED_PRESETS, ...PATTERN_PRESETS];
  for (const preset of presets) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn sm";
    btn.setAttribute("aria-pressed", preset === selectedPlacement ? "true" : "false");
    btn.dataset.placement = preset;
    btn.textContent = PLACEMENT_LABELS[preset];
    btn.addEventListener("click", () => {
      selectedPlacement = preset;
      placementPickerEl.querySelectorAll<HTMLButtonElement>("[data-placement]").forEach((el) => {
        el.setAttribute("aria-pressed", el.dataset.placement === preset ? "true" : "false");
      });
      repaintCardPreviews();
    });
    placementPickerEl.appendChild(btn);
  }
}

function renderVariantPicker(): void {
  variantPickerEl.innerHTML = "";
  if (!selectedProduct) {
    if (stepVariantEl) stepVariantEl.hidden = true;
    if (shippingNoteEl) shippingNoteEl.hidden = true;
    return;
  }
  if (stepVariantEl) stepVariantEl.hidden = false;
  for (const variant of selectedProduct.variants) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn sm";
    btn.dataset.variantId = String(variant.id);
    btn.setAttribute(
      "aria-pressed",
      selectedVariant?.id === variant.id ? "true" : "false",
    );
    btn.textContent = `${variant.label} — ${formatUsd(variant.retail_cents)}`;
    btn.addEventListener("click", () => {
      selectedVariant = variant;
      variantPickerEl.querySelectorAll<HTMLButtonElement>("[data-variant-id]").forEach((el) => {
        el.setAttribute(
          "aria-pressed",
          el.dataset.variantId === String(variant.id) ? "true" : "false",
        );
      });
      updateCheckoutButton();
      updateSummary();
    });
    variantPickerEl.appendChild(btn);
  }
  if (shippingNoteEl) {
    if (selectedProduct.shipping_cents > 0) {
      shippingNoteEl.hidden = false;
      shippingNoteEl.textContent = `+ ${formatUsd(selectedProduct.shipping_cents)} standard shipping & handling, added at checkout.`;
    } else {
      shippingNoteEl.hidden = true;
    }
  }
}

function updateSummary(): void {
  if (!sumSubtotalEl || !sumShippingEl || !sumTotalEl) return;
  if (!selectedProduct) {
    sumSubtotalEl.textContent = "—";
    sumShippingEl.textContent = "—";
    sumTotalEl.textContent = "—";
    return;
  }
  const sub = selectedVariant
    ? selectedVariant.retail_cents
    : lowestPrice(selectedProduct);
  const ship = selectedProduct.shipping_cents;
  sumSubtotalEl.textContent = selectedVariant ? formatUsd(sub) : `from ${formatUsd(sub)}`;
  sumShippingEl.textContent = ship > 0 ? formatUsd(ship) : "Free";
  sumTotalEl.textContent = selectedVariant ? formatUsd(sub + ship) : `from ${formatUsd(sub + ship)}`;
}

function updateCheckoutButton(): void {
  const ready = !!(drawingId && selectedProduct && selectedVariant && !checkoutInFlight);
  checkoutBtn.disabled = !ready;
  checkoutBtn.textContent = checkoutInFlight ? "Redirecting…" : "Continue to checkout";
}

async function fetchCatalog(): Promise<MerchCatalog> {
  const res = await fetch(`${API_BASE}/merch/products`, { cache: "no-store" });
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);
  return (await res.json()) as MerchCatalog;
}

async function fetchDrawing(id: string): Promise<Uint8Array> {
  const res = await fetch(`${DRAWING_BASE_URL}/${id}.gif`);
  if (!res.ok) throw new Error(`drawing fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

async function handleCheckout(): Promise<void> {
  if (!drawingId || !selectedProduct || !selectedVariant || checkoutInFlight) return;
  checkoutInFlight = true;
  updateCheckoutButton();
  setStatus("creating checkout session…");
  try {
    // {ORDER_ID} is substituted server-side before redirect to Stripe.
    const successUrl = `${location.origin}/merch/order/{ORDER_ID}`;
    const cancelUrl = `${location.origin}/merch?d=${encodeURIComponent(drawingId)}&frame=${currentFrame}`;
    const res = await fetch(`${API_BASE}/merch/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        drawing_id: drawingId,
        frame: currentFrame,
        product_id: selectedProduct.id,
        variant_id: selectedVariant.id,
        // Omit the default — lambda's idle path is happy with no field
        // and the order record stays cleaner for pre-feature parity.
        ...(selectedPlacement !== DEFAULT_PLACEMENT ? { placement: selectedPlacement } : {}),
        success_url: successUrl,
        cancel_url: cancelUrl,
      }),
    });
    if (!res.ok) {
      throw new Error(`${res.status} ${(await res.text()) || res.statusText}`);
    }
    const body = (await res.json()) as CheckoutResponse;
    if (!body.checkout_url) throw new Error("server returned no checkout_url");
    location.href = body.checkout_url;
  } catch (err) {
    checkoutInFlight = false;
    updateCheckoutButton();
    setStatus(`checkout failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function boot(): Promise<void> {
  const params = new URL(location.href).searchParams;
  const id = params.get("d");
  const frameParam = params.get("frame");
  const productParam = params.get("product");
  if (!id || !/^[0-9a-f]{64}$/.test(id)) {
    setStatus("missing or malformed drawing id (?d=<64 hex>).");
    return;
  }
  drawingId = id;

  setStatus("loading drawing…");
  try {
    const bytes = await fetchDrawing(id);
    const decoded = decodeGif(bytes);
    frames = decoded.frames;
    if (decoded.activePalette) activePalette = decoded.activePalette;
  } catch (err) {
    setStatus(`failed to load drawing: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const requested = frameParam ? Number.parseInt(frameParam, 10) : 0;
  if (!Number.isInteger(requested) || requested < 0 || requested >= frames.length) {
    setStatus(`frame ${frameParam} is out of range (0–${frames.length - 1}).`);
    return;
  }
  currentFrame = requested;

  renderPreview();
  renderFrameStrip();

  setStatus("loading catalog…");
  try {
    const catalog = await fetchCatalog();
    renderCatalog(catalog);
    setStatus("");
    updateSummary();
    // Deep-link from /products card: auto-select the product so the user
    // only has to pick a variant. Unknown product id silently falls back
    // to the un-selected state.
    const preselected = pickProductFromQuery(catalog.products, productParam);
    if (preselected) selectProduct(preselected);
  } catch (err) {
    setStatus(`failed to load catalog: ${err instanceof Error ? err.message : String(err)}`);
  }

  checkoutBtn.addEventListener("click", () => {
    void handleCheckout();
  });
}

void boot();
