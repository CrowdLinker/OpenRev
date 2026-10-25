## What and why

<!-- What this changes, and the problem it solves. Link the issue if there is one. -->

## How it was tested

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Tried it in the dashboard or with the tracker (if it changes either)

## Checklist

- [ ] Server code runs on both Cloudflare Workers and Node.js (no Node built-ins outside `src/runtime/node.ts` and the database adapters)
- [ ] SQL works on D1, SQLite and PostgreSQL, and migrations are new entries, not edits
- [ ] Docs updated if user-facing behaviour changed
