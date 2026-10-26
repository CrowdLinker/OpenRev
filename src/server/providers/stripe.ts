import { intervalFromPeriod, parseInterval, type BillingInterval } from "../lib/billing";
import { hmacHex, safeEqual } from "../lib/crypto";
import { isValidClientId } from "../lib/ids";
import type { NormalizedGoal, NormalizedPayment } from "../services/payments";
import type { ImportPage, PaymentProvider, ProviderResult, WebhookRequest } from "./types";
import { num, parseJson, pickSessionId, pickVisitorId, str, toMs } from "./util";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TOLERANCE_SECONDS = 600;

export async function verifyStripeSignature(rawBody: string, signatureHeader: string | null, secret: string | undefined, now = Date.now()) {
  if (!signatureHeader || !secret) return false;
  const parts = signatureHeader.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const v1 = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !/^\d{1,12}$/.test(t) || !v1.length) return false;
  if (Math.abs(now / 1000 - Number(t)) > TOLERANCE_SECONDS) return false;
  const expected = await hmacHex("SHA-256", secret.trim(), `${t}.${rawBody}`);
  return v1.some((sig) => safeEqual(sig, expected));
}

/** Subscription metadata lives in different places depending on the Stripe API version. */
function invoiceMetadata(invoice: Obj): Obj[] {
  return [
    invoice.metadata,
    invoice.subscription_details?.metadata,
    invoice.parent?.subscription_details?.metadata,
    invoice.lines?.data?.[0]?.metadata,
  ].filter(Boolean);
}

/** The billing interval of a subscription invoice: the price's recurring interval, else its line's period. */
function invoiceInterval(invoice: Obj): BillingInterval | null {
  // Every line has a period, so prefer the subscription's own line over a setup fee or one-off item listed first.
  const lines: Obj[] = invoice.lines?.data ?? [];
  const line: Obj = lines.find((l) => l?.price?.recurring || l?.plan) ?? lines.find((l) => l?.period) ?? {};
  const recurring: Obj | undefined = line.price?.recurring ?? line.plan;
  return (
    parseInterval(recurring?.interval, recurring?.interval_count) ??
    intervalFromPeriod(line.period?.start, line.period?.end) ??
    intervalFromPeriod(invoice.period_start, invoice.period_end)
  );
}

function invoiceSubscription(invoice: Obj): string | null {
  return str(invoice.subscription) ?? str(invoice.parent?.subscription_details?.subscription) ?? null;
}

function fromCheckoutSession(s: Obj): NormalizedPayment | null {
  if (s.payment_status && s.payment_status !== "paid") return null;
  if (!s.amount_total) return null;
  const visitor = pickVisitorId(s.metadata) ?? (isValidClientId(s.client_reference_id) ? s.client_reference_id : null);
  return {
    provider: "stripe",
    transactionId: s.mode === "subscription" ? (str(s.invoice) ?? s.id) : (str(s.payment_intent) ?? s.id),
    type: "new",
    amount: s.amount_total,
    currency: String(s.currency || "usd").toUpperCase(),
    timestamp: toMs(s.created),
    visitorId: visitor,
    sessionId: pickSessionId(s.metadata),
    customerId: str(s.customer),
    email: s.customer_details?.email ?? s.customer_email ?? null,
    name: s.customer_details?.name ?? null,
    ref: s.id,
    subscriptionId: str(s.subscription),
  };
}

function fromInvoice(inv: Obj, eventCreated?: number): NormalizedPayment | null {
  const subscription = invoiceSubscription(inv);
  // One-off invoices are created by Checkout (counted via checkout.session.completed) or sent manually.
  if (!subscription) return null;
  const amount = num(inv.amount_paid) ?? 0;
  if (amount <= 0) return null;
  const reason = String(inv.billing_reason || "");
  const isNew = reason === "subscription_create" || reason === "manual";
  const meta = invoiceMetadata(inv);
  return {
    provider: "stripe",
    transactionId: inv.id,
    type: isNew ? "new" : "renewal",
    amount,
    currency: String(inv.currency || "usd").toUpperCase(),
    timestamp: toMs(inv.status_transitions?.paid_at) ?? toMs(eventCreated) ?? toMs(inv.created),
    visitorId: pickVisitorId(...meta),
    sessionId: pickSessionId(...meta),
    customerId: str(inv.customer),
    email: inv.customer_email ?? null,
    name: inv.customer_name ?? null,
    subscriptionId: subscription,
    interval: invoiceInterval(inv),
    description: inv.lines?.data?.[0]?.description ?? null,
  };
}

