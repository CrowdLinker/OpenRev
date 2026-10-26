# Upgrading, backups & data

## Upgrading

| Deployment | Command |
|---|---|
| Any (installed with the wizard) | `npm run update` |
| Docker | `docker compose pull && docker compose up -d` |
| Cloudflare | `git pull && npm install && npm run deploy` |

Database migrations run automatically when the new version starts (or on the first request on Cloudflare). They are additive and safe to run concurrently.

## Upgrade notes

### Upgrading to 0.2.0: who sees revenue

Team members now need **Can see revenue** to see revenue
([who sees revenue](../features/team-and-sharing.md#who-sees-revenue)). After the update, only owners see it: admins
and viewers who saw revenue before don't, in the dashboard, their API keys, the CLI, MCP, exports or emailed alerts,
until an owner turns it on for them. **After updating, grant "Can see revenue" in Settings → Team to the members who
should keep seeing it.** A notice there reminds each owner once (and each admin, once they can see revenue). Only
members who can see revenue can grant it, so an admin who lost it can't turn it back on for themselves. Invitations
that were pending start without it too.

Payment alerts and digests that already exist keep sending to their Slack, Discord, Telegram, webhook and outside
email destinations, whoever set them up. **Check them in Settings → Alerts after updating**, and delete any that point
somewhere that shouldn't see revenue. From now on only members who can see revenue can create or change them.

**Hide revenue** is now **Hide revenue on share links**. It keeps its value, but only applies to public share links,
where it now removes revenue on the server. Owners and members with **Can see revenue** see revenue in the dashboard
even when it's on.

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
