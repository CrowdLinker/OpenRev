# Stripe

OpenRev records Stripe Checkout Sessions, Payment Links, subscriptions (first payment and every renewal), PaymentIntents from custom flows, and refunds. Each payment is attributed to the visitor's traffic source.

## 1. Connect Stripe in OpenRev

1. Open your website in OpenRev and go to **Settings → Revenue → Connect → Stripe**.
2. Paste the **webhook signing secret** (`whsec_…`). If you have not created the Stripe endpoint yet, leave it empty, click **Connect**, and come back to **Edit** once you have the real secret.
3. Copy the webhook URL OpenRev shows. It looks like:

   ```
   https://YOUR-OPENREV-DOMAIN/api/webhooks/<integration-id>
   ```

Optional: add a **restricted API key** with read access to Checkout Sessions, Invoices and Charges, then use **Import history** to backfill past payments.

## 2. Create the webhook in Stripe

1. In the Stripe Dashboard open **Developers → Webhooks** (Workbench) and add an endpoint (destination) for your account.
2. Endpoint URL: the OpenRev webhook URL from step 1.
3. Select these events:

   | Event | Used for |
   | --- | --- |
   | `checkout.session.completed` | Checkout and Payment Link purchases |
   | `checkout.session.async_payment_succeeded` | Delayed payment methods (SEPA, bank transfers…) |
   | `invoice.paid` | Subscription first payments and renewals |
   | `payment_intent.succeeded` | Custom flows (Elements / PaymentIntents API), only when you pass a visitor id |
   | `charge.refunded` | Refunds (full and partial) |
   | `customer.subscription.created` / `updated` / `deleted` | Goals: `trial_started`, `subscription_cancel_scheduled`, `trial_converted`, `subscription_ended` |

4. Reveal the endpoint's **Signing secret** (`whsec_…`) and paste it into OpenRev (**Edit** on the integration).

Use a separate OpenRev integration for test mode and live mode — each Stripe endpoint has its own secret.

## 3. Pass the visitor id at checkout

The OpenRev script stores the visitor id in the `openrev_visitor_id` cookie (and `openrev_session_id` for the session). Attach them to the checkout so the payment can be attributed.

### Checkout Sessions (API)

```js
// Node / Express — read the cookies set by the OpenRev script
const visitorId = req.cookies.openrev_visitor_id;
const sessionId = req.cookies.openrev_session_id;

const session = await stripe.checkout.sessions.create({
  mode: "subscription", // or "payment"
  line_items: [{ price: "price_123", quantity: 1 }],
  success_url: "https://example.com/success?session_id={CHECKOUT_SESSION_ID}",
  cancel_url: "https://example.com/pricing",
  metadata: { openrev_visitor_id: visitorId, openrev_session_id: sessionId },
  // Recommended for subscriptions: renewal invoices then carry the visitor id too.
  subscription_data: { metadata: { openrev_visitor_id: visitorId } },
});
```

```ts
// Next.js (App Router, server action / route handler)
import { cookies } from "next/headers";
const jar = await cookies();
const visitorId = jar.get("openrev_visitor_id")?.value;
```

`client_reference_id: visitorId` works too.

### Payment Links

Nothing to do: the tracker adds `client_reference_id=<visitor id>` to every `buy.stripe.com` link on your site when it is clicked.

### Success page detection

If your success URL contains `?session_id={CHECKOUT_SESSION_ID}`, the tracker reports the `cs_…` id when the buyer lands on it, which links the payment to the visitor even without metadata.

### Custom flows (PaymentIntents / Elements)

```js
await stripe.paymentIntents.create({
  amount: 4900,
  currency: "usd",
  metadata: { openrev_visitor_id: visitorId },
});
```

`payment_intent.succeeded` is only recorded when this metadata is present (otherwise Checkout events already cover the payment).

In the browser, `window.openrev.visitorId()` returns the same id if you create checkouts from client-side code.

## How payments are counted

- Amount: `amount_total` / `amount_paid` in the payment currency, converted to your site currency.
- A subscription's first payment arrives as both `checkout.session.completed` and `invoice.paid`; both use the invoice id as the transaction id, so it is counted once. `invoice.paid` with `billing_reason=subscription_cycle` is a **renewal**.
- One-time Checkout payments are keyed by the PaymentIntent id, so `payment_intent.succeeded` for the same payment is not counted twice.
- `charge.refunded` reports the cumulative refunded amount; OpenRev updates the refund instead of adding a new one. Refunds inherit the original payment's attribution.
- Renewals without metadata are attributed through the Stripe customer id of the first payment.
- Zero-amount subscription checkouts (free trials) record a `free_trial` goal instead of a payment.

## Troubleshooting

- **401 Invalid signature** in the integration log: the signing secret does not match the endpoint (test vs live), or a proxy modified the request body.
- **Payments without a source**: make sure the OpenRev script runs on the page that starts checkout and that you pass `openrev_visitor_id` (or use a Payment Link / `session_id` success URL).
