# Yolfi

OpenRev records confirmed one-time [Yolfi](https://yolfi.com) crypto payments and attributes them to the visitor's traffic source. Both Paylinks and standalone API Checkout Sessions are supported.

## 1. Connect Yolfi in OpenRev

1. Open **Settings → Revenue → Connect → Yolfi**.
2. Leave the signing secret empty until the endpoint exists, click **Connect**, and copy the generated webhook URL:

   ```text
   https://YOUR-OPENREV-DOMAIN/api/webhooks/<integration-id>
   ```

## 2. Create a Yolfi webhook endpoint

1. Create an enabled webhook endpoint in your Yolfi organization with the OpenRev webhook URL.
2. Choose the native payload adapter, **NONE**, not the Stripe or Lemon Squeezy adapter.
3. Copy the endpoint's `signingSecret` returned on creation and paste it into **Webhook signing secret** when editing the OpenRev integration. This is not your organization API key. If the secret was not saved, rotate that endpoint's secret and save the new value in OpenRev.

Yolfi delivers native events to enabled endpoints. OpenRev handles `payment.confirmed` and acknowledges unrelated events without recording revenue. Requests are authenticated with the Base64 HMAC-SHA256 signature in `X-Yolfi-Signature`, computed over the exact raw body using that endpoint's signing secret.

See Yolfi's [webhook details](https://docs.yolfi.com/en/webhooks/webhook-details) and [signature reference](https://docs.yolfi.com/en/webhooks/webhook-signatures).

## 3. Pass the visitor id at checkout

Attach these string metadata values when creating an authenticated [API Checkout Session](https://docs.yolfi.com/en/checkout):

```ts
metadata: {
  openrev_visitor_id: cookies.openrev_visitor_id ?? "",
  openrev_session_id: cookies.openrev_session_id ?? "",
}
```

Read the cookies on your backend. The browser visitor id is also available through `window.openrev.visitorId()`. Keep your Yolfi API key on the backend; it is not required by the OpenRev provider.

For a Paylink, use Yolfi's documented [checkout parameters](https://docs.yolfi.com/en/paylinks/checkout-parameters) to attach metadata. OpenRev reads the current payment's `data.metadata`; do not assume metadata is inherited from a subscription.

Alternatively, identify the visitor with `openrev("identify", { email })`; the normal OpenRev email-attribution rules apply.

## How payments are counted

- Only live `payment.confirmed` events for `paymentType: "ONE_TIME"` are recorded as **New** payments. Invoice-created, overdue and sandbox events do not count as sales.
- **Amount basis:** `data.amountUsd` is the USD equivalent of the **final merchant receivable after fees**, not the gross checkout total. It is rounded to USD cents and converted to the website currency through OpenRev's normal currency conversion. Do not interpret these amounts as gross revenue or add them to a separate gross-payment feed for the same transactions. The source `currency` and crypto `amount` are not used as USD amounts.
- `data.invoiceId` is the stable transaction id, so OpenRev's existing payment deduplication handles retries. The unsigned `X-Yolfi-Event-ID` header is not used as a transaction id.
- `ref` is `checkoutSessionId` when present, otherwise `invoiceId`. Visitor/session metadata and customer email are used for attribution; this adapter does not add automatic success-page detection for Yolfi.
- Recurring payments are intentionally ignored: the current native payload does not distinguish a first recurring charge from a renewal, so this adapter does not invent a **New/Renewals** split or MRR. Refunds and historical import are not implemented.

The automated provider tests use signed fixtures based on the documented native payload. No live merchant account or real-money payment is required to run them.
