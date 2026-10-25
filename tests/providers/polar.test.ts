import { describe, expect, it } from "vitest";
import { fromBase64 } from "../../src/server/lib/crypto";
import { polar } from "../../src/server/providers/polar";
import { SESSION, VISITOR, json, makeRequest, standardWebhookHeaders } from "./_helpers";

// Polar secrets look like `whsec_…` but legacy ones are signed with the UTF-8 bytes of the whole string.
const LEGACY_SECRET = "whsec_polar_9aG2kLmP0qRsT4uVwX8yZ";
const STANDARD_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

function order(overrides: Record<string, unknown> = {}) {
  return {
    type: "order.paid",
    timestamp: "2026-10-20T12:00:01Z",
    data: {
      id: "b6c3a5c4-6f37-4a1e-9b3e-6a0d3f4b7a11",
      created_at: "2026-10-20T12:00:00Z",
      status: "paid",
      paid: true,
      subtotal_amount: 2000,
      discount_amount: 0,
      net_amount: 2000,
      tax_amount: 400,
      total_amount: 2400,
      refunded_amount: 0,
      refunded_tax_amount: 0,
      currency: "usd",
      billing_reason: "purchase",
      customer_id: "cus_polar_1",
      subscription_id: null,
      checkout_id: "chk_polar_1",
      metadata: { openrev_visitor_id: VISITOR, openrev_session_id: SESSION },
      customer: { id: "cus_polar_1", email: "ada@example.com", name: "Ada", metadata: {} },
      product: { name: "Lifetime" },
      description: "Lifetime deal",
      ...overrides,
    },
  };
}

describe("polar.verify", () => {
  it("accepts legacy Polar HMAC secrets (UTF-8 key, as @polar-sh/sdk validateEvent does)", async () => {
    const body = json(order());
    const headers = await standardWebhookHeaders(body, new TextEncoder().encode(LEGACY_SECRET));
    expect(await polar.verify(makeRequest(body, headers), { webhookSecret: LEGACY_SECRET })).toBe(true);
  });

  it("accepts Standard Webhooks secrets (base64 key after whsec_)", async () => {
    const body = json(order());
    const headers = await standardWebhookHeaders(body, fromBase64(STANDARD_SECRET.slice(6)));
    expect(await polar.verify(makeRequest(body, headers), { webhookSecret: STANDARD_SECRET })).toBe(true);
  });

  it("rejects tampered bodies, wrong secrets and missing headers", async () => {
    const body = json(order());
    const headers = await standardWebhookHeaders(body, new TextEncoder().encode(LEGACY_SECRET));
    expect(await polar.verify(makeRequest(body.replace("2400", "1"), headers), { webhookSecret: LEGACY_SECRET })).toBe(false);
    expect(await polar.verify(makeRequest(body, headers), { webhookSecret: "whsec_wrong" })).toBe(false);
    expect(await polar.verify(makeRequest(body), { webhookSecret: LEGACY_SECRET })).toBe(false);
  });
});

describe("polar.parse", () => {
  it("maps order.paid (purchase) to a new payment with the checkout id as ref", async () => {
    const r = await polar.parse(makeRequest(json(order())), {});
    expect(r.payments[0]).toMatchObject({
      provider: "polar",
      transactionId: "b6c3a5c4-6f37-4a1e-9b3e-6a0d3f4b7a11",
      type: "new",
      amount: 2400,
      currency: "USD",
      visitorId: VISITOR,
      sessionId: SESSION,
      ref: "chk_polar_1",
      customerId: "cus_polar_1",
      email: "ada@example.com",
      description: "Lifetime deal",
    });
  });

  it("classifies billing reasons", async () => {
    for (const [reason, type] of [
      ["subscription_create", "new"],
      ["subscription_cycle", "renewal"],
      ["subscription_update", "renewal"],
    ] as const) {
      const r = await polar.parse(makeRequest(json(order({ billing_reason: reason, subscription_id: "sub_1" }))), {});
      expect(r.payments[0].type).toBe(type);
    }
  });

  it("falls back to customer metadata for the visitor id", async () => {
    const r = await polar.parse(makeRequest(json(order({ metadata: {}, customer: { id: "c", metadata: { openrev_visitor_id: VISITOR } } }))), {});
    expect(r.payments[0].visitorId).toBe(VISITOR);
  });

  it("records order.refunded as a cumulative refund including refunded tax", async () => {
    const r = await polar.parse(
      makeRequest(json({ ...order({ status: "partially_refunded", refunded_amount: 1000, refunded_tax_amount: 200 }), type: "order.refunded" })),
      {},
    );
    expect(r.payments[0]).toMatchObject({
      transactionId: "refund_b6c3a5c4-6f37-4a1e-9b3e-6a0d3f4b7a11",
      type: "refund",
      amount: 1200,
      relatedTransactionId: "b6c3a5c4-6f37-4a1e-9b3e-6a0d3f4b7a11",
      cumulative: true,
    });
  });

  it("emits free_trial for zero-amount subscription orders and subscription goals", async () => {
    const trial = await polar.parse(makeRequest(json(order({ billing_reason: "subscription_create", total_amount: 0, net_amount: 0, tax_amount: 0 }))), {});
    expect(trial.payments).toHaveLength(0);
    expect(trial.goals?.[0]).toMatchObject({ name: "free_trial", visitorId: VISITOR });
    const sub = (type: string, data: Record<string, unknown>) =>
      makeRequest(json({ type, data: { id: "sub_1", customer_id: "cus_polar_1", metadata: { openrev_visitor_id: VISITOR }, ...data } }));
    expect((await polar.parse(sub("subscription.created", { status: "trialing" }), {})).goals?.[0].name).toBe("trial_started");
    expect((await polar.parse(sub("subscription.canceled", { cancel_at_period_end: true }), {})).goals?.[0].name).toBe("subscription_cancel_scheduled");
    expect((await polar.parse(sub("subscription.revoked", {}), {})).goals?.[0].name).toBe("subscription_ended");
  });
});
