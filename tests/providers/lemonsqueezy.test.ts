import { afterEach, describe, expect, it, vi } from "vitest";
import { lemonsqueezy } from "../../src/server/providers/lemonsqueezy";
import { SESSION, VISITOR, json, makeRequest, signHex } from "./_helpers";

const SECRET = "ls-signing-secret";

function orderEvent(name: string, attributes: Record<string, unknown>, custom: Record<string, unknown> | null = { openrev_visitor_id: VISITOR, openrev_session_id: SESSION }) {
  return {
    meta: { event_name: name, test_mode: false, ...(custom ? { custom_data: custom } : {}) },
    data: {
      type: "orders",
      id: "1001",
      attributes: {
        store_id: 1,
        customer_id: 77,
        identifier: "104e18a2-d755-4d4b-80c4-a6c1dcbe1c10",
        order_number: 1,
        user_name: "Ada Lovelace",
        user_email: "ada@example.com",
        currency: "USD",
        subtotal: 999,
        discount_total: 0,
        tax: 200,
        total: 1199,
        status: "paid",
        refunded: false,
        refunded_at: null,
        refunded_amount: 0,
        first_order_item: { product_name: "Pro", variant_name: "Default" },
        created_at: "2024-05-01T10:00:00.000000Z",
        ...attributes,
      },
    },
  };
}

function invoiceEvent(name: string, attributes: Record<string, unknown>, custom: Record<string, unknown> | null = null) {
  return {
    meta: { event_name: name, ...(custom ? { custom_data: custom } : {}) },
    data: {
      type: "subscription-invoices",
      id: "5001",
      attributes: {
        subscription_id: 42,
        customer_id: 77,
        user_email: "ada@example.com",
        billing_reason: "renewal",
        currency: "EUR",
        status: "paid",
        total: 1500,
        refunded_amount: 0,
        created_at: "2024-06-01T10:00:00.000000Z",
        ...attributes,
      },
    },
  };
}

async function signedRequest(event: unknown, secret = SECRET) {
  const body = json(event);
  return makeRequest(body, { "x-signature": await signHex("SHA-256", secret, body), "x-event-name": "order_created" });
}

describe("lemonsqueezy.verify", () => {
  it("accepts a valid X-Signature and rejects tampered or wrongly signed requests", async () => {
    const req = await signedRequest(orderEvent("order_created", {}));
    expect(await lemonsqueezy.verify(req, { webhookSecret: SECRET })).toBe(true);
    expect(await lemonsqueezy.verify({ ...req, rawBody: req.rawBody.replace("1199", "9999") }, { webhookSecret: SECRET })).toBe(false);
    expect(await lemonsqueezy.verify(await signedRequest(orderEvent("order_created", {}), "nope"), { webhookSecret: SECRET })).toBe(false);
    expect(await lemonsqueezy.verify(req, {})).toBe(false);
  });
});

