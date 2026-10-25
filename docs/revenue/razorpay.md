# Razorpay

OpenRev records captured Razorpay payments (Standard Checkout, Payment Links, Invoices), subscription charges (first payment and renewals) and refunds, and attributes them to the visitor's traffic source.

## 1. Connect Razorpay in OpenRev

1. Choose a webhook secret (a long random string, e.g. `openssl rand -hex 24`). This is **not** your API key secret.
2. In OpenRev open **Settings → Revenue → Connect → Razorpay** and paste it as **Webhook secret**.
3. Copy the webhook URL:

   ```
   https://YOUR-OPENREV-DOMAIN/api/webhooks/<integration-id>
   ```

## 2. Create the webhook in Razorpay

1. In the Razorpay Dashboard go to **Accounts & Settings → Webhooks → Add New Webhook**.
2. Webhook URL: the OpenRev URL. Secret: the same secret as in OpenRev.
3. Active events:

   | Event | Used for |
   | --- | --- |
   | `payment.captured` | One-time payments |
   | `order.paid` | One-time payments (also reads the order's `notes`, recommended for Payment Links) |
   | `subscription.charged` | Subscription payments (first charge and renewals) |
   | `invoice.paid` | Standalone Razorpay Invoices |
   | `refund.processed` | Refunds |

   `payment.captured` and `order.paid` describe the same payment and are recorded once.

Test mode and live mode have separate webhooks; create one OpenRev integration for each.

## 3. Pass the visitor id at checkout

OpenRev reads `openrev_visitor_id` (and `openrev_session_id`) from `notes` on the payment, order, subscription or invoice.

### Orders API + Standard Checkout

```js
// Server (Node) — read the cookie set by the OpenRev script
const order = await razorpay.orders.create({
  amount: 50000, // paise
  currency: "INR",
  notes: { openrev_visitor_id: req.cookies.openrev_visitor_id },
});
```

```js
// Browser — Checkout notes are stored on the payment
const rzp = new Razorpay({
  key: "rzp_live_...",
  order_id: order.id,
  notes: { openrev_visitor_id: window.openrev?.visitorId?.() },
  handler: (response) => {
    // Optional: links the payment through the order id even without notes.
    window.openrev?.("payment", { ref: response.razorpay_order_id });
  },
});
rzp.open();
```

### Subscriptions

```js
await razorpay.subscriptions.create({
  plan_id: "plan_123",
  total_count: 12,
  notes: { openrev_visitor_id: req.cookies.openrev_visitor_id },
});
```

Subscription notes are sent with every `subscription.charged` event, so renewals keep their attribution.

### Payment Links

Create links with `notes: { openrev_visitor_id }` and enable `order.paid`, which includes the order's notes.

In Next.js read the cookie with `(await cookies()).get("openrev_visitor_id")?.value`.

## How payments are counted

- Amount: `amount` in the currency subunit (paise for INR), converted to your site currency.
- The payment id (`pay_…`) is the transaction id; `ref` is the order id (`order_…`).
- Payments with an `invoice_id` belong to subscriptions or invoices: they are skipped in `payment.captured` / `order.paid` and counted from `subscription.charged` (`paid_count` 1 → **new**, more → **renewal**) or `invoice.paid` (standalone invoices), so nothing is counted twice.
- Refunds (`rfnd_…`) are linked to the original payment; each partial refund is recorded separately.
