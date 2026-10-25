# Gumroad

OpenRev records Gumroad sales and membership renewals (and, optionally, refunds) through **Gumroad Ping**, and attributes them to the visitor's traffic source.

## 1. Connect Gumroad in OpenRev

Gumroad does not sign its webhooks, so OpenRev protects the endpoint with a secret token in the URL.

1. In OpenRev open **Settings → Revenue → Connect → Gumroad**. Leave **Webhook token** empty to have OpenRev generate a long random token (or paste your own, e.g. from `openssl rand -hex 24`).
2. Copy the webhook URL OpenRev shows — it already includes the token:

   ```
   https://YOUR-OPENREV-DOMAIN/api/webhooks/<integration-id>?token=<your token>
   ```

Requests without the right `?token=` are rejected.

## 2. Configure the Ping in Gumroad

1. In Gumroad open **Settings → Advanced → Ping**.
2. Paste the full URL from step 1, **including `?token=…`**, and save. Use **Send test ping** to check that OpenRev receives it (the integration's last event time updates).

### Optional: refunds

The settings Ping only sends sales. To also receive refunds, register a `refund` resource subscription with the Gumroad API (create an application in **Settings → Advanced → Applications** and generate an access token):

```bash
curl -X PUT https://api.gumroad.com/v2/resource_subscriptions \
  -d access_token=YOUR_ACCESS_TOKEN \
  -d resource_name=refund \
  --data-urlencode "post_url=https://YOUR-OPENREV-DOMAIN/api/webhooks/<integration-id>?token=<your token>"
```

## 3. Pass the visitor id

Gumroad returns any query parameters of the product URL in the ping's `url_params`.

### Product links and the Gumroad overlay

Nothing to do for links to `gumroad.com` (e.g. `https://you.gumroad.com/l/product`) or short `gum.co` links: when a visitor clicks one, the tracker adds `?openrev_visitor_id=<visitor id>`. The `gumroad.js` overlay and embed open the link's URL, so the parameter is passed along.

Links on a custom domain are not tagged automatically. Use the `gumroad.com` URL, or add the parameter yourself:

```js
document.querySelectorAll('a[href*="your-custom-domain.com/l/"]').forEach((a) => {
  a.addEventListener("click", () => {
    const vid = window.openrev?.visitorId?.();
    if (!vid) return;
    const url = new URL(a.href);
    url.searchParams.set("openrev_visitor_id", vid);
    a.href = url.toString();
  });
});
```

From a server-rendered page you can also build the link with the `openrev_visitor_id` cookie: `https://you.gumroad.com/l/product?openrev_visitor_id=${req.cookies.openrev_visitor_id}`.

## How payments are counted

- Amount: `price` in **USD cents** (Gumroad reports sale prices in USD regardless of the product's display currency), converted to your site currency.
- `sale_id` is the transaction id; repeated pings for the same sale are recorded once.
- `is_recurring_charge=true` → **renewal**. Renewals usually have no `url_params`; they are attributed through the buyer's email / purchaser id of the first sale.
- Refund pings (`resource_name=refund`) record a refund of the full sale price, linked to the sale.
- Purchases of your own products made from your seller account (`test=true`) and free products are ignored.

## Limitations

- Gumroad's refund ping does not include the refunded amount, so partial refunds are recorded as full refunds.
- The `?token=` is the only protection of the endpoint: keep the URL private and rotate the token (in OpenRev and Gumroad) if it leaks.
