import { describe, expect, it } from "vitest";
import { paddle, verifyPaddleSignature } from "../../src/server/providers/paddle";
import { SESSION, VISITOR, json, makeRequest, signHex } from "./_helpers";

const SECRET = "pdl_ntfset_01h8brhckjd6qk4n7e4py2340t_6OqTqJ2tGx2ZMeSQWlwYsOrZEXDtg3Eq";

async function signed(event: unknown, secret = SECRET, ts = Math.floor(Date.now() / 1000), extraH1?: string) {
  const body = json(event);
  const h1 = await signHex("SHA-256", secret, `${ts}:${body}`);
  return makeRequest(body, { "paddle-signature": `ts=${ts};${extraH1 ? `h1=${extraH1};` : ""}h1=${h1}` });
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "evt_01hv8x2axb33yr5y238zfwcn5p",
    event_type: "transaction.completed",
    occurred_at: "2024-04-12T10:18:50.155553Z",
    data: {
      id: "txn_01hv8wptq8987qeep44cyrewp9",
      status: "completed",
      origin: "web",
      customer_id: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
      subscription_id: "sub_01hv8x29kz0t586xy6zn1a62ny",
      currency_code: "USD",
      custom_data: { openrev_visitor_id: VISITOR, openrev_session_id: SESSION },
      billed_at: "2024-04-12T10:18:48.294633Z",
      created_at: "2024-04-12T10:12:33.2014Z",
      items: [{ price: { description: "Monthly", name: "Monthly (per seat)" }, quantity: 10 }],
      details: { totals: { subtotal: "59900", tax: "5315", total: "65215", grand_total: "65215", currency_code: "USD" } },
      ...overrides,
    },
  };
}

describe("paddle.verify", () => {
  it("accepts a valid Paddle-Signature, including when several h1 values are sent", async () => {
    expect(await paddle.verify(await signed(transaction()), { webhookSecret: SECRET })).toBe(true);
    expect(await paddle.verify(await signed(transaction(), SECRET, undefined, "deadbeef"), { webhookSecret: SECRET })).toBe(true);
  });

  it("rejects tampered bodies, wrong secrets, stale timestamps and malformed headers", async () => {
    const req = await signed(transaction());
    expect(await paddle.verify({ ...req, rawBody: req.rawBody.replace("65215", "1") }, { webhookSecret: SECRET })).toBe(false);
    expect(await paddle.verify(await signed(transaction(), "pdl_ntfset_other"), { webhookSecret: SECRET })).toBe(false);
    expect(await paddle.verify(await signed(transaction(), SECRET, Math.floor(Date.now() / 1000) - 7200), { webhookSecret: SECRET })).toBe(false);
    expect(await verifyPaddleSignature(req.rawBody, "h1=abc", SECRET)).toBe(false);
    expect(await verifyPaddleSignature(req.rawBody, null, SECRET)).toBe(false);
  });
});

describe("paddle.parse", () => {
  it("maps a checkout transaction to a new payment", async () => {
    const r = await paddle.parse(await signed(transaction()), {});
    expect(r.payments[0]).toMatchObject({
      provider: "paddle",
      transactionId: "txn_01hv8wptq8987qeep44cyrewp9",
      type: "new",
      amount: 65215,
      currency: "USD",
      visitorId: VISITOR,
      sessionId: SESSION,
      customerId: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
      ref: "txn_01hv8wptq8987qeep44cyrewp9",
      subscriptionId: "sub_01hv8x29kz0t586xy6zn1a62ny",
      timestamp: Date.parse("2024-04-12T10:18:48.294633Z"),
    });
  });

  it("marks subscription_recurring transactions as renewals and ignores zero-value ones", async () => {
    const renewal = await paddle.parse(await signed(transaction({ origin: "subscription_recurring", custom_data: null })), {});
    expect(renewal.payments[0]).toMatchObject({ type: "renewal", visitorId: null });
    const zero = await paddle.parse(
      await signed(transaction({ origin: "subscription_payment_method_change", details: { totals: { total: "0", grand_total: "0" } } })),
      {},
    );
    expect(zero.payments).toHaveLength(0);
  });

  it("reads the billing interval from the price's billing cycle, or from the billing period", async () => {
    const cycle = await paddle.parse(await signed(transaction({ items: [{ price: { billing_cycle: { interval: "month", frequency: 3 } }, quantity: 1 }] })), {});
    expect(cycle.payments[0].interval).toEqual({ unit: "month", count: 3 });
    const period = await paddle.parse(
      await signed(transaction({ billing_period: { starts_at: "2024-04-12T10:18:48Z", ends_at: "2025-04-12T10:18:48Z" } })),
      {},
    );
    expect(period.payments[0].interval).toEqual({ unit: "year", count: 1 });
    const none = await paddle.parse(await signed(transaction()), {});
    expect(none.payments[0].interval).toBeNull();
  });

  it("records approved refund adjustments only", async () => {
    const adjustment = (status: string, action = "refund") => ({
      event_type: "adjustment.updated",
      occurred_at: "2024-04-15T08:54:10.646377Z",
      data: {
        id: "adj_01hvgf2s84dr6reszzg29zbvcm",
        action,
        status,
        transaction_id: "txn_01hv8wptq8987qeep44cyrewp9",
        customer_id: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
        currency_code: "USD",
        totals: { subtotal: "92", tax: "8", total: "100", fee: "5", earnings: "87", currency_code: "USD" },
        reason: "error",
      },
    });
    const pending = await paddle.parse(await signed(adjustment("pending_approval")), {});
    expect(pending.payments).toHaveLength(0);
    const credit = await paddle.parse(await signed(adjustment("approved", "credit")), {});
    expect(credit.payments).toHaveLength(0);
    const approved = await paddle.parse(await signed(adjustment("approved")), {});
    expect(approved.payments[0]).toMatchObject({
      transactionId: "adj_01hvgf2s84dr6reszzg29zbvcm",
      type: "refund",
      amount: 100,
      relatedTransactionId: "txn_01hv8wptq8987qeep44cyrewp9",
    });
  });

  it("emits trial and cancellation goals", async () => {
    const created = await paddle.parse(
      await signed({ event_type: "subscription.created", data: { id: "sub_1", status: "trialing", customer_id: "ctm_1", custom_data: { openrev_visitor_id: VISITOR } } }),
      {},
    );
    expect(created.goals?.[0]).toMatchObject({ name: "trial_started", visitorId: VISITOR, customerId: "ctm_1" });
    const canceled = await paddle.parse(await signed({ event_type: "subscription.canceled", data: { id: "sub_1", customer_id: "ctm_1" } }), {});
    expect(canceled.goals?.[0].name).toBe("subscription_ended");
  });
});
