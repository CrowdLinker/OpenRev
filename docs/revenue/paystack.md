# Paystack

OpenRev records successful Paystack charges (one-time and subscription) and processed refunds, and attributes them to the visitor's traffic source.

## 1. Connect Paystack in OpenRev

Paystack signs webhooks with your **secret key** (there is no separate webhook secret).

1. In Paystack open **Settings → API Keys & Webhooks** and copy the **Live Secret Key** (`sk_live_…`).
2. In OpenRev open **Settings → Revenue → Connect → Paystack** and paste it as **Secret key**. It is encrypted at rest and only used to verify signatures and, when you import history, to read past transactions.
3. Copy the webhook URL:

   ```
   https://YOUR-OPENREV-DOMAIN/api/webhooks/<integration-id>
   ```

**Import past transactions:** click **Import history** on the integration. It uses the same secret key to read every
successful transaction, then processed refunds (a charge refunded in full is imported with its refund). Transactions
keep the visitor id when it was in their metadata; older ones are matched by customer email when possible. Use the
test key's integration to import test transactions.

## 2. Set the webhook URL in Paystack

1. On the same **Settings → API Keys & Webhooks** page, paste the OpenRev URL into **Live Webhook URL** and save.
2. Paystack sends every event to that URL; OpenRev uses `charge.success` and `refund.processed` and ignores the rest.

For test mode, create a second OpenRev integration with your `sk_test_…` key and put its URL in **Test Webhook URL**.

## 3. Pass the visitor id at checkout

OpenRev reads `openrev_visitor_id` (and `openrev_session_id`) from the transaction `metadata`, including Paystack `custom_fields` entries whose `variable_name` is `openrev_visitor_id`.

### Initialize Transaction (API, redirect checkout)

```js
// Node / Express — read the cookie set by the OpenRev script
const res = await fetch("https://api.paystack.co/transaction/initialize", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    email: customer.email,
    amount: 500000, // in kobo / pesewas / cents
    callback_url: "https://example.com/thanks",
    metadata: {
      openrev_visitor_id: req.cookies.openrev_visitor_id,
      openrev_session_id: req.cookies.openrev_session_id,
    },
  }),
});
const { data } = await res.json(); // redirect to data.authorization_url
```

In Next.js read the cookie with `(await cookies()).get("openrev_visitor_id")?.value`.

### Paystack Popup (InlineJS)

```js
const popup = new PaystackPop();
popup.newTransaction({
  key: "pk_live_...",
  email: "customer@example.com",
  amount: 500000,
  metadata: { openrev_visitor_id: window.openrev?.visitorId?.() },
  onSuccess: (transaction) => {
    // Optional: links the payment even if metadata was not saved.
    window.openrev?.("payment", { ref: transaction.reference });
  },
});
```

### Subscriptions

Pass the metadata when initializing the first transaction with a `plan`. Renewal charges are created by Paystack and are attributed through the customer (`customer_code`) of the first payment.

### Payment pages (no code)

Payment Pages cannot carry metadata. Call `window.openrev("identify", { email })` on your site when you learn the buyer's email (e.g. at sign-up); OpenRev then matches payments by email.

## How payments are counted

- Amount: `amount` in the currency subunit (kobo for NGN, pesewas for GHS, cents for USD/ZAR/KES), converted to your site currency.
- The transaction `reference` is the transaction id (and the `ref` used by `openrev("payment", { ref })`); repeated deliveries are recorded once.
- Refunds (`refund.processed`) are linked to the original transaction through `transaction_reference`.

## Limitations

- Paystack does not flag renewals. A charge on a plan whose metadata has no OpenRev visitor id (or that has `invoice_action` metadata) is recorded as a **renewal**; a plan charge with a visitor id is recorded as **new**. Pass the visitor id on first subscription payments for correct classification.
