import { decodeGif } from "../src/editor/gif.js";
import type { BrandLogoProvider } from "./brand-logo.js";
import type { OrdersStore, Order } from "./orders.js";
import { PrintifyError, type PrintifyClient } from "./printify.js";
import type { MerchCatalog } from "./lambda.js";
import { upscaleBitmapToSvg } from "./upscale.js";

export interface PlacePrintifyOrderDeps {
  orders: OrdersStore;
  printify: PrintifyClient;
  catalog: MerchCatalog;
  fetchDrawing: (drawingId: string) => Promise<Uint8Array | null>;
  publicBaseUrl: string;
  // Optional Draw! brand wordmark uploader — used to add the inside-neck
  // logo on the tee (any product whose config carries `brand_decorations`).
  // null/undefined = skip brand decorations entirely. Tests inject a stub.
  brandLogo?: BrandLogoProvider;
}

export async function placePrintifyOrder(
  orderId: string,
  deps: PlacePrintifyOrderDeps,
): Promise<void> {
  let order: Order | null = null;
  try {
    order = await deps.orders.getOrder(orderId);
    if (!order) {
      console.error("placePrintifyOrder: order not found", { orderId });
      return;
    }
    if (order.status !== "paid") {
      console.log("placePrintifyOrder: order not in paid; skipping", {
        orderId,
        status: order.status,
      });
      return;
    }
    if (!order.shipping_address) {
      throw new Error("order missing shipping_address");
    }

    const product = deps.catalog.products.find((p) => p.id === order!.product_id);
    if (!product) throw new Error(`unknown product_id ${order.product_id}`);
    const variant = product.variants.find((v) => v.id === order!.variant_id);
    if (!variant) throw new Error(`unknown variant_id ${order.variant_id}`);

    // Idempotency: if a previous attempt got past createProduct (and
    // persisted the id) reuse it instead of creating a duplicate. Same for
    // createOrder. Without this, a Lambda timeout between two API calls would
    // either burn duplicate Printify resources or 409 forever on retry due
    // to the external_id idempotency check.
    let printifyProductId = order.printify_product_id;
    let printifyOrderId = order.printify_order_id;

    if (!printifyProductId) {
      const gifBytes = await deps.fetchDrawing(order.drawing_id);
      if (!gifBytes) throw new Error(`drawing not found: ${order.drawing_id}`);

      const decoded = decodeGif(gifBytes);
      if (!decoded.activePalette) throw new Error("gif missing DRAWBANG palette");
      const frame = decoded.frames[order.frame];
      if (!frame) throw new Error(`frame index out of range: ${order.frame}`);

      // Render the print asset as an SVG sized to the largest print-area
      // dim, rounded down to a multiple of 16 so each source pixel maps
      // to an integer-sized rect. SVG output is O(rects) in memory (≤256
      // rects total) regardless of sizePx, so the pre-cap from the PNG
      // pipeline is gone — Printify gets a vector asset it can rasterise
      // at print resolution itself.
      const sizePx =
        Math.floor(
          Math.max(product.print_area_px.width, product.print_area_px.height) / 16,
        ) * 16;
      const svgBytes = upscaleBitmapToSvg(frame, decoded.activePalette, { sizePx });

      const image = await deps.printify.uploadImage(
        `drawbang-${order.drawing_id}-f${order.frame}.svg`,
        svgBytes,
      );

      const drawingUrl = `${deps.publicBaseUrl}/d/${order.drawing_id}`;
      const positions = product.placeholder_positions ?? ["front"];
      const placeholders = positions.map((position) => ({
        position,
        images: [{ id: image.id, x: 0.5 as const, y: 0.5 as const, scale: 1 as const, angle: 0 as const }],
      }));

      // Apply the Draw! brand wordmark to any extra placeholder positions
      // declared by the product config (e.g. the tee's inside-neck label).
      // The brand logo is uploaded once per Lambda cold start and the id
      // reused across orders by the BrandLogoProvider's internal cache.
      const brandDecorations = product.brand_decorations ?? [];
      if (brandDecorations.length > 0 && deps.brandLogo) {
        const brandImageId = await deps.brandLogo.getImageId();
        for (const dec of brandDecorations) {
          placeholders.push({
            position: dec.position,
            images: [{ id: brandImageId, x: 0.5 as const, y: 0.5 as const, scale: 1 as const, angle: 0 as const }],
          });
        }
      }
      const printifyProduct = await deps.printify.createProduct({
        title: `Drawbang #${order.drawing_id.slice(0, 8)}`,
        description: `16x16 pixel art from drawbang.\n\nView the source drawing: ${drawingUrl}`,
        blueprint_id: product.blueprint_id,
        print_provider_id: product.print_provider_id,
        variants: [{ id: variant.id, price: variant.retail_cents, is_enabled: true }],
        print_areas: [
          {
            variant_ids: [variant.id],
            placeholders,
          },
        ],
      });
      printifyProductId = printifyProduct.id;
      // Persist the product id immediately so a timeout between here and
      // createOrder doesn't leave us with an orphan product on the next try.
      await deps.orders.transition(orderId, "paid", {
        printify_product_id: printifyProductId,
      });
    }

    if (!printifyOrderId) {
      try {
        const printifyOrder = await deps.printify.createOrder({
          external_id: order.order_id,
          label: `drawbang ${order.order_id}`,
          line_items: [
            { product_id: printifyProductId, variant_id: variant.id, quantity: 1 },
          ],
          shipping_method: 1,
          is_printify_express: false,
          send_shipping_notification: false,
          address_to: order.shipping_address,
        });
        printifyOrderId = printifyOrder.id;
      } catch (err) {
        // 409 here means a previous attempt already submitted this
        // external_id to Printify but we never persisted the resulting
        // order id (e.g. a Lambda timeout between createOrder and the
        // transition stamp). Look the existing order up and reuse it.
        if (err instanceof PrintifyError && err.status === 409) {
          const existing = await deps.printify.findOrderByExternalId(order.order_id);
          if (!existing) throw err;
          console.log("placePrintifyOrder: recovered existing order on 409", {
            orderId,
            printifyOrderId: existing.id,
          });
          printifyOrderId = existing.id;
        } else {
          throw err;
        }
      }
      await deps.orders.transition(orderId, "paid", {
        printify_order_id: printifyOrderId,
      });
    }

    // Printify creates orders in "on-hold"; they only fulfill after this.
    // Idempotent on Printify's side — calling on an already-in-production
    // order is a no-op (returns 200 with the order id).
    await deps.printify.sendToProduction(printifyOrderId);

    await deps.orders.transition(orderId, "paid", { status: "submitted" });
  } catch (err) {
    console.error("placePrintifyOrder failed", { orderId, err });
    if (order && order.status === "paid") {
      try {
        await deps.orders.transition(orderId, "paid", { status: "failed" });
      } catch (innerErr) {
        console.error("placePrintifyOrder: also failed to flip status to failed", {
          orderId,
          err: innerErr,
        });
      }
    }
  }
}