describe("lemonsqueezy.parse", () => {
  it("maps order_created to a new payment with custom data", async () => {
    const r = await lemonsqueezy.parse(await signedRequest(orderEvent("order_created", {})), {});
    expect(r.payments).toHaveLength(1);
    expect(r.payments[0]).toMatchObject({
      provider: "lemonsqueezy",
      transactionId: "order_1001",
      type: "new",
      amount: 1199,
      currency: "USD",
      visitorId: VISITOR,
      sessionId: SESSION,
      customerId: "77",
      email: "ada@example.com",
      name: "Ada Lovelace",
      description: "Pro",
      timestamp: Date.parse("2024-05-01T10:00:00Z"),
    });
  });

  it("ignores pending orders", async () => {
    const r = await lemonsqueezy.parse(await signedRequest(orderEvent("order_created", { status: "pending" })), {});
    expect(r.payments).toHaveLength(0);
    expect(r.ignored).toBeTruthy();
  });

  it("skips the initial subscription invoice (already counted by order_created) and records renewals", async () => {
    const initial = await lemonsqueezy.parse(await signedRequest(invoiceEvent("subscription_payment_success", { billing_reason: "initial" })), {});
    expect(initial.payments).toHaveLength(0);
    expect(initial.ignored).toMatch(/initial/);

    const renewal = await lemonsqueezy.parse(
      await signedRequest(invoiceEvent("subscription_payment_success", {}, { openrev_visitor_id: VISITOR })),
      {},
    );
    expect(renewal.payments[0]).toMatchObject({
      transactionId: "invoice_5001",
      type: "renewal",
      amount: 1500,
      currency: "EUR",
      subscriptionId: "42",
      visitorId: VISITOR,
    });
  });

  it("records order refunds cumulatively and links them to the order", async () => {
    const r = await lemonsqueezy.parse(
      await signedRequest(orderEvent("order_refunded", { status: "partial_refund", refunded_amount: 500, refunded_at: null })),
      {},
    );
    expect(r.payments[0]).toMatchObject({
      transactionId: "refund_order_1001",
      type: "refund",
      amount: 500,
      relatedTransactionId: "order_1001",
      cumulative: true,
    });
  });

  it("records renewal invoice refunds", async () => {
    const r = await lemonsqueezy.parse(await signedRequest(invoiceEvent("subscription_payment_refunded", { status: "refunded", refunded_amount: 1500 })), {});
    expect(r.payments[0]).toMatchObject({ transactionId: "refund_invoice_5001", type: "refund", amount: 1500, relatedTransactionId: "invoice_5001" });
  });

  it("emits subscription goals", async () => {
    const sub = (name: string, status: string) => ({
      meta: { event_name: name, custom_data: { openrev_visitor_id: VISITOR } },
      data: { type: "subscriptions", id: "42", attributes: { status, customer_id: 77, user_email: "ada@example.com" } },
    });
    expect((await lemonsqueezy.parse(await signedRequest(sub("subscription_created", "on_trial")), {})).goals?.[0]).toMatchObject({
      name: "trial_started",
      visitorId: VISITOR,
    });
    expect((await lemonsqueezy.parse(await signedRequest(sub("subscription_cancelled", "cancelled")), {})).goals?.[0].name).toBe(
      "subscription_cancel_scheduled",
    );
    expect((await lemonsqueezy.parse(await signedRequest(sub("subscription_expired", "expired")), {})).goals?.[0].name).toBe("subscription_ended");
  });

  it("ignores unrelated events", async () => {
    const r = await lemonsqueezy.parse(makeRequest(json({ meta: { event_name: "license_key_created" }, data: { id: "1", attributes: {} } })), {});
    expect(r.ignored).toMatch(/unhandled/);
  });
});

describe("lemonsqueezy.importHistory", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pages through orders then subscription invoices", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url.includes("/orders")) {
        return new Response(
          json({
            meta: { page: { currentPage: 1, lastPage: 1 } },
            data: [orderEvent("order_created", { refunded_amount: 199, status: "partial_refund" }).data],
          }),
        );
      }
      return new Response(
        json({ meta: { page: { currentPage: 1, lastPage: 1 } }, data: [invoiceEvent("x", {}).data, { ...invoiceEvent("x", { billing_reason: "initial" }).data, id: "5002" }] }),
      );
    });
    const first = await lemonsqueezy.importHistory!({ apiKey: "key", storeId: "1" }, null);
    expect(calls[0]).toContain("orders?page[number]=1&page[size]=100&filter[store_id]=1");
    expect(first.payments.map((p) => p.transactionId)).toEqual(["order_1001", "refund_order_1001"]);
    expect(first.nextCursor).toBe("invoices:1");
    const second = await lemonsqueezy.importHistory!({ apiKey: "key" }, first.nextCursor);
    expect(second.payments.map((p) => p.transactionId)).toEqual(["invoice_5001"]);
    expect(second.nextCursor).toBeNull();
  });
});