export function parseStripeEvent(event: Obj): ProviderResult {
  const type = String(event.type || "");
  const obj: Obj = event.data?.object ?? {};
  const payments: NormalizedPayment[] = [];
  const goals: NormalizedGoal[] = [];

  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      if (obj.status && obj.status !== "complete") return { payments, ignored: "checkout not complete" };
      const p = fromCheckoutSession(obj);
      const visitor = pickVisitorId(obj.metadata) ?? (isValidClientId(obj.client_reference_id) ? obj.client_reference_id : null);
      if (!p) {
        if (obj.mode === "subscription" && (obj.amount_total === 0 || obj.payment_status === "no_payment_required")) {
          goals.push({ name: "free_trial", visitorId: visitor, customerId: str(obj.customer), email: obj.customer_details?.email ?? null, ref: obj.id });
          return { payments, goals };
        }
        return { payments, ignored: "unpaid or zero-amount checkout" };
      }
      payments.push(p);
      break;
    }
    case "invoice.paid":
    case "invoice.payment_succeeded": {
      const p = fromInvoice(obj, event.created);
      if (!p) return { payments, ignored: "not a paid subscription invoice" };
      payments.push(p);
      break;
    }
    case "payment_intent.succeeded": {
      // Custom flows (Elements / PaymentIntent API): only when the developer attached a visitor id.
      const visitor = pickVisitorId(obj.metadata);
      if (!visitor) return { payments, ignored: "payment intent without openrev_visitor_id metadata" };
      payments.push({
        provider: "stripe",
        transactionId: obj.id,
        type: "new",
        amount: num(obj.amount_received) ?? num(obj.amount) ?? 0,
        currency: String(obj.currency || "usd").toUpperCase(),
        timestamp: toMs(obj.created),
        visitorId: visitor,
        sessionId: pickSessionId(obj.metadata),
        customerId: str(obj.customer),
        email: obj.receipt_email ?? null,
        description: obj.description ?? null,
      });
      break;
    }
    case "charge.refunded": {
      const refunded = num(obj.amount_refunded) ?? 0;
      if (refunded <= 0) return { payments, ignored: "nothing refunded" };
      payments.push({
        provider: "stripe",
        transactionId: `refund_${obj.id}`,
        type: "refund",
        amount: refunded,
        currency: String(obj.currency || "usd").toUpperCase(),
        timestamp: toMs(event.created) ?? toMs(obj.created),
        visitorId: pickVisitorId(obj.metadata),
        customerId: str(obj.customer),
        email: obj.billing_details?.email ?? obj.receipt_email ?? null,
        relatedTransactionId: str(obj.invoice) ?? str(obj.payment_intent),
        cumulative: true,
      });
      break;
    }
    case "customer.subscription.created": {
      if (obj.status === "trialing") {
        goals.push({ name: "trial_started", visitorId: pickVisitorId(obj.metadata), customerId: str(obj.customer) });
      }
      break;
    }
    case "customer.subscription.updated": {
      const prev = event.data?.previous_attributes ?? {};
      if (obj.cancel_at_period_end && prev.cancel_at_period_end === false) {
        goals.push({ name: "subscription_cancel_scheduled", visitorId: pickVisitorId(obj.metadata), customerId: str(obj.customer) });
      } else if (prev.status === "trialing" && obj.status === "active") {
        goals.push({ name: "trial_converted", visitorId: pickVisitorId(obj.metadata), customerId: str(obj.customer) });
      }
      break;
    }
    case "customer.subscription.deleted": {
      goals.push({ name: "subscription_ended", visitorId: pickVisitorId(obj.metadata), customerId: str(obj.customer) });
      break;
    }
    default:
      return { payments, ignored: `unhandled event ${type}` };
  }
  return { payments, goals };
}

async function stripeGet(key: string, path: string): Promise<Obj> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Stripe API error ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<Obj>;
}

export const stripe: PaymentProvider = {
  id: "stripe",
  name: "Stripe",
  website: "https://stripe.com",
  description:
    "Checkout Sessions, Payment Links, subscriptions (renewals included), PaymentIntents and refunds. Pass the visitor id as metadata, or let the tracker tag Payment Links and detect the checkout success page automatically.",
  fields: [
    {
      key: "webhookSecret",
      label: "Webhook signing secret",
      type: "password",
      required: true,
      placeholder: "whsec_...",
      secret: true,
      help: "Stripe Dashboard → Developers → Webhooks → your endpoint → Signing secret.",
    },
    {
      key: "apiKey",
      label: "Restricted API key (for importing past payments)",
      type: "password",
      placeholder: "rk_live_...",
      secret: true,
      help: "Read-only access to Checkout Sessions, Invoices and Charges is enough.",
    },
  ],
  events: [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "invoice.paid",
    "payment_intent.succeeded",
    "charge.refunded",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ],
  metadataHint: "metadata: { openrev_visitor_id, openrev_session_id }",

  async verify(req: WebhookRequest, config) {
    return verifyStripeSignature(req.rawBody, req.headers.get("stripe-signature"), config.webhookSecret);
  },

  async parse(req: WebhookRequest) {
    const event = parseJson<Obj>(req.rawBody);
    if (!event) return { payments: [], ignored: "invalid JSON" };
    return parseStripeEvent(event);
  },

  async importHistory(config, cursor): Promise<ImportPage> {
    const key = config.apiKey;
    if (!key) throw new Error("A Stripe API key is required to import past payments.");
    // cursor format: "<phase>:<starting_after>" where phase is sessions | invoices | charges
    const [phase = "sessions", after] = (cursor ?? "sessions:").split(":");
    if (!["sessions", "invoices", "charges"].includes(phase)) throw new Error("Invalid import cursor");
    const qs = `limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`;
    const payments: NormalizedPayment[] = [];
    let list: Obj;
    if (phase === "sessions") {
      list = await stripeGet(key, `checkout/sessions?${qs}&status=complete`);
      for (const s of list.data ?? []) {
        if (s.mode === "subscription") continue; // counted through invoices
        const p = fromCheckoutSession(s);
        if (p) payments.push(p);
      }
    } else if (phase === "invoices") {
      list = await stripeGet(key, `invoices?${qs}&status=paid`);
      for (const inv of list.data ?? []) {
        const p = fromInvoice(inv);
        if (p) payments.push(p);
      }
    } else {
      list = await stripeGet(key, `charges?${qs}`);
      for (const ch of list.data ?? []) {
        if (!ch.amount_refunded) continue;
        const r = parseStripeEvent({ type: "charge.refunded", created: ch.created, data: { object: ch } });
        payments.push(...r.payments);
      }
    }
    const data = (list.data ?? []) as Obj[];
    const last = data[data.length - 1]?.id;
    let next: string | null = null;
    if (list.has_more && last) next = `${phase}:${last}`;
    else if (phase === "sessions") next = "invoices:";
    else if (phase === "invoices") next = "charges:";
    return { payments, nextCursor: next };
  },
};
