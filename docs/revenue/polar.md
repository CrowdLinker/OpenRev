# Polar

OpenRev records Polar orders — one-time purchases, subscription first payments and renewals — and refunds, and attributes them to the visitor's traffic source.

## 1. Connect Polar in OpenRev

1. Open **Settings → Revenue → Connect → Polar** in OpenRev.
2. Polar generates the webhook secret in the next step. Type a placeholder, click **Connect**, and copy the webhook URL:

   ```
   https://YOUR-OPENREV-DOMAIN/api/webhooks/<integration-id>
   ```

## 2. Create the webhook endpoint in Polar

1. In Polar open **Settings → Webhooks → Add Endpoint**.
2. URL: the OpenRev webhook URL. Format: **Raw**.
3. Select these events:

   | Event | Used for |
   | --- | --- |
   | `order.paid` | Every paid order (purchases, subscription creation and renewals) |
   | `order.refunded` | Full and partial refunds |
   | `subscription.created`, `subscription.canceled`, `subscription.revoked` | Goals: `trial_started`, `subscription_cancel_scheduled`, `subscription_ended` (optional) |

4. Copy the endpoint **secret** (`whsec_…`) and paste it into OpenRev (**Edit** on the integration). Paste it exactly as shown; both Polar signing schemes (secrets created before and after 8 September 2026) are supported.

Use a separate endpoint and OpenRev integration for the Polar sandbox.

## 3. Pass the visitor id at checkout

Polar copies checkout `metadata` to the order and subscription, and `customer_metadata` to the customer. OpenRev looks for `openrev_visitor_id` in both.

### Checkout links (no code)

In **Products → Checkout Links**, set the **Success URL** to a page on your site that runs the OpenRev script, with Polar's placeholder:

```
https://example.com/thanks?checkout_id={CHECKOUT_ID}
```

The tracker reports the `checkout_id` when the buyer lands on that page, and OpenRev links the order (whose `checkout_id` matches) to the visitor. This works for renewals too, since they inherit the first order's attribution.

### Checkout sessions (API / SDK)

```ts
import { Polar } from "@polar-sh/sdk";
import { cookies } from "next/headers";

const polar = new Polar({ accessToken: process.env.POLAR_ACCESS_TOKEN! });
const jar = await cookies();

const checkout = await polar.checkouts.create({
  products: ["PRODUCT_ID"],
  successUrl: "https://example.com/thanks?checkout_id={CHECKOUT_ID}",
  metadata: {
    openrev_visitor_id: jar.get("openrev_visitor_id")?.value ?? "",
    openrev_session_id: jar.get("openrev_session_id")?.value ?? "",
  },
});
// redirect to checkout.url
```

With Express: `req.cookies.openrev_visitor_id`. In the browser: `window.openrev.visitorId()`.

### Embedded checkout

Embedded checkouts are created from the same checkout links or sessions, so use the success URL (or metadata) as above.

## How payments are counted

- Amount: `total_amount` (cents, after discounts, including tax) in the order currency, converted to your site currency.
- `billing_reason` `purchase` / `subscription_create` → **new**; `subscription_cycle`, `subscription_update`, `subscription_meter_cycle` → **renewal**. Polar sends one `order.paid` per order, so nothing is counted twice.
- `ref` is the order's `checkout_id`, matched with the `checkout_id` the tracker sees on your success page.
- `order.refunded` carries the cumulative `refunded_amount` + `refunded_tax_amount`; the refund is updated, not duplicated, when more is refunded later.
- Zero-amount subscription orders (free trials) record a `free_trial` goal instead of a payment.
