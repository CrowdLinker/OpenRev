import { parseInterval } from "../lib/billing";
import type { NormalizedPayment } from "../services/payments";
import type { ImportPage, PaymentProvider, ProviderResult, WebhookRequest } from "./types";
import { apiGet, currencyCode, num, parseJson, pickSessionId, pickVisitorId, str, toMs, verifyStandardWebhook } from "./util";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Dodo Payments (https://docs.dodopayments.com/developer-resources/webhooks).
 *
 * - Signature: Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`); the secret is
 *   `whsec_<base64>` and is base64-decoded (strict mode).
 * - Envelope: `{ business_id, type, timestamp, data: { payload_type, ... } }`.
 * - `payment.succeeded`: `total_amount` (incl. tax) in the currency's smallest unit. `charge_type` is `new` for the
 *   first payment of a subscription (or one-time carts) and `renewal` / `plan_change` / `on_demand` for later charges.
 *   Each payment fires once, so a subscription's first payment is never double counted.
 * - `refund.succeeded`: `amount` refunded, `payment_id` of the original payment.
 * - `ref` is the payment id: Dodo appends `?payment_id=…&status=succeeded` to the return URL, which the tracker reports.
 * - History import lists succeeded payments, then succeeded refunds (100 per page) with an API key. Refunds in the
 *   list have no customer; they inherit the attribution of the payment they refund.
 */

const RENEWAL_CHARGES = new Set(["renewal", "plan_change", "on_demand"]);

function paymentFrom(d: Obj, eventTime?: unknown): NormalizedPayment | null {
  if (d.status && d.status !== "succeeded") return null;
  if (d.is_update_payment_method === true) return null;
  const amount = num(d.total_amount) ?? 0;
  if (amount <= 0) return null;
  const bags = [d.metadata, d.customer?.metadata].filter(Boolean);
  const chargeType = String(d.charge_type || "");
  return {
    provider: "dodo",
    transactionId: String(d.payment_id),
    type: RENEWAL_CHARGES.has(chargeType) ? "renewal" : "new",
    amount,
    currency: currencyCode(d.currency) ?? "USD",
    timestamp: toMs(d.created_at) ?? toMs(eventTime),
    visitorId: pickVisitorId(...bags),
    sessionId: pickSessionId(...bags),
    customerId: str(d.customer?.customer_id),
    email: d.customer?.email ?? null,
    name: d.customer?.name ?? null,
    ref: String(d.payment_id),
    subscriptionId: str(d.subscription_id) ?? str(d.subscription_ids?.[0]),
    interval: parseInterval(
      d.payment_frequency_interval ?? d.subscription?.payment_frequency_interval,
      d.payment_frequency_count ?? d.subscription?.payment_frequency_count,
    ),
  };
}

export function parseDodoEvent(event: Obj): ProviderResult {
  const type = String(event.type || "");
  const d: Obj = event.data ?? {};
  const payments: NormalizedPayment[] = [];

  switch (type) {
    case "payment.succeeded": {
      if (!d.payment_id) return { payments, ignored: "payment without payment_id" };
      const p = paymentFrom(d, event.timestamp);
      if (!p) return { payments, ignored: "payment not succeeded, payment-method update or zero amount" };
      payments.push(p);
      break;
    }
    case "refund.succeeded": {
      const amount = num(d.amount) ?? 0;
      if (!d.refund_id || amount <= 0) return { payments, ignored: "refund without id or amount" };
      if (d.status && d.status !== "succeeded") return { payments, ignored: `refund status ${d.status}` };
      payments.push({
        provider: "dodo",
        transactionId: String(d.refund_id),
        type: "refund",
        amount,
        currency: currencyCode(d.currency) ?? "USD",
        timestamp: toMs(d.created_at) ?? toMs(event.timestamp),
        visitorId: pickVisitorId(d.metadata, d.customer?.metadata),
        customerId: str(d.customer?.customer_id),
        email: d.customer?.email ?? null,
        relatedTransactionId: str(d.payment_id),
        description: d.reason ?? null,
      });
      break;
    }
    default:
      return { payments, ignored: `unhandled event ${type}` };
  }
  return { payments };
}

export const dodo: PaymentProvider = {
  id: "dodo",
  name: "Dodo Payments",
  website: "https://dodopayments.com",
  description:
    "One-time payments, subscription renewals and refunds. Pass the visitor id in the checkout session metadata (or as metadata_openrev_visitor_id on payment links).",
  fields: [
    {
      key: "webhookSecret",
      label: "Webhook signing secret",
      type: "password",
      required: true,
      placeholder: "whsec_...",
      secret: true,
      help: "Dodo Payments → Developer → Webhooks → your endpoint → Overview → Signing secret.",
    },
    {
      key: "apiKey",
      label: "API key for importing past payments",
      type: "password",
      secret: true,
      help: "Dodo Payments → Developer → API keys. Only used to read payments and refunds.",
    },
    {
      key: "environment",
      label: "Environment",
      type: "select",
      options: [
        { value: "live", label: "Live mode" },
        { value: "test", label: "Test mode" },
      ],
      help: "Which mode the API key belongs to.",
    },
  ],
  events: ["payment.succeeded", "refund.succeeded"],
  metadataHint: "metadata: { openrev_visitor_id, openrev_session_id }",

  async verify(req: WebhookRequest, config) {
    return verifyStandardWebhook(req, config.webhookSecret, 600, "base64");
  },

  async parse(req: WebhookRequest) {
    const event = parseJson<Obj>(req.rawBody);
    if (!event) return { payments: [], ignored: "invalid JSON" };
    return parseDodoEvent(event);
  },

  async importHistory(config, cursor): Promise<ImportPage> {
    const key = config.apiKey;
    if (!key) throw new Error("A Dodo Payments API key is required to import past payments.");
    const base = config.environment === "test" ? "https://test.dodopayments.com" : "https://live.dodopayments.com";
    // cursor format: "<phase>:<page>" where phase is payments | refunds; pages count from 0
    const [phase = "payments", pageStr] = (cursor ?? "payments:0").split(":");
    if (phase !== "payments" && phase !== "refunds") throw new Error("Invalid import cursor");
    const page = Math.max(0, Number(pageStr) || 0);
    const list = await apiGet<Obj>("Dodo Payments", `${base}/${phase}?page_size=100&page_number=${page}&status=succeeded`, key);
    const items = (list.items ?? []) as Obj[];
    const payments: NormalizedPayment[] = [];
    for (const d of items) {
      if (phase === "payments") {
        const p = paymentFrom(d);
        if (p) payments.push(p);
      } else {
        payments.push(...parseDodoEvent({ type: "refund.succeeded", data: d }).payments);
      }
    }
    let next: string | null = null;
    if (items.length === 100) next = `${phase}:${page + 1}`;
    else if (phase === "payments") next = "refunds:0";
    return { payments, nextCursor: next };
  },
};
