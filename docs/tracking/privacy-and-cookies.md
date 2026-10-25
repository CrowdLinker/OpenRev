# Privacy and cookies

OpenRev is self-hosted: the data goes to your server and nowhere else. This page explains what the script collects, what it stores in the browser, and the two tracking modes.

*This is a technical description, not legal advice. Check your obligations (GDPR, ePrivacy, CCPA…) with someone qualified.*

## What is collected

For each visit, OpenRev records:

| Data | Details |
| --- | --- |
| Page | Hostname and path. The query string is dropped, except UTM parameters and `ref` / `via` / `source`, which are stored on the session. |
| Referrer | Origin and path of the referring page (no query string). Referrals from your own domains are ignored. |
| Device | Browser and version, OS and version, device type (from the user agent and screen width), browser language. The raw user agent is not stored. |
| Location | Country, region, city and approximate coordinates, derived from the IP address. |
| Activity | Pageviews, engaged time (added to the session duration), outbound link clicks, goals and their properties. |
| Identity (only if you send it) | User id, name, email, avatar URL and custom properties from [`identify`](identify.md). |
| Payments (only if you connect a provider) | Amount, currency, customer email/name and ids from your payment provider. |

### The IP address is not stored

OpenRev uses the IP address while it processes the request, for three things: geolocation, IP [exclusion rules](exclusions.md), and the anonymous visitor id in cookieless mode. It's never written to the database.

### Geolocation

- **Node / Docker:** OpenRev looks up the IP in a local database file. By default it downloads the free [DB-IP](https://db-ip.com) Lite City database (CC BY 4.0) into its data folder on startup, and refreshes it when it's more than 35 days old. You can point it to your own DB-IP or MaxMind GeoLite2 `.mmdb` file, or turn off the download; see the [configuration options](../self-hosting/configuration.md). If no database is loaded, location headers from your host (Vercel, Netlify, CloudFront, Google Cloud, Cloudflare) are used when present.
- **Cloudflare Workers:** OpenRev uses the location Cloudflare attaches to each request.

Either way, no IP address is sent to a third-party geolocation API.

## Cookie mode (default)

The default script (`/js/script.js`) sets two first-party cookies:

| Cookie | Lifetime | Purpose |
| --- | --- | --- |
| `openrev_visitor_id` | 1 year, renewed on every visit | Random id that recognizes a returning visitor, so a payment days later can be credited to the visit that brought them |
| `openrev_session_id` | 30 minutes, renewed on activity | Random id that groups the pages of one visit |

Both are random UUIDs, not derived from any personal data. They're set by the script on your domain (shared across subdomains when `data-domain` is set), with `SameSite=Lax` and `Secure` on HTTPS. They're never shared with other websites.

Cookie mode gives the most accurate data: returning visitors, multi-day journeys and attribution of payments made days or weeks after the first visit. In the EU and UK, storing a persistent identifier on a visitor's device generally falls under ePrivacy rules, which may require consent depending on your use and jurisdiction.

## Cookieless mode

In cookieless mode the browser stores no cookies and no visitor id.

- **Visitor id:** computed on the server for each request as a SHA-256 hash of a random daily salt, your website id and domain, the visitor's IP address and user agent. Only a shortened hash is stored.
- **Daily salt:** a new random salt is created every day (UTC) and deleted after 3 days, so the hash can't be recomputed afterwards and the same person gets a different id each day.
- **Session id:** kept in the tab's `sessionStorage` (cleared when the tab closes), expiring after 30 minutes of inactivity.

### Trade-offs

- A returning visitor counts as new each day (UTC). Multi-day journeys, multi-day funnels and first-touch attribution only work within a day.
- Payments made on a later day can't be linked to the original visit through the visitor id.
- Payment links aren't tagged and Shopify carts don't get the visitor id, since there's none in the browser. Checkout success page detection (`?session_id=cs_…`), `openrev("payment", { email })` and email matching still work. See [Revenue](../revenue/README.md).
- Visitors sharing an IP address and browser version on the same day (an office, a school) can be counted as one.

### Turn it on

1. **Settings → General → Cookieless mode**: turn it on and save. The server then ignores any visitor id sent by the browser and always uses the hash.
2. **Switch the script** to `/js/script.cookieless.js` (or add `data-cookieless="true"`). The snippet in **Settings → Tracking code** updates automatically once the setting is on.

```html
<script
  defer
  data-website-id="YOUR_WEBSITE_ID"
  data-domain="example.com"
  src="https://analytics.example.com/js/script.cookieless.js"
></script>
```

Do both. With only the setting, the old script keeps setting cookies (which the server then ignores). With only the script, nothing breaks, but the setting keeps the dashboard snippet in sync.

## Other browser storage

| Key | Storage | When |
| --- | --- | --- |
| `openrev_session_id`, `openrev_session_id_t` | `sessionStorage` | Cookieless mode only |
| `openrev_cart` | `sessionStorage` | Shopify stores only: remembers that the cart was tagged |
| `openrev_ignore` | `localStorage` | Only if you [exclude your browser](exclusions.md#exclude-your-own-visits) |

The script also reads DataFast's `datafast_visitor_id` / `datafast_session_id` cookies if they exist, to keep visitors continuous after [switching from DataFast](../guides/migrate-from-datafast.md).

## GDPR notes

- **Where data lives:** on your OpenRev server and database. Your hosting provider is the only processor involved.
- **Personal data:** in cookie mode the visitor id is a pseudonymous identifier. Data you send with `identify` (names, emails) and payment data from providers is personal data. Mention OpenRev in your privacy policy and have a legal basis for it.
- **Minimization:** don't put personal data in goal properties or URLs. Query strings are dropped, but paths are stored as they are.
- **Retention:** by default, data is kept until you delete it. Set `RETENTION_DAYS` on your instance to delete raw events and sessions older than that many days automatically ([configuration](../self-hosting/configuration.md)).
- **Access and export:** **Settings → Data** exports raw data as CSV. **Visitors** lets you search by name, email or user id to see everything recorded about a person.
- **Deletion:** **Settings → Data** can reset or delete a whole website's data. There's no per-visitor delete button yet; handle individual erasure requests in the database (rows with that visitor id in `visitors` (column `id`), and with that `visitor_id` in `sessions`, `events`, `payments`, `customers` and `checkout_refs`).
- **Shared dashboards:** public share links hide names and emails.

## Choosing a mode

| | Cookie mode | Cookieless mode |
| --- | --- | --- |
| Stores an identifier in the browser | Yes (1 year) | No |
| Recognizes returning visitors | Yes | Same day only |
| Revenue attribution over days or weeks | Yes | Limited to the same day, or by email |
| Automatic payment link tagging | Yes | No |
| Accuracy for shared IPs | High | Lower |

If revenue attribution is the reason you use OpenRev, cookie mode with a consent banner (where required) gives the best results. If you can't store anything on the device without consent and don't want a banner, use cookieless mode and rely on [identify](identify.md) and checkout metadata to connect payments.
