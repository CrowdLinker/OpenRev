import { describe, expect, it } from "vitest";
import { woocommerce } from "../../src/server/providers/woocommerce";
import { SESSION, VISITOR, json, makeRequest, signBase64 } from "./_helpers";

const SECRET = "wc_secret_K8s&2pQ";

async function signed(payload: unknown, topic = "order.updated", secret = SECRET) {
  const body = json(payload);
  return makeRequest(body, {
    "x-wc-webhook-signature": await signBase64("SHA-256", secret, body),
    "x-wc-webhook-topic": topic,
    "x-wc-webhook-resource": "order",
    "x-wc-webhook-event": topic.split(".")[1],
    "x-wc-webhook-id": "7",
  });
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 727,
    number: "727",
    order_key: "wc_order_58d2d042d1d",
    created_via: "checkout",
    status: "processing",
    currency: "EUR",
    total: "29.35",
    total_tax: "1.35",
    customer_id: 26,
    billing: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" },
    date_created_gmt: "2026-10-20T10:00:00",
    date_paid_gmt: "2026-10-20T10:01:00",
    date_modified_gmt: "2026-10-20T10:01:00",
    meta_data: [
      { id: 1, key: "openrev_visitor_id", value: VISITOR },
      { id: 2, key: "openrev_session_id", value: SESSION },
    ],
    line_items: [{ id: 315, name: "Woo Single #1", quantity: 2, total: "28.00" }],
    refunds: [],
    ...overrides,
  };
}

describe("woocommerce.verify", () => {
  it("accepts valid signatures and the unsigned creation ping", async () => {
    expect(await woocommerce.verify(await signed(order()), { webhookSecret: SECRET })).toBe(true);
    expect(await woocommerce.verify(makeRequest("webhook_id=7", { "content-type": "application/x-www-form-urlencoded" }), { webhookSecret: SECRET })).toBe(
      true,
    );
  });

  it("accepts secrets stored HTML-escaped by WordPress", async () => {
    const req = await signed(order(), "order.updated", SECRET);
    expect(await woocommerce.verify(req, { webhookSecret: "wc_secret_K8s&amp;2pQ" })).toBe(true);
  });

  it("rejects tampered bodies, wrong secrets and unsigned non-ping requests", async () => {
    const req = await signed(order());
    expect(await woocommerce.verify({ ...req, rawBody: req.rawBody.replace("29.35", "1.00") }, { webhookSecret: SECRET })).toBe(false);
    expect(await woocommerce.verify(await signed(order(), "order.updated", "other"), { webhookSecret: SECRET })).toBe(false);
    expect(await woocommerce.verify(makeRequest(req.rawBody), { webhookSecret: SECRET })).toBe(false);
  });
});

describe("woocommerce.parse", () => {
  it("ignores the creation ping", async () => {
    const r = await woocommerce.parse(makeRequest("webhook_id=7"), {});
    expect(r.payments).toHaveLength(0);
    expect(r.ignored).toMatch(/ping/);
  });

  it("maps a processing order to a payment keyed by order id (major → minor units)", async () => {
    const r = await woocommerce.parse(await signed(order(), "order.created"), {});
    expect(r.payments).toHaveLength(1);
    expect(r.payments[0]).toMatchObject({
      provider: "woocommerce",
      transactionId: "727",
      type: "new",
      amount: 2935,
      currency: "EUR",
      visitorId: VISITOR,
      sessionId: SESSION,
      customerId: "26",
      email: "ada@example.com",
      name: "Ada Lovelace",
      timestamp: Date.UTC(2026, 9, 20, 10, 1, 0),
    });
  });

  it("ignores unpaid orders and honours custom paid statuses", async () => {
    const pending = await woocommerce.parse(await signed(order({ status: "on-hold" })), {});
    expect(pending.payments).toHaveLength(0);
    const custom = await woocommerce.parse(await signed(order({ status: "on-hold" })), { paidStatuses: "wc-on-hold, completed" });
    expect(custom.payments).toHaveLength(1);
  });

  it("marks WooCommerce Subscriptions renewal orders as renewals", async () => {
    const r = await woocommerce.parse(await signed(order({ created_via: "subscription", meta_data: [] })), {});
    expect(r.payments[0]).toMatchObject({ type: "renewal", visitorId: null });
  });

  it("emits a cumulative refund from the refunds array (partial and full)", async () => {
    const partial = await woocommerce.parse(await signed(order({ refunds: [{ id: 1, reason: "", total: "-5.00" }] })), {});
    expect(partial.payments.map((p) => p.type)).toEqual(["new", "refund"]);
    expect(partial.payments[1]).toMatchObject({ transactionId: "refund_727", amount: 500, relatedTransactionId: "727", cumulative: true });

    const full = await woocommerce.parse(await signed(order({ status: "refunded", refunds: [] })), {});
    expect(full.payments[1]).toMatchObject({ type: "refund", amount: 2935 });
  });

  it("ignores non-order topics", async () => {
    const r = await woocommerce.parse(await signed({ id: 1 }, "product.updated"), {});
    expect(r.ignored).toMatch(/unhandled topic/);
  });
});
