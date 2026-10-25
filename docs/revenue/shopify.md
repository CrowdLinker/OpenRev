# Shopify

OpenRev records paid Shopify orders (including subscription renewal orders) and refunds, and attributes them to the visitor's traffic source. No checkout code is needed: the OpenRev script saves the visitor id in the cart.

## 1. Install the OpenRev script on your storefront

In Shopify admin open **Online Store → Themes → … → Edit code**, open `layout/theme.liquid` and paste your OpenRev snippet (Settings → Tracking code in OpenRev) before `</head>`:

```html
<script defer data-website-id="YOUR_WEBSITE_ID" data-domain="yourstore.com" src="https://YOUR-OPENREV-DOMAIN/js/script.js"></script>
```

On storefront pages the script detects Shopify and stores the visitor id as **cart attributes** (`openrev_visitor_id`, `openrev_session_id`) through `/cart/update.js`. Shopify copies cart attributes to the order's `note_attributes`, where OpenRev reads them.

## 2. Connect Shopify in OpenRev

1. Open **Settings → Revenue → Connect → Shopify**.
2. Paste the **webhook signing secret** (see below). If you have not created a webhook yet, leave it empty, click **Connect**, and come back to **Edit**.
3. Copy the webhook URL:

   ```
   https://YOUR-OPENREV-DOMAIN/api/webhooks/<integration-id>
   ```

## 3. Create the webhooks in Shopify

1. In Shopify admin go to **Settings → Notifications → Webhooks** and click **Create webhook** twice:

   | Event | Topic | Used for |
   | --- | --- | --- |
   | Order payment | `orders/paid` | Paid orders |
   | Refund create | `refunds/create` | Refunds |

   Format: **JSON**. URL: the OpenRev webhook URL. API version: the latest stable version.
2. Below the list Shopify shows **“Your webhooks will be signed with …”**. Copy that key and paste it into OpenRev as the webhook signing secret.

If you register the webhooks from a Shopify app instead, use that app's **client secret** as the signing secret.

## Optional: pass the visitor id yourself

Headless storefronts (Hydrogen, Storefront API) do not run the automatic cart update. Set the same cart attributes when you create or update the cart:

```graphql
mutation {
  cartAttributesUpdate(
    cartId: "gid://shopify/Cart/..."
    attributes: [{ key: "openrev_visitor_id", value: "VISITOR_ID" }, { key: "openrev_session_id", value: "SESSION_ID" }]
  ) {
    cart { id }
  }
}
```

Read the ids from the `openrev_visitor_id` / `openrev_session_id` cookies on your server, or `window.openrev.visitorId()` / `window.openrev.sessionId()` in the browser.

## How payments are counted

- Amount: `total_price` in the **shop currency** (major units such as `"19.99"`, converted to cents), including tax and shipping, then converted to your site currency.
- Each order id is recorded once (`orders/paid` retries are deduplicated).
- Orders created by subscription billing attempts (`source_name` `subscription_contract…`) are **renewals**; they inherit the attribution of the customer's first order when they have no cart attributes.
- `refunds/create` sums the successful `refund` transactions of the refund and links it to the order.
- Test orders (`test: true`, e.g. Bogus Gateway) are ignored, and so are `orders/paid` deliveries whose `financial_status` isn't `paid`, `partially_refunded` or `refunded`.

## Limitations

- Refund transactions are reported in the transaction currency; on multi-currency stores this can differ from the shop currency used for the order. Both are converted to your site currency with daily exchange rates.
- Orders created outside the online store (POS, draft orders, marketplaces) have no visitor id and are attributed by customer email or id only.
