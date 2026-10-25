# create-openrev

Deploy [OpenRev](https://github.com/CrowdLinker/OpenRev) — open-source, revenue-first web analytics — in one command:

```bash
npm create openrev@latest
```

The wizard asks where to run it:

- **Cloudflare** (Workers + D1, free tier) — logs you in with Wrangler, creates the database and deploys.
- **Docker** — writes a `.env` and starts `docker compose`.
- **Node.js** — builds and starts the server with SQLite or PostgreSQL.

Non-interactive: `npm create openrev@latest my-analytics -- --target cloudflare --name my-analytics --yes`
