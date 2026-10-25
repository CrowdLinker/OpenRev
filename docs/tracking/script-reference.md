# Script reference

Every attribute, script variant, JavaScript function, cookie and automatic behavior of the OpenRev tracking script (`src/tracker/script.ts`).

```html
<script
  defer
  data-website-id="YOUR_WEBSITE_ID"
  data-domain="example.com"
  src="https://analytics.example.com/js/script.js"
></script>
```

## Attributes

Boolean attributes are only on when the value is exactly `"true"`.

| Attribute | Default | What it does |
| --- | --- | --- |
| `data-website-id` | (required) | Your website id from **Settings → Tracking code**. Without it the script does nothing. |
| `data-domain` | none | Your root domain (`www.` is stripped). Visitor and session cookies are set on `.example.com` so they're shared across subdomains. Links to this domain and its subdomains are never counted as outbound. It does not change which hostnames the server accepts; that's the domain in **Settings → General**. |
| `data-allowed-hostnames` | none | Comma-separated list of other domains you own, for [cross-domain tracking](cross-domain.md). Links to them get `_or_vid`/`_or_sid` appended and are not counted as outbound. Example: `"example.io,myshop.com"`. |
| `data-api-url` | script origin + `/api/events` | Where events are sent. Absolute or relative URL. Use it when you [proxy](proxy.md) the events endpoint under a different path. |
| `data-api` | | Alias of `data-api-url`. |
| `data-allow-localhost` | `false` | Track on `localhost`, `127.x.x.x`, `[::1]` and `*.localhost`. The server also needs **Settings → General → Accept events from localhost**. |
| `data-allow-file-protocol` | `false` | Track pages opened from `file://`. The server records them as `localhost`, so **Accept events from localhost** must be on too. |
| `data-debug` | `false` | Track when the page runs inside an iframe (ignored by default). |
| `data-disable-console` | `false` | Silence the `[OpenRev]` console messages. |
| `data-disable-payments` | `false` | Turn off payment helpers: payment link tagging, checkout success page detection and Shopify cart attributes. |
| `data-disable-outbound` | `false` | Don't record clicks on links to other sites. |
| `data-hash` | `false` | Hash-based routing: include `location.hash` in the page path and track `hashchange`. Same as `script.hash.js`. See [SPA & hash routing](spa-and-hash-routing.md). |
| `data-cookieless` | `false` | No cookies. Same as `script.cookieless.js`. See [Privacy & cookies](privacy-and-cookies.md). |

## Script variants

All variants are served by your OpenRev instance under `/js/`.

| File | Hash routing | Cookieless |
| --- | --- | --- |
| `/js/script.js` | no | no |
| `/js/script.hash.js` | yes | no |
| `/js/script.cookieless.js` | no | yes |
| `/js/script.hash.cookieless.js` | yes | yes |

The variants are the same as `script.js` with `data-hash="true"` and/or `data-cookieless="true"`. Use whichever you prefer.

## JavaScript API

The script defines `window.openrev`. It also defines `window.datafast` with the same API, unless a real DataFast script already did (see [Migrating from DataFast](../guides/migrate-from-datafast.md)).

| Call | What it does |
| --- | --- |
| `openrev("goal_name")` | Records a custom goal. See [Goals](goals.md). |
| `openrev("goal_name", { key: "value" })` | Goal with up to 10 custom properties. |
| `openrev("identify", { user_id, email, name, image, ...props })` | Attaches a user to the current visitor. See [Identify users](identify.md). |
| `openrev("payment", { email })` | Tells OpenRev this visitor just paid with this email, so the payment can be matched when the provider reports it. Also accepts `ref` (or `transaction_id`): the checkout reference your provider reports, such as a Stripe Checkout Session id. |
| `openrev("pageview")` | Sends a pageview for the current URL, even if it was already counted. Only needed when your router doesn't use the History API. |
| `openrev.visitorId()` | Returns the visitor id (also `openrev.getVisitorId()`). Returns `null` in cookieless mode. |
| `openrev.sessionId()` | Returns the session id (also `openrev.getSessionId()`). |

`identify`, `payment` and `pageview` are reserved. Any other first argument is treated as a goal name.

### Calling the API before the script loads

The script loads with `defer`, so `window.openrev` doesn't exist until the page has parsed. To make early calls safe, add this queue snippet before the OpenRev script:

```html
<script>
  window.openrev = window.openrev || function () { (window.openrev.q = window.openrev.q || []).push(arguments); };
</script>
```

Queued calls run as soon as the script loads, right after the first pageview. A queue on `window.datafast` is picked up too. `openrev.visitorId()` and `openrev.sessionId()` only exist once the script has loaded.

### TypeScript

```ts
// global.d.ts
export {};

declare global {
  interface Window {
    openrev?: ((event: string, data?: Record<string, unknown>) => void) & {
      visitorId?: () => string | null;
      sessionId?: () => string;
    };
  }
}
```

## HTML attributes

| Attribute | What it does |
| --- | --- |
| `data-openrev-goal="name"` | Records the goal when the element (or anything inside it) is clicked. |
| `data-openrev-goal-<key>="value"` | Adds a property to that goal. Dashes in `<key>` become underscores. |
| `data-openrev-scroll="name"` | Records the goal when the element scrolls into view, once per page view. |
| `data-openrev-scroll-threshold="0.5"` | Fraction of the element that must be visible (0 to 1). Default `0.5`. |
| `data-openrev-scroll-delay="0"` | Milliseconds the element must stay visible before the goal fires. Default `0`. |
| `data-openrev-scroll-<key>="value"` | Adds a property to the scroll goal. |

