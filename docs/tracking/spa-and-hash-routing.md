# Single-page apps and hash routing

## Single-page apps: automatic

The script listens to the browser's History API: `history.pushState`, `history.replaceState` and the back/forward buttons (`popstate`). Each time the path changes, it records a pageview. This covers Next.js, React Router, Remix, Vue Router, Nuxt, SvelteKit, Astro view transitions, Gatsby, Angular and most other routers. No extra code is needed.

What counts as a new pageview:

| Change | New pageview? |
| --- | --- |
| `/pricing` → `/signup` | Yes |
| `/pricing` → `/pricing?plan=pro` | No, only the path counts |
| `/docs` → `/docs#install` | No (unless you use [hash mode](#hash-based-routing)) |
| The same path pushed twice in a row | No |
| `/` → `/en` with `replaceState` (client-side redirect) | Yes, so the visit can count as two pageviews |

Paths are stored without their query string. UTM parameters and `ref` are read from the landing URL and stored on the session ([channels](channels.md)). Trailing slashes are removed, so `/pricing/` and `/pricing` are the same page in reports.

When the route changes, the script also:

- sends the engagement time of the previous page;
- re-arms [scroll goals](goals.md#scroll-goals) for the new page;
- checks the new URL for checkout success parameters (unless `data-disable-payments` is set).

### Manual pageviews

If your app changes screens without changing the URL through the History API (a multi-step widget, a custom router), send pageviews yourself:

```js
window.openrev("pageview");
```

It records the current URL, even if it was already counted. Don't call it on route changes in a normal SPA: the automatic pageview already happened, so you'd count every page twice. There's no option to send a custom path; OpenRev always records `location`.

## Hash-based routing

If your app's routes live in the hash (`https://example.com/#/pricing`), use the hash variant of the script:

```html
<script
  defer
  data-website-id="YOUR_WEBSITE_ID"
  data-domain="example.com"
  src="https://analytics.example.com/js/script.hash.js"
></script>
```

or keep `script.js` and add `data-hash="true"`. In hash mode:

- the path includes the hash: `/#/pricing`, `/#/settings/billing`;
- `hashchange` events are tracked as well as History API changes;
- in-page anchors also count as pages: clicking `#features` records `/#features`. Hash mode is only for apps that route with the hash.

For a cookieless setup with hash routing, use `/js/script.hash.cookieless.js`.

## Tips

- **Goals in SPAs** work as usual: call `window.openrev("goal_name")` after the action succeeds. See [Goals](goals.md).
- **Duplicate pageviews?** Look for manual `openrev("pageview")` calls, and for client-side redirects (a locale prefix, adding a trailing slash with `replaceState`) that change the path right after load. Server-side redirects avoid the extra pageview.
- **Several scripts?** The script initializes once per page. A second copy (from GTM, a plugin or a layout rendered twice) is ignored, so it can't double-count.
