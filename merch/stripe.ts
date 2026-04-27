import Stripe from "stripe";

export interface StripeHelperConfig {
  secretKey: string;
  webhookSecret: string;
  client?: Stripe;
}

export interface CreateCheckoutSessionArgs {
  orderId: string;
  productName: string;
  productImageUrl?: string;
  amountCents: number;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  shippingCountries: string[];
}

const API_VERSION = "2026-04-22.dahlia" as const;

export class StripeHelper {
  private readonly client: Stripe;
  private readonly webhookSecret: string;

  constructor(cfg: StripeHelperConfig) {
    this.client = cfg.client ?? new Stripe(cfg.secretKey, { apiVersion: API_VERSION });
    this.webhookSecret = cfg.webhookSecret;
  }

  async createCheckoutSession(args: CreateCheckoutSessionArgs): Promise<{ id: string; url: string }> {
    type CreateParams = Parameters<Stripe["checkout"]["sessions"]["create"]>[0];
    type AllowedCountry = NonNullable<NonNullable<CreateParams>["shipping_address_collection"]>["allowed_countries"][number];

    const params: CreateParams = {
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: args.productName,
              ...(args.productImageUrl ? { images: [args.productImageUrl] } : {}),
            },
            unit_amount: args.amountCents,
          },
          quantity: 1,
        },
      ],
      shipping_address_collection: {
        allowed_countries: args.shippingCountries as AllowedCountry[],
      },
      success_url: `${args.successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: args.cancelUrl,
      metadata: { order_id: args.orderId },
      ...(args.customerEmail ? { customer_email: args.customerEmail } : {}),
    };

    const session = await this.client.checkout.sessions.create(params);
    if (!session.url) {
      throw new Error(`Stripe returned a session without a url (id=${session.id})`);
    }
    return { id: session.id, url: session.url };
  }

  parseWebhook(rawBody: string, signatureHeader: string): Stripe.Event {
    return this.client.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
  }
}