The DataFast equivalents `data-fast-goal`, `data-fast-goal-*`, `data-fast-scroll`, `data-fast-scroll-threshold`, `data-fast-scroll-delay` and `data-fast-scroll-*` work too. Examples are in [Goals](goals.md).

## Cookies and storage

| Name | Where | Lifetime | Content |
| --- | --- | --- | --- |
| `openrev_visitor_id` | cookie | 1 year, renewed on every event | Random visitor id |
| `openrev_session_id` | cookie | 30 minutes, renewed on every event | Random session id |
| `openrev_session_id`, `openrev_session_id_t` | `sessionStorage` | the browser tab | Session id and last activity time (cookieless mode only) |
| `openrev_cart` | `sessionStorage` | the browser tab | Shopify only: remembers that the cart was already tagged |
| `openrev_ignore` | `localStorage` | until removed | Set it to `"true"` to [exclude your browser](exclusions.md#exclude-your-own-visits) |

Cookies are first-party, `SameSite=Lax`, `Secure` on HTTPS, and set on `.example.com` when the page is on `data-domain` or one of its subdomains (otherwise host-only).

If there's no `openrev_visitor_id` / `openrev_session_id` cookie yet, the script adopts the value of DataFast's `datafast_visitor_id` / `datafast_session_id` cookies, so visitors stay continuous when you switch.

Ids passed in the URL as `_or_vid` / `_or_sid` (or DataFast's `_df_vid` / `_df_sid`) are stored and then removed from the address bar. See [cross-domain tracking](cross-domain.md).

## Automatic behavior

| Behavior | Details | Turn off with |
| --- | --- | --- |
| Pageviews | On load and on every route change (`pushState`, `replaceState`, `popstate`, plus `hashchange` in hash mode). The same path twice in a row counts once. | — |
| Engagement time | Time the page was visible, sent when you leave the page, switch route or hide the tab. Adds to the session duration. | — |
| Outbound links | Clicks on `http(s)` links to other sites. Records the destination without its query string. Shown as **Exit links**. | `data-disable-outbound` |
| Cross-domain links | Adds `_or_vid` and `_or_sid` to links pointing at `data-allowed-hostnames`. | remove the attribute |
| Stripe Payment Links | Adds `client_reference_id=<visitor id>` to `buy.stripe.com` links (unless one is already set). | `data-disable-payments` |
| Lemon Squeezy checkouts | Adds `checkout[custom][openrev_visitor_id]` and `checkout[custom][openrev_session_id]` to checkout links on `*.lemonsqueezy.com`, and to `/checkout/buy/…` links on any domain (Lemon Squeezy custom checkout domains). | `data-disable-payments` |
| Gumroad | Adds `openrev_visitor_id` to `gumroad.com` and `gum.co` links. | `data-disable-payments` |
| Shopify cart | On Shopify storefronts, saves `openrev_visitor_id` and `openrev_session_id` as cart attributes. | `data-disable-payments` |
| Checkout success pages | When the URL has `session_id=cs_…` (Stripe Checkout), `checkout_id=…`, or `payment_id=…` with `status=succeeded`, `success` or `paid`, records the checkout reference so the provider's webhook can be matched to this visitor. | `data-disable-payments` |

Link tagging happens on `mousedown`, `touchstart` and `click`, so the link is already updated when the browser follows it. Payment setup per provider is covered in [Revenue](../revenue/README.md). Payment link tagging and Shopify cart attributes need a visitor id, so they're skipped in cookieless mode; checkout success page detection still works.

## When the script doesn't track

The script stays silent (and logs `[OpenRev] Tracking disabled: …` unless `data-disable-console` is set) when:

- `data-website-id` is missing;
- `localStorage.openrev_ignore` (or `datafast_ignore`) is `"true"`;
- the browser looks automated: `navigator.webdriver` is set, or the user agent contains `headless`, `phantom`, `selenium`, `puppeteer`, `playwright`, `bot`, `crawl` or `spider`;
- the page is on localhost without `data-allow-localhost="true"`;
- the page is a `file://` URL without `data-allow-file-protocol="true"`;
- the page is inside an iframe without `data-debug="true"`.

The script only initializes once per page. A second copy is ignored, even if it has a different website id.

## The events endpoint

The script sends `POST` requests to `/api/events` (`/api/event` is accepted as an alias). The body is JSON sent as `text/plain`, so no CORS preflight is needed. The endpoint allows any origin and accepts up to 32 KB per event.

| Field | Sent with | Meaning |
| --- | --- | --- |
| `type` | all | `pageview`, `goal`, `engagement`, `outbound`, `identify` or `payment` |
| `websiteId` | all | `data-website-id` |
| `href` | all | Full page URL |
| `referrer` | all | `document.referrer` |
| `visitorId`, `sessionId` | all | Ids from the cookies (`visitorId` is `null` in cookieless mode) |
| `screenWidth`, `language` | all | Used for device type and language |
| `hash` | all | `true` in hash-routing mode |
| `name`, `props` | `goal` | Goal name and properties |
| `engagedMs` | `engagement` | Visible time on the page |
| `url` | `outbound` | Destination |
| `userId`, `email`, `name`, `image`, `props` | `identify` | User data |
| `email`, `ref`, `provider` | `payment` | Payment hints |

Responses:

- `202 {"ok":true}`: stored.
- `202 {"ok":false,"reason":"…"}`: dropped on purpose. The reasons are listed in [Troubleshooting](../guides/troubleshooting.md#start-here-read-the-response).
- `400 {"ok":false,"reason":"invalid_json"}` or `413 {"ok":false,"reason":"payload_too_large"}`.

This endpoint is meant for browsers: it applies bot filtering and the hostname check. To send goals, identities or payments from your server, use the [REST API](../api/README.md) with an API key.
