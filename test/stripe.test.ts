import { strict as assert } from "node:assert";
import { test } from "node:test";
import Stripe from "stripe";
import { StripeHelper } from "../merch/stripe.js";

type CapturedCreate = {
  calls: Stripe.Checkout.SessionCreateParams[];
};

function stubClient(captured: CapturedCreate, ret: { id: string; url: string | null }): Stripe {
  return {
    checkout: {
      sessions: {
        create: async (params: Stripe.Checkout.SessionCreateParams) => {
          captured.calls.push(params);
          return ret;
        },
      },
    },
  } as unknown as Stripe;
}

test("createCheckoutSession sends the expected request shape", async () => {
  const captured: CapturedCreate = { calls: [] };
  const client = stubClient(captured, { id: "cs_test_123", url: "https://checkout.stripe.com/x" });
  const helper = new StripeHelper({ secretKey: "sk_test", webhookSecret: "whsec_x", client });

  const result = await helper.createCheckoutSession({
    orderId: "ord_42",
    productName: "Drawbang Mug",
    productImageUrl: "https://example.com/mug.png",
    amountCents: 2400,
    shippingCents: 700,
    successUrl: "https://drawbang.example/merch/success",
    cancelUrl: "https://drawbang.example/merch/cancel",
    customerEmail: "buyer@example.com",
    shippingCountries: ["US", "CA"],
  });

  assert.deepEqual(result, { id: "cs_test_123", url: "https://checkout.stripe.com/x" });
  assert.equal(captured.calls.length, 1);
  const p = captured.calls[0];
  assert.equal(p.mode, "payment");
  assert.equal(p.success_url, "https://drawbang.example/merch/success?session_id={CHECKOUT_SESSION_ID}");
  assert.equal(p.cancel_url, "https://drawbang.example/merch/cancel");
  assert.equal(p.customer_email, "buyer@example.com");
  assert.deepEqual(p.metadata, { order_id: "ord_42" });
  assert.deepEqual(p.shipping_address_collection?.allowed_countries, ["US", "CA"]);
  assert.equal(p.line_items?.length, 1);
  const li = p.line_items![0];
  assert.equal(li.quantity, 1);
  assert.equal(li.price_data?.currency, "usd");
  assert.equal(li.price_data?.unit_amount, 2400);
  assert.equal(li.price_data?.product_data?.name, "Drawbang Mug");
  assert.deepEqual(li.price_data?.product_data?.images, ["https://example.com/mug.png"]);
  // Shipping shows up as a separate fixed-amount line on the checkout page.
  assert.equal(p.shipping_options?.length, 1);
  const so = p.shipping_options![0];
  assert.equal(so.shipping_rate_data?.type, "fixed_amount");
  assert.equal(so.shipping_rate_data?.display_name, "Standard shipping");
  assert.equal(so.shipping_rate_data?.fixed_amount?.amount, 700);
  assert.equal(so.shipping_rate_data?.fixed_amount?.currency, "usd");
});

test("createCheckoutSession omits images and customer_email when not provided", async () => {
  const captured: CapturedCreate = { calls: [] };
  const client = stubClient(captured, { id: "cs_test_456", url: "https://checkout.stripe.com/y" });
  const helper = new StripeHelper({ secretKey: "sk_test", webhookSecret: "whsec_x", client });

  await helper.createCheckoutSession({
    orderId: "ord_no_email",
    productName: "Sticker",
    amountCents: 500,
    shippingCents: 0,
    successUrl: "https://drawbang.example/s",
    cancelUrl: "https://drawbang.example/c",
    shippingCountries: ["US"],
  });

  const p = captured.calls[0];
  assert.equal(p.customer_email, undefined);
  assert.equal(p.line_items?.[0].price_data?.product_data?.images, undefined);
  // shippingCents == 0 should leave shipping_options off entirely.
  assert.equal(p.shipping_options, undefined);
});

test("createCheckoutSession throws when Stripe returns a session without a url", async () => {
  const captured: CapturedCreate = { calls: [] };
  const client = stubClient(captured, { id: "cs_test_789", url: null });
  const helper = new StripeHelper({ secretKey: "sk_test", webhookSecret: "whsec_x", client });

  await assert.rejects(
    () =>
      helper.createCheckoutSession({
        orderId: "ord_x",
        productName: "Tee",
        amountCents: 2000,
        shippingCents: 500,
        successUrl: "https://drawbang.example/s",
        cancelUrl: "https://drawbang.example/c",
        shippingCountries: ["US"],
      }),
    /without a url/,
  );
});

test("parseWebhook returns the event for a valid signature", () => {
  const webhookSecret = "whsec_test_secret";
  const helper = new StripeHelper({ secretKey: "sk_test_dummy", webhookSecret });
  const stripe = new Stripe("sk_test_dummy");
  const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_x" } } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });

  const event = helper.parseWebhook(payload, header);
  assert.equal(event.id, "evt_1");
  assert.equal(event.type, "checkout.session.completed");
});

test("parseWebhook throws on an invalid signature", () => {
  const helper = new StripeHelper({ secretKey: "sk_test_dummy", webhookSecret: "whsec_correct" });
  const stripe = new Stripe("sk_test_dummy");
  const payload = JSON.stringify({ id: "evt_2", type: "x" });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_wrong" });

  assert.throws(() => helper.parseWebhook(payload, header), /signature/i);
});
