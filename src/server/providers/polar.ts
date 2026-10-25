import type { NormalizedGoal, NormalizedPayment } from "../services/payments";
import type { PaymentProvider, ProviderResult, WebhookRequest } from "./types";
import { currencyCode, num, parseJson, pickSessionId, pickVisitorId, str, toMs, verifyStandardWebhook } from "./util";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Polar (https://polar.sh/docs/integrate/webhooks/delivery).
 *
 * - Signature: Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`).
 *   Secrets created before 8 Sep 2026 use "Polar HMAC" (key = UTF-8 bytes of the whole `whsec_…` string, which is
 *   what `@polar-sh/sdk` `validateEvent` does by base64-encoding the secret before handing it to standardwebhooks);
 *   newer secrets are plain Standard Webhooks (`whsec_<base64>`). Like Polar's SDKs we try both keys.
 * - `order.paid` is sent once per paid order. `billing_reason`: `purchase` / `subscription_create` → new;
 *   `subscription_cycle` / `subscription_update` / `subscription_meter_cycle` → renewal.
 * - Amounts are integers in cents. `order.refunded` carries cumulative `refunded_amount` (+ `refunded_tax_amount`).
 * - Checkout `metadata` is copied to the order and subscription; `customer_metadata` to the customer.
 */

const RENEWAL_REASONS = new Set(["subscription_cycle", "subscription_update", "subscription_meter_cycle"]);

function orderBags(o: Obj): Obj[] {
  return [o.metadata, o.subscription?.metadata, o.customer?.metadata, o.custom_field_data].filter(Boolean);
}

function orderPayment(o: Obj, eventTime?: unknown): NormalizedPayment | null {
  if (o.paid === false) return null;
  if (o.status && !["paid", "refunded", "partially_refunded"].includes(String(o.status))) return null;
  const amount = num(o.total_amount) ?? (num(o.net_amount) ?? 0) + (num(o.tax_amount) ?? 0);
  if (!amount || amount <= 0) return null;
  const bags = orderBags(o);
  return {
    provider: "polar",
    transactionId: String(o.id),
    type: RENEWAL_REASONS.has(String(o.billing_reason || "")) ? "renewal" : "new",
    amount,
    currency: currencyCode(o.currency) ?? "USD",
    timestamp: toMs(o.created_at) ?? toMs(eventTime),
    visitorId: pickVisitorId(...bags),
    sessionId: pickSessionId(...bags),
    customerId: str(o.customer_id) ?? str(o.customer?.id),
    email: o.customer?.email ?? null,
    name: o.customer?.name ?? o.billing_name ?? null,
    ref: str(o.checkout_id),
    subscriptionId: str(o.subscription_id),
    description: o.description ?? o.product?.name ?? null,
  };
}

function orderRefund(o: Obj, eventTime?: unknown): NormalizedPayment | null {
  const amount = (num(o.refunded_amount) ?? 0) + (num(o.refunded_tax_amount) ?? 0);
  if (amount <= 0) return null;
  const bags = orderBags(o);
  return {
    provider: "polar",
    transactionId: `refund_${o.id}`,
    type: "refund",
    amount,
    currency: currencyCode(o.currency) ?? "USD",
    timestamp: toMs(eventTime) ?? toMs(o.modified_at),
    visitorId: pickVisitorId(...bags),
    customerId: str(o.customer_id) ?? str(o.customer?.id),
    email: o.customer?.email ?? null,
    subscriptionId: str(o.subscription_id),
    relatedTransactionId: String(o.id),
    cumulative: true,
  };
}

export function parsePolarEvent(event: Obj): ProviderResult {
  const type = String(event.type || "");
  const data: Obj = event.data ?? {};
  const payments: NormalizedPayment[] = [];
  const goals: NormalizedGoal[] = [];
  const subBags = [data.metadata, data.customer?.metadata].filter(Boolean);
  const subGoal = (name: string): NormalizedGoal => ({
    name,
    visitorId: pickVisitorId(...subBags),
    customerId: str(data.customer_id) ?? str(data.customer?.id),
    email: data.customer?.email ?? null,
    ref: str(data.checkout_id),
  });

  switch (type) {
    case "order.paid": {
      const p = orderPayment(data, event.timestamp);
      if (!p) {
        if (data.billing_reason === "subscription_create" && (num(data.total_amount) ?? 0) === 0) {
          goals.push({ ...subGoal("free_trial"), visitorId: pickVisitorId(...orderBags(data)) });
          return { payments, goals };
        }
        return { payments, ignored: "unpaid or zero-amount order" };
      }
      payments.push(p);
      break;
    }
    case "order.refunded": {
      const r = orderRefund(data, event.timestamp);
      if (!r) return { payments, ignored: "nothing refunded" };
      payments.push(r);
      break;
    }
    case "subscription.created": {
      if (data.status === "trialing") goals.push(subGoal("trial_started"));
      break;
    }
    case "subscription.canceled": {
      if (data.cancel_at_period_end) goals.push(subGoal("subscription_cancel_scheduled"));
      break;
    }
    case "subscription.revoked": {
      goals.push(subGoal("subscription_ended"));
      break;
    }
    default:
      return { payments, ignored: `unhandled event ${type}` };
  }
  return { payments, goals };
}

export const polar: PaymentProvider = {
  id: "polar",
  name: "Polar",
  website: "https://polar.sh",
  description:
    "One-time purchases and subscriptions (renewals included) and refunds. Pass the visitor id as checkout metadata, or add checkout_id={CHECKOUT_ID} to your success URL so the tracker links the order.",
  fields: [
    {
      key: "webhookSecret",
      label: "Webhook secret",
      type: "password",
      required: true,
      placeholder: "whsec_...",
      secret: true,
      help: "Polar → Settings → Webhooks → your endpoint → Secret. Paste it exactly as shown.",
    },
  ],
  events: ["order.paid", "order.refunded", "subscription.created", "subscription.canceled", "subscription.revoked"],
  metadataHint: "metadata: { openrev_visitor_id, openrev_session_id }",

  async verify(req: WebhookRequest, config) {
    return verifyStandardWebhook(req, config.webhookSecret, 600, "auto");
  },

  async parse(req: WebhookRequest) {
    const event = parseJson<Obj>(req.rawBody);
    if (!event) return { payments: [], ignored: "invalid JSON" };
    return parsePolarEvent(event);
  },
};
