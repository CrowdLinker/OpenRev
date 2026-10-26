import { describe, expect, it } from "vitest";
import { parseStripeEvent, stripe, verifyStripeSignature } from "../../src/server/providers/stripe";
import { VISITOR, SESSION, json, makeRequest, signHex } from "./_helpers";

const SECRET = "whsec_test_123";

async function signed(body: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
  const sig = await signHex("SHA-256", secret, `${ts}.${body}`);
  return makeRequest(body, { "stripe-signature": `t=${ts},v1=${sig}` });
}

describe("stripe.verify", () => {
  const body = json({ id: "evt_1", type: "checkout.session.completed" });

  it("accepts a valid signature", async () => {
    expect(await stripe.verify(await signed(body), { webhookSecret: SECRET })).toBe(true);
  });

  it("rejects tampered bodies, wrong secrets, stale timestamps and missing headers", async () => {
    const req = await signed(body);
    expect(await stripe.verify({ ...req, rawBody: body.replace("evt_1", "evt_2") }, { webhookSecret: SECRET })).toBe(false);
    expect(await stripe.verify(await signed(body, "whsec_other"), { webhookSecret: SECRET })).toBe(false);
    expect(await stripe.verify(await signed(body, SECRET, Math.floor(Date.now() / 1000) - 3600), { webhookSecret: SECRET })).toBe(false);
    expect(await stripe.verify(makeRequest(body), { webhookSecret: SECRET })).toBe(false);
    expect(await verifyStripeSignature(body, "garbage", SECRET)).toBe(false);
  });
});

describe("stripe.parse", () => {
  it("maps a one-time Checkout Session to a new payment keyed by the PaymentIntent", async () => {
    const event = {
      type: "checkout.session.completed",
      created: 1714557600,
      data: {
        object: {
          id: "cs_test_a1",
          mode: "payment",
          status: "complete",
          payment_status: "paid",
          amount_total: 4900,
          currency: "eur",
          payment_intent: "pi_123",
          customer: "cus_1",
          created: 1714557590,
          customer_details: { email: "buyer@example.com", name: "Ada" },
          metadata: { openrev_visitor_id: VISITOR, openrev_session_id: SESSION },
        },
      },
    };
    const result = await stripe.parse(makeRequest(json(event)), {});
    expect(result.payments).toHaveLength(1);
    expect(result.payments[0]).toMatchObject({
      transactionId: "pi_123",
      type: "new",
      amount: 4900,
      currency: "EUR",
      visitorId: VISITOR,
      sessionId: SESSION,
      ref: "cs_test_a1",
      email: "buyer@example.com",
      customerId: "cus_1",
    });
  });

  it("uses client_reference_id from tagged Payment Links as the visitor id", () => {
    const r = parseStripeEvent({
      type: "checkout.session.completed",
      data: { object: { id: "cs_2", mode: "payment", payment_status: "paid", amount_total: 1000, currency: "usd", client_reference_id: VISITOR } },
    });
    expect(r.payments[0].visitorId).toBe(VISITOR);
    expect(r.payments[0].transactionId).toBe("cs_2");
  });

  it("keys subscription checkouts and their first invoice to the same transaction id", () => {
    const checkout = parseStripeEvent({
      type: "checkout.session.completed",
      data: { object: { id: "cs_3", mode: "subscription", payment_status: "paid", amount_total: 2000, currency: "usd", invoice: "in_1", subscription: "sub_1" } },
    });
    const invoice = parseStripeEvent({
      type: "invoice.paid",
      data: { object: { id: "in_1", subscription: "sub_1", billing_reason: "subscription_create", amount_paid: 2000, currency: "usd" } },
    });
    expect(checkout.payments[0].transactionId).toBe("in_1");
    expect(invoice.payments[0]).toMatchObject({ transactionId: "in_1", type: "new" });
  });

  it("marks subscription_cycle invoices as renewals and reads metadata from subscription_details", () => {
    const r = parseStripeEvent({
      type: "invoice.paid",
      data: {
        object: {
          id: "in_2",
          parent: { subscription_details: { subscription: "sub_1", metadata: { openrev_visitor_id: VISITOR } } },
          billing_reason: "subscription_cycle",
          amount_paid: 2000,
          currency: "usd",
        },
      },
    });
    expect(r.payments[0]).toMatchObject({ type: "renewal", subscriptionId: "sub_1", visitorId: VISITOR });
  });

  it("reads the billing interval from the invoice line's price, or from its period", () => {
    const yearly = parseStripeEvent({
      type: "invoice.paid",
      data: {
        object: {
          id: "in_3",
          subscription: "sub_2",
          billing_reason: "subscription_create",
          amount_paid: 12000,
          currency: "usd",
          lines: { data: [{ price: { recurring: { interval: "year", interval_count: 1 } }, period: { start: 1735689600, end: 1767225600 } }] },
        },
      },
    });
    expect(yearly.payments[0].interval).toEqual({ unit: "year", count: 1 });
    // Newer API versions don't expand the price; the line's period still says how long the charge covers.
    const quarterly = parseStripeEvent({
      type: "invoice.paid",
      data: { object: { id: "in_4", subscription: "sub_3", amount_paid: 3000, currency: "usd", lines: { data: [{ period: { start: 1735689600, end: 1743465600 } }] } } },
    });
    expect(quarterly.payments[0].interval).toEqual({ unit: "month", count: 3 });
    // A setup fee listed before the plan doesn't decide the interval.
    const withFee = parseStripeEvent({
      type: "invoice.paid",
      data: {
        object: {
          id: "in_5",
          subscription: "sub_4",
          billing_reason: "subscription_create",
          amount_paid: 17000,
          currency: "usd",
          period_start: 1735689600,
          period_end: 1735689600,
          lines: {
            data: [
              { amount: 5000, period: { start: 1735689600, end: 1735689600 } },
              { amount: 12000, price: { recurring: { interval: "year", interval_count: 1 } }, period: { start: 1735689600, end: 1767225600 } },
            ],
          },
        },
      },
    });
    expect(withFee.payments[0].interval).toEqual({ unit: "year", count: 1 });
  });

  it("records cumulative refunds linked to the original payment", () => {
    const r = parseStripeEvent({
      type: "charge.refunded",
      created: 1714557600,
      data: { object: { id: "ch_1", amount_refunded: 500, currency: "usd", payment_intent: "pi_123" } },
    });
    expect(r.payments[0]).toMatchObject({ transactionId: "refund_ch_1", type: "refund", amount: 500, relatedTransactionId: "pi_123", cumulative: true });
  });

  it("emits a free_trial goal for zero-amount subscription checkouts and ignores unknown events", () => {
    const trial = parseStripeEvent({
      type: "checkout.session.completed",
      data: { object: { id: "cs_4", mode: "subscription", amount_total: 0, payment_status: "no_payment_required", metadata: { openrev_visitor_id: VISITOR } } },
    });
    expect(trial.payments).toHaveLength(0);
    expect(trial.goals?.[0]).toMatchObject({ name: "free_trial", visitorId: VISITOR });
    expect(parseStripeEvent({ type: "customer.created", data: { object: {} } }).ignored).toMatch(/unhandled/);
  });
});
