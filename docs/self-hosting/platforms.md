# Other platforms

OpenRev ships as a Cloudflare Worker and as a Docker image / Node.js server, so it runs almost anywhere.

| Platform | How |
|---|---|
| **Cloudflare Workers** | [cloudflare.md](cloudflare.md) — recommended, free tier |
| **Render** | [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/CrowdLinker/OpenRev) — uses [`render.yaml`](../../render.yaml) (Docker + 1 GB persistent disk) |
| **Railway** | New project → Deploy from GitHub repo → it builds the [`Dockerfile`](../../Dockerfile) ([`railway.json`](../../railway.json)). Add a volume mounted at `/data`, or a Railway PostgreSQL database and set `DATABASE_URL`. |
| **Fly.io** | `fly launch --copy-config --no-deploy && fly volumes create openrev_data --size 1 && fly deploy` ([`fly.toml`](../../fly.toml)) |
| **Coolify / CapRover / Dokku** | Deploy the repository with the Dockerfile, mount a volume at `/data`, expose port 3000. |
| **DigitalOcean / Hetzner / any VPS** | Use the [one-command installer](../../README.md#-quick-start) with the Docker target, or [docker.md](docker.md). |
| **Kubernetes** | Use the image `ghcr.io/crowdlinker/openrev:latest` with a PersistentVolumeClaim at `/data` (SQLite, single replica) or `DATABASE_URL` (PostgreSQL). Health probe: `GET /api/health`. |

## Choosing a database

| | Use when |
|---|---|
| **Cloudflare D1** | Deploying on Cloudflare. |
| **SQLite** (default on Node/Docker) | A single server. Handles millions of events per month; back up the `/data` volume. |
| **PostgreSQL** | You want a managed database (Neon, Supabase, RDS, Railway…), several app replicas, or very large volumes. Set `DATABASE_URL`. |

The schema and queries are identical on all three; migrations run automatically.

## Serverless Node platforms (Vercel, Netlify, Lambda)

OpenRev's server is a standard [Hono](https://hono.dev) app (`createApp` in `src/server/app.ts`) and can be adapted to other runtimes with a PostgreSQL `DATABASE_URL`, but these targets are not officially packaged yet — contributions welcome.
