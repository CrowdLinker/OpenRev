# Dodo Payments

OpenRev records Dodo Payments one-time payments, subscription payments (first charge and renewals) and refunds, and attributes them to the visitor's traffic source.

## 1. Connect Dodo Payments in OpenRev

1. Open **Settings → Revenue → Connect → Dodo Payments** in OpenRev.
2. Dodo generates the signing secret in the next step. Leave it empty, click **Connect**, and copy the webhook URL:

   ```
   https://YOUR-OPENREV-DOMAIN/api/webhooks/<integration-id>
   ```

## 2. Create the webhook endpoint in Dodo Payments

1. In the Dodo Payments dashboard go to **Developer → Webhooks → Add endpoint**.
2. Endpoint URL: the OpenRev webhook URL.
3. Subscribe to:

   | Event | Used for |
   | --- | --- |
   | `payment.succeeded` | Every successful payment (one-time, first subscription charge, renewals) |
   | `refund.succeeded` | Refunds |

4. Click **Create endpoint**, then copy the **Signing secret** (`whsec_…`) from the endpoint's **Overview** tab and paste it into OpenRev (**Edit** on the integration).

Test mode and live mode have separate endpoints and secrets; use one OpenRev integration for each.

## 3. Pass the visitor id at checkout

Dodo stores checkout `metadata` on the resulting payment. OpenRev reads `openrev_visitor_id` (and `openrev_session_id`) from the payment metadata or the customer metadata. The DataFast key `datafast_visitor_id` is accepted too, so an existing DataFast setup keeps working.

### Checkout sessions (API / SDK)

```ts
import DodoPayments from "dodopayments";
import { cookies } from "next/headers";

const dodo = new DodoPayments({ bearerToken: process.env.DODO_PAYMENTS_API_KEY });
const jar = await cookies();

const session = await dodo.checkoutSessions.create({
  product_cart: [{ product_id: "pdt_123", quantity: 1 }],
  return_url: "https://example.com/thanks",
  metadata: {
    openrev_visitor_id: jar.get("openrev_visitor_id")?.value ?? "",
    openrev_session_id: jar.get("openrev_session_id")?.value ?? "",
  },
});
// redirect to session.checkout_url (or open it with the overlay checkout SDK)
```

With Express: `req.cookies.openrev_visitor_id`.

### Static payment links

Payment links accept `metadata_*` query parameters. Add the visitor id before sending the buyer to the link:

```html
<a id="buy" href="https://checkout.dodopayments.com/buy/pdt_123?quantity=1&redirect_url=https://example.com/thanks">Buy</a>
<script>
  document.getElementById("buy").addEventListener("click", (e) => {
    const vid = window.openrev?.visitorId?.();
    if (vid) {
      const url = new URL(e.currentTarget.href);
      url.searchParams.set("metadata_openrev_visitor_id", vid);
      e.currentTarget.href = url.toString();
    }
  });
</script>
```

### Overlay and inline checkout

Overlay/inline checkout opens a checkout session created on your server, so pass `metadata` when creating the session as shown above.

### Success page detection

Dodo appends `?payment_id=…&status=succeeded` to your return/redirect URL. If that page runs the OpenRev script, the tracker reports the payment id and OpenRev links the payment to the visitor even without metadata.

## How payments are counted

- Amount: `total_amount` (smallest currency unit, including tax) in the payment currency, converted to your site currency.
- `charge_type` `renewal`, `plan_change` and `on_demand` → **renewal**; everything else (one-time carts, first subscription payment) → **new**. Dodo sends one `payment.succeeded` per payment, so first payments are never double counted. Payments made only to update a payment method are ignored.
- Renewals without metadata inherit the attribution of the customer's first payment (same Dodo `customer_id`).
- Refunds are linked to the original `payment_id`; partial refunds are recorded individually.
