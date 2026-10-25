# Lemon Squeezy

OpenRev records Lemon Squeezy orders, subscription renewals and refunds, and attributes them to the visitor's traffic source.

## 1. Connect Lemon Squeezy in OpenRev

1. Choose a signing secret: any random string of 6–40 characters (for example the output of `openssl rand -hex 16`).
2. In OpenRev open **Settings → Revenue → Connect → Lemon Squeezy** and paste that secret as **Webhook signing secret**.
3. Copy the webhook URL OpenRev shows:

   ```
   https://YOUR-OPENREV-DOMAIN/api/webhooks/<integration-id>
   ```

Optional: add an **API key** (Lemon Squeezy → Settings → API) and click **Import history** to backfill past orders and renewals. Set **Store ID** if the key has access to several stores. Imported orders have no visitor id (Lemon Squeezy does not return checkout custom data from the API), so they are matched by customer email when possible.

## 2. Create the webhook in Lemon Squeezy

1. Go to **Settings → Webhooks** and click **+**.
2. **Callback URL**: the OpenRev webhook URL.
3. **Signing secret**: the same secret you entered in OpenRev.
4. Select these events:

   | Event | Used for |
   | --- | --- |
   | `order_created` | One-time purchases and the first payment of a subscription |
   | `order_refunded` | Order refunds (full and partial) |
   | `subscription_payment_success` | Subscription renewals |
   | `subscription_payment_refunded` | Refunds of renewal payments |
   | `subscription_created`, `subscription_cancelled`, `subscription_expired` | Goals: `trial_started`, `subscription_cancel_scheduled`, `subscription_ended` (optional) |

5. Save. Webhooks created in test mode only receive test-mode events — create a separate webhook (and OpenRev integration) for live mode.

## 3. Pass the visitor id at checkout

Lemon Squeezy forwards checkout **custom data** to webhooks as `meta.custom_data`. OpenRev looks for `openrev_visitor_id` (and `openrev_session_id`) there.

### Checkout links and the Lemon.js overlay

Nothing to do. When a visitor clicks a `https://<store>.lemonsqueezy.com/checkout/…` link (including `lemonsqueezy-button` overlay links), the tracker appends:

```
?checkout[custom][openrev_visitor_id]=<visitor id>&checkout[custom][openrev_session_id]=<session id>
```

If you open checkouts from JavaScript (`LemonSqueezy.Url.Open(url)`) or use a custom checkout domain, add the parameters yourself:

```js
const url = new URL("https://yourstore.lemonsqueezy.com/checkout/buy/VARIANT_ID");
const vid = window.openrev?.visitorId?.();
if (vid) url.searchParams.set("checkout[custom][openrev_visitor_id]", vid);
LemonSqueezy.Url.Open(url.toString());
```

### Checkouts created with the API

```js
// Node — read the cookie set by the OpenRev script
const visitorId = req.cookies.openrev_visitor_id;

await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`,
    Accept: "application/vnd.api+json",
    "Content-Type": "application/vnd.api+json",
  },
  body: JSON.stringify({
    data: {
      type: "checkouts",
      attributes: { checkout_data: { custom: { openrev_visitor_id: visitorId } } },
      relationships: {
        store: { data: { type: "stores", id: "STORE_ID" } },
        variant: { data: { type: "variants", id: "VARIANT_ID" } },
      },
    },
  }),
});
```

## How payments are counted

- Amount: the order/invoice `total` (cents, including tax) in the order currency, converted to your site currency.
- A subscription's first payment triggers both `order_created` and `subscription_payment_success` (`billing_reason: initial`). OpenRev counts the order and skips the initial invoice, so nothing is double counted. Invoices with `billing_reason` `renewal` or `updated` are **renewals**.
- Renewals usually carry the same custom data; if not, they inherit the attribution of the customer's first order (same Lemon Squeezy `customer_id`).
- `refunded_amount` is cumulative, so partial refunds followed by a full refund are handled correctly. Refunds link to the original order or invoice.
- Only orders with status `paid` (or later `refunded` / `partial_refund`) are recorded; `pending` and `failed` orders are ignored.

## Limitations

- A refund of the *initial* subscription payment is taken from `order_refunded`; the matching `subscription_payment_refunded` (billing reason `initial`) is ignored to avoid counting it twice.
