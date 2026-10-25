# Deploy OpenRev on Cloudflare (Workers + D1)

Cloudflare is the recommended way to run OpenRev: it is serverless, global, needs no maintenance and fits comfortably in the **free tier** for most sites (100,000 Worker requests per day, D1 databases up to 500 MB). Each pageview or event is one request.

What gets deployed to **your** Cloudflare account:

| Resource | Purpose |
|---|---|
| Worker `openrev` | API, event collection, webhooks, MCP server |
| Workers Static Assets | The dashboard and the tracking script (`/js/script.js`) |
| D1 database `openrev` | All analytics, payments and settings (created automatically) |
| Cron Trigger (every 10 min) | Alerts, traffic-spike checks, daily/weekly digests, FX rates, cleanup |

Visitor geolocation comes for free from Cloudflare (`request.cf`), including city and coordinates for the realtime globe.

## Option 1 — one command

Requirements: Node.js 22.13+ and git.

```bash
curl -fsSL https://raw.githubusercontent.com/CrowdLinker/OpenRev/main/install.sh | bash -s -- --target cloudflare
```

or, from a clone:

```bash
git clone https://github.com/CrowdLinker/OpenRev.git && cd OpenRev
npm install
npm run setup -- --target cloudflare
```

The wizard:

1. logs you in with `wrangler login` (a browser window opens) if needed,
2. asks for a Worker name (default `openrev`),
3. builds the dashboard and tracking script,
4. runs `wrangler deploy` — Wrangler **creates the D1 database automatically** on the first deploy and links it to the Worker,
5. stores a random `OPENREV_SECRET` with `wrangler secret put` (used to encrypt payment-provider credentials),
6. prints your URL, e.g. `https://openrev.your-subdomain.workers.dev`.

Open the URL and create your admin account. Database migrations run automatically on the first request.

## Option 2 — Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CrowdLinker/OpenRev)

Cloudflare copies the repository to your GitHub/GitLab account, provisions the D1 database, prompts for `OPENREV_SECRET` (generate one with `openssl rand -hex 32` and keep a copy: changing it later means re-entering your payment-provider keys) and sets up Workers Builds so every push to your copy redeploys automatically.

## Option 3 — manually

```bash
git clone https://github.com/CrowdLinker/OpenRev.git && cd OpenRev
npm install
npx wrangler login
npm run deploy                                    # builds and runs wrangler deploy
openssl rand -hex 32 | npx wrangler secret put OPENREV_SECRET
```

## Custom domain

Cloudflare dashboard → **Workers & Pages** → your Worker → **Settings → Domains & Routes → Add → Custom domain** (e.g. `analytics.example.com`). Then set the public URL so alerts, emails and webhook URLs use it:

```jsonc
// wrangler.jsonc
"vars": {
  "PUBLIC_URL": "https://analytics.example.com",
  "DISABLE_SIGNUP": "false"
}
```

and redeploy with `npm run deploy`.

Tip: serving OpenRev from a subdomain of the website you track (e.g. `stats.example.com`) also makes the script first-party, which avoids most ad blockers.

## Configuration

Set variables in `wrangler.jsonc` → `vars`, and secrets with `npx wrangler secret put NAME`:

| Name | Type | Description |
|---|---|---|
| `OPENREV_SECRET` | secret | Encrypts provider credentials. Set by the wizard. |
| `PUBLIC_URL` | var | Public URL of the instance. |
| `DISABLE_SIGNUP` | var | Sign-ups close after the first (admin) account; `true` keeps them closed even if an admin re-opens them. |
| `RESEND_API_KEY` | secret | Enables emails (invites, email alerts, digests) via [Resend](https://resend.com). |
| `OPENREV_EMAIL_FROM` | var | Sender, e.g. `OpenRev <analytics@example.com>`. |
| `RETENTION_DAYS` | var | Delete raw events/sessions older than N days. |

See [configuration.md](configuration.md) for details.

## Updating

```bash
npm run update      # git pull, npm install, build, wrangler deploy
```

If you used the Deploy button, pull upstream changes into your copy of the repository; Workers Builds redeploys automatically. Migrations are applied automatically.

## Limits & scaling

- D1 databases can grow to 10 GB on the Workers Paid plan. On the free plan each database is limited to 500 MB, and 5 GB is the total D1 storage for the account. Use `RETENTION_DAYS` to cap raw data.
- The free Workers plan allows 100k requests/day. Sites with more traffic should use the Workers Paid plan ($5/month for 10M requests).
- Queries run directly on D1; dashboards stay fast up to several million events per month. For very large sites, consider [PostgreSQL on Node/Docker](docker.md).

## Backups

```bash
npx wrangler d1 export openrev --remote --output openrev-backup.sql
```

D1 also has built-in point-in-time recovery ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)) for the last 30 days on the Workers Paid plan (7 days on the free plan).

## Local development of the Worker

```bash
npm run dev:cf      # builds the client and runs `wrangler dev` with a local D1 database
```
