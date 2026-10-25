import { describe, expect, it } from "vitest";
import { custom } from "../../src/server/providers/custom";
import type { ProviderConfig } from "../../src/server/providers/types";
import { VISITOR, json, makeRequest, signBase64, signHex } from "./_helpers";

const base: ProviderConfig = {
  signatureAlgorithm: "sha256",
  signatureHeader: "X-Acme-Signature",
  signatureEncoding: "hex",
  secret: "acme-secret",
  eventTypePath: "type",
  paymentEvents: "payment.succeeded, invoice.paid",
  refundEvents: "refund.created",
  amountPath: "data.amount",
  amountUnit: "minor",
  currencyPath: "data.currency",
  defaultCurrency: "USD",
  transactionIdPath: "data.id",
  relatedTransactionIdPath: "data.payment_id",
  emailPath: "data.customer.email",
  customerIdPath: "data.customer.id",
  timestampPath: "created",
  renewalPath: "data.billing_reason",
  renewalValue: "subscription_cycle",
};

const payment = {
  type: "payment.succeeded",
  created: 1767225600,
  data: {
    id: "pay_1",
    amount: 4900,
    currency: "eur",
    billing_reason: "subscription_create",
    customer: { id: "cus_1", email: "ada@example.com" },
    metadata: { openrev_visitor_id: VISITOR },
  },
};

describe("custom.verify", () => {
  it("verifies hex HMAC signatures with an optional prefix", async () => {
    const body = json(payment);
    const sig = await signHex("SHA-256", "acme-secret", body);
    expect(await custom.verify(makeRequest(body, { "x-acme-signature": sig }), base)).toBe(true);
    expect(await custom.verify(makeRequest(body, { "x-acme-signature": `sha256=${sig}` }), { ...base, signaturePrefix: "sha256=" })).toBe(true);
    expect(await custom.verify(makeRequest(body.replace("4900", "1"), { "x-acme-signature": sig }), base)).toBe(false);
    expect(await custom.verify(makeRequest(body, { "x-acme-signature": sig }), { ...base, secret: "other" })).toBe(false);
    expect(await custom.verify(makeRequest(body, {}), base)).toBe(false);
  });

  it("verifies base64 HMAC-SHA512 and SHA-1 signatures", async () => {
    const body = json(payment);
    const sha512 = await signBase64("SHA-512", "acme-secret", body);
    expect(await custom.verify(makeRequest(body, { "x-acme-signature": sha512 }), { ...base, signatureAlgorithm: "sha512", signatureEncoding: "base64" })).toBe(true);
    const sha1 = await signHex("SHA-1", "acme-secret", body);
    expect(await custom.verify(makeRequest(body, { "x-acme-signature": sha1 }), { ...base, signatureAlgorithm: "sha1" })).toBe(true);
  });

  it("requires a URL token when the algorithm is none", async () => {
    const body = json(payment);
    const cfg = { ...base, signatureAlgorithm: "none", token: "tok_123456" };
    expect(await custom.verify(makeRequest(body, {}, "https://x.test/api/webhooks/abc?token=tok_123456"), cfg)).toBe(true);
    expect(await custom.verify(makeRequest(body, {}, "https://x.test/api/webhooks/abc?token=nope"), cfg)).toBe(false);
    expect(await custom.verify(makeRequest(body, {}, "https://x.test/api/webhooks/abc"), cfg)).toBe(false);
    expect(await custom.verify(makeRequest(body, {}, "https://x.test/api/webhooks/abc?token="), { ...base, signatureAlgorithm: "none" })).toBe(false);
  });

  it("enforces the token in addition to the HMAC when both are set", async () => {
    const body = json(payment);
    const sig = await signHex("SHA-256", "acme-secret", body);
    const cfg = { ...base, token: "tok_123456" };
    expect(await custom.verify(makeRequest(body, { "x-acme-signature": sig }), cfg)).toBe(false);
    expect(await custom.verify(makeRequest(body, { "x-acme-signature": sig }, "https://x.test/api/webhooks/abc?token=tok_123456"), cfg)).toBe(true);
  });
});

describe("custom.parse", () => {
  it("maps configured paths to a payment", async () => {
    const r = await custom.parse(makeRequest(json(payment)), base);
    expect(r.payments[0]).toMatchObject({
      provider: "custom",
      transactionId: "pay_1",
      type: "new",
      amount: 4900,
      currency: "EUR",
      visitorId: VISITOR,
      email: "ada@example.com",
      customerId: "cus_1",
      timestamp: 1767225600000,
    });
  });

  it("converts major units and detects renewals", async () => {
    const event = { ...payment, data: { ...payment.data, amount: "19.99", currency: "JPY", billing_reason: "subscription_cycle" } };
    const r = await custom.parse(makeRequest(json(event)), { ...base, amountUnit: "major" });
    expect(r.payments[0]).toMatchObject({ amount: 20, currency: "JPY", type: "renewal" });
    const usd = await custom.parse(makeRequest(json({ ...event, data: { ...event.data, currency: "usd" } })), { ...base, amountUnit: "major" });
    expect(usd.payments[0].amount).toBe(1999);
  });

  it("supports truthy renewal flags and an explicit visitor path", async () => {
    const event = { type: "invoice.paid", data: { id: "inv_1", amount: 100, recurring: true, buyer: { ref: VISITOR } } };
    const r = await custom.parse(makeRequest(json(event)), { ...base, renewalPath: "data.recurring", renewalValue: "", visitorIdPath: "data.buyer.ref" });
    expect(r.payments[0]).toMatchObject({ type: "renewal", visitorId: VISITOR, currency: "USD" });
  });

  it("maps refund events with a prefixed transaction id and the original payment id", async () => {
    const event = { type: "refund.created", data: { id: "re_1", amount: -1500, currency: "usd", payment_id: "pay_1" } };
    const r = await custom.parse(makeRequest(json(event)), base);
    expect(r.payments[0]).toMatchObject({ transactionId: "refund_re_1", type: "refund", amount: 1500, relatedTransactionId: "pay_1" });
  });

  it("ignores unconfigured events and payloads missing required fields", async () => {
    expect((await custom.parse(makeRequest(json({ ...payment, type: "customer.created" })), base)).ignored).toMatch(/not configured/);
    expect((await custom.parse(makeRequest(json({ type: "payment.succeeded", data: { id: "x" } })), base)).ignored).toMatch(/amount/);
    expect((await custom.parse(makeRequest(json({ type: "payment.succeeded", data: { amount: 5 } })), base)).ignored).toMatch(/transaction id/);
  });

  it("treats every request as a payment when no event type path is set", async () => {
    const r = await custom.parse(makeRequest(json({ data: { id: "p", amount: 300 } })), { ...base, eventTypePath: "" });
    expect(r.payments[0]).toMatchObject({ transactionId: "p", amount: 300, currency: "USD" });
  });

  it("accepts form-encoded bodies", async () => {
    const body = "type=payment.succeeded&data[id]=p9&data[amount]=12.50&data[currency]=GBP";
    const r = await custom.parse(makeRequest(body), { ...base, amountUnit: "major" });
    expect(r.payments[0]).toMatchObject({ transactionId: "p9", amount: 1250, currency: "GBP" });
  });
});
