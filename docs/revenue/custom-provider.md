# Custom payment providers

There are three ways to send revenue from a payment system that has no built-in OpenRev integration:

1. **Custom webhook** (no code): point the provider's webhooks at OpenRev and tell OpenRev where the amount, currency and transaction id are in the payload, plus the visitor id or customer email when the provider sends them.
2. **Payments API**: call OpenRev from your backend after a successful charge (Settings → Revenue → *Any other payment system: Payments API*).
3. **Built-in adapter** (code): add a provider to OpenRev itself and contribute it back.

---

## Option 1: the “Custom webhook” integration

Open **Settings → Revenue → Connect → Custom webhook**. After saving, OpenRev shows the webhook URL:

```
https://YOUR-OPENREV-DOMAIN/api/webhooks/<integration-id>?token=<url-token>
```

Configure your provider to POST JSON (or `application/x-www-form-urlencoded`) events to it.

### Authentication

| Field | Meaning |
| --- | --- |
| **Signature algorithm** | `HMAC-SHA256`, `HMAC-SHA512`, `HMAC-SHA1`, or **None**. The HMAC is computed over the **raw request body** with the signing secret as key. |
| **Signature header** | Header carrying the signature, e.g. `X-Signature` (case-insensitive). |
| **Signature encoding** | `hex` (default; compared case-insensitively) or `base64`. |
| **Signature prefix** | Text to strip before comparing, e.g. `sha256=` for GitHub-style `X-Hub-Signature-256: sha256=<hex>`. |
| **Signing secret** | The shared secret. |
| **URL token** | Leave empty to let OpenRev generate one — the webhook URL shown in the dashboard already includes `?token=<value>`. Required when the algorithm is **None**; with an algorithm, both the token and the signature must match. |

Signatures are compared in constant time. Schemes that sign something other than the raw body (for example `timestamp.body`) are not supported by the custom integration — use a built-in adapter (Option 3) for those.

### Field mapping

Paths are dotted JSON paths. Array items use their index: `data.items.0.price`.

