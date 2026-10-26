import { describe, expect, it } from "vitest";
import { gumroad } from "../../src/server/providers/gumroad";
import { VISITOR, makeRequest } from "./_helpers";

const TOKEN = "f3a9c1d2e4b5a6978877665544332211";

function ping(fields: Record<string, string>) {
  return new URLSearchParams({
    seller_id: "gid_seller",
    product_id: "gid_product",
    product_name: "Pixel Pack",
    permalink: "pixels",
    email: "ada@example.com",
    price: "1500",
    currency: "eur",
    quantity: "1",
    order_number: "524459935",
    sale_id: "FO8TXN-dvxYabdavG97Y-Q==",
    sale_timestamp: "2026-10-20T10:00:00Z",
    full_name: "Ada Lovelace",
    purchaser_id: "1234567890",
    "url_params[openrev_visitor_id]": VISITOR,
    "url_params[utm_source]": "twitter",
    "card[visual]": "**** 4242",
    refunded: "false",
    disputed: "false",
    ...fields,
  }).toString();
}

const url = (token?: string) => `https://x.test/api/webhooks/abc${token !== undefined ? `?token=${token}` : ""}`;
const form = { "content-type": "application/x-www-form-urlencoded" };

describe("gumroad.verify", () => {
  it("requires the ?token= query parameter to match", async () => {
    const body = ping({});
    expect(await gumroad.verify(makeRequest(body, form, url(TOKEN)), { token: TOKEN })).toBe(true);
    expect(await gumroad.verify(makeRequest(body, form, url("wrong")), { token: TOKEN })).toBe(false);
    expect(await gumroad.verify(makeRequest(body, form, url()), { token: TOKEN })).toBe(false);
    expect(await gumroad.verify(makeRequest(body, form, url(TOKEN)), {})).toBe(false);
  });
});

describe("gumroad.parse", () => {
  it("maps a sale ping (form encoded) to a USD payment with the visitor id from url_params", async () => {
    const r = await gumroad.parse(makeRequest(ping({}), form, url(TOKEN)), { token: TOKEN });
    expect(r.payments).toHaveLength(1);
    expect(r.payments[0]).toMatchObject({
      provider: "gumroad",
      transactionId: "FO8TXN-dvxYabdavG97Y-Q==",
      type: "new",
      amount: 1500,
      currency: "USD",
      visitorId: VISITOR,
      email: "ada@example.com",
      name: "Ada Lovelace",
      customerId: "1234567890",
      description: "Pixel Pack",
      timestamp: Date.parse("2026-10-20T10:00:00Z"),
    });
  });

  it("marks recurring charges as renewals", async () => {
    const r = await gumroad.parse(makeRequest(ping({ is_recurring_charge: "true", subscription_id: "sub_gum_1" }), form), {});
    expect(r.payments[0]).toMatchObject({ type: "renewal", subscriptionId: "sub_gum_1" });
  });

  it("reads membership recurrence as the billing interval", async () => {
    const r = await gumroad.parse(makeRequest(ping({ subscription_id: "sub_gum_2", recurrence: "yearly" }), form), {});
    expect(r.payments[0].interval).toEqual({ unit: "year", count: 1 });
    const two = await gumroad.parse(makeRequest(ping({ subscription_id: "sub_gum_3", recurrence: "every_two_years" }), form), {});
    expect(two.payments[0].interval).toEqual({ unit: "year", count: 2 });
  });

  it("ignores the seller's test purchases and free products", async () => {
    expect((await gumroad.parse(makeRequest(ping({ test: "true" }), form), {})).payments).toHaveLength(0);
    expect((await gumroad.parse(makeRequest(ping({ price: "0" }), form), {})).payments).toHaveLength(0);
  });

  it("maps refund resource pings to a full refund linked to the sale", async () => {
    const r = await gumroad.parse(makeRequest(ping({ resource_name: "refund", refunded: "true" }), form), {});
    expect(r.payments).toHaveLength(1);
    expect(r.payments[0]).toMatchObject({
      transactionId: "refund_FO8TXN-dvxYabdavG97Y-Q==",
      type: "refund",
      amount: 1500,
      relatedTransactionId: "FO8TXN-dvxYabdavG97Y-Q==",
    });
  });

  it("accepts JSON bodies", async () => {
    const body = JSON.stringify({ sale_id: "abc", price: 900, url_params: { openrev_visitor_id: VISITOR } });
    const r = await gumroad.parse(makeRequest(body, { "content-type": "application/json" }), {});
    expect(r.payments[0]).toMatchObject({ transactionId: "abc", amount: 900, visitorId: VISITOR });
  });
});
