import { afterEach, describe, expect, it, vi } from "vitest";
import { dodo } from "../../src/server/providers/dodo";
import { paddle } from "../../src/server/providers/paddle";
import { paystack } from "../../src/server/providers/paystack";
import { polar } from "../../src/server/providers/polar";
import { VISITOR } from "./_helpers";

/** Records each request and answers with the first matching fixture. */
function fakeApi(routes: [RegExp, unknown][]) {
  const calls: { url: string; auth: string | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    const hit = routes.find(([re]) => re.test(url));
    return hit ? Response.json(hit[1]) : new Response("not found", { status: 404 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("polar.importHistory", () => {
  const order = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    created_at: "2026-03-01T10:00:00Z",
    modified_at: "2026-03-05T10:00:00Z",
    status: "paid",
    paid: true,
    total_amount: 2900,
    currency: "usd",
    billing_reason: "subscription_create",
    customer: { id: "cus_1", email: "ada@example.com", name: "Ada" },
    subscription_id: "sub_1",
    subscription: { recurring_interval: "month", recurring_interval_count: 1 },
    metadata: { openrev_visitor_id: VISITOR },
    ...extra,
  });

  it("pages through orders, oldest first, with their refunds", async () => {
    const calls = fakeApi([
      [/page=1&/, { items: [order("o1"), order("o2", { status: "partially_refunded", refunded_amount: 900, billing_reason: "subscription_cycle" })], pagination: { total_count: 3, max_page: 2 } }],
      [/page=2&/, { items: [order("o3", { billing_reason: "purchase", subscription_id: null, subscription: null })], pagination: { total_count: 3, max_page: 2 } }],
    ]);
    const first = await polar.importHistory!({ accessToken: "polar_oat_x" }, null);
    expect(calls[0].url).toBe("https://api.polar.sh/v1/orders/?page=1&limit=100&sorting=created_at&status=paid&status=refunded&status=partially_refunded");
    expect(calls[0].auth).toBe("Bearer polar_oat_x");
    expect(first.payments.map((p) => [p.transactionId, p.type, p.amount])).toEqual([
      ["o1", "new", 2900],
      ["o2", "renewal", 2900],
      ["refund_o2", "refund", 900],
    ]);
    expect(first.payments[0]).toMatchObject({ visitorId: VISITOR, email: "ada@example.com", interval: { unit: "month", count: 1 } });
    expect(first.nextCursor).toBe("2");
    const second = await polar.importHistory!({ accessToken: "polar_oat_x", environment: "sandbox" }, first.nextCursor);
    expect(calls[1].url.startsWith("https://sandbox-api.polar.sh/v1/orders/?page=2&")).toBe(true);
    expect(second.payments.map((p) => p.transactionId)).toEqual(["o3"]);
    expect(second.nextCursor).toBeNull();
  });

  it("needs an access token", async () => {
    await expect(polar.importHistory!({}, null)).rejects.toThrow(/access token/);
  });
});

describe("paddle.importHistory", () => {
  const txn = (id: string, origin = "web") => ({
    id,
    status: "completed",
    origin,
    billed_at: "2026-04-01T09:00:00Z",
    currency_code: "EUR",
    customer_id: "ctm_1",
    customer: { id: "ctm_1", email: "grace@example.com", name: "Grace" },
    subscription_id: "sub_1",
    custom_data: { openrev_visitor_id: VISITOR },
    details: { totals: { grand_total: "4900", currency_code: "EUR" } },
    items: [{ price: { description: "Pro", billing_cycle: { interval: "year", frequency: 1 } } }],
  });

  it("imports completed transactions with their customer, then approved refunds", async () => {
    const calls = fakeApi([
      [/\/transactions\?.*after=txn_2/, { data: [txn("txn_3", "subscription_recurring")], meta: { pagination: { has_more: false } } }],
      [/\/transactions\?/, { data: [txn("txn_1"), txn("txn_2")], meta: { pagination: { has_more: true, next: "https://api.paddle.com/transactions?after=txn_2" } } }],
      [
        /\/adjustments\?/,
        {
          data: [{ id: "adj_1", action: "refund", status: "approved", transaction_id: "txn_1", currency_code: "EUR", totals: { total: "4900" }, created_at: "2026-04-03T00:00:00Z" }],
          meta: { pagination: { has_more: false } },
        },
      ],
    ]);
    const key = "pdl_live_apikey_abc";
    const first = await paddle.importHistory!({ apiKey: key }, null);
    expect(calls[0].url).toBe("https://api.paddle.com/transactions?status=completed,paid&include=customer&per_page=30&order_by=id%5BASC%5D");
    expect(first.payments[0]).toMatchObject({ transactionId: "txn_1", type: "new", amount: 4900, currency: "EUR", email: "grace@example.com", visitorId: VISITOR, interval: { unit: "year", count: 1 } });
    expect(first.nextCursor).toBe("transactions:txn_2");
    const second = await paddle.importHistory!({ apiKey: key }, first.nextCursor);
    expect(second.payments.map((p) => [p.transactionId, p.type])).toEqual([["txn_3", "renewal"]]);
    expect(second.nextCursor).toBe("adjustments:");
    const third = await paddle.importHistory!({ apiKey: key }, second.nextCursor);
    expect(calls[2].url).toBe("https://api.paddle.com/adjustments?action=refund,chargeback&status=approved&per_page=50&order_by=id%5BASC%5D");
    expect(third.payments[0]).toMatchObject({ transactionId: "adj_1", type: "refund", amount: 4900, relatedTransactionId: "txn_1" });
    expect(third.nextCursor).toBeNull();
  });

  it("uses the sandbox API for sandbox keys", async () => {
    const calls = fakeApi([[/./, { data: [], meta: { pagination: { has_more: false } } }]]);
    await paddle.importHistory!({ apiKey: "pdl_sdbx_apikey_abc" }, null);
    expect(calls[0].url.startsWith("https://sandbox-api.paddle.com/transactions?")).toBe(true);
  });
});

describe("dodo.importHistory", () => {
  const payment = (id: string, charge_type = "new") => ({
    payment_id: id,
    status: "succeeded",
    total_amount: 1500,
    currency: "USD",
    created_at: "2026-05-01T12:00:00Z",
    charge_type,
    customer: { customer_id: "cus_9", email: "linus@example.com", name: "Linus" },
    subscription_id: "sub_9",
    metadata: { openrev_visitor_id: VISITOR },
  });

  it("pages through succeeded payments, then refunds", async () => {
    const full = Array.from({ length: 100 }, (_, i) => payment(`pay_${i}`, i ? "renewal" : "new"));
    const calls = fakeApi([
      [/\/payments\?.*page_number=0/, { items: full }],
      [/\/payments\?.*page_number=1/, { items: [payment("pay_100", "renewal")] }],
      [/\/refunds\?/, { items: [{ refund_id: "ref_1", payment_id: "pay_0", amount: 1500, currency: "USD", status: "succeeded", created_at: "2026-05-02T00:00:00Z", is_partial: false }] }],
    ]);
    const first = await dodo.importHistory!({ apiKey: "dodo_key", environment: "test" }, null);
    expect(calls[0].url).toBe("https://test.dodopayments.com/payments?page_size=100&page_number=0&status=succeeded");
    expect(first.payments).toHaveLength(100);
    expect(first.payments[0]).toMatchObject({ transactionId: "pay_0", type: "new", email: "linus@example.com", visitorId: VISITOR });
    expect(first.nextCursor).toBe("payments:1");
    const second = await dodo.importHistory!({ apiKey: "dodo_key" }, first.nextCursor);
    expect(calls[1].url.startsWith("https://live.dodopayments.com/payments?")).toBe(true);
    expect(second.nextCursor).toBe("refunds:0");
    const third = await dodo.importHistory!({ apiKey: "dodo_key" }, second.nextCursor);
    expect(third.payments).toEqual([expect.objectContaining({ transactionId: "ref_1", type: "refund", amount: 1500, relatedTransactionId: "pay_0" })]);
    expect(third.nextCursor).toBeNull();
  });

  it("reports API errors with the provider's name", async () => {
    fakeApi([]);
    await expect(dodo.importHistory!({ apiKey: "bad" }, null)).rejects.toThrow(/Dodo Payments API error 404/);
  });
});

describe("paystack.importHistory", () => {
  const charge = (reference: string, extra: Record<string, unknown> = {}) => ({
    id: Number(reference.replace(/\D/g, "")),
    reference,
    status: "success",
    amount: 500000,
    currency: "NGN",
    paid_at: "2026-02-10T08:00:00.000Z",
    customer: { customer_code: "CUS_1", email: "chika@example.com", first_name: "Chika", last_name: "O" },
    metadata: { openrev_visitor_id: VISITOR },
    ...extra,
  });

  it("imports successful transactions, then processed refunds with their transaction reference", async () => {
    const calls = fakeApi([
      [/\/transaction\?.*page=1&/, { status: true, data: [charge("ref_1")], meta: { total: 2, perPage: 100, page: 1, pageCount: 2 } }],
      [/\/transaction\?.*page=2&/, { status: true, data: [charge("ref_2", { plan: { plan_code: "PLN_1", interval: "monthly" }, metadata: null })], meta: { pageCount: 2 } }],
      [/\/refund\?/, { status: true, data: [{ id: 77, transaction: 1, amount: 500000, currency: "NGN", status: "processed", createdAt: "2026-02-12T00:00:00.000Z" }], meta: { pageCount: 1 } }],
      [/\/transaction\/1$/, { status: true, data: charge("ref_1") }],
    ]);
    const first = await paystack.importHistory!({ secretKey: "sk_test_x" }, null);
    expect(calls[0]).toEqual({ url: "https://api.paystack.co/transaction?perPage=100&page=1&status=success", auth: "Bearer sk_test_x" });
    expect(first.payments[0]).toMatchObject({ transactionId: "ref_1", type: "new", amount: 500000, email: "chika@example.com", visitorId: VISITOR });
    expect(first.nextCursor).toBe("transactions:2");
    const second = await paystack.importHistory!({ secretKey: "sk_test_x" }, first.nextCursor);
    expect(second.payments[0]).toMatchObject({ transactionId: "ref_2", type: "renewal", interval: { unit: "month", count: 1 } });
    expect(second.nextCursor).toBe("refunds:1");
    const third = await paystack.importHistory!({ secretKey: "sk_test_x" }, second.nextCursor);
    expect(third.payments).toEqual([expect.objectContaining({ transactionId: "refund_77", type: "refund", relatedTransactionId: "ref_1", email: "chika@example.com" })]);
    expect(third.nextCursor).toBeNull();
  });
});
