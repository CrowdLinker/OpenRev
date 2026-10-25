# Contributing to OpenRev

Thanks for helping! OpenRev aims to be the simplest way to know which marketing makes money — keep changes focused, tested and runtime-agnostic.

## Setup

```bash
git clone https://github.com/CrowdLinker/OpenRev.git && cd OpenRev
npm install
npm run dev          # http://localhost:5173 (dashboard) + :3000 (API), SQLite in ./data
```

To try the tracker locally, add a test page with `data-allow-localhost="true"` and enable *Accept events from localhost* in the website settings.

## Checks

```bash
npm run typecheck
npm test                                    # SQLite + PGlite (Postgres in WASM)
TEST_DATABASE_URL=postgres://... npm test   # also against a real PostgreSQL
npm run build
npm run dev:cf                              # optional: the Cloudflare Worker with local D1
```

CI runs all of the above plus a Docker build.

## Ground rules

- **Runtime-agnostic server code.** Shared code under `src/server` must run on Cloudflare Workers and Node.js: use Web APIs (`fetch`, `crypto.subtle`), no Node built-ins. The only Node-only code is `src/runtime/node.ts` and the database adapters `src/server/db/sqlite-node.ts` / `postgres.ts`.
- **Portable SQL.** Queries run on D1, SQLite and PostgreSQL. Use `?` placeholders, `COALESCE` (not `IFNULL`), `CASE` (not `MAX(a,b)`), `ON CONFLICT … DO UPDATE`, and no dialect-specific functions. D1 allows at most 100 bound parameters per statement. Tests run every query on both engines.
- **Migrations are append-only.** Add a new entry to `src/server/db/migrations.ts`; never edit a shipped one.
- **Tracker size matters.** Keep `src/tracker/script.ts` dependency-free and small.

## Adding a payment provider

One file in `src/server/providers/` implementing `PaymentProvider`, registered in `providers/index.ts`, with tests in `tests/providers/` and a guide in `docs/revenue/`. See [docs/revenue/custom-provider.md](docs/revenue/custom-provider.md).

## Commits & PRs

Small, focused PRs with a clear description. Include tests for behaviour changes and update the docs when user-facing behaviour changes.

## Releasing the installer

`npm create openrev` runs the [`create-openrev`](https://www.npmjs.com/package/create-openrev) package in
`packages/create-openrev`. It's published by the **Publish create-openrev to npm** workflow through npm trusted
publishing, so no npm token is stored anywhere, and every release needs a maintainer's 2FA:

1. Bump `version` in `packages/create-openrev/package.json` and merge the PR.
2. Run the workflow from the Actions tab on `main`. It stages the release with `npm stage publish`. It doesn't run on
   tags, so publishing an OpenRev release (`v0.1.0`, ...) never republishes the installer.
3. A package maintainer approves the staged version on npmjs.com (create-openrev → Staged Packages) with 2FA. It goes
   public with a provenance attestation that links it to the workflow run.

The installer clones `main`, so most changes to OpenRev reach users without a new installer release. Release it only
when `packages/create-openrev` itself changes.
