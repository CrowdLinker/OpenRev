# Exclusions

Keep your own visits, your team, internal pages and unwanted traffic out of your stats.

## Exclude your own visits

Open your website, open the browser console (F12 or Cmd+Option+J) and run:

```js
localStorage.setItem("openrev_ignore", "true")
```

From then on the script sends nothing from that browser, and the console shows `[OpenRev] Tracking disabled: localStorage.openrev_ignore is set`. To be tracked again:

```js
localStorage.removeItem("openrev_ignore")
```

- `localStorage` is per browser and per origin. Repeat it in each browser you use, and on each subdomain (`www.example.com` and `app.example.com` are separate).
- DataFast's `localStorage.datafast_ignore = "true"` is honored too.
- To make it a one-click toggle, save this as a bookmark and click it while on your site:

  ```text
  javascript:(function(){var k="openrev_ignore";if(localStorage.getItem(k)==="true"){localStorage.removeItem(k);alert("OpenRev: tracking this browser again");}else{localStorage.setItem(k,"true");alert("OpenRev: ignoring this browser");}})();
  ```

The same instructions are in **Settings → Exclusions**.

## Exclusion rules

**Settings → Exclusions** drops matching events before they're stored. Enter one rule per line (commas work too) and save.

| Rule | Format | Examples |
| --- | --- | --- |
| IP addresses | Exact IP, a prefix ending in `*`, or IPv4 CIDR | `203.0.113.4`, `192.168.*`, `10.0.0.0/8`, `2001:db8:*` |
| Paths | Exact path, `*` for one path segment, `**` for anything. A pattern ending in `/*` also matches deeper paths. | `/admin/*`, `/preview/**`, `/blog/*/edit` |
| Countries | Two-letter ISO country codes | `RU`, `CN` |
| Hostnames | Exact hostname, without `www.` | `staging.example.com` |

Notes:

- **IPs** are the address OpenRev sees for the visitor. If you [proxy](proxy.md) the script, that's the address your proxy forwards. CIDR ranges work for IPv4 only; for IPv6 use a prefix with `*`.
- **Paths** are matched against the path without query string (and with the hash in [hash mode](spa-and-hash-routing.md#hash-based-routing)). Trailing slashes are removed first, so write `/admin/*`, not `/admin/*/`.
- **Countries** come from IP geolocation, so they're only as accurate as the location data.
- **Hostnames** are compared after removing a leading `www.`. Enter `example.com`, not `www.example.com`.
- Rules apply to events from the tracking script, from the moment you save (allow up to 30 seconds). They don't delete data that was already recorded.
- An excluded event gets the response `{"ok":false,"reason":"excluded"}`, which is handy to confirm a rule works.

## Filtered automatically

You don't need rules for these:

- **Bots:** search engine crawlers, AI crawlers (GPTBot, ClaudeBot, PerplexityBot, CCBot…), SEO tools (Ahrefs, Semrush…), uptime monitors (UptimeRobot, Pingdom, StatusCake…), performance tools (Lighthouse, PageSpeed, GTmetrix), link previews (Facebook, WhatsApp, Slack…), HTTP libraries (`curl`, `wget`, `python-requests`, `axios`, `node-fetch`, Go, Java…) and requests with no user agent.
- **Automated browsers:** the script doesn't run when `navigator.webdriver` is set or the user agent says headless, Selenium, Puppeteer or Playwright. End-to-end tests don't pollute your data.
- **Local development:** `localhost`, `127.0.0.1`, `[::1]`, `*.localhost` and `file://` pages, unless you [allow them](script-reference.md#attributes).
- **Iframes:** pages embedded in an iframe, including most site-builder previews, unless `data-debug="true"`.
- **Other hostnames:** with **Only accept events from my domains** on (the default), events from hostnames that aren't your domain, its subdomains or an [additional domain](cross-domain.md#different-domains) are rejected. Preview deployments (`*.vercel.app`, `*.netlify.app`…) and sites that copied your snippet stay out.

## Excluding a whole environment

For staging or preview sites, the simplest option is to not add their hostnames to the website (they're rejected by the hostname check), or list them under **Hostnames**. To test tracking on staging, create a separate OpenRev website for it.
