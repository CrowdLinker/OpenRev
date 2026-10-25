import { describe, expect, it } from "vitest";
import { parseShopifyEvent, shopify } from "../../src/server/providers/shopify";
import { SESSION, VISITOR, json, makeRequest, signBase64 } from "./_helpers";

const SECRET = "4f8f0c1e2d3b4a5968778695a4b3c2d1e0f";

async function signed(topic: string, payload: unknown, secret = SECRET) {
  const body = json(payload);
  return makeRequest(body, {
    "x-shopify-hmac-sha256": await signBase64("SHA-256", secret, body),
    "x-shopify-topic": topic,
    "x-shopify-shop-domain": "example.myshopify.com",
  });
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 5678901234567,
    name: "#1001",
    email: "ada@example.com",
    currency: "USD",
    total_price: "199.99",
    total_tax: "16.00",
    total_price_set: { shop_money: { amount: "199.99", currency_code: "USD" }, presentment_money: { amount: "183.50", currency_code: "EUR" } },
    financial_status: "paid",
    test: false,
    source_name: "web",
    processed_at: "2026-10-20T10:00:00-04:00",
    created_at: "2026-10-20T09:59:00-04:00",
    checkout_token: "bd5a8aa1ecd019dd3520ff791ee3a24c",
    note_attributes: [
      { name: "openrev_visitor_id", value: VISITOR },
      { name: "openrev_session_id", value: SESSION },
    ],
    customer: { id: 6543210987654, email: "ada@example.com", first_name: "Ada", last_name: "Lovelace" },
    line_items: [{ title: "Hoodie", price: "199.99", quantity: 1 }],
    ...overrides,
  };
}

describe("shopify.verify", () => {
  it("accepts a valid base64 X-Shopify-Hmac-Sha256 and rejects tampered or wrongly signed requests", async () => {
    const req = await signed("orders/paid", order());
    expect(await shopify.verify(req, { webhookSecret: SECRET })).toBe(true);
    expect(await shopify.verify({ ...req, rawBody: req.rawBody.replace("199.99", "1.00") }, { webhookSecret: SECRET })).toBe(false);
    expect(await shopify.verify(await signed("orders/paid", order(), "other"), { webhookSecret: SECRET })).toBe(false);
    expect(await shopify.verify(makeRequest(req.rawBody), { webhookSecret: SECRET })).toBe(false);
  });
});

describe("shopify.parse", () => {
  it("maps orders/paid to a payment in shop currency (major → minor units) with the visitor from note_attributes", async () => {
    const r = await shopify.parse(await signed("orders/paid", order()), {});
    expect(r.payments[0]).toMatchObject({
      provider: "shopify",
      transactionId: "5678901234567",
      type: "new",
      amount: 19999,
      currency: "USD",
      visitorId: VISITOR,
      sessionId: SESSION,
      customerId: "6543210987654",
      email: "ada@example.com",
      name: "Ada Lovelace",
      timestamp: Date.parse("2026-10-20T14:00:00Z"),
    });
  });

  it("handles zero-decimal currencies and subscription renewal orders", async () => {
    const r = await shopify.parse(
      await signed("orders/paid", order({ currency: "JPY", total_price: "1500", total_price_set: undefined, source_name: "subscription_contract_checkout_one" })),
      {},
    );
    expect(r.payments[0]).toMatchObject({ amount: 1500, currency: "JPY", type: "renewal" });
  });

  it("ignores test orders", async () => {
    const r = await shopify.parse(await signed("orders/paid", order({ test: true })), {});
    expect(r.payments).toHaveLength(0);
    expect(r.ignored).toMatch(/test/);
  });

  it("maps refunds/create to a refund summing successful refund transactions", async () => {
    const refund = {
      id: 929361464,
      order_id: 5678901234567,
      created_at: "2026-10-21T10:00:00-04:00",
      processed_at: "2026-10-21T10:00:00-04:00",
      note: "Damaged",
      transactions: [
        { id: 1, kind: "refund", status: "success", amount: "50.00", currency: "USD" },
        { id: 2, kind: "refund", status: "failure", amount: "10.00", currency: "USD" },
        { id: 3, kind: "sale", status: "success", amount: "199.99", currency: "USD" },
      ],
    };
    const r = await shopify.parse(await signed("refunds/create", refund), {});
    expect(r.payments[0]).toMatchObject({
      transactionId: "refund_929361464",
      type: "refund",
      amount: 5000,
      currency: "USD",
      relatedTransactionId: "5678901234567",
    });
  });

  it("ignores other topics", async () => {
    const r = await shopify.parse(await signed("orders/create", order()), {});
    expect(r.ignored).toMatch(/unhandled topic/);
  });
});

describe("shopify topic binding", () => {
  it("ignores signed bodies that aren't paid orders even when labelled orders/paid", () => {
    const checkout = { id: 31415926535, currency: "USD", total_price: "999.00", note_attributes: [{ name: "openrev_visitor_id", value: "visitor-1111-aaaa" }] };
    expect(parseShopifyEvent("orders/paid", checkout).payments).toHaveLength(0);
    expect(parseShopifyEvent("orders/paid", { ...checkout, financial_status: "paid", admin_graphql_api_id: "gid://shopify/DraftOrder/1" }).payments).toHaveLength(0);
    expect(parseShopifyEvent("orders/paid", { ...checkout, financial_status: "paid", admin_graphql_api_id: "gid://shopify/Order/1" }).payments).toHaveLength(1);
  });
});
