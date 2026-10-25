import type { NormalizedGoal, NormalizedPayment } from "../services/payments";
import type { PaymentProvider, ProviderResult, WebhookRequest } from "./types";
import { currencyCode, num, parseJson, pickSessionId, pickVisitorId, str, toMs, verifyHmacSignature } from "./util";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Paddle Billing (https://developer.paddle.com/webhooks/signature-verification).
 *
 * - Signature: `Paddle-Signature: ts=<unix>;h1=<hex>` where h1 = HMAC-SHA256(`${ts}:${rawBody}`) keyed with the
 *   notification destination's secret key (`pdl_ntfset_…`). Several `h1` values may be present during rotation.
 * - Amounts are strings in the lowest denomination of `currency_code` (e.g. "1999" = $19.99).
 * - `transaction.completed` is sent once per paid transaction: `origin` tells first purchases (`web`, `api`)
 *   from subscription charges (`subscription_recurring`, `subscription_update`, `subscription_charge`), so there is
 *   no double counting of a subscription's first payment.
 * - Refunds/chargebacks are adjustments; Paddle must approve most refunds, so they are counted once `status` is
 *   `approved` (via `adjustment.created` or `adjustment.updated`).
 */

const TOLERANCE_SECONDS = 600;
const RENEWAL_ORIGINS = new Set(["subscription_recurring", "subscription_update", "subscription_charge"]);
const REFUND_ACTIONS = new Set(["refund", "chargeback"]);

export async function verifyPaddleSignature(rawBody: string, header: string | null, secret: string | undefined, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = header.split(";").map((p) => {
    const i = p.indexOf("=");
    return i === -1 ? [p.trim(), ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  });
  const ts = parts.find(([k]) => k === "ts")?.[1];
  const h1 = parts.filter(([k]) => k === "h1").map(([, v]) => v);
  if (!ts || !/^\d+$/.test(ts) || !h1.length) return false;
  if (Math.abs(now / 1000 - Number(ts)) > TOLERANCE_SECONDS) return false;
  return verifyHmacSignature({ algorithm: "sha256", secret, data: `${ts}:${rawBody}`, signature: h1, encoding: "hex" });
}

function transactionPayment(t: Obj, occurredAt?: unknown): NormalizedPayment | null {
  if (t.status && t.status !== "completed" && t.status !== "paid") return null;
  const totals: Obj = t.details?.totals ?? {};
  const amount = num(totals.grand_total) ?? num(totals.total) ?? 0;
  if (amount <= 0) return null;
  const origin = String(t.origin || "");
  const custom = t.custom_data && typeof t.custom_data === "object" ? t.custom_data : null;
  const firstItem: Obj = t.items?.[0] ?? {};
  return {
    provider: "paddle",
    transactionId: String(t.id),
    type: RENEWAL_ORIGINS.has(origin) ? "renewal" : "new",
    amount,
    currency: currencyCode(t.currency_code) ?? currencyCode(totals.currency_code) ?? "USD",
    timestamp: toMs(t.billed_at) ?? toMs(occurredAt) ?? toMs(t.created_at),
    visitorId: pickVisitorId(custom),
    sessionId: pickSessionId(custom),
    customerId: str(t.customer_id),
    ref: String(t.id),
    subscriptionId: str(t.subscription_id),
    description: firstItem.price?.description ?? firstItem.price?.name ?? null,
  };
}

function adjustmentRefund(adj: Obj, occurredAt?: unknown): NormalizedPayment | null {
  if (!REFUND_ACTIONS.has(String(adj.action || ""))) return null;
  if (adj.status !== "approved") return null;
  const amount = num(adj.totals?.total) ?? 0;
  if (amount <= 0) return null;
  return {
    provider: "paddle",
    transactionId: String(adj.id),
    type: "refund",
    amount,
    currency: currencyCode(adj.currency_code) ?? currencyCode(adj.totals?.currency_code) ?? "USD",
    timestamp: toMs(adj.updated_at) ?? toMs(occurredAt) ?? toMs(adj.created_at),
    customerId: str(adj.customer_id),
    subscriptionId: str(adj.subscription_id),
    relatedTransactionId: str(adj.transaction_id),
    description: adj.reason ? `${adj.action}: ${adj.reason}` : null,
  };
}

export function parsePaddleEvent(event: Obj): ProviderResult {
  const type = String(event.event_type || "");
  const data: Obj = event.data ?? {};
  const payments: NormalizedPayment[] = [];
  const goals: NormalizedGoal[] = [];
  const custom = data.custom_data && typeof data.custom_data === "object" ? data.custom_data : null;

  switch (type) {
    case "transaction.completed":
    case "transaction.paid": {
      // `transaction.paid` can arrive before `transaction.completed`; both map to the same transaction id.
      const p = transactionPayment(data, event.occurred_at);
      if (!p) return { payments, ignored: "transaction not completed or zero amount" };
      payments.push(p);
      break;
    }
    case "adjustment.created":
    case "adjustment.updated": {
      const r = adjustmentRefund(data, event.occurred_at);
      if (!r) return { payments, ignored: `adjustment ${data.action ?? "?"} with status ${data.status ?? "?"} is not an approved refund` };
      payments.push(r);
      break;
    }
    case "subscription.created": {
      if (data.status === "trialing") goals.push({ name: "trial_started", visitorId: pickVisitorId(custom), customerId: str(data.customer_id) });
      break;
    }
    case "subscription.canceled": {
      goals.push({ name: "subscription_ended", visitorId: pickVisitorId(custom), customerId: str(data.customer_id) });
      break;
    }
    default:
      return { payments, ignored: `unhandled event ${type}` };
  }
  return { payments, goals };
}

export const paddle: PaymentProvider = {
  id: "paddle",
  name: "Paddle",
  website: "https://www.paddle.com",
  description:
    "Paddle Billing transactions (one-time and subscriptions, renewals included) and approved refunds/chargebacks. Pass the visitor id as customData when opening Paddle Checkout.",
  fields: [
    {
      key: "webhookSecret",
      label: "Webhook secret key",
      type: "password",
      required: true,
      placeholder: "pdl_ntfset_...",
      secret: true,
      help: "Paddle → Developer tools → Notifications → your destination → Secret key.",
    },
  ],
  events: ["transaction.completed", "adjustment.created", "adjustment.updated", "subscription.created", "subscription.canceled"],
  metadataHint: "customData: { openrev_visitor_id, openrev_session_id }",

  async verify(req: WebhookRequest, config) {
    return verifyPaddleSignature(req.rawBody, req.headers.get("paddle-signature"), config.webhookSecret);
  },

  async parse(req: WebhookRequest) {
    const event = parseJson<Obj>(req.rawBody);
    if (!event) return { payments: [], ignored: "invalid JSON" };
    return parsePaddleEvent(event);
  },
};
