# Revenue attribution

OpenRev links each payment to the visitor who made it when it can find them, then credits the traffic source, campaign, landing page, country and device of that visitor's visit. You get revenue, conversion rate and revenue per visitor next to every row of the dashboard — not just traffic.

## How a payment finds its visitor

The tracking script gives each visitor an id, stored in the first-party cookie `openrev_visitor_id` (and the session in `openrev_session_id`). When a payment arrives, OpenRev looks for that id, in this order:

1. **Checkout metadata** — the id you attached when creating the checkout (`metadata.openrev_visitor_id`, Lemon Squeezy `custom_data`, Paddle `custom_data`, Shopify cart attributes…). `datafast_visitor_id` is accepted too.
2. **Automatic tagging** — the tracker adds the visitor id to Stripe Payment Links (`client_reference_id`), Lemon Squeezy checkout links and Gumroad links, and to Shopify carts.
3. **Success-page detection** — when the visitor lands back on your site with `?session_id=cs_…` (Stripe Checkout), `?checkout_id=…` (Polar, Creem) or `?payment_id=…&status=succeeded` (Dodo), the tracker reports it and OpenRev links the payment — even if the webhook arrived first.
4. **Returning customers** — a refund reuses the visitor of the payment it refunds; otherwise renewals and refunds reuse the first visitor linked to the customer (`customer_id`), from their earliest attributed payment.
5. **Email** — if you call `openrev("identify", { email })` or `openrev("payment", { email })`, payments with that email are linked.

Payments that can't be linked still count toward totals and show as **Unattributed**.

## Attribution models

Choose per website in **Settings → General** (applies retroactively):

| Model | Credit goes to |
|---|---|
| **Last non-direct touch** (default) | The most recent visit before the payment that came from a real source (search, social, campaign, referral…). Direct visits — e.g. a customer typing your URL to log in — don't steal the credit. |
| **Last touch** | The most recent visit before the payment. |
| **First touch** | The visitor's very first visit. |

The **Customer lifetime value** report always groups customers by their first touch.

## Money

- Amounts are stored in the original currency and converted to the website currency with daily exchange rates (European Central Bank via frankfurter.dev, with fallbacks).
- Revenue is the gross amount paid by the customer (including tax), consistently across providers.
- **New** = first purchases and first subscription payments; **Renewals** = recurring charges; **Refunds** are subtracted from net revenue and inherit the original payment's attribution.
- Every provider event is idempotent: retries and duplicate webhooks are recorded once.

## Providers

| Provider | Guide | Events | Import history |
|---|---|---|---|
| Stripe | [stripe.md](stripe.md) | Checkout, Payment Links, subscriptions, PaymentIntents, refunds | ✅ |
| Lemon Squeezy | [lemonsqueezy.md](lemonsqueezy.md) | Orders, subscription renewals, refunds | ✅ |
| Polar | [polar.md](polar.md) | Orders, renewals, refunds | |
| Paddle (Billing) | [paddle.md](paddle.md) | Transactions, renewals, refunds/chargebacks | |
| Shopify | [shopify.md](shopify.md) | Paid orders, refunds | |
| Dodo Payments | [dodo.md](dodo.md) | Payments, renewals, refunds | |
| Creem | [creem.md](creem.md) | Checkouts, subscription payments, refunds | |
| Gumroad | [gumroad.md](gumroad.md) | Sales, memberships, refunds | |
| Paystack | [paystack.md](paystack.md) | Charges, refunds | |
| Razorpay | [razorpay.md](razorpay.md) | Payments, subscriptions, invoices, refunds | |
| WooCommerce | [woocommerce.md](woocommerce.md) | Orders, refunds | |
| **Any other system** | [custom-provider.md](custom-provider.md) | Configure JSON paths + signature for any webhook | |
| **Your backend** | [Payments API](../api/README.md#payments) | `POST /api/v1/payments` | |

You can connect several providers to the same website.

## Setup in 3 steps

1. **Settings → Revenue → Connect** and choose your provider. The signing secret can be added after the webhook exists.
2. Copy the **webhook URL** into your provider's dashboard and subscribe to the listed events, then paste the signing secret into OpenRev.
3. Pass the visitor id at checkout (see each guide). Read it server-side from the `openrev_visitor_id` cookie, or client-side with `window.openrev.visitorId()`.

The integration shows its status (**Receiving events**, or the last error such as an invalid signature) so you can verify the setup immediately. Get notified of every sale on Slack, Discord, Telegram or email with **Settings → Alerts**.

## Reserved goals

Some providers also emit lifecycle goals you can use in funnels and alerts: `free_trial`, `trial_started`, `trial_converted`, `subscription_cancel_scheduled`, `subscription_ended`.
