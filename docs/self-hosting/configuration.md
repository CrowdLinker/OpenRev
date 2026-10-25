# Configuration reference

## Node.js / Docker (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_URL` | derived from requests | Public URL of the instance, used in alert links, emails and webhook URLs shown in the dashboard. |
| `OPENREV_SECRET` | generated & stored in the DB | Key used to encrypt payment-provider credentials (AES-GCM). Set it explicitly so a database dump alone can't reveal credentials. |
| `PORT` | `3000` | HTTP port. |
| `HOST` | `0.0.0.0` | Interface to bind. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Directory for the SQLite database and the geolocation database. |
| `DATABASE_URL` | `$DATA_DIR/openrev.db` | SQLite file path or `postgres://…` URL. For managed Postgres add `?sslmode=`: it's passed to the driver as-is, so `require` encrypts the connection and `verify-ca` / `verify-full` also verify the server certificate against Node's trusted CAs (add a private CA with `NODE_EXTRA_CA_CERTS`). |
| `DATABASE_POOL_SIZE` | `10` | PostgreSQL connection pool size. |
| `DISABLE_SIGNUP` | `false` | Public sign-ups are closed by default once the first (admin) account exists — people join with invitations, and admins can open sign-ups in **Account → Instance administration**. `true` keeps sign-ups closed regardless of that toggle. |
| `RESEND_API_KEY` | — | Enables emails (invitations, email alerts, digests) via [Resend](https://resend.com). |
| `OPENREV_EMAIL_FROM` | `OpenRev <onboarding@resend.dev>` | Sender address (must be a domain verified in Resend). |
| `RETENTION_DAYS` | — (keep forever) | Delete raw events and sessions older than N days. Payments are kept. |
| `TRUST_PROXY` | `true` | Read the client IP from `X-Forwarded-For` / `X-Real-IP`. Analytics use the first `X-Forwarded-For` address (the visitor, also when a website proxies the tracker); login rate limits use the connection's address, or the last `X-Forwarded-For` entry (the one your reverse proxy appends) when the connection comes from a private or loopback address. Set `false` if OpenRev is exposed without a reverse proxy: both then use the connection's address. |
| `GEOIP_DB` | — | Path to a MaxMind GeoLite2 / DB-IP `.mmdb` file. |
| `GEOIP_AUTO_DOWNLOAD` | `true` | Download the free DB-IP Lite city database into `DATA_DIR` and refresh it monthly. |
| `PUBLIC_DIR` | `dist/public` | Location of the built dashboard (advanced). |

## Cloudflare Workers

Variables go in `wrangler.jsonc` → `vars`; secrets are set with `npx wrangler secret put NAME`.

| Name | Type |
|---|---|
| `OPENREV_SECRET` | secret |
| `PUBLIC_URL` | var |
| `DISABLE_SIGNUP` | var |
| `RESEND_API_KEY` | secret |
| `OPENREV_EMAIL_FROM` | var |
| `RETENTION_DAYS` | var |

Geolocation is provided by Cloudflare. The D1 binding must be named `DB`.

## Per-website settings (dashboard → Settings)

| Setting | Description |
|---|---|
| Domain & additional domains | Events from other hostnames are rejected unless *Only accept events from my domains* is turned off. Subdomains are always accepted. |
| Timezone & currency | Used for charts/digests; revenue in other currencies is converted with daily ECB rates (frankfurter.dev) with fallbacks. |
| Attribution model | `last_non_direct` (default), `last_touch` or `first_touch`. Changes apply retroactively. |
| #1 KPI | A goal shown as a headline conversion metric. |
| Cookieless mode | No cookies; visitors are identified with a hash of IP + user agent + a salt that rotates daily. |
| Exclusions | IPs (exact, wildcard `1.2.3.*`, CIDR), paths (`/admin/*`), countries, hostnames. |
| Public dashboard | Read-only share link without personal data. |

## Scheduled jobs

Node runs them every minute in-process; Cloudflare uses the Cron Trigger in `wrangler.jsonc` (every 10 minutes): traffic-spike alerts and digests (hourly), exchange-rate refresh, cleanup of expired sessions and old raw data (`RETENTION_DAYS`).
