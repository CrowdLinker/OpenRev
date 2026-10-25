<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/openrev-logo-dark.png" />
  <img src="docs/assets/brand/openrev-logo-light.png" alt="OpenRev" width="300" />
</picture>

### Open-source, revenue-first web analytics

See which channels, pages and campaigns actually make you money, on infrastructure you own.

[![CI](https://github.com/CrowdLinker/OpenRev/actions/workflows/ci.yml/badge.svg)](https://github.com/CrowdLinker/OpenRev/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-5b4cf5.svg)](LICENSE)
[![Tracker: 3.9 kB gzipped](https://img.shields.io/badge/tracker-3.9%20kB%20gzipped-10b981.svg)](src/tracker/script.ts)
[![Runs on Cloudflare, Docker and Node.js](https://img.shields.io/badge/runs%20on-Cloudflare%20%C2%B7%20Docker%20%C2%B7%20Node.js-18181b.svg)](#-self-hosting)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-5b4cf5.svg)](CONTRIBUTING.md)

[**Quick start**](#-quick-start) · [Product tour](#-product-tour) · [Payment providers](#-connect-any-payment-provider) · [API & MCP](#-for-developers-and-ai-agents) · [Docs](docs/README.md)

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/hero-dark.webp" />
  <img src="docs/assets/screenshots/hero-light.webp" alt="The OpenRev dashboard: visitors, revenue, conversion rate and revenue per visitor, with a chart of daily visitors and revenue and a sources table where every channel shows the revenue it brought in" width="100%" />
</picture>

</div>

## Why OpenRev

Most web analytics stop at traffic. OpenRev links every payment to the visit that led to it, so revenue, conversion rate and revenue per visitor sit next to every source, campaign, page, country and goal in your dashboard.

It is a free, MIT-licensed alternative to [DataFast](https://datafa.st) and [DataBull](https://databull.app) that you host yourself: on Cloudflare's free tier, in a Docker container, or on any Node.js server. Your visitors and payments stay in your own database.

<table>
  <tr>
    <td width="33%" valign="top">
      <h4>💸 Revenue attribution</h4>
      Stripe, Lemon Squeezy, Polar, Paddle, Shopify and 6 more built in, plus any other system through a custom webhook or the Payments API.
    </td>
    <td width="33%" valign="top">
      <h4>🪶 A 3.9 kB script</h4>
      No third-party trackers. Cookie or cookieless mode, SPA and hash routing, outbound links, scroll goals and bot filtering.
    </td>
    <td width="33%" valign="top">
      <h4>☁️ Runs anywhere</h4>
      Cloudflare Workers + D1, Docker or Node.js, on SQLite or PostgreSQL. One command sets it up.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h4>🤖 AI-ready</h4>
      ChatGPT, Perplexity, Claude and Gemini traffic get their own channel, and a built-in MCP server lets your AI assistant query your numbers.
    </td>
    <td valign="top">
      <h4>🔔 Alerts that matter</h4>
      New sales with their source and journey, goal completions, traffic spikes and digests, sent to Slack, Discord, Telegram, email or a webhook.
    </td>
    <td valign="top">
      <h4>🔁 Drop-in for DataFast</h4>
      Understands <code>window.datafast()</code>, <code>data-fast-goal</code> and <code>datafast_visitor_id</code>, so you can switch without touching your checkout.
    </td>
  </tr>
</table>

## 🚀 Quick start

### One command

```bash
curl -fsSL https://raw.githubusercontent.com/CrowdLinker/OpenRev/main/install.sh | bash
```

The installer downloads OpenRev and asks where to run it:

| Target | What happens | Cost |
|---|---|---|
| **Cloudflare** (recommended) | Logs you in with Wrangler, creates the D1 database, deploys the Worker and stores a secret. | Free tier: 100k requests/day, 500 MB database |
| **Docker** | Writes `.env` and starts `docker compose` with SQLite or a bundled PostgreSQL. | Any $5 VPS |
| **Node.js** | Builds and runs the server with a SQLite file or a `postgres://` URL. | Any Node.js 22 host |

Prefer npm? `npm create openrev@latest` does the same thing. Already cloned the repo? Run `npm install && npm run setup`.

### One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CrowdLinker/OpenRev)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/CrowdLinker/OpenRev)

### Docker

```bash
docker run -d --name openrev -p 3000:3000 -v openrev-data:/data \
  -e PUBLIC_URL=https://analytics.example.com ghcr.io/crowdlinker/openrev:latest
```

### Add the script to your site

Open your instance, create the admin account, add your website and paste the snippet into your site's `<head>`:

```html
<script
  defer
  data-website-id="YOUR_WEBSITE_ID"
  data-domain="example.com"
  src="https://analytics.example.com/js/script.js"
></script>
```

Then connect your payment provider under **Settings → Revenue**. That's it: traffic shows up right away and every new payment is attributed. Guides for [Next.js, WordPress, Shopify, Webflow, Framer, GTM and more](docs/tracking/install.md).

## 🧭 Product tour

### Revenue next to every source

Revenue, payments, customers, conversion rate and revenue per visitor for every channel, referrer, campaign, page, country, device and goal. Split new revenue from renewals and refunds, pick first-touch, last-touch or last-non-direct attribution, and mix currencies freely: everything converts to your website's currency.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/revenue-dark.webp" />
  <img src="docs/assets/screenshots/revenue-light.webp" alt="Revenue view with net revenue, new revenue, renewals, refunds and average order value, revenue by source, and customer lifetime value by first touch" width="100%" />
</picture>

### Where your buyers come from

Channels are classified for you (Direct, Organic and Paid Search, Organic and Paid Social, **AI**, Email, Referral, Affiliate, Display), alongside referrers, UTM parameters, `?ref=` links, pages, entry and exit pages, outbound links, countries, regions, cities, browsers and devices. Filter the whole dashboard by any of them.

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/sources-dark.webp" />
        <img src="docs/assets/screenshots/sources-light.webp" alt="Sources by channel with visitors and revenue, including an AI channel" />
      </picture>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/locations-dark.webp" />
        <img src="docs/assets/screenshots/locations-light.webp" alt="Locations: world map with visitors and revenue by country" />
      </picture>
    </td>
  </tr>
</table>

### Realtime

A live globe, the visitors on your site right now with a buyer-intent score, and a feed of pageviews, goals and payments as they happen.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/realtime-dark.webp" />
  <img src="docs/assets/screenshots/realtime-light.webp" alt="Realtime view with a globe of live visitors, a live visitor list and an activity feed" width="100%" />
</picture>

### Goals and funnels

Track goals from JavaScript, HTML attributes, scroll-into-view or your server, with custom properties, and promote one to your **#1 KPI**. Funnels chain pages, goals and payments and show the drop-off and revenue at each step.

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/funnel-dark.webp" />
        <img src="docs/assets/screenshots/funnel-light.webp" alt="Funnel from the homepage to pricing, signup and payment, with drop-off and revenue at each step" />
      </picture>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/goals-dark.webp" />
        <img src="docs/assets/screenshots/goals-light.webp" alt="Goals table with visitors and revenue for each goal" />
      </picture>
    </td>
  </tr>
</table>

### Visitor journeys

Every session, page, goal and payment of a visitor in one timeline. Call `openrev("identify", { user_id, email, name })` and visitors are merged across devices.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/visitor-dark.webp" />
  <img src="docs/assets/screenshots/visitor-light.webp" alt="Visitor profile with identity, first-touch source, lifetime revenue and a timeline of sessions, goals and payments" width="100%" />
</picture>

### Customer lifetime value

Lifetime value and repeat-purchase rate by first-touch source, so you can tell which channels bring customers who stay.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/ltv-dark.webp" />
  <img src="docs/assets/screenshots/ltv-light.webp" alt="Customer lifetime value by first-touch channel" width="100%" />
</picture>

### And the rest

- **Team and sharing**: unlimited websites and members (owner, admin, viewer), invitation links, and public read-only dashboards that hide personal data.
- **Alerts**: new sales and refunds with source, country and journey, goal completions, traffic spikes, and daily or weekly digests to Slack, Discord, Telegram, email or webhooks.
- **Tracking options**: subdomains and cross-domain tracking, a first-party proxy to get past ad blockers, and exclusions by IP, path, country, hostname or your own browser.
- **Exports**: CSV export of all raw data, chart notes, and date ranges from hourly to monthly with period-over-period comparison.

## 💳 Connect any payment provider

| Provider | Events | History import |
|---|---|:-:|
| [Stripe](docs/revenue/stripe.md) | Checkout, Payment Links, subscriptions, PaymentIntents, refunds | ✅ |
| [Lemon Squeezy](docs/revenue/lemonsqueezy.md) | Orders, subscription renewals, refunds | ✅ |
| [Polar](docs/revenue/polar.md) | Orders, renewals, refunds | |
| [Paddle Billing](docs/revenue/paddle.md) | Transactions, renewals, refunds and chargebacks | |
| [Shopify](docs/revenue/shopify.md) | Paid orders, refunds | |
| [Dodo Payments](docs/revenue/dodo.md) | Payments, renewals, refunds | |
| [Creem](docs/revenue/creem.md) | Checkouts, subscription payments, refunds | |
| [Gumroad](docs/revenue/gumroad.md) | Sales, memberships, refunds | |
| [Paystack](docs/revenue/paystack.md) | Charges, refunds | |
| [Razorpay](docs/revenue/razorpay.md) | Payments, subscriptions, invoices, refunds | |
| [WooCommerce](docs/revenue/woocommerce.md) | Orders, refunds | |
| **Anything else** | [Custom webhook](docs/revenue/custom-provider.md): map JSON paths and a signature for any provider | |
| **Your backend** | [`POST /api/v1/payments`](docs/api/README.md#payments) | |

Connect several providers to the same website. Webhook retries are recorded once, refunds inherit the attribution of the payment they refund, and payments that can't be linked to a visit still count toward your totals as *Unattributed*.

## 🔗 How attribution works

```mermaid
flowchart LR
    A["Visitor lands on your site"] --> B["Tracker sets the<br/>openrev_visitor_id cookie"]
    B --> C["Checkout carries<br/>the visitor id"]
    C --> D["Payment provider"]
    D -- "signed webhook" --> E["OpenRev verifies<br/>the signature"]
    E --> F["Payment linked to the<br/>visitor's sessions"]
    F --> G["Revenue by source, campaign,<br/>page, country and goal"]
```

Pass the visitor id when you create a checkout. With Stripe:

```js
const session = await stripe.checkout.sessions.create({
  // ...
  metadata: {
    openrev_visitor_id: cookies.get("openrev_visitor_id"),
    openrev_session_id: cookies.get("openrev_session_id"),
  },
});
```

No access to your checkout code? The tracker can tag Stripe Payment Links, Lemon Squeezy and Gumroad links and Shopify carts for you, detect the checkout success page, or match payments by email after `openrev("identify")`. [Read how a payment finds its visitor](docs/revenue/README.md).

## 🤖 For developers and AI agents

**REST API.** Query analytics and send payments, goals and identities from your backend with a website key or an account token. An [OpenAPI 3.1 spec](docs/api/README.md) is served by every instance.

```bash
curl "https://analytics.example.com/api/v1/analytics/breakdowns/source?period=30d&sort=revenue" \
  -H "Authorization: Bearer or_xxxxxxxxxxxxxxxxxxxxxxxx"
```

**MCP server.** Ask Claude, Cursor or any MCP client *"Which channels drove the most revenue last month?"* or *"Show me the journey of my last 5 customers"*.

```bash
claude mcp add --transport http openrev https://analytics.example.com/mcp \
  --header "Authorization: Bearer or_xxx"
```

**Tracker API.** Goals, properties and identity from the browser:

```js
openrev("signup", { plan: "pro" });                              // custom goal
openrev("identify", { user_id: "u_42", email: "jane@example.com" });
```

```html
<button data-openrev-goal="start_trial" data-openrev-goal-plan="pro">Start trial</button>
```

See the [API reference](docs/api/README.md), the [MCP tools](docs/api/README.md#mcp-server) and the [script reference](docs/tracking/script-reference.md).

## 🏠 Self-hosting

| | Database | Best for | Guide |
|---|---|---|---|
| **Cloudflare Workers** | D1 | Free hosting with nothing to maintain | [cloudflare.md](docs/self-hosting/cloudflare.md) |
| **Docker** | SQLite or PostgreSQL | A VPS or your own servers | [docker.md](docs/self-hosting/docker.md) |
| **Node.js** | SQLite or PostgreSQL | Any Node.js 22 host | [node.md](docs/self-hosting/node.md) |
| **Render, Railway, Fly.io** | SQLite on a volume, or PostgreSQL | Managed containers | [platforms.md](docs/self-hosting/platforms.md) |

Migrations run on start-up, and IP geolocation works out of the box (from Cloudflare, Vercel or CloudFront headers, or the free DB-IP Lite database). Everything else is in the [configuration reference](docs/self-hosting/configuration.md) and the [upgrade and backup guide](docs/self-hosting/upgrading.md).

## 🔒 Privacy and security

- **Your data, your database.** No third-party scripts, no data sent anywhere you didn't configure.
- **Cookieless mode** for sites that don't want a consent banner, and IP addresses are never stored. See [privacy, cookies and GDPR](docs/tracking/privacy-and-cookies.md).
- **Hardened by default.** Provider webhooks are checked against their signing secrets, alert webhooks can't reach private networks, sign-in and password checks are rate-limited, and the proxy headers you trust are configurable with `TRUST_PROXY`.
- Found a vulnerability? Please report it privately as described in [SECURITY.md](SECURITY.md).

## ⚖️ How it compares

| | OpenRev | DataFast | DataBull |
|---|:-:|:-:|:-:|
| Pricing | **Free and open source (MIT)** | Subscription | One-time license |
| Self-hosted | ✅ Cloudflare, Docker, Node.js | — | ✅ Cloudflare |
| Where your data lives | Your D1, SQLite or PostgreSQL | DataFast's service | Your Cloudflare D1 |
| Revenue attribution | ✅ | ✅ | ✅ |
| Payment providers | 11 built in + custom webhook + API | Stripe, Lemon Squeezy, Polar, Paddle, Shopify and more + API | Stripe, Polar, Dodo |
| Goals, funnels and journeys | ✅ | ✅ | ✅ |
| Alerts | Slack, Discord, Telegram, email, webhooks | Email | Telegram |
| API and MCP server | ✅ | ✅ | Read-only |

<sub>Based on each product's public website in October 2026. Moving over? Follow the [DataFast migration guide](docs/guides/migrate-from-datafast.md).</sub>

## 🏗️ Architecture

```mermaid
flowchart LR
    T["Tracker<br/>(3.9 kB, your site)"] -- "events" --> S
    P["Payment providers"] -- "webhooks" --> S
    S["OpenRev server<br/>Hono + TypeScript"] --> DB[("D1, SQLite<br/>or PostgreSQL")]
    S --> UI["React dashboard"]
    S --> API["REST API + MCP"]
    S --> AL["Alerts and digests"]
```

One TypeScript codebase built on [Hono](https://hono.dev) runs unchanged on Cloudflare Workers ([`src/runtime/cloudflare.ts`](src/runtime/cloudflare.ts)) and Node.js ([`src/runtime/node.ts`](src/runtime/node.ts)), with one portable SQL schema for D1, SQLite (`node:sqlite`, no native dependencies) and PostgreSQL.

```
src/
  tracker/        browser tracking script (no dependencies)
  server/
    db/           D1, SQLite and Postgres adapters + migrations
    lib/          UA parsing, bot detection, channel classification, timezone and currency math
    services/     ingestion, stats engine, payments and attribution, alerts, scheduler
    providers/    payment provider adapters (Stripe, Paddle, Polar, ...)
    routes/       dashboard API, public REST API v1, MCP server, webhooks
  runtime/        Cloudflare Worker and Node.js entry points
  dashboard/      React + Tailwind dashboard
```

## 🛠️ Development

```bash
npm install
npm run dev        # dashboard on http://localhost:5173, API on :3000 (SQLite in ./data)
npm test           # vitest: SQLite + PGlite (Postgres), plus real Postgres via TEST_DATABASE_URL
npm run typecheck
npm run build      # dist/public (dashboard + tracker) and dist/server/node.js
npm run dev:cf     # run the Cloudflare Worker locally with wrangler
```

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Adding a payment provider takes a single file ([guide](docs/revenue/custom-provider.md)).

## 🗺️ Roadmap

- Google Search Console integration (keywords → revenue)
- Social mentions and 𝕏 post and link-in-bio attribution
- Import from Plausible and Google Analytics
- React Native / mobile SDK and web-to-app funnels
- AI crawler (bot) traffic reports via server middleware
- Historical import for more providers (Polar, Paddle, Dodo…)
- An analytics CLI for terminals (the MCP server already covers agents)

Have an idea? [Open an issue](https://github.com/CrowdLinker/OpenRev/issues).

## 📄 License

MIT © [Crowdlinker](https://crowdlinker.com). IP geolocation by [DB-IP](https://db-ip.com) (CC BY 4.0).

OpenRev is an independent open-source project and is not affiliated with DataFast or DataBull.
