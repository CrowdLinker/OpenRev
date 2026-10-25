# Creem

OpenRev records Creem one-time payments, subscription payments (first charge and renewals) and refunds, and attributes them to the visitor's traffic source.

## 1. Connect Creem in OpenRev

1. Open **Settings → Revenue → Connect → Creem** in OpenRev.
2. Paste your Creem **webhook signing secret** (Creem → **Developers → Webhooks**). If you create the webhook first, type a placeholder, click **Connect**, and use **Edit** later.
3. Copy the webhook URL:

   ```
   https://YOUR-OPENREV-DOMAIN/api/webhooks/<integration-id>
   ```

## 2. Create the webhook in Creem

1. In the Creem dashboard open **Developers → Webhooks** and add an endpoint.
2. URL: the OpenRev webhook URL.
3. Events (an empty event list subscribes to everything, which also works):

   | Event | Used for |
   | --- | --- |
   | `checkout.completed` | One-time purchases and first subscription payments |
   | `subscription.paid` | Subscription payments (renewals) |
   | `refund.created` | Refunds |
   | `subscription.trialing`, `subscription.scheduled_cancel`, `subscription.canceled` | Goals: `trial_started`, `subscription_cancel_scheduled`, `subscription_ended` (optional) |

4. Make sure the secret in OpenRev matches the endpoint's signing secret.

Test mode (`test-api.creem.io`) and live mode are separate; use one OpenRev integration for each.

## 3. Pass the visitor id at checkout

Creem stores checkout `metadata` and copies it onto the subscription, so every `subscription.paid` carries it too. OpenRev reads `openrev_visitor_id` and `openrev_session_id` from it.

### Checkout API

```js
// Node / Express — read the cookie set by the OpenRev script
const visitorId = req.cookies.openrev_visitor_id;

const res = await fetch("https://api.creem.io/v1/checkouts", {
  method: "POST",
  headers: { "x-api-key": process.env.CREEM_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({
    product_id: "prod_123",
    success_url: "https://example.com/thanks",
    metadata: { openrev_visitor_id: visitorId, openrev_session_id: req.cookies.openrev_session_id },
  }),
});
const { checkout_url } = await res.json();
```

In Next.js read the cookie with `(await cookies()).get("openrev_visitor_id")?.value`.

### Payment links

Creem payment links accept `metadata[...]` query parameters. Tag the link before the buyer leaves your site:

```html
<a id="buy" href="https://www.creem.io/payment/prod_123">Buy</a>
<script>
  document.getElementById("buy").addEventListener("click", (e) => {
    const vid = window.openrev?.visitorId?.();
    if (vid) {
      const url = new URL(e.currentTarget.href);
      url.searchParams.set("metadata[openrev_visitor_id]", vid);
      e.currentTarget.href = url.toString();
    }
  });
</script>
```

### Success page detection

Creem redirects to your success URL with `?checkout_id=…`. If that page runs the OpenRev script, the tracker reports the checkout id and OpenRev links the payment to the visitor even without metadata.

## How payments are counted

- Amount: the amount paid in cents, including tax (`order.amount_paid` for checkouts, `last_transaction.amount_paid` for subscription payments), converted to your site currency.
- A subscription's first payment produces both `checkout.completed` and `subscription.paid`. Both are keyed by the Creem **transaction id** (`order.transaction` / `last_transaction_id`), so the payment is counted once whichever arrives first. Later `subscription.paid` events are **renewals**.
- `ref` is the checkout id, matched with the `checkout_id` on your success page.
- Refunds (`refund_amount`) are linked to the refunded transaction and inherit its attribution.

## Limitations

- If a `subscription.paid` payload has no transaction details, the product price is used as the amount (it does not include tax or discounts).
- A subscription payment is treated as the first one (not a renewal) when it happens within an hour of the subscription's creation.
