# Paddle

OpenRev supports **Paddle Billing** (the current Paddle platform with `txn_…` / `sub_…` ids). It records completed transactions — one-time purchases, subscription first payments and renewals — plus approved refunds and chargebacks. Paddle Classic is not supported.

## 1. Connect Paddle in OpenRev

1. Open **Settings → Revenue → Connect → Paddle** in OpenRev.
2. The **Webhook secret key** is created by Paddle in the next step. Type a placeholder for now, click **Connect**, and copy the webhook URL:

   ```
   https://YOUR-OPENREV-DOMAIN/api/webhooks/<integration-id>
   ```

## 2. Create a notification destination in Paddle

1. In Paddle go to **Developer tools → Notifications → New destination**.
2. Type: **Webhook**. URL: the OpenRev webhook URL. Usage type: platform (or both).
3. Select these events:

   | Event | Used for |
   | --- | --- |
   | `transaction.completed` | Every paid transaction (`origin` tells first purchases from renewals) |
   | `adjustment.created`, `adjustment.updated` | Refunds and chargebacks (counted once Paddle approves them) |
   | `subscription.created`, `subscription.canceled` | Goals: `trial_started`, `subscription_ended` (optional) |

4. Save, open the destination again and copy its **Secret key** (`pdl_ntfset_…`).
5. In OpenRev click **Edit** on the Paddle integration and paste the secret key.

Sandbox and live accounts have separate destinations and secrets; use one OpenRev integration per environment.

## 3. Pass the visitor id at checkout

Paddle copies checkout **custom data** to the transaction (`custom_data`). OpenRev reads `openrev_visitor_id` and `openrev_session_id` from it.

### Paddle.js overlay or inline checkout

```js
Paddle.Checkout.open({
  items: [{ priceId: "pri_01h...", quantity: 1 }],
  customData: {
    openrev_visitor_id: window.openrev?.visitorId?.(),
    openrev_session_id: window.openrev?.sessionId?.(),
  },
});
```

Optionally report the transaction id when the checkout completes, which links the payment even if custom data is missing:

```js
Paddle.Initialize({
  token: "live_...",
  eventCallback(event) {
    if (event.name === "checkout.completed") {
      window.openrev?.("payment", { ref: event.data.transaction_id });
    }
  },
});
```

### HTML checkout buttons

Set the custom data attribute from JavaScript before the button is clicked:

```html
<a href="#" class="paddle_button" data-items='[{"priceId":"pri_01h...","quantity":1}]'>Buy</a>
<script>
  document.querySelectorAll(".paddle_button").forEach((el) => {
    el.setAttribute("data-custom-data", JSON.stringify({ openrev_visitor_id: window.openrev?.visitorId?.() }));
  });
</script>
```

### Transactions created with the API

```js
// Node — read the cookie set by the OpenRev script
const visitorId = req.cookies.openrev_visitor_id;

await fetch("https://api.paddle.com/transactions", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.PADDLE_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    items: [{ price_id: "pri_01h...", quantity: 1 }],
    custom_data: { openrev_visitor_id: visitorId },
  }),
});
```

## How payments are counted

- Amount: `details.totals.grand_total` (lowest currency unit, including tax) in the transaction currency, converted to your site currency.
- `origin` `web` / `api` → **new**; `subscription_recurring`, `subscription_update`, `subscription_charge` → **renewal**. Each transaction is delivered once, so first payments are never double counted. Zero-value transactions (e.g. payment method updates) are ignored.
- Renewal transactions are attributed through the Paddle customer id of the first payment when they carry no custom data.
- Refunds are adjustments with `action: refund` (or `chargeback`). Most refunds need Paddle's approval: they are recorded when `status` becomes `approved` and are linked to the original transaction.
- The `transaction.completed` webhook does not include the customer's email.
