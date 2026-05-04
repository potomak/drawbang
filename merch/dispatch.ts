import { decodeGif } from "../src/editor/gif.js";
import type { OrdersStore, Order } from "./orders.js";
import type { PrintifyClient } from "./printify.js";
import type { MerchCatalog } from "./lambda.js";
import { upscaleBitmapToPng } from "./upscale.js";

export interface PlacePrintifyOrderDeps {
  orders: OrdersStore;
  printify: PrintifyClient;
  catalog: MerchCatalog;
  fetchDrawing: (drawingId: string) => Promise<Uint8Array | null>;
  publicBaseUrl: string;
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

      // Largest print-area dim, rounded down to a multiple of 16 so each source
      // pixel becomes an integer-sized block.
      const maxDim = Math.max(product.print_area_px.width, product.print_area_px.height);
      const sizePx = Math.floor(maxDim / 16) * 16;
      const pngBytes = await upscaleBitmapToPng(frame, decoded.activePalette, { sizePx });

      const image = await deps.printify.uploadImage(
        `drawbang-${order.drawing_id}-f${order.frame}.png`,
        pngBytes,
      );

      const drawingUrl = `${deps.publicBaseUrl}/d/${order.drawing_id}`;
      const positions = product.placeholder_positions ?? ["front"];
      const placeholders = positions.map((position) => ({
        position,
        images: [{ id: image.id, x: 0.5 as const, y: 0.5 as const, scale: 1 as const, angle: 0 as const }],
      }));
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
