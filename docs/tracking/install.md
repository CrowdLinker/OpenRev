# Install the tracking script

OpenRev needs one small script on every page of your site. It records pageviews, sources, goals and the visitor id that links payments back to traffic.

In the examples below, `https://analytics.example.com` is your OpenRev instance and `example.com` is the site you track. Replace both, along with `YOUR_WEBSITE_ID`.

## 1. Get your snippet

1. In OpenRev, click **Add website**. Enter the root domain without `https://` or `www.` (for example `example.com`). Subdomains are included automatically.
2. Open **Settings → Tracking code**. The snippet there already contains your website id.

```html
<script
  defer
  data-website-id="YOUR_WEBSITE_ID"
  data-domain="example.com"
  src="https://analytics.example.com/js/script.js"
></script>
```

- `data-website-id` is required. Without it nothing is tracked.
- `data-domain` is your root domain. It lets visitor and session cookies be shared across subdomains (`www.example.com`, `app.example.com`…).
- If you turned on **Cookieless mode** in **Settings → General**, the snippet uses `/js/script.cookieless.js` instead. See [Privacy & cookies](privacy-and-cookies.md).
- If you show a cookie banner, use `/js/script.consent.js` to stay cookieless until the visitor accepts. See [Cookieless until consent](privacy-and-cookies.md#cookieless-until-consent).

Every option is listed in the [script reference](script-reference.md).

## 2. Add it to your site

Put the snippet in the `<head>` of every page. Pick your platform:

- [Plain HTML](#plain-html)
- [Next.js (App Router)](#nextjs-app-router) · [Next.js (Pages Router)](#nextjs-pages-router)
- [React / Vite](#react--vite) · [Vue / Nuxt](#vue--nuxt) · [Astro](#astro) · [SvelteKit](#sveltekit) · [Remix / React Router](#remix--react-router) · [Gatsby](#gatsby)
- [WordPress](#wordpress) · [Shopify](#shopify) · [Webflow](#webflow) · [Framer](#framer) · [Wix](#wix) · [Squarespace](#squarespace) · [Ghost](#ghost) · [Bubble](#bubble) · [Carrd](#carrd)
- [Google Tag Manager](#google-tag-manager)
- [Lovable, Bolt, v0 and other AI builders](#lovable-bolt-v0-and-other-ai-builders)

Single-page apps need nothing extra. Route changes made with the History API are tracked automatically ([details](spa-and-hash-routing.md)).

### Plain HTML

Paste the snippet inside `<head>` on every page (or in the shared header template).

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Example</title>
    <script
      defer
      data-website-id="YOUR_WEBSITE_ID"
      data-domain="example.com"
      src="https://analytics.example.com/js/script.js"
    ></script>
  </head>
  <body>…</body>
</html>
```

### Next.js (App Router)

Add the script to the root layout with `next/script`.

```tsx
// app/layout.tsx
import Script from "next/script";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <Script
          defer
          data-website-id="YOUR_WEBSITE_ID"
          data-domain="example.com"
          src="https://analytics.example.com/js/script.js"
          strategy="afterInteractive"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

### Next.js (Pages Router)

```tsx
// pages/_app.tsx
import type { AppProps } from "next/app";
import Script from "next/script";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Script
        defer
        data-website-id="YOUR_WEBSITE_ID"
        data-domain="example.com"
        src="https://analytics.example.com/js/script.js"
        strategy="afterInteractive"
      />
      <Component {...pageProps} />
    </>
  );
}
```

### React / Vite

Paste the snippet inside `<head>` in `index.html` (Vite) or `public/index.html` (Create React App). React Router and other client-side routers are tracked automatically.

### Vue / Nuxt

**Vue (Vite):** paste the snippet inside `<head>` in `index.html`.

**Nuxt 3:** add it to `app.head` in `nuxt.config.ts`.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  app: {
    head: {
      script: [
        {
          src: "https://analytics.example.com/js/script.js",
          defer: true,
          "data-website-id": "YOUR_WEBSITE_ID",
          "data-domain": "example.com",
        },
      ],
    },
  },
});
```

### Astro

Add the script to the `<head>` of your base layout. `is:inline` tells Astro to leave the tag as it is.

```astro
---
// src/layouts/Layout.astro
---
<html lang="en">
  <head>
    <script
      is:inline
      defer
      data-website-id="YOUR_WEBSITE_ID"
      data-domain="example.com"
      src="https://analytics.example.com/js/script.js"
    ></script>
  </head>
  <body><slot /></body>
</html>
```

Navigations with Astro view transitions are tracked as pageviews. The script only initializes once per page load, even if Astro re-runs inline scripts.

### SvelteKit

Paste the snippet in `src/app.html`, inside `<head>`:

```html
<!-- src/app.html -->
<head>
  <meta charset="utf-8" />
  <script
    defer
    data-website-id="YOUR_WEBSITE_ID"
    data-domain="example.com"
    src="https://analytics.example.com/js/script.js"
  ></script>
  %sveltekit.head%
</head>
```

### Remix / React Router

In framework mode, add the tag to the `<head>` in `app/root.tsx`:

```tsx
// app/root.tsx
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router"; // or "@remix-run/react"

export default function App() {
  return (
    <html lang="en">
      <head>
        <Meta />
        <Links />
        <script
          defer
          data-website-id="YOUR_WEBSITE_ID"
          data-domain="example.com"
          src="https://analytics.example.com/js/script.js"
        />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
```

### Gatsby

Use the `onRenderBody` SSR API:

```jsx
// gatsby-ssr.js
import React from "react";

export const onRenderBody = ({ setHeadComponents }) => {
  setHeadComponents([
    <script
      key="openrev"
      defer
      data-website-id="YOUR_WEBSITE_ID"
      data-domain="example.com"
      src="https://analytics.example.com/js/script.js"
    />,
  ]);
};
```

### WordPress

**With a plugin (easiest):**

1. Install a header-code plugin such as **WPCode** (Insert Headers and Footers).
2. Go to **Code Snippets → Header & Footer**, paste the snippet in the **Header** box and save.

**From a (child) theme:**

```php
// functions.php
add_action('wp_head', function () { ?>
  <script
    defer
    data-website-id="YOUR_WEBSITE_ID"
    data-domain="example.com"
    src="https://analytics.example.com/js/script.js"
  ></script>
<?php });
```

If you use an optimization plugin (WP Rocket, LiteSpeed Cache, Autoptimize…), exclude the OpenRev script from **Delay JavaScript execution** and from combining/minifying. Delayed scripts miss visitors who leave without interacting.

### Shopify

1. Go to **Online Store → Themes**, click **⋯ → Edit code** on your live theme.
2. Open `layout/theme.liquid`.
3. Paste the snippet right before `</head>` and save.

On Shopify storefronts the script also stores the visitor id in the cart attributes (`openrev_visitor_id`, `openrev_session_id`), so orders can be attributed. To record the orders, connect Shopify in **Settings → Revenue** ([Shopify guide](../revenue/shopify.md)).

### Webflow

1. Open **Site settings → Custom code**.
2. Paste the snippet in **Head code** and save.
3. Publish your site.

Custom code requires a paid Webflow site plan. Scripts don't run in the Designer preview, so test on the published site.

### Framer

1. Open **Site Settings → General → Custom Code**.
2. Paste the snippet in **End of `<head>` tag**.
3. Publish.

### Wix

1. In the dashboard, go to **Settings → Custom Code** (in the **Advanced** section).
2. Click **+ Add Custom Code** and paste the snippet.
3. **Add Code to Pages:** All pages, **Load code once**.
4. **Place Code in:** Head. Click **Apply**.

Wix only runs custom code on a published site with a connected domain (premium plan).

### Squarespace

1. Open **Settings → Developer Tools → Code Injection** (on older dashboards: **Settings → Advanced → Code Injection**).
2. Paste the snippet in **Header** and save.

Code Injection is not available on every Squarespace plan.

### Ghost

1. In Ghost Admin, open **Settings → Code injection** (under **Advanced** in Ghost 5).
2. Paste the snippet in **Site header** and save.

### Bubble

1. Open **Settings → SEO / metatags**.
2. Paste the snippet in **Script/meta tags in header**.
3. Deploy to live.

If you test on `yourapp.bubbleapps.io` while your OpenRev website uses your custom domain, those events are rejected by the hostname check. Add the domain under **Additional domains** if you want them ([cross-domain tracking](cross-domain.md)).

### Carrd

1. Add an **Embed** element (requires a Carrd Pro plan with embeds).
2. Set **Type** to Code, **Style** to Hidden and **Location** to Head.
3. Paste the snippet and publish.

### Google Tag Manager

Create a **Custom HTML** tag with the code below, trigger it on **All Pages**, then submit and publish the container.

```html
<script>
  (function () {
    var s = document.createElement("script");
    s.defer = true;
    s.src = "https://analytics.example.com/js/script.js";
    s.setAttribute("data-website-id", "YOUR_WEBSITE_ID");
    s.setAttribute("data-domain", "example.com");
    document.head.appendChild(s);
  })();
</script>
```

Many ad blockers block GTM itself. If accuracy matters, add the snippet to your site directly or use a [proxy](proxy.md).

### Lovable, Bolt, v0 and other AI builders

Ask the AI to add the snippet. Paste something like this into the chat, with your real snippet:

```text
Add this analytics script to the <head> of every page, exactly as written (keep every data- attribute).
For a Vite/React project put it in index.html. For a Next.js project add it to app/layout.tsx
with next/script and strategy="afterInteractive". Don't change anything else.

<script
  defer
  data-website-id="YOUR_WEBSITE_ID"
  data-domain="example.com"
  src="https://analytics.example.com/js/script.js"
></script>
```

Then publish and verify on the published URL, not in the builder's preview (previews usually run in an iframe or on a different domain, and both are ignored by default).

To track a conversion, ask for it explicitly: *"After a successful signup, call `window.openrev?.("signup")`."* See [goals](goals.md).

### Any other platform

Look for a setting called "custom code", "head code", "header scripts" or "code injection" and paste the snippet there.

## 3. Verify the installation

1. Open your live site in a new tab, in a browser without an ad blocker. Not on `localhost` (that's ignored unless you [allow it](script-reference.md#attributes)).
2. In OpenRev, open **Settings → Tracking code**. The status box below the snippet switches from **Waiting for the first visit…** to **OpenRev is receiving data**, with the time, hostname and path of the last event.
3. Optional, from the browser devtools on your site:
   - **Network** tab: filter by `events` and reload. You should see `POST https://analytics.example.com/api/events` with status **202** and the response `{"ok":true}`.
   - If the response is `{"ok":false,"reason":"…"}`, the event was rejected. The reason tells you why ([list of reasons](../guides/troubleshooting.md#start-here-read-the-response)).
   - **Console** tab: messages starting with `[OpenRev]` explain why tracking is disabled (for example `Tracking disabled: localhost`).
   - Type `openrev.visitorId()` in the console. It returns your visitor id once the script is loaded (`null` in cookieless mode).

The **Realtime** page shows visitors as they arrive.

Nothing showing up? See [Troubleshooting](../guides/troubleshooting.md).

## Next steps

- [Track goals](goals.md) such as signups and button clicks.
- [Identify users](identify.md) to see names in journeys and match payments by email.
- [Connect a payment provider](../revenue/README.md) to attribute revenue.
- [Proxy the script](proxy.md) through your domain to avoid ad blockers.
- [Exclude your own visits](exclusions.md).
