import { toMinor } from "../lib/currency";
import type { NormalizedPayment } from "../services/payments";
import type { ProviderConfig, PaymentProvider, ProviderResult, WebhookRequest } from "./types";
import { currencyCode, num, pairsToObject, parseJson, pickSessionId, pickVisitorId, str, utcMs, verifyHmacSignature } from "./util";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * WooCommerce (https://woocommerce.com/document/webhooks/).
 *
 * - Signature: `X-WC-Webhook-Signature` = base64 HMAC-SHA256 of the raw body keyed with the webhook secret.
 *   WooCommerce HTML-entity-decodes the stored secret before signing (`wp_specialchars_decode`), so both forms are tried.
 * - When a webhook is saved, WooCommerce POSTs an unsigned `webhook_id=<id>` ping and only activates the webhook if
 *   the response is 2xx — that ping is accepted and ignored.
 * - Topics `order.created` / `order.updated`: an order in a paid status (`processing`, `completed` by default) is a
 *   payment keyed by the order id, so repeated updates are idempotent. Refunds are read from the order's `refunds`
 *   array (cumulative, works for partial refunds and status `refunded`).
 * - Amounts are decimal strings in the order currency (major units).
 * - Renewal orders created by WooCommerce Subscriptions have `created_via: "subscription"`.
 * - The visitor id must be stored as order meta `openrev_visitor_id` (no leading underscore: protected meta keys
 *   are not included in webhook payloads) — see docs/revenue/woocommerce.md.
 */

const DEFAULT_PAID = ["processing", "completed"];

function paidStatuses(config: ProviderConfig): Set<string> {
  const custom = (config.paidStatuses || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^wc-/, ""))
    .filter(Boolean);
  return new Set([...(custom.length ? custom : DEFAULT_PAID), "refunded"]);
}

function isPing(req: WebhookRequest): boolean {
  return /^webhook_id=\d+$/.test(req.rawBody.trim()) && !req.headers.get("x-wc-webhook-signature");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function parseWooOrder(o: Obj, config: ProviderConfig = {}): ProviderResult {
  const payments: NormalizedPayment[] = [];
  if (!o || o.id === undefined || o.id === null) return { payments, ignored: "payload is not an order" };
  const status = String(o.status || "").toLowerCase();
  const currency = currencyCode(o.currency);
  if (!currency) return { payments, ignored: "order without currency" };
  const meta = pairsToObject(o.meta_data, "key", "value");
  const visitorId = pickVisitorId(meta);
  const sessionId = pickSessionId(meta);
  const customerId = o.customer_id && String(o.customer_id) !== "0" ? String(o.customer_id) : null;
  const email = o.billing?.email || null;
  const name = [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(" ") || null;
  const orderId = String(o.id);

  if (paidStatuses(config).has(status)) {
    const total = num(o.total);
    if (total !== null && total > 0) {
      const firstItem: Obj = o.line_items?.[0] ?? {};
      payments.push({
        provider: "woocommerce",
        transactionId: orderId,
        type: String(o.created_via || "") === "subscription" ? "renewal" : "new",
        amount: toMinor(total, currency),
        currency,
        timestamp: utcMs(o.date_paid_gmt) ?? utcMs(o.date_created_gmt) ?? utcMs(o.date_created),
        visitorId,
        sessionId,
        customerId,
        email,
        name,
        ref: str(o.order_key),
        description: `Order #${o.number ?? orderId}${firstItem.name ? ` — ${firstItem.name}` : ""}`,
      });
    }
  }

  const refunds: Obj[] = Array.isArray(o.refunds) ? o.refunds : [];
  let refunded = 0;
  for (const r of refunds) refunded += Math.abs(num(r.total) ?? 0);
  if (refunded === 0 && status === "refunded") refunded = Math.abs(num(o.total) ?? 0);
  if (refunded > 0) {
    payments.push({
      provider: "woocommerce",
      transactionId: `refund_${orderId}`,
      type: "refund",
      amount: toMinor(refunded, currency),
      currency,
      timestamp: utcMs(o.date_modified_gmt) ?? utcMs(o.date_modified),
      visitorId,
      customerId,
      email,
      relatedTransactionId: orderId,
      cumulative: true,
    });
  }

  if (!payments.length) return { payments, ignored: `order status ${status || "unknown"} is not paid` };
  return { payments };
}

export const woocommerce: PaymentProvider = {
  id: "woocommerce",
  name: "WooCommerce",
  website: "https://woocommerce.com",
  description:
    "Paid orders (any payment gateway), WooCommerce Subscriptions renewals and refunds. Requires a small snippet that saves the visitor id on the order.",
  fields: [
    {
      key: "webhookSecret",
      label: "Webhook secret",
      type: "password",
      required: true,
      secret: true,
      help: "WooCommerce → Settings → Advanced → Webhooks → your webhook → Secret. Use the same secret for every OpenRev webhook (order created and order updated).",
    },
    {
      key: "paidStatuses",
      label: "Paid order statuses",
      type: "text",
      placeholder: "processing,completed",
      help: "Comma-separated order statuses that count as paid. Defaults to `processing,completed`.",
    },
  ],
  events: ["order.created", "order.updated"],
  metadataHint: "order meta: openrev_visitor_id, openrev_session_id",

  async verify(req: WebhookRequest, config) {
    if (isPing(req)) return true;
    const secret = config.webhookSecret?.trim();
    if (!secret) return false;
    const signature = req.headers.get("x-wc-webhook-signature");
    const candidates = Array.from(new Set([secret, decodeEntities(secret)]));
    for (const s of candidates) {
      if (await verifyHmacSignature({ algorithm: "sha256", secret: s, data: req.rawBody, signature, encoding: "base64" })) return true;
    }
    return false;
  },

  async parse(req: WebhookRequest, config) {
    if (isPing(req)) return { payments: [], ignored: "WooCommerce webhook ping", unsigned: true };
    const topic = String(req.headers.get("x-wc-webhook-topic") || "").toLowerCase();
    if (topic && !topic.startsWith("order.")) return { payments: [], ignored: `unhandled topic ${topic}` };
    if (topic === "order.deleted" || topic === "order.restored") return { payments: [], ignored: `unhandled topic ${topic}` };
    const body = parseJson<Obj>(req.rawBody);
    if (!body) return { payments: [], ignored: "invalid JSON" };
    return parseWooOrder(body, config);
  },
};
