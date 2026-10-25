import { describe, expect, it } from "vitest";
import { creem } from "../../src/server/providers/creem";
import { SESSION, VISITOR, json, makeRequest, signHex } from "./_helpers";

const SECRET = "whsec_creem_secret_123";

async function signed(event: unknown, secret = SECRET) {
  const body = json(event);
  return makeRequest(body, { "creem-signature": await signHex("SHA-256", secret, body) });
}

const customer = { id: "cust_1OcIK1GEuVvXZwD19tjq2z", object: "customer", email: "ada@example.com", name: "Ada", country: "NL" };

function checkout(overrides: Record<string, unknown> = {}, order: Record<string, unknown> = {}) {
  return {
    id: "evt_5WHHcZPv7VS0YUsberIuOz",
    eventType: "checkout.completed",
    created_at: 1728734325927,
    object: {
      id: "ch_4l0N34kxo16AhRKUHFUuXr",
      object: "checkout",
      status: "completed",
      order: {
        id: "ord_4aDwWXjMLpes4Kj4XqNnUA",
        customer: customer.id,
        amount: 1000,
        sub_total: 1000,
        tax_amount: 210,
        amount_due: 1210,
        amount_paid: 1210,
        currency: "EUR",
        status: "paid",
        type: "onetime",
        transaction: "tran_5yMaWzAl3jxuGJMCOrYWwk",
        created_at: "2024-10-12T11:58:33.097Z",
        ...order,
      },
      product: { id: "prod_1", name: "Monthly", price: 1000, currency: "EUR" },
      customer,
      metadata: { openrev_visitor_id: VISITOR, openrev_session_id: SESSION },
      ...overrides,
    },
  };
}

function subscriptionPaid(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_21mO1jWmU2QHe7u2oFV7y1",
    eventType: "subscription.paid",
    created_at: 1728734327355,
    object: {
      id: "sub_6pC2lNB6joCRQIZ1aMrTpi",
      object: "subscription",
      product: { id: "prod_1", name: "Monthly", price: 1000, currency: "EUR" },
      customer,
      status: "active",
      last_transaction_id: "tran_5yMaWzAl3jxuGJMCOrYWwk",
      last_transaction: { id: "tran_5yMaWzAl3jxuGJMCOrYWwk", amount: 1000, amount_paid: 1210, currency: "EUR" },
      last_transaction_date: "2024-10-12T11:58:47.109Z",
      created_at: "2024-10-12T11:58:45.425Z",
      metadata: { openrev_visitor_id: VISITOR },
      ...overrides,
    },
  };
}

describe("creem.verify", () => {
  it("accepts a valid creem-signature and rejects tampered or wrongly signed requests", async () => {
    const req = await signed(checkout());
    expect(await creem.verify(req, { webhookSecret: SECRET })).toBe(true);
    expect(await creem.verify({ ...req, rawBody: req.rawBody.replace("1210", "1") }, { webhookSecret: SECRET })).toBe(false);
    expect(await creem.verify(await signed(checkout(), "other"), { webhookSecret: SECRET })).toBe(false);
    expect(await creem.verify(makeRequest(req.rawBody), { webhookSecret: SECRET })).toBe(false);
  });
});

describe("creem.parse", () => {
  it("maps checkout.completed to a new payment keyed by the transaction id with the checkout id as ref", async () => {
    const r = await creem.parse(await signed(checkout()), {});
    expect(r.payments[0]).toMatchObject({
      provider: "creem",
      transactionId: "tran_5yMaWzAl3jxuGJMCOrYWwk",
      type: "new",
      amount: 1210,
      currency: "EUR",
      visitorId: VISITOR,
      sessionId: SESSION,
      ref: "ch_4l0N34kxo16AhRKUHFUuXr",
      customerId: customer.id,
      email: "ada@example.com",
    });
  });

  it("keys the first subscription.paid to the same transaction as the checkout (no double counting)", async () => {
    const co = await creem.parse(await signed(checkout({ subscription: { id: "sub_6pC2lNB6joCRQIZ1aMrTpi", metadata: {} } }, { type: "recurring" })), {});
    const first = await creem.parse(await signed(subscriptionPaid()), {});
    expect(first.payments[0]).toMatchObject({ transactionId: co.payments[0].transactionId, type: "new", amount: 1210 });
  });

  it("marks later subscription.paid events as renewals", async () => {
    const r = await creem.parse(
      await signed(
        subscriptionPaid({
          last_transaction_id: "tran_next",
          last_transaction: { id: "tran_next", amount_paid: 1210, currency: "EUR" },
          last_transaction_date: "2024-11-12T11:58:47.109Z",
        }),
      ),
      {},
    );
    expect(r.payments[0]).toMatchObject({ transactionId: "tran_next", type: "renewal", subscriptionId: "sub_6pC2lNB6joCRQIZ1aMrTpi", visitorId: VISITOR });
  });

  it("falls back to the product price when the payload has no transaction details", async () => {
    const r = await creem.parse(
      await signed(subscriptionPaid({ last_transaction: undefined, last_transaction_id: "tran_x", last_transaction_date: "2024-12-12T11:58:47.109Z" })),
      {},
    );
    expect(r.payments[0]).toMatchObject({ transactionId: "tran_x", amount: 1000, currency: "EUR", type: "renewal" });
  });

  it("defers subscription checkouts without a transaction id to subscription.paid", async () => {
    const r = await creem.parse(await signed(checkout({ subscription: { id: "sub_1" } }, { transaction: undefined, type: "recurring" })), {});
    expect(r.payments).toHaveLength(0);
    expect(r.ignored).toMatch(/subscription.paid/);
  });

  it("maps refund.created to a refund linked to the transaction", async () => {
    const r = await creem.parse(
      await signed({
        id: "evt_61eTsJHUgInFw2BQKhTiPV",
        eventType: "refund.created",
        created_at: 1728734351631,
        object: {
          id: "ref_3DB9NQFvk18TJwSqd0N6bd",
          status: "succeeded",
          refund_amount: 1210,
          refund_currency: "EUR",
          reason: "requested_by_customer",
          transaction: { id: "tran_5yMaWzAl3jxuGJMCOrYWwk", amount_paid: 1210, currency: "EUR" },
          checkout: { id: "ch_4l0N34kxo16AhRKUHFUuXr", metadata: { openrev_visitor_id: VISITOR } },
          customer,
          created_at: 1728734351525,
        },
      }),
      {},
    );
    expect(r.payments[0]).toMatchObject({
      transactionId: "ref_3DB9NQFvk18TJwSqd0N6bd",
      type: "refund",
      amount: 1210,
      currency: "EUR",
      visitorId: VISITOR,
      relatedTransactionId: "tran_5yMaWzAl3jxuGJMCOrYWwk",
    });
  });

  it("emits subscription goals", async () => {
    const goal = async (eventType: string) =>
      (await creem.parse(await signed({ eventType, created_at: 1, object: { id: "sub_1", customer, metadata: { openrev_visitor_id: VISITOR } } }), {})).goals?.[0];
    expect(await goal("subscription.trialing")).toMatchObject({ name: "trial_started", visitorId: VISITOR });
    expect((await goal("subscription.scheduled_cancel"))?.name).toBe("subscription_cancel_scheduled");
    expect((await goal("subscription.canceled"))?.name).toBe("subscription_ended");
  });
});