| Field | Example | Notes |
| --- | --- | --- |
| **Event type path** | `type` | Leave empty to treat every request as a payment. |
| **Payment event values** | `payment.succeeded,order.paid` | Comma-separated. If empty, every event that is not a refund event is a payment. |
| **Refund event values** | `refund.created` | Comma-separated. Refunds are stored as negative revenue. |
| **Amount path** | `data.amount` | Number or numeric string. Negative values are made positive. |
| **Refund amount path** | `data.refund.amount` | Optional, when refunds use another field. |
| **Amount unit** | `minor` / `major` | `minor`: `1999` = $19.99. `major`: `19.99` = $19.99 (converted using the currency's decimals, e.g. JPY has none). |
| **Currency path** / **Default currency** | `data.currency` / `USD` | 3-letter ISO code, any case. The default is used when the path is empty or missing. |
| **Transaction id path** | `data.id` | Must be unique and stable for retries: duplicates are ignored. Refund ids are stored as `refund_<id>`. |
| **Original payment id path** | `data.payment_id` | For refunds: the transaction id of the refunded payment, so the refund inherits its attribution. |
| **Visitor id path** | `data.metadata.openrev_visitor_id` | Optional. When empty, `openrev_visitor_id` (or `datafast_visitor_id`) is looked up in `metadata`, `custom_data`, `notes`, `data`, `data.metadata`, `data.object.metadata`, `object.metadata`, `payload.metadata` and `meta.custom_data`. |
| **Session id path** | `data.metadata.openrev_session_id` | Optional. |
| **Customer email path** | `data.customer.email` | Used to attribute payments without a visitor id. |
| **Customer id path** | `data.customer.id` | Renewals and refunds without a visitor id (or original payment) reuse the first visitor linked to this customer, from their earliest attributed payment. |
| **Timestamp path** | `data.created_at` | Unix seconds, unix milliseconds or ISO 8601. Defaults to the time of receipt. |
| **Checkout reference path** | `data.checkout_id` | Matched with `?checkout_id=` on your success page (detected by the tracker) or with `openrev("payment", { ref })`. |
| **Renewal flag path** / **Renewal value** | `data.billing_reason` / `subscription_cycle` | If the value at the path equals the renewal value (case-insensitive), the payment is a renewal. With an empty renewal value, any truthy value (`true`, `1`, `"yes"`) means renewal. |
| **Subscription id path** | `data.subscription_id` | Payments that share a subscription id count as one subscription in [MRR](../features/mrr.md). |
| **Billing interval path** / **Interval count path** | `data.plan.interval` / `data.plan.interval_count` | How often the subscription bills (`month`, `year`, `weekly`, `annually`…) and how many intervals each payment covers. Optional: without them, MRR infers the interval from the gaps between payments. |

### Example

A provider sends:

```http
POST /api/webhooks/abc123?token=<url-token>
X-Acme-Signature: 5d41402abc4b2a76b9719d911017c592...

{
  "type": "payment.succeeded",
  "created": 1767225600,
  "data": {
    "id": "pay_123",
    "amount": 4900,
    "currency": "eur",
    "billing_reason": "subscription_cycle",
    "customer": { "id": "cus_1", "email": "ada@example.com" },
    "metadata": { "openrev_visitor_id": "3f1c2a9e-1b2c-4d5e-8f90-123456789abc" }
  }
}
```

Configuration: algorithm `HMAC-SHA256`, header `X-Acme-Signature`, encoding `hex`, event type path `type`, payment events `payment.succeeded`, amount path `data.amount` (minor), currency path `data.currency`, transaction id path `data.id`, email path `data.customer.email`, customer id path `data.customer.id`, timestamp path `created`, renewal path `data.billing_reason` = `subscription_cycle`. The visitor id is found automatically in `data.metadata`.

Result: a €49.00 **renewal** attributed to that visitor.

### Passing the visitor id

Read the `openrev_visitor_id` cookie on your server (or `window.openrev.visitorId()` in the browser) when you create the checkout, and store it wherever your provider keeps custom data (metadata, notes, custom fields, passthrough…). Make sure it comes back in the webhook payload.

The integration log (Settings → Revenue) shows why an event was ignored, e.g. `amount not found at data.amount`.

---

## Option 3: adding a built-in adapter

Built-in adapters live in `src/server/providers/`. They run on Cloudflare Workers and Node, so use only Web APIs (`fetch`, `crypto.subtle`, `TextEncoder`, `atob`/`btoa`) — no Node-only modules.

### 1. Implement `PaymentProvider`

Create `src/server/providers/acme.ts`:

```ts
import type { NormalizedPayment } from "../services/payments";
import type { PaymentProvider, ProviderResult } from "./types";
import { currencyCode, num, parseJson, pickSessionId, pickVisitorId, str, toMs, truthy, verifyHmacSignature } from "./util";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function parseAcmeEvent(event: Obj): ProviderResult {
  const d: Obj = event.data ?? {};
  const id = str(d.id)?.trim(); // unique + stable across retries (idempotency key)
  const amount = num(d.amount); // MINOR units
  const payments: NormalizedPayment[] = [];
  switch (event.type) {
    case "payment.succeeded":
      if (!id) return { payments, ignored: "missing payment id" };
      if (!amount || amount < 0) return { payments, ignored: "invalid amount" };
      payments.push({
        provider: "acme",
        transactionId: id,
        type: truthy(d.renewal) ? "renewal" : "new", // "false" or "0" strings are not renewals
        amount, // always positive
        currency: currencyCode(d.currency) ?? "USD",
        timestamp: toMs(d.created_at),
        visitorId: pickVisitorId(d.metadata),
        sessionId: pickSessionId(d.metadata),
        customerId: str(d.customer_id),
        email: d.email ?? null,
        ref: str(d.checkout_id), // optional: id the tracker can see on the success page
      });
      break;
    case "refund.created":
      if (!id) return { payments, ignored: "missing refund id" };
      if (!amount || amount < 0) return { payments, ignored: "invalid amount" };
      payments.push({
        provider: "acme",
        transactionId: `refund_${id}`,
        type: "refund",
        amount,
        currency: currencyCode(d.currency) ?? "USD",
        relatedTransactionId: str(d.payment_id), // inherits the payment's attribution
      });
      break;
    default:
      return { payments, ignored: `unhandled event ${event.type}` };
  }
  return { payments };
}

export const acme: PaymentProvider = {
  id: "acme", // used in webhook URLs, the payments table and docs/revenue/acme.md
  name: "Acme Pay",
  website: "https://acme.example",
  description: "One-time payments and refunds. Pass the visitor id as metadata.",
  fields: [{ key: "webhookSecret", label: "Webhook secret", type: "password", required: true, secret: true }],
  events: ["payment.succeeded", "refund.created"],
  metadataHint: "metadata: { openrev_visitor_id }",
  async verify(req, config) {
    return verifyHmacSignature({
      algorithm: "sha256",
      secret: config.webhookSecret,
      data: req.rawBody, // always verify the raw body
      signature: req.headers.get("acme-signature"),
      encoding: "hex",
    });
  },
  async parse(req) {
    const event = parseJson<Obj>(req.rawBody);
    if (!event) return { payments: [], ignored: "invalid JSON" };
    return parseAcmeEvent(event);
  },
};
```

Rules (see `NormalizedPayment` in `src/server/services/payments.ts`):

- `amount` is in **minor units** and always positive; refunds use `type: "refund"`. Convert decimal strings with `toMinor(major, currency)` from `src/server/lib/currency.ts`.
- `transactionId` must be unique per provider and identical for retries. If the provider sends two events for the same money (e.g. an order and a subscription payment for a subscription's first charge), map both to the same id or skip one of them.
- `type`: `new` for first purchases, `renewal` for recurring charges, `refund` for refunds. Set `relatedTransactionId` on refunds and `cumulative: true` when the provider reports cumulative refunded totals.
- Return `{ payments: [], ignored: "reason" }` for valid but irrelevant events — the reason appears in the integration log.
- Optional `goals`: `free_trial`, `trial_started`, `subscription_cancel_scheduled`, `subscription_ended`, `trial_converted`.
- Optional `importHistory(config, cursor)` to backfill payments from the provider's API (paginated; return `nextCursor: null` when done).

Helpers in `src/server/providers/util.ts`: `verifyHmacSignature`, `verifyStandardWebhook` (Standard Webhooks / Svix), `urlTokenMatches`, `pickVisitorId`, `pickSessionId`, `getPath`, `str`, `num`, `toMs`, `utcMs`, `parseJson`, `parseForm`, `pairsToObject`, `asObject`, `currencyCode`, `truthy`.

### 2. Register it

Add it to `PROVIDERS` in `src/server/providers/index.ts` (keep `custom` last). The dashboard picks up the name, description, fields, events and metadata hint automatically.

### 3. Add tests and docs

- `tests/providers/acme.test.ts`: sign realistic payloads with the provider's algorithm (`hmacHex` / `hmacBase64` from `src/server/lib/crypto.ts`), assert that `verify` accepts valid requests and rejects tampered bodies and wrong secrets, and that `parse` returns the right type, amount (minor units), currency, transaction id, visitor id and refunds. Build requests as:

  ```ts
  { rawBody, headers: new Headers({ ... }), url: new URL("https://x.test/api/webhooks/abc"), method: "POST" }
  ```

  `tests/providers/_helpers.ts` has `makeRequest`, `signHex`, `signBase64` and `standardWebhookHeaders`.
- `docs/revenue/acme.md`: where to create the webhook, which events to enable, which secret to paste and how to pass the visitor id. The dashboard links to `docs/revenue/<provider id>.md`.

Run `npx vitest run tests/providers` and `npx tsc --noEmit -p tsconfig.json`.
