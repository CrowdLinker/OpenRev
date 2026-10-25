<div align="center">

<img src="src/dashboard/public/favicon.svg" width="64" height="64" alt="OpenRev logo" />

# OpenRev

**Open-source, revenue-first web analytics.**
Find out which marketing channels, pages and campaigns actually make you money — on infrastructure you own.

[![CI](https://github.com/CrowdLinker/OpenRev/actions/workflows/ci.yml/badge.svg)](https://github.com/CrowdLinker/OpenRev/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-violet.svg)](LICENSE)

[Quick start](#-quick-start) · [Features](#-features) · [Docs](docs/README.md) · [Revenue providers](docs/revenue/README.md) · [API](docs/api/README.md)

</div>

---

OpenRev is a free, self-hostable alternative to [DataFast](https://datafa.st) and [DataBull](https://databull.app). Add a 4 kB script to your site, connect Stripe (or Lemon Squeezy, Polar, Paddle, Shopify, Gumroad, Dodo, Creem, Paystack, Razorpay, WooCommerce, or **any** payment system through a custom webhook or the Payments API), and every sale is attributed to the visitor's traffic source, landing page, campaign, country and device.

- 🪶 **Lightweight & private** — no third-party trackers, cookie or cookieless mode, your data stays in your database.
- 💸 **Revenue attribution** — revenue, conversion rate and revenue-per-visitor next to every traffic source.
- ☁️ **Runs anywhere** — Cloudflare Workers + D1 (free tier), Docker, or plain Node.js with SQLite or PostgreSQL.
- ⚡ **One command to deploy** — `curl -fsSL https://raw.githubusercontent.com/CrowdLinker/OpenRev/main/install.sh | bash`
- 🔁 **Drop-in for DataFast** — understands `window.datafast()`, `data-fast-goal` and `datafast_visitor_id`.

## 🚀 Quick start

### One command (Cloudflare, Docker or Node.js)

```bash
curl -fsSL https://raw.githubusercontent.com/CrowdLinker/OpenRev/main/install.sh | bash
```

The installer downloads OpenRev and asks where to run it:

| Target | What happens | Cost |
|---|---|---|
| **Cloudflare** (recommended) | Logs you in with Wrangler, creates the D1 database, deploys the Worker, stores a secret. | Free tier: 100k requests/day, 500 MB D1 database |
| **Docker** | Writes `.env`, starts `docker compose` (SQLite or bundled PostgreSQL). | Any $5 VPS |
| **Node.js** | Builds and runs the server (SQLite file or `postgres://` URL). | — |

Prefer npm? `npm create openrev@latest` does the same thing. Already cloned the repo? Run `npm install && npm run setup`.

### One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CrowdLinker/OpenRev)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/CrowdLinker/OpenRev)

### Docker

```bash
docker run -d --name openrev -p 3000:3000 -v openrev-data:/data \
  -e PUBLIC_URL=https://analytics.example.com ghcr.io/crowdlinker/openrev:latest
```

Then open your instance, create the admin account, add your website and paste the snippet into your site's `<head>`:

```html
<script
  defer
  data-website-id="YOUR_WEBSITE_ID"
  data-domain="example.com"
  src="https://analytics.example.com/js/script.js"
></script>
```

➡️ Full guides: [Cloudflare](docs/self-hosting/cloudflare.md) · [Docker](docs/self-hosting/docker.md) · [Node.js](docs/self-hosting/node.md) · [Other platforms](docs/self-hosting/platforms.md) · [Configuration](docs/self-hosting/configuration.md)

## ✨ Features

**Web analytics**
- Visitors, pageviews, sessions, bounce rate, session time, new vs returning — with period-over-period comparison
- Channels (Direct, Organic/Paid Search, Organic/Paid Social, **AI** — ChatGPT, Perplexity, Claude, Gemini…, Email, Referral, Affiliate, Display), referrers, UTM source/medium/campaign/term/content, `?ref=` links
- Pages, entry pages, exit pages, exit links (outbound clicks), hostnames
- World map, countries, regions, cities · devices, browsers, operating systems (incl. Instagram/TikTok in-app browsers)
- Filter everything by any dimension, date ranges with pinnable presets, hourly → monthly charts, chart notes
- SPA routing (history & hash), subdomains and cross-domain tracking, bot filtering, exclusions (IPs, paths, countries, hostnames, your own browser)

**Revenue attribution**
- Revenue, payments, customers, **conversion rate** and **revenue per visitor** for every source, page, country, device and goal
- First-touch, last-touch and last-non-direct attribution models
- New revenue vs renewals vs refunds, average order value, multi-currency with automatic conversion
- **Customer lifetime value** by first-touch source, repeat-purchase rate
- Visitor ids flow automatically: checkout metadata, Stripe Payment Link tagging, checkout success-page detection, Shopify cart attributes, email matching after `identify`
- Historical import (Stripe, Lemon Squeezy)

**Payment providers** — [Stripe](docs/revenue/stripe.md), [Lemon Squeezy](docs/revenue/lemonsqueezy.md), [Polar](docs/revenue/polar.md), [Paddle](docs/revenue/paddle.md), [Shopify](docs/revenue/shopify.md), [Dodo Payments](docs/revenue/dodo.md), [Creem](docs/revenue/creem.md), [Gumroad](docs/revenue/gumroad.md), [Paystack](docs/revenue/paystack.md), [Razorpay](docs/revenue/razorpay.md), [WooCommerce](docs/revenue/woocommerce.md), a [custom webhook adapter](docs/revenue/custom-provider.md) for anything else, and the [Payments API](docs/api/README.md#payments).

**Conversion insights**
- Custom goals (JS, HTML attributes, scroll-into-view, server-side) with custom properties and a **#1 KPI**
- Funnels (pages → goals → payment) with drop-off and revenue per step
- Visitor journeys: every session, page, goal and payment of a visitor, with identity (`openrev("identify")`)
- **Realtime**: live globe, live visitor list with buyer-intent score, activity feed

**Team & sharing**
- Unlimited websites and team members (owner / admin / viewer), invitations by link or email
- Public read-only dashboards (no personal data)
- Alerts to **Slack, Discord, Telegram, email or webhooks**: new sales & refunds (with source, country and journey), goal completions, traffic spikes, daily/weekly digests

**For developers & AI agents**
- REST API with website keys and account tokens, [OpenAPI spec](docs/api/README.md)
- Server-side goals, payments and identify (DataFast-compatible payloads)
- Built-in **MCP server** — ask Claude, Cursor or any MCP client about your traffic and revenue
- CSV export of all raw data

### How it compares

| | OpenRev | DataFast | DataBull |
|---|:-:|:-:|:-:|
| Pricing | **Free & open source (MIT)** | Subscription | One-time license |
| Self-hosted | ✅ Cloudflare, Docker, Node.js | — | ✅ Cloudflare |
| Database | D1, SQLite or PostgreSQL | Managed | D1 |
| Revenue attribution | ✅ | ✅ | ✅ |
| Payment providers | 11 built-in + custom webhook + API | Stripe, Lemon Squeezy, Polar, Paddle, Shopify & more + API | Stripe, Polar, Dodo |
| Goals, funnels & journeys | ✅ | ✅ | Journeys |
| Alerts | Slack, Discord, Telegram, email, webhooks | Email | Telegram |
| REST API & MCP server | ✅ | ✅ | — |

<sub>Comparison based on each product's public website in October 2026.</sub>

## 🧭 How revenue attribution works

```
 visitor lands ─► tracker sets openrev_visitor_id cookie ─► sessions & pageviews recorded
                                                               │
 checkout: pass the visitor id as metadata ──────────────────► payment provider
   (or let the tracker tag Payment Links / detect the success page)    │
                                                                       ▼
 provider webhook ─► OpenRev verifies the signature ─► payment linked to the visitor's sessions
                                                       ─► revenue by source, page, country, goal…
```

Pass the visitor id when you create a checkout — e.g. with Stripe:

```js
const session = await stripe.checkout.sessions.create({
  // ...
  metadata: {
    openrev_visitor_id: cookies.get("openrev_visitor_id"),
    openrev_session_id: cookies.get("openrev_session_id"),
  },
});
```

See [Revenue attribution](docs/revenue/README.md) for every provider, renewals, refunds and multi-currency.

## 🏗️ Architecture

- **Server**: TypeScript + [Hono](https://hono.dev), runtime-agnostic — the same app runs on Cloudflare Workers ([`src/runtime/cloudflare.ts`](src/runtime/cloudflare.ts)) and Node.js ([`src/runtime/node.ts`](src/runtime/node.ts)).
- **Storage**: one portable SQL schema for Cloudflare D1, SQLite (`node:sqlite`, no native deps) and PostgreSQL. Migrations run automatically.
- **Dashboard**: React + Tailwind, served as static assets.
- **Tracker**: dependency-free TypeScript, ~4 kB gzipped ([`src/tracker/script.ts`](src/tracker/script.ts)).
- **Geolocation**: Cloudflare/Vercel/CloudFront headers when available, otherwise the free DB-IP Lite database is downloaded automatically.

```
src/
  tracker/        browser tracking script
  server/
    db/           D1, SQLite and Postgres adapters + migrations
    lib/          UA parsing, bot detection, channel classification, timezone & currency math
    services/     ingestion, stats engine, payments & attribution, alerts, scheduler
    providers/    payment provider adapters (Stripe, Paddle, Polar, ...)
    routes/       dashboard API, public REST API v1, MCP server, webhooks
  runtime/        Cloudflare Worker and Node.js entry points
  dashboard/      React dashboard
```

## 🛠️ Development

```bash
npm install
npm run dev        # dashboard on http://localhost:5173, API on :3000 (SQLite in ./data)
npm test           # vitest — SQLite + PGlite (Postgres) + optional real Postgres via TEST_DATABASE_URL
npm run typecheck
npm run build      # dist/public (dashboard + tracker) and dist/server/node.js
npm run dev:cf     # run the Cloudflare Worker locally with wrangler
```

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Adding a payment provider is a single file: [docs/revenue/custom-provider.md](docs/revenue/custom-provider.md).

## 🗺️ Roadmap

Planned (contributions welcome):

- Google Search Console integration (keywords → revenue)
- Social mentions and 𝕏 post/link-in-bio attribution
- Import from Plausible and Google Analytics
- React Native / mobile SDK and web-to-app funnels
- AI crawler (bot) traffic reports via server middleware
- Historical import for more providers (Polar, Paddle, Dodo…)
- Analytics CLI for terminals and AI agents (the MCP server already covers agents)

## 📄 License

MIT © [Crowdlinker](https://crowdlinker.com). IP geolocation by [DB-IP](https://db-ip.com) (CC BY 4.0).

OpenRev is an independent open-source project and is not affiliated with DataFast or DataBull.
