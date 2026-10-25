import { toMinor } from "../lib/currency";
import type { NormalizedPayment } from "../services/payments";
import type { PaymentProvider, ProviderResult, WebhookRequest } from "./types";
import { currencyCode, num, pairsToObject, parseJson, pickSessionId, pickVisitorId, str, toMs, truthy, verifyHmacSignature } from "./util";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Shopify (https://shopify.dev/docs/apps/build/webhooks/subscribe/https).
 *
 * - Signature: `X-Shopify-Hmac-Sha256` = base64 HMAC-SHA256 of the raw body. The key is the secret shown under
 *   Settings → Notifications → Webhooks ("Your webhooks will be signed with …") for webhooks created in the admin,
 *   or the app's client secret for webhooks registered by an app.
 * - Topic in `X-Shopify-Topic`: `orders/paid` (payment) and `refunds/create` (refund).
 * - Amounts are decimal strings in major units (e.g. "19.99"); converted with `toMinor`.
 * - The OpenRev tracker stores the visitor id as cart attributes, which become the order's `note_attributes`.
 * - Renewal orders created by subscription billing attempts have `source_name` `subscription_contract`
 *   (`subscription_contract_checkout_one` since late 2025).
 */

function money(set: Obj | undefined, fallbackAmount: unknown, fallbackCurrency: unknown): { amount: number; currency: string } | null {
  const shop: Obj | undefined = set?.shop_money;
  const currency = currencyCode(shop?.currency_code) ?? currencyCode(fallbackCurrency);
  const major = num(shop?.amount) ?? num(fallbackAmount);
  if (!currency || major === null) return null;
  return { amount: toMinor(major, currency), currency };
}

function orderPayment(o: Obj): NormalizedPayment | null {
  const m = money(o.total_price_set, o.total_price, o.currency);
  if (!m || m.amount <= 0) return null;
  const attrs = pairsToObject(o.note_attributes);
  const customer: Obj = o.customer ?? {};
  const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(" ") || o.billing_address?.name || null;
  const source = String(o.source_name || "");
  const firstItem: Obj = o.line_items?.[0] ?? {};
  return {
    provider: "shopify",
    transactionId: String(o.id),
    type: source.startsWith("subscription_contract") ? "renewal" : "new",
    amount: m.amount,
    currency: m.currency,
    timestamp: toMs(o.processed_at) ?? toMs(o.created_at),
    visitorId: pickVisitorId(attrs),
    sessionId: pickSessionId(attrs),
    customerId: str(customer.id),
    email: o.email || o.contact_email || customer.email || null,
    name: fullName,
    ref: str(o.checkout_token) ?? str(o.cart_token),
    description: o.name ? `Order ${o.name}${firstItem.title ? ` — ${firstItem.title}` : ""}` : (firstItem.title ?? null),
  };
}

function refundFrom(r: Obj): NormalizedPayment | null {
  const transactions: Obj[] = Array.isArray(r.transactions) ? r.transactions : [];
  let total = 0;
  let currency: string | null = null;
  for (const t of transactions) {
    if (t.kind !== "refund" || (t.status && t.status !== "success")) continue;
    const c = currencyCode(t.currency);
    const amt = num(t.amount);
    if (!c || amt === null) continue;
    currency = currency ?? c;
    if (c === currency) total += toMinor(amt, c);
  }
  if (!currency || total <= 0 || !r.id) return null;
  return {
    provider: "shopify",
    transactionId: `refund_${r.id}`,
    type: "refund",
    amount: total,
    currency,
    timestamp: toMs(r.processed_at) ?? toMs(r.created_at),
    relatedTransactionId: str(r.order_id),
    description: r.note ?? null,
  };
}

export function parseShopifyEvent(topic: string, body: Obj): ProviderResult {
  const payments: NormalizedPayment[] = [];
  switch (topic) {
    case "orders/paid": {
      if (truthy(body.test)) return { payments, ignored: "test order" };
      // X-Shopify-Topic isn't covered by the HMAC, so the signed body itself must be a paid order:
      // other bodies signed with the same shop key (checkouts, draft orders) are ignored.
      if (!["paid", "partially_refunded", "refunded"].includes(String(body.financial_status))) {
        return { payments, ignored: `order financial_status ${body.financial_status ?? "missing"}` };
      }
      if (body.admin_graphql_api_id && !String(body.admin_graphql_api_id).startsWith("gid://shopify/Order/")) {
        return { payments, ignored: "not an order" };
      }
      const p = orderPayment(body);
      if (!p) return { payments, ignored: "zero-amount order" };
      payments.push(p);
      break;
    }
    case "refunds/create": {
      const r = refundFrom(body);
      if (!r) return { payments, ignored: "refund without successful refund transactions" };
      payments.push(r);
      break;
    }
    default:
      return { payments, ignored: `unhandled topic ${topic || "(missing X-Shopify-Topic)"}` };
  }
  return { payments };
}

export const shopify: PaymentProvider = {
  id: "shopify",
  name: "Shopify",
  website: "https://www.shopify.com",
  description:
    "Paid orders and refunds from your Shopify store. The OpenRev script on your storefront saves the visitor id in the cart automatically, so no code changes are needed.",
  fields: [
    {
      key: "webhookSecret",
      label: "Webhook signing secret",
      type: "password",
      required: true,
      secret: true,
      help: "Shopify admin → Settings → Notifications → Webhooks: the key shown under “Your webhooks will be signed with”. For app-registered webhooks use the app's client secret.",
    },
  ],
  events: ["orders/paid", "refunds/create"],
  metadataHint: "cart attributes: { openrev_visitor_id, openrev_session_id } (set automatically by the tracker)",

  async verify(req: WebhookRequest, config) {
    return verifyHmacSignature({
      algorithm: "sha256",
      secret: config.webhookSecret,
      data: req.rawBody,
      signature: req.headers.get("x-shopify-hmac-sha256"),
      encoding: "base64",
    });
  },

  async parse(req: WebhookRequest) {
    const body = parseJson<Obj>(req.rawBody);
    if (!body) return { payments: [], ignored: "invalid JSON" };
    return parseShopifyEvent(String(req.headers.get("x-shopify-topic") || "").toLowerCase(), body);
  },
};
