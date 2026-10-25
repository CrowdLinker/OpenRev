import type { NormalizedGoal, NormalizedPayment } from "../services/payments";
import type { PaymentProvider, ProviderResult, WebhookRequest } from "./types";
import { currencyCode, num, parseJson, pickSessionId, pickVisitorId, str, toMs, verifyHmacSignature } from "./util";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Creem (https://docs.creem.io/code/webhooks).
 *
 * - Signature: `creem-signature` = hex HMAC-SHA256 of the raw body, keyed with the webhook secret.
 * - Envelope: `{ id, eventType, created_at, object }`. Amounts are integers in cents.
 * - Double counting: a subscription's first payment produces `checkout.completed` *and* `subscription.paid`.
 *   Both are keyed by the Creem transaction id (`order.transaction` / `last_transaction_id`), so whichever arrives
 *   second merges into the first instead of adding revenue.
 * - Checkout metadata is copied onto the subscription, so renewals carry the visitor id too.
 * - `ref` is the checkout id: Creem appends `?checkout_id=…` to the success URL, which the tracker reports.
 */

/** A `subscription.paid` this close to the subscription's creation is its first payment, not a renewal. */
const FIRST_PAYMENT_WINDOW_MS = 60 * 60 * 1000;

function customerOf(o: Obj): Obj {
  return o.customer && typeof o.customer === "object" ? o.customer : {};
}

function checkoutPayment(c: Obj): NormalizedPayment | null {
  const order: Obj = c.order ?? {};
  if (c.status && c.status !== "completed") return null;
  if (order.status && order.status !== "paid") return null;
  const amount = num(order.amount_paid) ?? num(order.amount_due) ?? num(order.amount) ?? 0;
  if (amount <= 0) return null;
  const customer = customerOf(c);
  const bags = [c.metadata, c.subscription?.metadata].filter(Boolean);
  const subscription = c.subscription && typeof c.subscription === "object" ? c.subscription : null;
  const txId = str(order.transaction) ?? str(subscription?.last_transaction_id);
  // Without a transaction id a subscription checkout cannot be matched with its `subscription.paid` event;
  // let that event count the payment instead (it carries the same metadata).
  if (!txId && (subscription || c.subscription)) return null;
  return {
    provider: "creem",
    transactionId: txId ?? str(order.id) ?? String(c.id),
    type: "new",
    amount,
    currency: currencyCode(order.currency) ?? currencyCode(c.product?.currency) ?? "USD",
    timestamp: toMs(order.created_at),
    visitorId: pickVisitorId(...bags),
    sessionId: pickSessionId(...bags),
    customerId: str(customer.id) ?? str(order.customer),
    email: customer.email ?? null,
    name: customer.name ?? null,
    ref: str(c.id),
    subscriptionId: str(c.subscription?.id) ?? str(c.subscription),
    description: c.product?.name ?? null,
  };
}

function subscriptionPayment(s: Obj, eventCreated?: unknown): NormalizedPayment | null {
  const tx: Obj = s.last_transaction && typeof s.last_transaction === "object" ? s.last_transaction : {};
  const txId = str(s.last_transaction_id) ?? str(tx.id);
  if (!txId) return null;
  const product: Obj = s.product && typeof s.product === "object" ? s.product : {};
  // Prefer the transaction amount; fall back to the product price when the payload has no transaction details.
  const units = num(s.items?.[0]?.units) ?? 1;
  const price = num(product.price);
  const amount = num(tx.amount_paid) ?? num(tx.amount) ?? (price !== null ? price * units : 0);
  if (amount <= 0) return null;
  const paidAt = toMs(s.last_transaction_date) ?? toMs(tx.created_at) ?? toMs(eventCreated);
  const createdAt = toMs(s.created_at);
  const isFirst = paidAt !== null && createdAt !== null && Math.abs(paidAt - createdAt) < FIRST_PAYMENT_WINDOW_MS;
  const customer = customerOf(s);
  return {
    provider: "creem",
    transactionId: txId,
    type: isFirst ? "new" : "renewal",
    amount,
    currency: currencyCode(tx.currency) ?? currencyCode(product.currency) ?? "USD",
    timestamp: paidAt,
    visitorId: pickVisitorId(s.metadata),
    sessionId: pickSessionId(s.metadata),
    customerId: str(customer.id) ?? str(s.customer),
    email: customer.email ?? null,
    name: customer.name ?? null,
    subscriptionId: str(s.id),
    description: product.name ?? null,
  };
}

export function parseCreemEvent(event: Obj): ProviderResult {
  const type = String(event.eventType || event.type || "");
  const o: Obj = event.object ?? {};
  const payments: NormalizedPayment[] = [];
  const goals: NormalizedGoal[] = [];
  const subGoal = (name: string): NormalizedGoal => {
    const customer = customerOf(o);
    return {
      name,
      visitorId: pickVisitorId(o.metadata),
      customerId: str(customer.id) ?? str(o.customer),
      email: customer.email ?? null,
      timestamp: toMs(event.created_at),
    };
  };

  switch (type) {
    case "checkout.completed": {
      const p = checkoutPayment(o);
      if (!p) {
        const reason = o.subscription && !o.order?.transaction && !o.subscription?.last_transaction_id
          ? "subscription checkout without transaction id (counted through subscription.paid)"
          : "checkout not completed/paid or zero amount";
        return { payments, ignored: reason };
      }
      payments.push(p);
      break;
    }
    case "subscription.paid": {
      const p = subscriptionPayment(o, event.created_at);
      if (!p) return { payments, ignored: "subscription payment without transaction id or amount" };
      payments.push(p);
      break;
    }
    case "refund.created": {
      const amount = num(o.refund_amount) ?? 0;
      if (o.status && o.status !== "succeeded") return { payments, ignored: `refund status ${o.status}` };
      if (!o.id || amount <= 0) return { payments, ignored: "refund without id or amount" };
      const customer = customerOf(o);
      const tx: Obj = o.transaction && typeof o.transaction === "object" ? o.transaction : {};
      payments.push({
        provider: "creem",
        transactionId: String(o.id),
        type: "refund",
        amount,
        currency: currencyCode(o.refund_currency) ?? currencyCode(tx.currency) ?? "USD",
        timestamp: toMs(o.created_at) ?? toMs(event.created_at),
        visitorId: pickVisitorId(o.checkout?.metadata, o.subscription?.metadata),
        customerId: str(customer.id) ?? str(tx.customer),
        email: customer.email ?? null,
        subscriptionId: str(o.subscription?.id) ?? str(tx.subscription),
        relatedTransactionId: str(tx.id) ?? str(o.transaction),
        description: o.reason ?? null,
      });
      break;
    }
    case "subscription.trialing":
      goals.push(subGoal("trial_started"));
      break;
    case "subscription.scheduled_cancel":
      goals.push(subGoal("subscription_cancel_scheduled"));
      break;
    case "subscription.canceled":
      goals.push(subGoal("subscription_ended"));
      break;
    default:
      return { payments, ignored: `unhandled event ${type}` };
  }
  return { payments, goals };
}

export const creem: PaymentProvider = {
  id: "creem",
  name: "Creem",
  website: "https://www.creem.io",
  description:
    "One-time payments, subscription renewals and refunds. Pass the visitor id as checkout metadata (API or metadata[...] link parameters); the checkout_id on your success URL is detected automatically.",
  fields: [
    {
      key: "webhookSecret",
      label: "Webhook signing secret",
      type: "password",
      required: true,
      placeholder: "whsec_...",
      secret: true,
      help: "Creem → Developers → Webhooks → your webhook → Signing secret.",
    },
  ],
  events: ["checkout.completed", "subscription.paid", "refund.created", "subscription.trialing", "subscription.scheduled_cancel", "subscription.canceled"],
  metadataHint: "metadata: { openrev_visitor_id, openrev_session_id }",

  async verify(req: WebhookRequest, config) {
    return verifyHmacSignature({
      algorithm: "sha256",
      secret: config.webhookSecret,
      data: req.rawBody,
      signature: req.headers.get("creem-signature"),
      encoding: "hex",
    });
  },

  async parse(req: WebhookRequest) {
    const event = parseJson<Obj>(req.rawBody);
    if (!event) return { payments: [], ignored: "invalid JSON" };
    return parseCreemEvent(event);
  },
};
