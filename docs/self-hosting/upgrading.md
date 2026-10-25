# Upgrading, backups & data

## Upgrading

| Deployment | Command |
|---|---|
| Any (installed with the wizard) | `npm run update` |
| Docker | `docker compose pull && docker compose up -d` |
| Cloudflare | `git pull && npm install && npm run deploy` |

Database migrations run automatically when the new version starts (or on the first request on Cloudflare). They are additive and safe to run concurrently.

## Backups

| Database | Backup |
|---|---|
| SQLite | Copy `data/openrev.db` (use `sqlite3 data/openrev.db ".backup backup.db"` while running), or snapshot the Docker volume. |
| PostgreSQL | `pg_dump "$DATABASE_URL" > openrev.sql` |
| Cloudflare D1 | `npx wrangler d1 export openrev --remote --output openrev.sql` (and D1 Time Travel). |

Keep `OPENREV_SECRET` with your backups — it's needed to decrypt stored payment-provider credentials (you can always re-enter them).

## Exporting data

Every website can export raw sessions, events, payments and visitors as CSV from **Settings → Data**, or programmatically with the [API](../api/README.md). Text cells that start with `=`, `+`, `-` or `@` are prefixed with an apostrophe (`'`) so spreadsheet apps don't run them as formulas.

## Moving between databases

Export CSVs from the old instance or use the database's own tools; the schema (`src/server/db/migrations.ts`) is identical on D1, SQLite and PostgreSQL.
