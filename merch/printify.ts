export interface PrintifyClientConfig {
  token: string;
  shopId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface ShippingAddress {
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  country: string;
  region: string;
  address1: string;
  address2?: string;
  city: string;
  zip: string;
}

export interface CreateProductArgs {
  title: string;
  description: string;
  blueprint_id: number;
  print_provider_id: number;
  variants: { id: number; price: number; is_enabled: boolean }[];
  print_areas: {
    variant_ids: number[];
    placeholders: {
      // Common: "front" / "back" / "default". Multi-up products like sticker
      // sheets use "front_1".."front_N". Some apparel adds "neck" / "sleeve".
      // Printify validates per blueprint+provider, so we leave it open and
      // catch invalid values via 422.
      position: string;
      images: { id: string; x: 0.5; y: 0.5; scale: 1; angle: 0 }[];
    }[];
  }[];
}

export interface CreateOrderArgs {
  external_id: string;
  label: string;
  line_items: { product_id: string; variant_id: number; quantity: number }[];
  shipping_method: 1;
  is_printify_express: false;
  send_shipping_notification: false;
  address_to: ShippingAddress;
}

export class PrintifyError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `Printify request failed: ${status}`);
    this.name = "PrintifyError";
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_BASE_URL = "https://api.printify.com/v1";
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000];
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export class PrintifyClient {
  private readonly token: string;
  private readonly shopId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(cfg: PrintifyClientConfig) {
    this.token = cfg.token;
    this.shopId = cfg.shopId;
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.sleepImpl = cfg.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async uploadImage(filename: string, pngBytes: Uint8Array): Promise<{ id: string; preview_url: string }> {
    const contents = Buffer.from(pngBytes).toString("base64");
    return this.request<{ id: string; preview_url: string }>("POST", "/uploads/images.json", {
      file_name: filename,
      contents,
    });
  }

  async createProduct(args: CreateProductArgs): Promise<{ id: string }> {
    return this.request<{ id: string }>("POST", `/shops/${this.shopId}/products.json`, args);
  }

  async createOrder(args: CreateOrderArgs): Promise<{ id: string; status: string }> {
    return this.request<{ id: string; status: string }>(
      "POST",
      `/shops/${this.shopId}/orders.json`,
      args,
    );
  }

  async getOrder(printifyOrderId: string): Promise<{ id: string; status: string }> {
    return this.request<{ id: string; status: string }>(
      "GET",
      `/shops/${this.shopId}/orders/${printifyOrderId}.json`,
    );
  }

  // Printify creates orders in "on-hold" status by default. They only enter
  // production after this is called — without it the order silently stalls.
  async sendToProduction(printifyOrderId: string): Promise<{ id: string }> {
    return this.request<{ id: string }>(
      "POST",
      `/shops/${this.shopId}/orders/${printifyOrderId}/send_to_production.json`,
    );
  }

  // Recover the Printify order created by a previous timed-out attempt.
  // We send `external_id: order.order_id` on createOrder, but Printify
  // exposes that on listings as `metadata.shop_order_id` rather than the
  // top-level `external_id` (always null in shop listings — confirmed
  // empirically). So we list the most-recent N and filter client-side.
  // limit defaults to 50 — if a previous attempt's createOrder happened
  // within the last 50 orders this will find it. Bump if you ever have
  // more in-flight retries than that.
  async findOrderByExternalId(
    externalId: string,
    limit = 50,
  ): Promise<{ id: string } | null> {
    const out = await this.request<{
      data: { id: string; metadata?: { shop_order_id?: string } }[];
    }>("GET", `/shops/${this.shopId}/orders.json?limit=${limit}`);
    const found = out.data.find((o) => o.metadata?.shop_order_id === externalId);
    return found ? { id: found.id } : null;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, init);
      if (res.ok) {
        return (await res.json()) as T;
      }

      const shouldRetry = RETRY_STATUSES.has(res.status) && attempt < RETRY_DELAYS_MS.length;
      if (!shouldRetry) {
        let parsed: unknown;
        try {
          parsed = await res.json();
        } catch {
          parsed = await res.text().catch(() => undefined);
        }
        throw new PrintifyError(res.status, parsed);
      }

      let delay = RETRY_DELAYS_MS[attempt];
      if (res.status === 429) {
        const ra = res.headers.get("Retry-After");
        if (ra) {
          const secs = Number(ra);
          if (Number.isFinite(secs) && secs >= 0) delay = secs * 1000;
        }
      }
      await this.sleepImpl(delay);
    }
  }
}
