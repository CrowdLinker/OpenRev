import { toMinor } from "../lib/currency";
import type { NormalizedPayment } from "../services/payments";
import type { PaymentProvider, ProviderConfig, ProviderResult, WebhookRequest } from "./types";
import {
  currencyCode,
  getPath,
  num,
  parseForm,
  parseJson,
  pickSessionId,
  pickVisitorId,
  str,
  toMs,
  truthy,
  urlTokenMatches,
  verifyHmacSignature,
  type SignatureAlgorithm,
} from "./util";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Generic adapter for any payment system that can POST a webhook. Everything is configured in the dashboard:
 * how to authenticate the request (HMAC of the raw body, or a secret `?token=` in the URL) and where to find each
 * field in the JSON payload (dotted paths read with `getPath`, e.g. `data.object.amount` or `items.0.price`).
 * See docs/revenue/custom-provider.md.
 */

const ALGORITHMS = new Set(["sha1", "sha256", "sha512"]);

function list(v: string | undefined): string[] {
  return (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function readPath(body: unknown, path: string | undefined): unknown {
  const p = (path || "").trim();
  return p ? getPath(body, p) : undefined;
}

function parseBody(raw: string): Obj | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return parseJson<Obj>(trimmed);
  const form = parseForm(trimmed);
  return Object.keys(form).length ? (form as Obj) : null;
}

/** Bags searched for `openrev_visitor_id` (and DataFast-compatible keys) when no explicit path is configured. */
function defaultBags(body: Obj): Obj[] {
  const candidates = [
    body,
    body.metadata,
    body.custom_data,
    body.notes,
    body.data,
    body.data?.metadata,
    body.data?.custom_data,
    body.data?.notes,
    body.data?.object,
    body.data?.object?.metadata,
    body.object,
    body.object?.metadata,
    body.payload,
    body.payload?.metadata,
    body.meta?.custom_data,
  ];
  return candidates.filter((c): c is Obj => !!c && typeof c === "object" && !Array.isArray(c));
}

export function parseCustomEvent(body: Obj, config: ProviderConfig): ProviderResult {
  const payments: NormalizedPayment[] = [];
  const eventPath = (config.eventTypePath || "").trim();
  const eventType = eventPath ? str(readPath(body, eventPath)) : null;
  const paymentEvents = list(config.paymentEvents);
  const refundEvents = list(config.refundEvents);

  let kind: "payment" | "refund" | null = null;
  if (!eventPath) kind = "payment";
  else if (eventType && refundEvents.includes(eventType)) kind = "refund";
  else if (eventType && (paymentEvents.includes(eventType) || !paymentEvents.length)) kind = "payment";
  if (!kind) return { payments, ignored: `event type ${eventType ?? "(not found at " + eventPath + ")"} is not configured` };

  const currency =
    currencyCode(readPath(body, config.currencyPath)) ?? currencyCode(config.defaultCurrency) ?? null;
  if (!currency) return { payments, ignored: "currency not found (set a currency path or a default currency)" };

  const amountPath = kind === "refund" && config.refundAmountPath?.trim() ? config.refundAmountPath : config.amountPath;
  const rawAmount = num(readPath(body, amountPath));
  if (rawAmount === null) return { payments, ignored: `amount not found at ${amountPath || "(no amount path)"}` };
  const amount = Math.abs(config.amountUnit === "major" ? toMinor(rawAmount, currency) : Math.round(rawAmount));
  if (amount <= 0) return { payments, ignored: "zero amount" };

  const id = str(readPath(body, config.transactionIdPath));
  if (!id) return { payments, ignored: `transaction id not found at ${config.transactionIdPath || "(no path)"}` };

  const explicitVisitor = readPath(body, config.visitorIdPath);
  const bags = defaultBags(body);
  const visitorId = pickVisitorId({ openrev_visitor_id: explicitVisitor }, ...bags);
  const sessionId = pickSessionId({ openrev_session_id: readPath(body, config.sessionIdPath) }, ...bags);

  let type: NormalizedPayment["type"] = kind === "refund" ? "refund" : "new";
  if (kind === "payment" && config.renewalPath?.trim()) {
    const v = readPath(body, config.renewalPath);
    const expected = (config.renewalValue || "").trim().toLowerCase();
    const isRenewal = expected ? (str(v) ?? (typeof v === "boolean" ? String(v) : "")).toLowerCase() === expected : truthy(v);
    if (isRenewal) type = "renewal";
  }

  const email = str(readPath(body, config.emailPath));
  payments.push({
    provider: "custom",
    transactionId: kind === "refund" ? `refund_${id}` : id,
    type,
    amount,
    currency,
    timestamp: toMs(readPath(body, config.timestampPath)),
    visitorId,
    sessionId,
    customerId: str(readPath(body, config.customerIdPath)),
    email: email && email.includes("@") ? email : null,
    ref: str(readPath(body, config.refPath)),
    relatedTransactionId: kind === "refund" ? str(readPath(body, config.relatedTransactionIdPath)) : null,
  });
  return { payments };
}

export const custom: PaymentProvider = {
  id: "custom",
  name: "Custom webhook",
  website: "https://github.com/CrowdLinker/OpenRev/blob/main/docs/revenue/custom-provider.md",
  description:
    "Connect any payment system that can send a JSON webhook: choose how requests are authenticated and where the amount, currency, transaction id and visitor id live in the payload.",
  fields: [
    {
      key: "signatureAlgorithm",
      label: "Signature algorithm",
      type: "select",
      required: true,
      options: [
        { value: "sha256", label: "HMAC-SHA256" },
        { value: "sha512", label: "HMAC-SHA512" },
        { value: "sha1", label: "HMAC-SHA1" },
        { value: "none", label: "None — require ?token= in the webhook URL" },
      ],
      help: "HMAC of the raw request body, keyed with the signing secret. Pick “None” only if your provider cannot sign requests; then a secret `?token=` is required in the URL.",
    },
    {
      key: "signatureHeader",
      label: "Signature header",
      type: "text",
      placeholder: "X-Signature",
      help: "Name of the HTTP header that carries the signature (case-insensitive). Required unless the algorithm is “None”.",
    },
    {
      key: "signatureEncoding",
      label: "Signature encoding",
      type: "select",
      options: [
        { value: "hex", label: "Hex" },
        { value: "base64", label: "Base64" },
      ],
      help: "How the provider encodes the HMAC digest. Defaults to hex.",
    },
    {
      key: "signaturePrefix",
      label: "Signature prefix",
      type: "text",
      placeholder: "sha256=",
      help: "Text in front of the digest that should be stripped before comparing, e.g. `sha256=` (GitHub-style).",
    },
    {
      key: "secret",
      label: "Signing secret",
      type: "password",
      secret: true,
      help: "The shared secret used to compute the HMAC. Required unless the algorithm is “None”.",
    },
    {
      key: "token",
      label: "URL token",
      type: "password",
      secret: true,
      help: "Required when the algorithm is “None” (and enforced whenever set): append `?token=<this value>` to the webhook URL. Use a long random string.",
    },
    {
      key: "eventTypePath",
      label: "Event type path",
      type: "text",
      placeholder: "type",
      help: "Dotted path to the event name, e.g. `type` or `event`. Leave empty to treat every request as a payment.",
    },
    {
      key: "paymentEvents",
      label: "Payment event values",
      type: "text",
      placeholder: "payment.succeeded,order.paid",
      help: "Comma-separated event names that represent a successful payment. Empty = every event that is not a refund event.",
    },
    {
      key: "refundEvents",
      label: "Refund event values",
      type: "text",
      placeholder: "refund.created",
      help: "Comma-separated event names that represent a refund. Refunds are stored as negative revenue.",
    },
    {
      key: "amountPath",
      label: "Amount path",
      type: "text",
      required: true,
      placeholder: "data.amount",
      help: "Dotted path to the amount paid, e.g. `data.amount` or `data.items.0.price`. Numbers or numeric strings.",
    },
    {
      key: "refundAmountPath",
      label: "Refund amount path",
      type: "text",
      placeholder: "data.refund.amount",
      help: "Path to the refunded amount in refund events, when it differs from the amount path.",
    },
    {
      key: "amountUnit",
      label: "Amount unit",
      type: "select",
      required: true,
      options: [
        { value: "minor", label: "Minor units (cents): 1999 = $19.99" },
        { value: "major", label: "Major units: 19.99 = $19.99" },
      ],
      help: "Most APIs send integers in the smallest currency unit (minor). Choose major if the amount looks like `19.99`.",
    },
    {
      key: "currencyPath",
      label: "Currency path",
      type: "text",
      placeholder: "data.currency",
      help: "Path to a 3-letter ISO currency code (case-insensitive).",
    },
    {
      key: "defaultCurrency",
      label: "Default currency",
      type: "text",
      placeholder: "USD",
      help: "Used when the payload has no currency (or no currency path is set).",
    },
    {
      key: "transactionIdPath",
      label: "Transaction id path",
      type: "text",
      required: true,
      placeholder: "data.id",
      help: "Path to a unique, stable id of the payment (or refund). Used to ignore duplicate deliveries.",
    },
    {
      key: "relatedTransactionIdPath",
      label: "Original payment id path for refunds",
      type: "text",
      placeholder: "data.payment_id",
      help: "In refund events: path to the id of the refunded payment, so the refund is attributed to the same traffic source.",
    },
    {
      key: "visitorIdPath",
      label: "Visitor id path",
      type: "text",
      placeholder: "data.metadata.openrev_visitor_id",
      help: "Path to the OpenRev visitor id you passed at checkout. If empty, `openrev_visitor_id` (or `datafast_visitor_id`) is looked up in common places such as `metadata`, `data.metadata` and `data.object.metadata`.",
    },
    {
      key: "sessionIdPath",
      label: "Session id path",
      type: "text",
      placeholder: "data.metadata.openrev_session_id",
      help: "Path to the OpenRev session id, if you pass it.",
    },
    {
      key: "emailPath",
      label: "Customer email path",
      type: "text",
      placeholder: "data.customer.email",
      help: "Used to attribute payments without a visitor id to visitors you identified with the same email.",
    },
    {
      key: "customerIdPath",
      label: "Customer id path",
      type: "text",
      placeholder: "data.customer.id",
      help: "Lets renewals and refunds inherit the attribution of the customer's first payment.",
    },
    {
      key: "timestampPath",
      label: "Timestamp path",
      type: "text",
      placeholder: "data.created_at",
      help: "Unix seconds, unix milliseconds or an ISO 8601 date. Defaults to the time the webhook is received.",
    },
    {
      key: "refPath",
      label: "Checkout reference path",
      type: "text",
      placeholder: "data.checkout_id",
      help: "A checkout/order id that also appears on your success page as `?checkout_id=` — lets the tracker link the visitor without metadata.",
    },
    {
      key: "renewalPath",
      label: "Renewal flag path",
      type: "text",
      placeholder: "data.billing_reason",
      help: "Path to a field that tells renewals apart from first payments.",
    },
    {
      key: "renewalValue",
      label: "Renewal value",
      type: "text",
      placeholder: "subscription_cycle",
      help: "The value at the renewal path that means “renewal”. Leave empty to treat any truthy value (true, 1, \"yes\") as a renewal.",
    },
  ],
  events: [],
  metadataHint: "metadata: { openrev_visitor_id, openrev_session_id } (or the path you configure)",

  async verify(req: WebhookRequest, config) {
    const algorithm = (config.signatureAlgorithm || "sha256").trim().toLowerCase();
    const tokenSet = !!config.token?.trim();
    if (tokenSet && !urlTokenMatches(req.url, config.token)) return false;
    if (algorithm === "none") return tokenSet;
    if (!ALGORITHMS.has(algorithm)) return false;
    const headerName = config.signatureHeader?.trim();
    if (!headerName || !config.secret?.trim()) return false;
    return verifyHmacSignature({
      algorithm: algorithm as SignatureAlgorithm,
      secret: config.secret,
      data: req.rawBody,
      signature: req.headers.get(headerName),
      encoding: config.signatureEncoding === "base64" ? "base64" : "hex",
      prefix: config.signaturePrefix?.trim() || undefined,
    });
  },

  async parse(req: WebhookRequest, config) {
    const body = parseBody(req.rawBody);
    if (!body) return { payments: [], ignored: "empty or invalid body" };
    return parseCustomEvent(body, config);
  },
};
