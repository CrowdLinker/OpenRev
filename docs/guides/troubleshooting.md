# Troubleshooting

In the examples, `https://analytics.example.com` is your OpenRev instance and `example.com` is your site.

- [Start here: read the response](#start-here-read-the-response)
- [No data at all](#no-data-at-all)
- [Some visits are missing](#some-visits-are-missing)
- [Duplicate pageviews](#duplicate-pageviews)
- [Wrong locations](#wrong-locations)
- [Goals don't show up](#goals-dont-show-up)
- [Revenue isn't attributed](#revenue-isnt-attributed)
- [Numbers look off by a day](#numbers-look-off-by-a-day-timezones)

## Start here: read the response

OpenRev tells you why it ignored an event. Open your site, then the browser devtools:

1. **Console:** look for messages starting with `[OpenRev]`. `Tracking disabled: …` means the script decided not to send anything, and says why.
2. **Network:** filter by `events` and reload. Click the `POST /api/events` request and look at the response.

| Response | Meaning | Fix |
| --- | --- | --- |
| `202 {"ok":true}` | Stored | — |
| no request at all | The script didn't load or didn't run | See [No data at all](#no-data-at-all) |
| `unknown_website` | `data-website-id` doesn't match a website on this OpenRev instance | Copy the snippet again from **Settings → Tracking code** |
| `hostname_not_allowed` | The page's hostname isn't your domain, a subdomain or an additional domain (or it's localhost and localhost isn't allowed) | Fix the domain in **Settings → General**, or add the hostname under **Additional domains** |
| `bot` | The user agent looks like a bot or is missing | Use a normal browser. Behind a proxy, forward the `User-Agent` header ([proxy rules](../tracking/proxy.md#rules-every-proxy-must-follow)) |
| `excluded` | The event matched an [exclusion rule](../tracking/exclusions.md) (IP, path, country or hostname) | Check **Settings → Exclusions** |
| `invalid_goal_name` | The goal name is empty after normalization | Use letters, numbers, `_`, `-` or `:` ([naming rules](../tracking/goals.md#naming-rules)) |
| `missing_user_id`, `missing_ref` | `identify` was called without `user_id` or `email`, or `payment` without `email` or `ref` | Pass the missing field ([identify](../tracking/identify.md)) |
| `invalid_url`, `missing_website_id`, `invalid_type` | Malformed request | Usually a custom integration or a broken proxy sending the wrong body |
| `400 invalid_json` | The body isn't the JSON the script sent | Your proxy changed the body; forward it unchanged |
| `413 payload_too_large` | Event over 32 KB | Send fewer or shorter properties |

The event status box in **Settings → Tracking code** shows **OpenRev is receiving data** as soon as one event is stored.

## No data at all

### The script isn't on the page

View the page source of the **published** site and search for `data-website-id`. In the console, `typeof openrev` should be `"function"`. Site builders often need a publish step after editing custom code, and some only run custom code on a paid plan or a connected domain ([install guides](../tracking/install.md)).

### An ad blocker or privacy setting blocks it

uBlock Origin, AdGuard, Brave Shields, Firefox strict mode and Safari's advanced protection can block the script or `/api/events`. The Network tab then shows the request as blocked (`ERR_BLOCKED_BY_CLIENT`) or missing. Test in a clean browser profile. To recover these visitors in production, [proxy the script through your domain](../tracking/proxy.md).

### You're testing on localhost or a file

`localhost`, `127.0.0.1`, `*.localhost` and `file://` pages are ignored by default (console: `Tracking disabled: localhost`). To test locally, both:

1. add `data-allow-localhost="true"` (or `data-allow-file-protocol="true"`) to the script tag, and
2. turn on **Settings → General → Accept events from localhost**.

A LAN address (`192.168.1.20`) or a tunnel (`*.ngrok.app`) isn't localhost: it's rejected by the hostname check unless you add it under **Additional domains** or turn off **Only accept events from my domains**.

### The hostname check rejects your events

Response: `hostname_not_allowed`. OpenRev only accepts events from the website's domain, its subdomains and the **Additional domains** in **Settings → General** (as long as **Only accept events from my domains** is on, the default). Common causes:

- the domain in OpenRev has a typo or a different TLD (`example.co` vs `example.com`). `www.` doesn't matter;
- you're testing on a preview or staging URL (`*.vercel.app`, `*.netlify.app`, `*.webflow.io`, `*.framer.website`, `*.bubbleapps.io`…);
- the site lives on a second domain that isn't listed ([cross-domain tracking](../tracking/cross-domain.md)).

`data-domain` in the snippet doesn't affect this check. It only controls which domain cookies are set on. A wrong `data-domain` doesn't block events, but it breaks visitor continuity between subdomains.

### The page is in an iframe

The script ignores pages running inside an iframe (console: `inside an iframe`), which includes most site-builder editors and previews. Test on the published site, or add `data-debug="true"` if your site really is embedded.

### Automated browsers

Playwright, Puppeteer, Selenium and other WebDriver-controlled browsers aren't tracked (`navigator.webdriver` is set). Test manually.

### Content Security Policy

If your site sends a `Content-Security-Policy` header, the console shows a CSP error. Allow your OpenRev origin for scripts (to load `script.js`) and for connections (to send events):

```text
Content-Security-Policy: script-src 'self' https://analytics.example.com; connect-src 'self' https://analytics.example.com
```

If you use the inline queue snippet, also allow it with a nonce or hash (or `'unsafe-inline'`). With a [proxy](../tracking/proxy.md), everything is served from your own domain and `'self'` is enough.

### Your own visits are excluded

If you ran `localStorage.setItem("openrev_ignore", "true")` on this browser (console: `localStorage.openrev_ignore is set`), your visits are ignored on purpose. Also check that your IP or country isn't in **Settings → Exclusions**.

### The script is installed twice

The script runs once per page. If two snippets with different website ids are on the same page (for example one hard-coded and one from GTM), only the first one tracks.

### Settings changes haven't applied yet

Changes to domains, localhost and exclusions can take up to 30 seconds to apply.

## Some visits are missing

- **Ad blockers:** the most common cause of lower numbers than other tools. Use a [proxy](../tracking/proxy.md).
- **Bot filtering:** crawlers, monitors and HTTP clients are dropped ([list](../tracking/exclusions.md#filtered-automatically)). Other tools may count some of them.
- **Script delayed:** "delay JavaScript" features of WordPress optimization plugins and some site builders only load scripts after the first interaction, so quick bounces are lost. Exclude the OpenRev script from them.
- **Cookieless mode:** returning visitors count as new every day, and visitors behind the same IP with the same browser can merge.

## Duplicate pageviews

The script loads only once per page and skips a route change to the path it just counted. Duplicates usually come from:

- **Manual `openrev("pageview")` calls** on route changes. Single-page apps are tracked automatically; remove the manual call ([details](../tracking/spa-and-hash-routing.md#manual-pageviews)).
- **Client-side redirects** right after load (`/` → `/en`, or adding a trailing slash with `history.replaceState`): the first URL and the redirected one both count. Redirect on the server instead.
- **Hash mode on a site that doesn't route with the hash:** every `#anchor` click counts as a page. Use the regular `script.js`.

## Wrong locations

If many visitors show the same city or country (your server's or hosting provider's), OpenRev is seeing your proxy's IP instead of the visitor's:

- forward `X-Forwarded-For` in your [proxy](../tracking/proxy.md);
- on a Node/Docker instance, don't set `TRUST_PROXY=false` if a proxy sits in front of OpenRev;
- if OpenRev is behind Cloudflare or runs on Cloudflare Workers, read [Where OpenRev is hosted matters](../tracking/proxy.md#where-openrev-is-hosted-matters).

On Node/Docker, also check the server log for `Geolocation database loaded`. If the database couldn't be downloaded, locations are only filled in when your host adds location headers.

## Goals don't show up

- **Called before the script loaded:** without the [queue snippet](../tracking/script-reference.md#calling-the-api-before-the-script-loads), `openrev(...)` throws `openrev is not defined` before the script has loaded.
- **Name changed:** names are normalized: `Sign Up` is recorded as `sign_up`, `checkout.started` as `checkoutstarted` ([rules](../tracking/goals.md#naming-rules)).
- **`data-openrev-goal` on a `<form>`:** goals fire on clicks, not on submit. Put the attribute on the submit button.
- **Scroll goal never fires:** with the default threshold of `0.5`, an element more than twice the screen height can never be half visible. Lower `data-openrev-scroll-threshold` or put the attribute on a smaller element.
- **Server-side goals:** `POST /api/v1/goals` needs a valid API key from a website admin and `openrev_visitor_id` (`datafast_visitor_id` is still accepted for migrated integrations). A `401` means the key is wrong, a `403` that the key belongs to a viewer; a `422` names the missing field.

## Revenue isn't attributed

Payments appear in **Revenue** but their source is **Unattributed**, or they don't appear at all.

### Payments don't appear

Open **Settings → Revenue** and look at the provider's badge:

- **Waiting for first event:** the provider isn't sending webhooks yet. Check that the webhook URL from OpenRev is configured in the provider's dashboard, with the right events, in the right mode (test vs live).
- **Error** with *Invalid webhook signature — check the signing secret.*: the secret in OpenRev doesn't match the provider's endpoint. Test and live endpoints have different secrets. Click **Edit** and paste the secret again.
- **Error** with *Missing … — add it in Settings → Revenue.*: a required field of the integration is empty.
- **Paused:** the integration is disabled.

Provider-specific steps are in [Revenue](../revenue/README.md).

### Payments appear as Unattributed

OpenRev couldn't link the payment to a visitor, or that visitor has no recorded sessions.

- **No visitor id in the checkout metadata.** Pass `openrev_visitor_id` (the value of the `openrev_visitor_id` cookie) in your checkout metadata; `datafast_visitor_id` is still accepted for migrated integrations. Payment Links, Lemon Squeezy checkout links, Gumroad links and Shopify carts are tagged automatically by the script, unless `data-disable-payments` is set.
- **Reading the wrong cookie after migrating from DataFast.** New visitors only have `openrev_visitor_id`; see [Migrate from DataFast](migrate-from-datafast.md#5-update-your-checkout-code).
- **The buyer's browser blocked the script,** so there are no sessions to credit. A [proxy](../tracking/proxy.md) fixes most of these.
- **Checkout on another domain** that isn't set up for [cross-domain tracking](../tracking/cross-domain.md).
- **Cookieless mode**: there's no visitor id in the browser to pass. Rely on the success page (`?session_id={CHECKOUT_SESSION_ID}` for Stripe), [`identify`](../tracking/identify.md) with the customer's email, or `openrev("payment", { email })` on your thank-you page.
- **The email doesn't match.** Email matching needs the same address in `identify` (or `openrev("payment", { email })`) and in the provider's payment.

Identifying a visitor with an email later also links earlier unattributed payments with that email.

## Numbers look off by a day (timezones)

- Every report (today, yesterday, daily charts) uses the **website's timezone**, set in **Settings → General → Timezone**. It defaults to the timezone of the browser that created the website.
- Your payment provider's dashboard uses its own account timezone, so "today's revenue" can differ near midnight.
- API requests use the website's timezone unless you pass a `timezone` parameter.
- Changing the timezone re-buckets all past data immediately; nothing is lost.
- In cookieless mode, visitor ids reset at midnight **UTC**, whatever the website's timezone.
