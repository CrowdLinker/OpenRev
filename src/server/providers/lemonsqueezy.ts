import type { NormalizedGoal, NormalizedPayment } from "../services/payments";
import type { ImportPage, PaymentProvider, ProviderResult, WebhookRequest } from "./types";
import { currencyCode, num, parseJson, pickSessionId, pickVisitorId, str, toMs, verifyHmacSignature } from "./util";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Lemon Squeezy (https://docs.lemonsqueezy.com/help/webhooks).
 *
 * - Signature: `X-Signature` = hex HMAC-SHA256 of the raw body, keyed with the webhook signing secret.
 * - Payload: JSON:API resource in `data` (`data.id`, `data.attributes`), event name and checkout custom data in `meta`.
 * - Amounts are integers in cents of `attributes.currency`.
 *
 * Double counting: a subscription's first payment produces both `order_created` and
 * `subscription_payment_success` (billing_reason `initial`). The order counts as the new payment and
 * initial invoices are skipped; only `renewal`/`updated` invoices are recorded as renewals.
 * Orders and subscription invoices have separate numeric id sequences, hence the `order_` / `invoice_` prefixes.
 */

const PAID_STATUSES = new Set(["paid", "refunded", "partial_refund"]);

function orderPayment(id: string, a: Obj, custom: Obj | null): NormalizedPayment | null {
  if (a.status && !PAID_STATUSES.has(String(a.status))) return null;
  const amount = num(a.total) ?? 0;
  if (amount <= 0) return null;
  const item = a.first_order_item ?? {};
  return {
    provider: "lemonsqueezy",
    transactionId: `order_${id}`,
    type: "new",
    amount,
    currency: currencyCode(a.currency) ?? "USD",
    timestamp: toMs(a.created_at),
    visitorId: pickVisitorId(custom),
    sessionId: pickSessionId(custom),
    customerId: str(a.customer_id),
    email: a.user_email ?? null,
    name: a.user_name ?? null,
    ref: str(a.identifier),
    description: [item.product_name, item.variant_name].filter((s) => s && s !== "Default").join(" — ") || null,
  };
}

function orderRefund(id: string, a: Obj, custom: Obj | null, eventTime?: unknown): NormalizedPayment | null {
  const refunded = num(a.refunded_amount) ?? 0;
  if (refunded <= 0) return null;
  return {
    provider: "lemonsqueezy",
    transactionId: `refund_order_${id}`,
    type: "refund",
    amount: refunded,
    currency: currencyCode(a.currency) ?? "USD",
    timestamp: toMs(a.refunded_at) ?? toMs(eventTime) ?? toMs(a.updated_at),
    visitorId: pickVisitorId(custom),
    customerId: str(a.customer_id),
    email: a.user_email ?? null,
    relatedTransactionId: `order_${id}`,
    cumulative: true,
  };
}

function invoicePayment(id: string, a: Obj, custom: Obj | null): NormalizedPayment | null {
  if (a.status && !PAID_STATUSES.has(String(a.status))) return null;
  if (String(a.billing_reason || "") === "initial") return null;
  const amount = num(a.total) ?? 0;
  if (amount <= 0) return null;
  return {
    provider: "lemonsqueezy",
    transactionId: `invoice_${id}`,
    type: "renewal",
    amount,
    currency: currencyCode(a.currency) ?? "USD",
    timestamp: toMs(a.created_at),
    visitorId: pickVisitorId(custom),
    sessionId: pickSessionId(custom),
    customerId: str(a.customer_id),
    email: a.user_email ?? null,
    name: a.user_name ?? null,
    subscriptionId: str(a.subscription_id),
  };
}

function invoiceRefund(id: string, a: Obj, custom: Obj | null): NormalizedPayment | null {
  if (String(a.billing_reason || "") === "initial") return null;
  const refunded = num(a.refunded_amount) ?? 0;
  if (refunded <= 0) return null;
  return {
    provider: "lemonsqueezy",
    transactionId: `refund_invoice_${id}`,
    type: "refund",
    amount: refunded,
    currency: currencyCode(a.currency) ?? "USD",
    timestamp: toMs(a.refunded_at) ?? toMs(a.updated_at),
    visitorId: pickVisitorId(custom),
    customerId: str(a.customer_id),
    email: a.user_email ?? null,
    subscriptionId: str(a.subscription_id),
    relatedTransactionId: `invoice_${id}`,
    cumulative: true,
  };
}

export function parseLemonSqueezyEvent(event: Obj, eventName?: string | null): ProviderResult {
  const name = String(event.meta?.event_name || eventName || "");
  const data: Obj = event.data ?? {};
  const a: Obj = data.attributes ?? {};
  const id = str(data.id);
  const custom: Obj | null = event.meta?.custom_data && typeof event.meta.custom_data === "object" ? event.meta.custom_data : null;
  const payments: NormalizedPayment[] = [];
  const goals: NormalizedGoal[] = [];
  if (!id) return { payments, ignored: `event ${name || "(unknown)"} without data.id` };

  switch (name) {
    case "order_created": {
      const p = orderPayment(id, a, custom);
      if (!p) return { payments, ignored: `order not paid (status ${a.status ?? "unknown"}) or zero amount` };
      payments.push(p);
      break;
    }
    case "order_refunded": {
      const r = orderRefund(id, a, custom);
      if (!r) return { payments, ignored: "nothing refunded" };
      payments.push(r);
      break;
    }
    case "subscription_payment_success":
    case "subscription_payment_recovered": {
      if (String(a.billing_reason || "") === "initial") {
        return { payments, ignored: "initial subscription payment (counted through order_created)" };
      }
      const p = invoicePayment(id, a, custom);
      if (!p) return { payments, ignored: "invoice not paid or zero amount" };
      payments.push(p);
      break;
    }
    case "subscription_payment_refunded": {
      if (String(a.billing_reason || "") === "initial") {
        return { payments, ignored: "initial subscription payment refund (counted through order_refunded)" };
      }
      const r = invoiceRefund(id, a, custom);
      if (!r) return { payments, ignored: "nothing refunded" };
      payments.push(r);
      break;
    }
    case "subscription_created": {
      if (a.status === "on_trial") {
        goals.push({ name: "trial_started", visitorId: pickVisitorId(custom), customerId: str(a.customer_id), email: a.user_email ?? null });
      }
      break;
    }
    case "subscription_cancelled": {
      goals.push({ name: "subscription_cancel_scheduled", visitorId: pickVisitorId(custom), customerId: str(a.customer_id), email: a.user_email ?? null });
      break;
    }
    case "subscription_expired": {
      goals.push({ name: "subscription_ended", visitorId: pickVisitorId(custom), customerId: str(a.customer_id), email: a.user_email ?? null });
      break;
    }
    default:
      return { payments, ignored: `unhandled event ${name || "(missing meta.event_name)"}` };
  }
  return { payments, goals };
}

const API = "https://api.lemonsqueezy.com/v1";

async function lsGet(key: string, path: string): Promise<Obj> {
  const res = await fetch(`${API}/${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/vnd.api+json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Lemon Squeezy API error ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<Obj>;
}

export const lemonsqueezy: PaymentProvider = {
  id: "lemonsqueezy",
  name: "Lemon Squeezy",
  website: "https://www.lemonsqueezy.com",
  description:
    "Orders, subscription renewals and refunds. Checkout links on your site are tagged with the visitor id automatically; for API checkouts pass it in checkout_data.custom.",
  fields: [
    {
      key: "webhookSecret",
      label: "Webhook signing secret",
      type: "password",
      required: true,
      secret: true,
      help: "The signing secret you typed when creating the webhook in Lemon Squeezy → Settings → Webhooks.",
    },
    {
      key: "apiKey",
      label: "API key for importing past orders",
      type: "password",
      secret: true,
      help: "Lemon Squeezy → Settings → API. Used only to read orders and subscription invoices.",
    },
    {
      key: "storeId",
      label: "Store ID",
      type: "text",
      placeholder: "12345",
      help: "Limit imports to one store when your API key has access to several.",
    },
  ],
  events: [
    "order_created",
    "order_refunded",
    "subscription_payment_success",
    "subscription_payment_refunded",
    "subscription_created",
    "subscription_cancelled",
    "subscription_expired",
  ],
  metadataHint: "checkout_data.custom: { openrev_visitor_id, openrev_session_id }",

  async verify(req: WebhookRequest, config) {
    return verifyHmacSignature({
      algorithm: "sha256",
      secret: config.webhookSecret,
      data: req.rawBody,
      signature: req.headers.get("x-signature"),
      encoding: "hex",
    });
  },

  async parse(req: WebhookRequest) {
    const event = parseJson<Obj>(req.rawBody);
    if (!event) return { payments: [], ignored: "invalid JSON" };
    return parseLemonSqueezyEvent(event, req.headers.get("x-event-name"));
  },

  async importHistory(config, cursor): Promise<ImportPage> {
    const key = config.apiKey;
    if (!key) throw new Error("A Lemon Squeezy API key is required to import past orders.");
    // cursor format: "<phase>:<page>" where phase is orders | invoices
    const [phase, pageStr] = (cursor ?? "orders:1").split(":");
    const page = Math.max(1, Number(pageStr) || 1);
    const store = config.storeId?.trim() ? `&filter[store_id]=${encodeURIComponent(config.storeId.trim())}` : "";
    const resource = phase === "invoices" ? "subscription-invoices" : "orders";
    const list = await lsGet(key, `${resource}?page[number]=${page}&page[size]=100${store}`);
    const payments: NormalizedPayment[] = [];
    for (const row of (list.data ?? []) as Obj[]) {
      const id = str(row.id);
      const a: Obj = row.attributes ?? {};
      if (!id) continue;
      if (phase === "invoices") {
        const p = invoicePayment(id, a, null);
        if (p) payments.push(p);
        const r = invoiceRefund(id, a, null);
        if (r) payments.push(r);
      } else {
        const p = orderPayment(id, a, null);
        if (p) payments.push(p);
        const r = orderRefund(id, a, null);
        if (r) payments.push(r);
      }
    }
    const lastPage = num(list.meta?.page?.lastPage) ?? page;
    let next: string | null = null;
    if (page < lastPage) next = `${phase}:${page + 1}`;
    else if (phase !== "invoices") next = "invoices:1";
    return { payments, nextCursor: next };
  },
};
