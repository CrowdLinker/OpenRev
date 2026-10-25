import { describe, expect, it } from "vitest";
import { razorpay } from "../../src/server/providers/razorpay";
import { SESSION, VISITOR, json, makeRequest, signHex } from "./_helpers";

const SECRET = "rzp_webhook_secret_123";

async function signed(event: unknown, secret = SECRET) {
  const body = json(event);
  return makeRequest(body, { "x-razorpay-signature": await signHex("SHA-256", secret, body), "x-razorpay-event-id": "evt_1" });
}

function paymentEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay_DESp9bgForNoUd",
    entity: "payment",
    amount: 50000,
    currency: "INR",
    status: "captured",
    order_id: "order_DESoU0U4ikYA19",
    invoice_id: null,
    method: "upi",
    captured: true,
    description: "Pro plan",
    email: "ada@example.com",
    contact: "+919876543210",
    customer_id: "cust_C0WlbKhp3aLA7W",
    notes: { openrev_visitor_id: VISITOR, openrev_session_id: SESSION },
    created_at: 1767225600,
    ...overrides,
  };
}

describe("razorpay.verify", () => {
  it("accepts a valid X-Razorpay-Signature and rejects tampered or wrongly signed requests", async () => {
    const req = await signed({ event: "payment.captured", payload: { payment: { entity: paymentEntity() } } });
    expect(await razorpay.verify(req, { webhookSecret: SECRET })).toBe(true);
    expect(await razorpay.verify({ ...req, rawBody: req.rawBody.replace("50000", "1") }, { webhookSecret: SECRET })).toBe(false);
    expect(await razorpay.verify(await signed({ event: "payment.captured" }, "other"), { webhookSecret: SECRET })).toBe(false);
    expect(await razorpay.verify(makeRequest(req.rawBody), { webhookSecret: SECRET })).toBe(false);
  });
});

describe("razorpay.parse", () => {
  it("maps payment.captured to a new payment with the visitor from notes", async () => {
    const r = await razorpay.parse(await signed({ event: "payment.captured", payload: { payment: { entity: paymentEntity() } } }), {});
    expect(r.payments[0]).toMatchObject({
      provider: "razorpay",
      transactionId: "pay_DESp9bgForNoUd",
      type: "new",
      amount: 50000,
      currency: "INR",
      visitorId: VISITOR,
      sessionId: SESSION,
      customerId: "cust_C0WlbKhp3aLA7W",
      email: "ada@example.com",
      ref: "order_DESoU0U4ikYA19",
      timestamp: 1767225600000,
    });
  });

  it("reads order notes on order.paid (empty payment notes arrive as [])", async () => {
    const r = await razorpay.parse(
      await signed({
        event: "order.paid",
        payload: {
          payment: { entity: paymentEntity({ notes: [] }) },
          order: { entity: { id: "order_DESoU0U4ikYA19", amount: 50000, status: "paid", notes: { openrev_visitor_id: VISITOR } } },
        },
      }),
      {},
    );
    expect(r.payments[0]).toMatchObject({ transactionId: "pay_DESp9bgForNoUd", visitorId: VISITOR });
  });

  it("counts subscription payments only from subscription.charged", async () => {
    const subPayment = paymentEntity({ id: "pay_sub_2", invoice_id: "inv_1", notes: [] });
    const captured = await razorpay.parse(await signed({ event: "payment.captured", payload: { payment: { entity: subPayment } } }), {});
    expect(captured.payments).toHaveLength(0);

    const charged = (paidCount: number) =>
      signed({
        event: "subscription.charged",
        payload: {
          subscription: { entity: { id: "sub_DEX6xcJ1HSW4CR", customer_id: "cust_C0WlbKhp3aLA7W", paid_count: paidCount, notes: { openrev_visitor_id: VISITOR } } },
          payment: { entity: subPayment },
        },
      });
    const first = await razorpay.parse(await charged(1), {});
    expect(first.payments[0]).toMatchObject({ transactionId: "pay_sub_2", type: "new", subscriptionId: "sub_DEX6xcJ1HSW4CR", visitorId: VISITOR });
    const renewal = await razorpay.parse(await charged(3), {});
    expect(renewal.payments[0].type).toBe("renewal");
  });

  it("counts standalone invoices from invoice.paid", async () => {
    const r = await razorpay.parse(
      await signed({
        event: "invoice.paid",
        payload: {
          payment: { entity: paymentEntity({ id: "pay_inv", invoice_id: "inv_2", notes: [] }) },
          invoice: { entity: { id: "inv_2", subscription_id: null, customer_id: "cust_X", notes: { openrev_visitor_id: VISITOR } } },
        },
      }),
      {},
    );
    expect(r.payments[0]).toMatchObject({ transactionId: "pay_inv", type: "new", visitorId: VISITOR });
  });

  it("maps refund.processed to a refund linked to the payment", async () => {
    const r = await razorpay.parse(
      await signed({
        event: "refund.processed",
        payload: {
          refund: { entity: { id: "rfnd_FS8TWyPrCsa0OB", amount: 20000, currency: "INR", payment_id: "pay_DESp9bgForNoUd", notes: [], created_at: 1767312000 } },
          payment: { entity: paymentEntity({ amount_refunded: 20000, refund_status: "partial" }) },
        },
      }),
      {},
    );
    expect(r.payments[0]).toMatchObject({
      transactionId: "rfnd_FS8TWyPrCsa0OB",
      type: "refund",
      amount: 20000,
      relatedTransactionId: "pay_DESp9bgForNoUd",
      visitorId: VISITOR,
    });
  });
});
