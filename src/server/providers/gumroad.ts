import type { NormalizedPayment } from "../services/payments";
import type { PaymentProvider, ProviderResult, WebhookRequest } from "./types";
import { asObject, num, parseForm, parseJson, pickSessionId, pickVisitorId, str, toMs, truthy, urlTokenMatches } from "./util";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Gumroad Ping (https://gumroad.com/ping, payload built in antiwork/gumroad `Purchase::PingNotification`).
 *
 * - Gumroad does not sign pings. The webhook URL must carry a secret `?token=…` that matches the integration's
 *   token (compared in constant time).
 * - Body: `application/x-www-form-urlencoded` with Rails-style nested keys (`url_params[openrev_visitor_id]=…`);
 *   JSON bodies (resource subscriptions created for Zapier-like apps) are accepted too.
 * - `price` is in USD cents (Gumroad converts to USD; the `currency` field is the product's display currency).
 * - `is_recurring_charge=true` marks subscription renewals. `test=true` marks the seller's own test purchases.
 * - The Settings → Advanced "Ping" endpoint only receives sales. Refunds arrive only through a `refund`
 *   resource subscription (API) — the same payload with `refunded=true`; it is recorded as a full refund.
 * - Visitor id: the tracker appends `?openrev_visitor_id=…` to Gumroad links; Gumroad returns it in `url_params`.
 */

function parseBody(req: WebhookRequest): Obj | null {
  const raw = req.rawBody.trim();
  const type = req.headers.get("content-type") || "";
  if (type.includes("json") || raw.startsWith("{")) return parseJson<Obj>(raw);
  if (!raw) return null;
  return parseForm(raw) as Obj;
}

export function parseGumroadPing(b: Obj): ProviderResult {
  const payments: NormalizedPayment[] = [];
  const saleId = str(b.sale_id);
  if (!saleId) return { payments, ignored: "ping without sale_id" };
  const resource = String(b.resource_name || "sale");
  const urlParams = asObject(b.url_params);
  const customFields = asObject(b.custom_fields);
  const visitorId = pickVisitorId(urlParams, customFields, b);
  const sessionId = pickSessionId(urlParams, customFields);
  const amount = num(b.price) ?? 0;
  const base = {
    provider: "gumroad",
    currency: "USD",
    visitorId,
    customerId: str(b.purchaser_id),
    email: typeof b.email === "string" ? b.email : null,
    name: typeof b.full_name === "string" ? b.full_name : null,
    subscriptionId: str(b.subscription_id),
  };

  if (truthy(b.test)) return { payments, ignored: "test purchase (made by the seller)" };

  if (resource === "refund" || (resource === "sale" && truthy(b.refunded))) {
    if (amount <= 0) return { payments, ignored: "refund without amount" };
    payments.push({
      ...base,
      transactionId: `refund_${saleId}`,
      type: "refund",
      amount,
      timestamp: Date.now(),
      relatedTransactionId: saleId,
    });
    // A sale ping that already says refunded still represents the original payment.
    if (resource === "sale") payments.unshift(salePayment(b, saleId, amount, base, sessionId));
    return { payments };
  }
  if (resource !== "sale") return { payments, ignored: `unhandled resource ${resource}` };
  if (amount <= 0) return { payments, ignored: "free purchase" };
  payments.push(salePayment(b, saleId, amount, base, sessionId));
  return { payments };
}

function salePayment(b: Obj, saleId: string, amount: number, base: Omit<NormalizedPayment, "transactionId" | "type" | "amount">, sessionId: string | null): NormalizedPayment {
  return {
    ...base,
    transactionId: saleId,
    type: truthy(b.is_recurring_charge) ? "renewal" : "new",
    amount,
    timestamp: toMs(b.sale_timestamp),
    sessionId,
    ref: str(b.order_number),
    description: typeof b.product_name === "string" ? b.product_name : null,
  };
}

export const gumroad: PaymentProvider = {
  id: "gumroad",
  name: "Gumroad",
  website: "https://gumroad.com",
  description:
    "Sales, membership renewals and (optionally) refunds via Gumroad Ping. Gumroad links on your site are tagged with the visitor id automatically.",
  fields: [
    {
      key: "token",
      label: "Webhook token",
      type: "password",
      required: true,
      secret: true,
      placeholder: "a long random string",
      help: "Gumroad does not sign pings, so OpenRev only accepts requests whose URL ends with `?token=<this value>`. Use a long random string (e.g. `openssl rand -hex 24`) and paste the full URL, token included, into Gumroad → Settings → Advanced → Ping.",
    },
  ],
  events: ["sale", "refund"],
  metadataHint: "URL parameter on the product link: ?openrev_visitor_id=…",

  async verify(req: WebhookRequest, config) {
    return urlTokenMatches(req.url, config.token);
  },

  async parse(req: WebhookRequest) {
    const body = parseBody(req);
    if (!body) return { payments: [], ignored: "empty or invalid body" };
    return parseGumroadPing(body);
  },
};
