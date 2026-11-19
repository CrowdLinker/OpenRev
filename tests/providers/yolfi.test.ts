import { describe, expect, it } from "vitest";
import { getProvider, providerCatalog } from "../../src/server/providers";
import { yolfi } from "../../src/server/providers/yolfi";
import { SESSION, VISITOR, json, makeRequest, signBase64 } from "./_helpers";

describe("yolfi", () => {
  it("is available alongside the other payment providers", () => {
    expect(getProvider("yolfi")?.name).toBe("Yolfi");
    expect(providerCatalog().find((provider) => provider.id === "yolfi")).toMatchObject({
      website: "https://yolfi.com",
      events: ["payment.confirmed"],
      supportsImport: false,
    });
  });
});

const SECRET = "yolfi_test_endpoint_secret";

describe("yolfi.verify", () => {
  it("accepts the endpoint's base64 HMAC-SHA256 signature over the raw body", async () => {
    const body = '{ "type": "payment.confirmed", "label": "café" }';
    const signature = await signBase64("SHA-256", SECRET, body);
    expect(await yolfi.verify(makeRequest(body, { "X-Yolfi-Signature": signature }), { webhookSecret: SECRET })).toBe(true);
  });
});

function payment(data: Record<string, unknown> = {}) {
  return {
    id: "evt_test_payment",
    type: "payment.confirmed",
    created: 1792404000,
    livemode: true,
    data: {
      invoiceId: "550e8400-e29b-41d4-a716-446655440000",
      checkoutSessionId: "ycs_0123456789abcdef0123456789abcdef",
      paymentType: "ONE_TIME",
      status: "confirmed",
      amount: "0.00025",
      amountUsd: "18.75",
      currency: "EUR",
      updatedAt: "2026-10-19T10:00:00.000Z",
      metadata: { openrev_visitor_id: VISITOR, openrev_session_id: SESSION },
      customer: { clientReferenceId: "customer_123", email: "ada@example.com", name: "Ada" },
      ...data,
    },
  };
}

describe("yolfi.parse", () => {
  it("records a confirmed Checkout payment as USD merchant receipts with visitor attribution", async () => {
    const request = makeRequest(json(payment()));
    const signature = await signBase64("SHA-256", SECRET, request.rawBody);
    request.headers.set("X-Yolfi-Signature", signature);
    expect(await yolfi.verify(request, { webhookSecret: SECRET })).toBe(true);
    const result = await yolfi.parse(request, {});
    expect(result.payments).toEqual([
      {
        provider: "yolfi",
        transactionId: "550e8400-e29b-41d4-a716-446655440000",
        type: "new",
        amount: 1875,
        currency: "USD",
        timestamp: 1792404000000,
        visitorId: VISITOR,
        sessionId: SESSION,
        customerId: "customer_123",
        email: "ada@example.com",
        name: "Ada",
        ref: "ycs_0123456789abcdef0123456789abcdef",
      },
    ]);
  });
});

describe("yolfi event filtering", () => {
  it.each(["invoice.created", "invoice.overdue", "subscription.cancelled"])("ignores %s instead of recording a payment", async (type) => {
    const result = await yolfi.parse(makeRequest(json({ ...payment(), type })), {});
    expect(result.payments).toHaveLength(0);
    expect(result.ignored).toBeTruthy();
  });

  it("ignores sandbox events", async () => {
    const result = await yolfi.parse(makeRequest(json({ ...payment(), livemode: false })), {});
    expect(result.payments).toHaveLength(0);
  });

  it("does not misclassify recurring receipts as new one-time payments", async () => {
    const result = await yolfi.parse(makeRequest(json(payment({ paymentType: "RECURRING", subscriptionId: "sub_test" }))), {});
    expect(result.payments).toHaveLength(0);
    expect(result.ignored).toContain("one-time");
  });
});

describe("yolfi amount validation", () => {
  it.each(["0", "-1", "not-a-number", null, "1e100", "0.001"])("ignores invalid or sub-cent USD amount %s", async (amountUsd) => {
    const result = await yolfi.parse(makeRequest(json(payment({ amountUsd }))), {});
    expect(result.payments).toHaveLength(0);
    expect(result.ignored).toBeTruthy();
  });
});

describe("yolfi regression cases", () => {
  it("rejects tampered bodies, wrong secrets, missing signatures and malformed signatures", async () => {
    const body = json(payment());
    const signature = await signBase64("SHA-256", SECRET, body);
    expect(await yolfi.verify(makeRequest(body.replace("18.75", "99.00"), { "X-Yolfi-Signature": signature }), { webhookSecret: SECRET })).toBe(false);
    expect(await yolfi.verify(makeRequest(body, { "X-Yolfi-Signature": signature }), { webhookSecret: "wrong-secret" })).toBe(false);
    expect(await yolfi.verify(makeRequest(body), { webhookSecret: SECRET })).toBe(false);
    expect(await yolfi.verify(makeRequest(body, { "X-Yolfi-Signature": "not-base64" }), { webhookSecret: SECRET })).toBe(false);
    expect(await yolfi.verify(makeRequest(body, { "X-Yolfi-Signature": signature }), {})).toBe(false);
  });

  it("supports a Paylink payment without a Checkout Session and keeps its invoice as the ref", async () => {
    const result = await yolfi.parse(makeRequest(json(payment({ checkoutSessionId: undefined, paylinkId: "paylink_test" }))), {});
    expect(result.payments[0].ref).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("keeps the invoice transaction id stable across retries even when delivery headers change", async () => {
    const body = json(payment());
    const first = await yolfi.parse(makeRequest(body, { "X-Yolfi-Event-ID": "first" }), {});
    const retry = await yolfi.parse(makeRequest(body, { "X-Yolfi-Event-ID": "retry" }), {});
    expect(retry.payments[0].transactionId).toBe(first.payments[0].transactionId);
  });

  it("accepts a payment without optional customer or attribution fields", async () => {
    const result = await yolfi.parse(makeRequest(json(payment({ customer: undefined, metadata: undefined }))), {});
    expect(result.payments[0]).toMatchObject({ email: null, name: null, customerId: null, visitorId: null, sessionId: null });
  });

  it.each(["{", "null", "[]", "42", '{"type":"payment.confirmed","data":null}'])("ignores malformed payload %s", async (body) => {
    const result = await yolfi.parse(makeRequest(body), {});
    expect(result.payments).toHaveLength(0);
    expect(result.ignored).toBeTruthy();
  });

  it("does not record an invoice without a stable id", async () => {
    const result = await yolfi.parse(makeRequest(json(payment({ invoiceId: null }))), {});
    expect(result.payments).toHaveLength(0);
  });
});
