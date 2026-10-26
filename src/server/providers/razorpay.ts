import { intervalFromPeriod } from "../lib/billing";
import type { NormalizedPayment } from "../services/payments";
import type { PaymentProvider, ProviderResult, WebhookRequest } from "./types";
import { currencyCode, num, parseJson, pickSessionId, pickVisitorId, str, toMs, verifyHmacSignature } from "./util";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Razorpay (https://razorpay.com/docs/webhooks/validate-test/).
 *
 * - Signature: `X-Razorpay-Signature` = hex HMAC-SHA256 of the raw body keyed with the webhook secret.
 * - Envelope: `{ event, payload: { payment: { entity }, order: { entity }, refund: { entity }, subscription: { entity } } }`.
 * - Amounts are integers in the currency subunit (paise for INR).
 * - Visitor ids live in `notes` (payment notes from Checkout options, or order / subscription / invoice notes).
 * - One-time payments: `payment.captured` and/or `order.paid` (both keyed by the payment id, so enabling both is safe).
 * - Subscriptions: payments carry an `invoice_id`; they are counted from `subscription.charged`
 *   (`paid_count` 1 → new, >1 → renewal) and skipped in `payment.captured` / `order.paid` to avoid double counting.
 *   Standalone Razorpay Invoices are counted from `invoice.paid`.
 */

function entity(event: Obj, key: string): Obj | null {
  const e = event.payload?.[key]?.entity;
  return e && typeof e === "object" ? e : null;
}

function notesOf(...objs: (Obj | null)[]): Obj[] {
  return objs.map((o) => o?.notes).filter((n) => n && typeof n === "object" && !Array.isArray(n));
}

function paymentFrom(p: Obj, bags: Obj[], type: "new" | "renewal", subscriptionId?: string | null): NormalizedPayment | null {
  if (p.status && p.status !== "captured") return null;
  const amount = num(p.amount) ?? 0;
  if (amount <= 0 || !p.id) return null;
  return {
    provider: "razorpay",
    transactionId: String(p.id),
    type,
    amount,
    currency: currencyCode(p.currency) ?? "INR",
    timestamp: toMs(p.created_at),
    visitorId: pickVisitorId(...bags),
    sessionId: pickSessionId(...bags),
    customerId: str(p.customer_id) ?? null,
    email: p.email || null,
    ref: str(p.order_id),
    subscriptionId: subscriptionId ?? null,
    description: p.description ?? null,
  };
}

export function parseRazorpayEvent(event: Obj): ProviderResult {
  const type = String(event.event || "");
  const payments: NormalizedPayment[] = [];
  const payment = entity(event, "payment");

  switch (type) {
    case "payment.captured":
    case "order.paid": {
      if (!payment) return { payments, ignored: "event without payment entity" };
      if (payment.invoice_id) {
        return { payments, ignored: "invoice/subscription payment (counted through subscription.charged or invoice.paid)" };
      }
      const order = entity(event, "order");
      const p = paymentFrom(payment, notesOf(payment, order), "new");
      if (!p) return { payments, ignored: "payment not captured or zero amount" };
      payments.push(p);
      break;
    }
    case "subscription.charged": {
      const sub = entity(event, "subscription");
      if (!payment || !sub) return { payments, ignored: "event without payment or subscription entity" };
      const paidCount = num(sub.paid_count) ?? 1;
      const p = paymentFrom(payment, notesOf(payment, sub), paidCount > 1 ? "renewal" : "new", str(sub.id));
      if (!p) return { payments, ignored: "payment not captured or zero amount" };
      if (!p.customerId) p.customerId = str(sub.customer_id);
      // The subscription's current billing cycle gives its interval (Razorpay plans don't come with the event).
      p.interval = intervalFromPeriod(sub.current_start, sub.current_end);
      payments.push(p);
      break;
    }
    case "invoice.paid": {
      const invoice = entity(event, "invoice");
      if (!payment || !invoice) return { payments, ignored: "event without payment or invoice entity" };
      if (invoice.subscription_id) return { payments, ignored: "subscription invoice (counted through subscription.charged)" };
      const order = entity(event, "order");
      const p = paymentFrom(payment, notesOf(payment, invoice, order), "new");
      if (!p) return { payments, ignored: "payment not captured or zero amount" };
      if (!p.customerId) p.customerId = str(invoice.customer_id);
      payments.push(p);
      break;
    }
    case "refund.processed": {
      const refund = entity(event, "refund");
      if (!refund) return { payments, ignored: "event without refund entity" };
      const amount = num(refund.amount) ?? 0;
      if (amount <= 0 || !refund.id) return { payments, ignored: "refund without id or amount" };
      payments.push({
        provider: "razorpay",
        transactionId: String(refund.id),
        type: "refund",
        amount,
        currency: currencyCode(refund.currency) ?? currencyCode(payment?.currency) ?? "INR",
        timestamp: toMs(refund.created_at) ?? toMs(event.created_at),
        visitorId: pickVisitorId(...notesOf(refund, payment)),
        customerId: str(payment?.customer_id),
        email: payment?.email || null,
        relatedTransactionId: str(refund.payment_id) ?? str(payment?.id),
      });
      break;
    }
    default:
      return { payments, ignored: `unhandled event ${type}` };
  }
  return { payments };
}

export const razorpay: PaymentProvider = {
  id: "razorpay",
  name: "Razorpay",
  website: "https://razorpay.com",
  description:
    "Captured payments (Checkout, Payment Links, Invoices), subscription charges and refunds. Pass the visitor id in `notes` when creating the order, subscription or Checkout.",
  fields: [
    {
      key: "webhookSecret",
      label: "Webhook secret",
      type: "password",
      required: true,
      secret: true,
      help: "The secret you entered when creating the webhook in Razorpay → Accounts & Settings → Webhooks (not your API key secret).",
    },
  ],
  events: ["payment.captured", "order.paid", "subscription.charged", "invoice.paid", "refund.processed"],
  metadataHint: "notes: { openrev_visitor_id, openrev_session_id }",

  async verify(req: WebhookRequest, config) {
    return verifyHmacSignature({
      algorithm: "sha256",
      secret: config.webhookSecret,
      data: req.rawBody,
      signature: req.headers.get("x-razorpay-signature"),
      encoding: "hex",
    });
  },

  async parse(req: WebhookRequest) {
    const event = parseJson<Obj>(req.rawBody);
    if (!event) return { payments: [], ignored: "invalid JSON" };
    return parseRazorpayEvent(event);
  },
};
