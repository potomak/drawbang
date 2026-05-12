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
const variantPickerEl = document.getElementById("variantPicker") as HTMLDivElement;
const checkoutBtn = document.getElementById("checkoutBtn") as HTMLButtonElement;
const previewCanvasEl = document.getElementById("preview") as HTMLCanvasElement;
const frameStripEl = document.getElementById("frameStrip") as HTMLDivElement;

interface MockupsFile {
  products: Record<string, MockupConfig>;
}
const MOCKUPS: MockupsFile = mockupsConfig as MockupsFile;

// Per-product card preview state — repainted whenever the user changes
// frames so each card shows the currently-selected frame composited onto
// that product's mockup.
interface CardPreview {
  canvas: HTMLCanvasElement;
  config: MockupConfig;
  mockup: HTMLImageElement;
}
const cardPreviews: CardPreview[] = [];

let frames: Bitmap[] = [];
let activePalette: Uint8Array = new Uint8Array(DEFAULT_ACTIVE_PALETTE);
let drawingId: string | null = null;
let currentFrame = 0;
let selectedProduct: MerchProduct | null = null;
let selectedVariant: MerchVariant | null = null;
let checkoutInFlight = false;
let previewCanvas: PixelCanvas | null = null;

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
    wrap.className = "frame" + (idx === currentFrame ? " selected" : "");
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
    card.className = "product-card";
    card.dataset.productId = product.id;

    const cfg = MOCKUPS.products[product.id];
    let mockupCanvas: HTMLCanvasElement | null = null;
    if (cfg) {
      mockupCanvas = document.createElement("canvas");
      mockupCanvas.className = "product-mockup";
      mockupCanvas.style.aspectRatio = `${cfg.mockup_width} / ${cfg.mockup_height}`;
      card.appendChild(mockupCanvas);
    }

    const name = document.createElement("strong");
    name.textContent = product.name;
    const price = document.createElement("span");
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
      void loadMockupImage(cfg.mockup_url)
        .then((mockup) => {
          cardPreviews.push({ canvas, config: cfg, mockup });
          if (frames.length > 0) {
            paintMockupPreview({
              canvas,
              mockup,
              config: cfg,
              frame: frames[currentFrame],
              palette: paletteRgb(),
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
  document.querySelectorAll<HTMLButtonElement>(".product-card").forEach((el) => {
    el.classList.toggle("selected", el.dataset.productId === product.id);
  });
  renderVariantPicker();
  updateCheckoutButton();
}

function repaintCardPreviews(): void {
  if (frames.length === 0) return;
  const palette = paletteRgb();
  const frame = frames[currentFrame];
  for (const c of cardPreviews) {
    paintMockupPreview({ canvas: c.canvas, mockup: c.mockup, config: c.config, frame, palette });
  }
}

function renderVariantPicker(): void {
  if (!selectedProduct) {
    variantPickerEl.hidden = true;
    variantPickerEl.innerHTML = "";
    return;
  }
  variantPickerEl.hidden = false;
  variantPickerEl.innerHTML = "";
  const heading = document.createElement("h3");
  heading.textContent = `${selectedProduct.name} — pick a variant`;
  variantPickerEl.appendChild(heading);
  for (const variant of selectedProduct.variants) {
    const id = `variant-${variant.id}`;
    const wrap = document.createElement("label");
    wrap.className = "variant-option";
    wrap.htmlFor = id;
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "variant";
    radio.id = id;
    radio.value = String(variant.id);
    radio.addEventListener("change", () => {
      selectedVariant = variant;
      updateCheckoutButton();
    });
    const label = document.createElement("span");
    label.textContent = `${variant.label} — ${formatUsd(variant.retail_cents)}`;
    wrap.append(radio, label);
    variantPickerEl.appendChild(wrap);
  }
  if (selectedProduct.shipping_cents > 0) {
    const note = document.createElement("p");
    note.className = "shipping-note";
    note.textContent = `+ ${formatUsd(selectedProduct.shipping_cents)} standard shipping & handling, added at checkout.`;
    variantPickerEl.appendChild(note);
  }
}

function updateCheckoutButton(): void {
  const ready = !!(drawingId && selectedProduct && selectedVariant && !checkoutInFlight);
  checkoutBtn.disabled = !ready;
  checkoutBtn.textContent = checkoutInFlight ? "redirecting…" : "continue to checkout";
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
