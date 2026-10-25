# Migrate from DataFast

OpenRev understands DataFast's script API, HTML attributes, cookies and visitor id metadata. For most sites, switching means changing the script tag and reconnecting your payment providers.

In the examples, `https://analytics.example.com` is your OpenRev instance and `example.com` is your site.

## 1. Create the website in OpenRev

Click **Add website**, enter your root domain (`example.com`) and pick the same timezone and currency you used in DataFast. Copy the website id from **Settings → Tracking code**.

## 2. Swap the script

Change `src` and `data-website-id`. Keep every other attribute: OpenRev supports the same ones (`data-domain`, `data-allowed-hostnames`, `data-api-url`, `data-allow-localhost`, `data-allow-file-protocol`, `data-debug`, `data-disable-console`, `data-disable-payments`).

Before:

```html
<script
  defer
  data-website-id="dfid_XXXXXXXX"
  data-domain="example.com"
  src="https://datafa.st/js/script.js"
></script>
```

After:

```html
<script
  defer
  data-website-id="YOUR_WEBSITE_ID"
  data-domain="example.com"
  src="https://analytics.example.com/js/script.js"
></script>
```

If you proxied DataFast through your domain, point the same proxy at your OpenRev instance instead. OpenRev uses the same paths (`/js/script.js` and `/api/events`). See [Proxy](../tracking/proxy.md); it explains which headers to forward.

For hash-based routing or cookieless tracking, use `/js/script.hash.js`, `/js/script.cookieless.js` or the matching `data-hash` / `data-cookieless` attributes ([script reference](../tracking/script-reference.md#script-variants)).

## 3. What keeps working as is

| DataFast | In OpenRev |
| --- | --- |
| `window.datafast("signup", { plan: "pro" })` | Works: `window.datafast` is an alias of `window.openrev` |
| `window.datafast("identify", { user_id, name, image, … })` | Works |
| `window.datafast("payment", { email })` | Works |
| The DataFast queue snippet (`window.datafast.q`) | Queued calls are replayed |
| `data-fast-goal`, `data-fast-goal-*` | Work like `data-openrev-goal` |
| `data-fast-scroll`, `data-fast-scroll-threshold`, `data-fast-scroll-delay`, `data-fast-scroll-*` | Work like `data-openrev-scroll` |
| `_df_vid` / `_df_sid` cross-domain parameters | Accepted |
| `localStorage.datafast_ignore = "true"` | Honored |
| `datafast_visitor_id` / `datafast_session_id` cookies | Adopted, see below |
| Goal names (lowercase letters, numbers, `_`, `-`, `:`, up to 64 characters) | Same rules ([naming](../tracking/goals.md#naming-rules)) |

You don't have to rename anything. For new code, `window.openrev` and the `data-openrev-*` attributes are the native names ([goals](../tracking/goals.md)).

`window.datafast` is only taken over when it isn't defined or is just the queue stub. If the real DataFast script is still on the page, `window.datafast` keeps pointing to DataFast.

## 4. Visitors stay continuous

When a returning visitor has a `datafast_visitor_id` cookie and no OpenRev cookie yet, OpenRev reuses that id as their `openrev_visitor_id` (and the same for the session cookie). So:

- the same person keeps the same visitor id in both tools;
- subscriptions created while you used DataFast, whose metadata carries `datafast_visitor_id`, point at a visitor id OpenRev also uses. Renewals are attributed once that visitor has been seen by OpenRev.

Historical DataFast analytics aren't imported. OpenRev starts counting from the moment the new script is live: a returning visitor keeps the same visitor id, but their first visit after the switch is the first one OpenRev records, so it counts as a new visitor.

## 5. Update your checkout code

OpenRev's payment adapters (Stripe, Lemon Squeezy, Polar, Paddle, Creem, Dodo, Paystack, Razorpay, Gumroad, Shopify, WooCommerce and custom webhooks) and its Payments, Goals and Identify APIs all accept `datafast_visitor_id` as the visitor id key. The payment adapters and the Payments API also accept `datafast_session_id` in place of `openrev_session_id`. **Your metadata keys can stay as they are.**

What must change is where the **value** comes from. Visitors who arrive after the switch only get the `openrev_visitor_id` cookie. Read it first:

```js
// Node / Express: before
const visitorId = req.cookies.datafast_visitor_id;

// after
const visitorId = req.cookies.openrev_visitor_id ?? req.cookies.datafast_visitor_id;

const session = await stripe.checkout.sessions.create({
  // ...
  metadata: { datafast_visitor_id: visitorId }, // or openrev_visitor_id: the key doesn't matter
});
```

In the browser, use `window.openrev.visitorId()` or read the `openrev_visitor_id` cookie.

Stripe Payment Links, Lemon Squeezy checkout links, Gumroad links and Shopify carts are tagged automatically by the script, as before ([script reference](../tracking/script-reference.md#automatic-behavior)).

## 6. Connect your payment providers

DataFast's revenue connections don't carry over. In OpenRev, open **Settings → Revenue → Connect**, pick your provider and follow its guide: OpenRev gives you a webhook URL to add in the provider's dashboard. See [Revenue](../revenue/README.md).

Some providers support **Import history** to backfill past payments. Payments from before the switch have no OpenRev sessions, so they'll mostly appear as unattributed.

## 7. Update API calls

If you call DataFast's API from your backend:

- Change the base URL from `https://datafa.st/api/v1` to `https://analytics.example.com/api/v1`.
- Create a key in **Settings → API & MCP** and send it as `Authorization: Bearer <key>`.
- `POST /payments` accepts DataFast's fields (`amount`, `currency`, `transaction_id`, `datafast_visitor_id`, `email`, `name`, `customer_id`, `renewal`, `refunded`, `timestamp`).
- `POST /goals` accepts `{ "datafast_visitor_id": "…", "name": "…", "metadata": { … } }`.
- Analytics breakdowns accept DataFast's names (`referrers`, `countries`, `devices`, `pages`…).

Details in the [API reference](../api/README.md).

## 8. Recreate your settings

Settings don't migrate. In OpenRev:

- **Settings → General:** additional domains for cross-domain tracking, attribution model, #1 KPI, cookieless mode.
- **Settings → Exclusions:** IPs, paths, countries, hostnames. Your `datafast_ignore` browsers stay excluded.
- **Funnels**, **Settings → Alerts**, **Settings → Team**.

## Running both tools for a while

You can keep both scripts on the page to compare numbers before removing DataFast:

- Both scripts read `data-fast-goal` and `data-fast-scroll` attributes, so attribute-based goals reach both.
- `window.datafast(...)` calls reach only DataFast while its script is installed. Add `window.openrev(...)` calls next to them for OpenRev.
- Expect some differences: each tool has its own bot filtering, and ad blockers treat the two scripts differently.

When you're happy, remove the DataFast script and disconnect DataFast from your payment providers.
