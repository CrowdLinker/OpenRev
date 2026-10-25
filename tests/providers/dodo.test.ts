import { describe, expect, it } from "vitest";
import { toBase64 } from "../../src/server/lib/crypto";
import { dodo } from "../../src/server/providers/dodo";
import { SESSION, VISITOR, json, makeRequest, randomKey, standardWebhookHeaders } from "./_helpers";

const KEY = randomKey(32);
const SECRET = `whsec_${toBase64(KEY)}`;

function payment(overrides: Record<string, unknown> = {}) {
  return {
    business_id: "bus_H4ekzPSlcg",
    type: "payment.succeeded",
    timestamp: "2026-10-20T10:30:00Z",
    data: {
      payload_type: "Payment",
      payment_id: "pay_ts2ySpzg07phGeBZqePbH",
      status: "succeeded",
      total_amount: 2999,
      tax: 499,
      currency: "USD",
      created_at: "2026-10-20T10:29:58Z",
      customer: { customer_id: "cus_dodo_1", email: "ada@example.com", name: "Ada", metadata: {} },
      metadata: { openrev_visitor_id: VISITOR, openrev_session_id: SESSION },
      subscription_id: null,
      charge_type: null,
      checkout_session_id: "cks_1",
      ...overrides,
    },
  };
}

async function signed(event: unknown, key = KEY) {
  const body = json(event);
  return makeRequest(body, await standardWebhookHeaders(body, key));
}

describe("dodo.verify", () => {
  it("accepts Standard Webhooks signatures made with the base64-decoded whsec_ secret", async () => {
    expect(await dodo.verify(await signed(payment()), { webhookSecret: SECRET })).toBe(true);
  });

  it("rejects tampered bodies, wrong secrets and UTF-8 (non-standard) keys", async () => {
    const req = await signed(payment());
    expect(await dodo.verify({ ...req, rawBody: req.rawBody.replace("2999", "1") }, { webhookSecret: SECRET })).toBe(false);
    expect(await dodo.verify(await signed(payment(), randomKey(32)), { webhookSecret: SECRET })).toBe(false);
    // Strict mode: a signature made with the secret's UTF-8 bytes is not valid for Dodo.
    expect(await dodo.verify(await signed(payment(), new TextEncoder().encode(SECRET)), { webhookSecret: SECRET })).toBe(false);
    expect(await dodo.verify(req, {})).toBe(false);
  });
});

describe("dodo.parse", () => {
  it("maps payment.succeeded to a new payment with the payment id as ref", async () => {
    const r = await dodo.parse(await signed(payment()), {});
    expect(r.payments[0]).toMatchObject({
      provider: "dodo",
      transactionId: "pay_ts2ySpzg07phGeBZqePbH",
      type: "new",
      amount: 2999,
      currency: "USD",
      visitorId: VISITOR,
      sessionId: SESSION,
      ref: "pay_ts2ySpzg07phGeBZqePbH",
      customerId: "cus_dodo_1",
      email: "ada@example.com",
    });
  });

  it("marks renewal charges and skips payment-method updates", async () => {
    const renewal = await dodo.parse(await signed(payment({ charge_type: "renewal", subscription_id: "sub_1", metadata: {} })), {});
    expect(renewal.payments[0]).toMatchObject({ type: "renewal", subscriptionId: "sub_1", visitorId: null });
    const update = await dodo.parse(await signed(payment({ is_update_payment_method: true })), {});
    expect(update.payments).toHaveLength(0);
  });

  it("maps refund.succeeded to a refund linked to the payment", async () => {
    const r = await dodo.parse(
      await signed({
        type: "refund.succeeded",
        timestamp: "2026-10-21T10:00:00Z",
        data: {
          payload_type: "Refund",
          refund_id: "ref_F0gZetLvTxxBrMU2CZcmy",
          payment_id: "pay_ts2ySpzg07phGeBZqePbH",
          amount: 1000,
          currency: "USD",
          status: "succeeded",
          is_partial: true,
          created_at: "2026-10-21T09:59:00Z",
          customer: { customer_id: "cus_dodo_1", email: "ada@example.com", name: "Ada" },
          metadata: {},
        },
      }),
      {},
    );
    expect(r.payments[0]).toMatchObject({
      transactionId: "ref_F0gZetLvTxxBrMU2CZcmy",
      type: "refund",
      amount: 1000,
      relatedTransactionId: "pay_ts2ySpzg07phGeBZqePbH",
    });
  });

  it("ignores other events", async () => {
    const r = await dodo.parse(await signed({ type: "subscription.active", data: {} }), {});
    expect(r.ignored).toMatch(/unhandled/);
  });
});
