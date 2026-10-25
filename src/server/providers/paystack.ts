import type { NormalizedPayment } from "../services/payments";
import type { PaymentProvider, ProviderResult, WebhookRequest } from "./types";
import { asObject, currencyCode, num, pairsToObject, parseJson, pickSessionId, pickVisitorId, str, toMs, verifyHmacSignature } from "./util";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Paystack (https://paystack.com/docs/payments/webhooks/).
 *
 * - Signature: `x-paystack-signature` = hex HMAC-SHA512 of the raw body keyed with your secret key
 *   (`sk_live_…` / `sk_test_…`, the same key used for API calls).
 * - Envelope: `{ event, data }`. Amounts are integers in the currency's subunit (kobo, pesewas, cents).
 * - `charge.success` → payment keyed by the transaction `reference`; `refund.processed` → refund whose
 *   `transaction_reference` points at the original payment.
 * - `metadata` may be an object or a JSON string and may contain a `custom_fields` array
 *   (`[{ display_name, variable_name, value }]`); both are searched for the visitor id.
 * - Subscriptions: Paystack does not flag renewals explicitly. A charge on a plan whose metadata carries no
 *   OpenRev visitor id (renewal charges are created by Paystack, not by your checkout code) is treated as a renewal.
 */

function metadataBags(meta: unknown): Obj[] {
  const m = asObject(meta);
  if (!m) return [];
  const bags: Obj[] = [m];
  const fields = Array.isArray(m.custom_fields) ? m.custom_fields : null;
  if (fields) {
    bags.push(pairsToObject(fields, "variable_name", "value"));
    bags.push(pairsToObject(fields, "display_name", "value"));
  }
  return bags;
}

function chargePayment(d: Obj): NormalizedPayment | null {
  if (d.status && d.status !== "success") return null;
  const amount = num(d.amount) ?? 0;
  if (amount <= 0) return null;
  const reference = str(d.reference) ?? str(d.id);
  if (!reference) return null;
  const bags = metadataBags(d.metadata);
  const visitorId = pickVisitorId(...bags);
  const plan = asObject(d.plan);
  const onPlan = !!(plan && (plan.plan_code || plan.id));
  const meta = asObject(d.metadata);
  const renewal = onPlan && (!!meta?.invoice_action || !visitorId);
  const customer: Obj = d.customer ?? {};
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(" ") || null;
  return {
    provider: "paystack",
    transactionId: reference,
    type: renewal ? "renewal" : "new",
    amount,
    currency: currencyCode(d.currency) ?? "NGN",
    timestamp: toMs(d.paid_at) ?? toMs(d.paidAt) ?? toMs(d.created_at),
    visitorId,
    sessionId: pickSessionId(...bags),
    customerId: str(customer.customer_code) ?? str(customer.id),
    email: customer.email ?? null,
    name,
    ref: reference,
    subscriptionId: str(d.subscription?.subscription_code) ?? str(d.subscription_code),
    description: plan?.name ? String(plan.name) : null,
  };
}

export function parsePaystackEvent(event: Obj): ProviderResult {
  const type = String(event.event || "");
  const d: Obj = event.data ?? {};
  const payments: NormalizedPayment[] = [];

  switch (type) {
    case "charge.success": {
      const p = chargePayment(d);
      if (!p) return { payments, ignored: "charge not successful or zero amount" };
      payments.push(p);
      break;
    }
    case "refund.processed": {
      const amount = num(d.amount) ?? 0;
      const txRef = str(d.transaction_reference) ?? str(d.transaction?.reference);
      if (amount <= 0 || !txRef) return { payments, ignored: "refund without amount or transaction reference" };
      const refundId = str(d.id) ?? str(d.refund_reference) ?? `${txRef}_${amount}`;
      const customer: Obj = d.customer ?? {};
      payments.push({
        provider: "paystack",
        transactionId: `refund_${refundId}`,
        type: "refund",
        amount,
        currency: currencyCode(d.currency) ?? "NGN",
        timestamp: toMs(d.refunded_at) ?? toMs(d.updatedAt) ?? toMs(d.updated_at) ?? toMs(d.createdAt) ?? toMs(d.created_at),
        visitorId: pickVisitorId(...metadataBags(d.metadata)),
        customerId: str(customer.customer_code),
        email: customer.email ?? null,
        relatedTransactionId: txRef,
      });
      break;
    }
    default:
      return { payments, ignored: `unhandled event ${type}` };
  }
  return { payments };
}

export const paystack: PaymentProvider = {
  id: "paystack",
  name: "Paystack",
  website: "https://paystack.com",
  description:
    "Successful charges (one-time and subscription) and processed refunds. Pass the visitor id in the transaction metadata when initializing a payment or opening Paystack Popup.",
  fields: [
    {
      key: "secretKey",
      label: "Secret key",
      type: "password",
      required: true,
      placeholder: "sk_live_...",
      secret: true,
      help: "Paystack signs webhooks with your secret key: Settings → API Keys & Webhooks. Use the live key for live mode (test events are signed with sk_test_…).",
    },
  ],
  events: ["charge.success", "refund.processed"],
  metadataHint: "metadata: { openrev_visitor_id, openrev_session_id }",

  async verify(req: WebhookRequest, config) {
    return verifyHmacSignature({
      algorithm: "sha512",
      secret: config.secretKey,
      data: req.rawBody,
      signature: req.headers.get("x-paystack-signature"),
      encoding: "hex",
    });
  },

  async parse(req: WebhookRequest) {
    const event = parseJson<Obj>(req.rawBody);
    if (!event) return { payments: [], ignored: "invalid JSON" };
    return parsePaystackEvent(event);
  },
};
