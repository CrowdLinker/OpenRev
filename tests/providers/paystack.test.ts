import { describe, expect, it } from "vitest";
import { paystack } from "../../src/server/providers/paystack";
import { SESSION, VISITOR, json, makeRequest, signHex } from "./_helpers";

const SECRET = "sk_test_7d1f3c2a9b8e4f6a5c0d1e2f3a4b5c6d7e8f9a0b";

async function signed(event: unknown, secret = SECRET) {
  const body = json(event);
  return makeRequest(body, { "x-paystack-signature": await signHex("SHA-512", secret, body) });
}

function charge(data: Record<string, unknown> = {}) {
  return {
    event: "charge.success",
    data: {
      id: 302961,
      domain: "live",
      status: "success",
      reference: "qTPrJoy9Bx",
      amount: 1000000,
      currency: "NGN",
      paid_at: "2026-10-20T10:23:45.000Z",
      created_at: "2026-10-20T10:20:00.000Z",
      channel: "card",
      metadata: { openrev_visitor_id: VISITOR, openrev_session_id: SESSION },
      customer: { id: 84312, first_name: "Ada", last_name: "Obi", email: "ada@example.com", customer_code: "CUS_xnxdt6s1zg1f4nx" },
      plan: {},
      ...data,
    },
  };
}

describe("paystack.verify", () => {
  it("accepts a valid HMAC-SHA512 x-paystack-signature and rejects tampered or wrongly signed requests", async () => {
    const req = await signed(charge());
    expect(await paystack.verify(req, { secretKey: SECRET })).toBe(true);
    expect(await paystack.verify({ ...req, rawBody: req.rawBody.replace("1000000", "1") }, { secretKey: SECRET })).toBe(false);
    expect(await paystack.verify(await signed(charge(), "sk_test_other"), { secretKey: SECRET })).toBe(false);
    expect(await paystack.verify(makeRequest(req.rawBody), { secretKey: SECRET })).toBe(false);
  });
});

describe("paystack.parse", () => {
  it("maps charge.success to a new payment in subunits keyed by reference", async () => {
    const r = await paystack.parse(await signed(charge()), {});
    expect(r.payments[0]).toMatchObject({
      provider: "paystack",
      transactionId: "qTPrJoy9Bx",
      type: "new",
      amount: 1000000,
      currency: "NGN",
      visitorId: VISITOR,
      sessionId: SESSION,
      customerId: "CUS_xnxdt6s1zg1f4nx",
      email: "ada@example.com",
      name: "Ada Obi",
      ref: "qTPrJoy9Bx",
      timestamp: Date.parse("2026-10-20T10:23:45.000Z"),
    });
  });

  it("reads the visitor id from stringified metadata and custom_fields", async () => {
    const stringified = await paystack.parse(await signed(charge({ metadata: JSON.stringify({ openrev_visitor_id: VISITOR }) })), {});
    expect(stringified.payments[0].visitorId).toBe(VISITOR);
    const fields = await paystack.parse(
      await signed(charge({ metadata: { custom_fields: [{ display_name: "Visitor", variable_name: "openrev_visitor_id", value: VISITOR }] } })),
      {},
    );
    expect(fields.payments[0].visitorId).toBe(VISITOR);
  });

  it("treats plan charges without checkout metadata as renewals", async () => {
    const plan = { id: 1716, name: "Monthly", plan_code: "PLN_gx2wn530m0i3w3m", interval: "monthly" };
    const first = await paystack.parse(await signed(charge({ plan })), {});
    expect(first.payments[0].type).toBe("new");
    const renewal = await paystack.parse(await signed(charge({ plan, reference: "renewal_1", metadata: "" })), {});
    expect(renewal.payments[0]).toMatchObject({ type: "renewal", visitorId: null, customerId: "CUS_xnxdt6s1zg1f4nx" });
  });

  it("maps refund.processed to a refund linked to the transaction reference", async () => {
    const r = await paystack.parse(
      await signed({
        event: "refund.processed",
        data: {
          id: 1234567,
          status: "processed",
          transaction_reference: "qTPrJoy9Bx",
          refund_reference: null,
          amount: 500000,
          currency: "NGN",
          customer: { first_name: null, last_name: null, email: "ada@example.com" },
          domain: "live",
        },
      }),
      {},
    );
    expect(r.payments[0]).toMatchObject({
      transactionId: "refund_1234567",
      type: "refund",
      amount: 500000,
      currency: "NGN",
      relatedTransactionId: "qTPrJoy9Bx",
    });
  });

  it("ignores failed charges and other events", async () => {
    expect((await paystack.parse(await signed(charge({ status: "failed" })), {})).payments).toHaveLength(0);
    expect((await paystack.parse(await signed({ event: "transfer.success", data: {} }), {})).ignored).toMatch(/unhandled/);
  });
});
