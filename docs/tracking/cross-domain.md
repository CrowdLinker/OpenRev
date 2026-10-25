# Cross-domain tracking

Track one journey across several hostnames, for example a marketing site, an app and a shop, so a payment made on one is credited to the source that brought the visitor to another.

## Subdomains: automatic

`www.example.com`, `app.example.com`, `blog.example.com` and `shop.example.com` are all part of the website whose domain is `example.com`. Nothing to configure besides using the same snippet everywhere:

```html
<script
  defer
  data-website-id="YOUR_WEBSITE_ID"
  data-domain="example.com"
  src="https://analytics.example.com/js/script.js"
></script>
```

- Keep `data-domain="example.com"` (the root domain) on every subdomain. The visitor and session cookies are then set on `.example.com` and shared, so moving from `www` to `app` keeps the same visitor and session.
- Without `data-domain`, cookies are host-only: each subdomain gets its own visitor id.
- Visits coming from one of your subdomains are not counted as referrals, and links between them are not counted as outbound clicks.
- Use the **Hostname** tab in the dashboard's pages panel to split traffic by subdomain.

## Different domains

For separate root domains (for example `example.com` and `example.io`, or a site and a checkout on another domain):

**1. Add the other domains in OpenRev.** In **Settings → General → Additional domains**, add each extra root domain, one per line (`example.io`). This lets OpenRev accept events from those domains and their subdomains, and treats visits between them as internal instead of referrals.

**2. Install the same snippet on every domain**, with the same `data-website-id`. On each site, set `data-domain` to that site's own root domain and list the other domains in `data-allowed-hostnames`:

```html
<!-- on example.com -->
<script
  defer
  data-website-id="YOUR_WEBSITE_ID"
  data-domain="example.com"
  data-allowed-hostnames="example.io"
  src="https://analytics.example.com/js/script.js"
></script>
```

```html
<!-- on example.io -->
<script
  defer
  data-website-id="YOUR_WEBSITE_ID"
  data-domain="example.io"
  data-allowed-hostnames="example.com"
  src="https://analytics.example.com/js/script.js"
></script>
```

`data-allowed-hostnames` takes a comma-separated list: `data-allowed-hostnames="example.io,myshop.com"`.

### How it works

When a visitor clicks a link to an allowed domain, the script appends the visitor and session ids to the URL:

```text
https://example.io/pricing?_or_vid=4f8c2a9e-…&_or_sid=b31d7e02-…
```

On arrival, the script on `example.io` saves these ids in its own cookies and removes the parameters from the address bar. The visit continues as the same visitor and session, with its original source.

- Only `<a href>` links clicked by the visitor are decorated. For redirects done in JavaScript or after a form post, add the parameters yourself:

  ```js
  const url = new URL("https://example.io/welcome");
  url.searchParams.set("_or_vid", window.openrev.visitorId());
  url.searchParams.set("_or_sid", window.openrev.sessionId());
  window.location.href = url.toString();
  ```

- Links to allowed domains aren't counted as outbound clicks.
- DataFast's `_df_vid` / `_df_sid` parameters are accepted too.
- In [cookieless mode](privacy-and-cookies.md#cookieless-mode) no visitor id exists in the browser. The server computes the same anonymous visitor id on all your domains (it's per website), so visitors are still recognized across them.

## Checklist

- [ ] Same `data-website-id` on every site.
- [ ] Each site's own root domain in `data-domain`.
- [ ] The other root domains in `data-allowed-hostnames` (different domains only).
- [ ] The other root domains in **Settings → General → Additional domains** (different domains only).

If events from a domain are missing and the events request answers `{"ok":false,"reason":"hostname_not_allowed"}`, step 1 is missing. Settings changes can take up to 30 seconds to apply.

## Hostnames you don't own

Settings → General → **Only accept events from my domains** (on by default) rejects events from any hostname that isn't your domain, its subdomains or an additional domain. That keeps out copies of your site, preview deployments (`*.vercel.app`, `*.netlify.app`) and other sites that copied your snippet. Turn it off only if you track many domains you can't list.
