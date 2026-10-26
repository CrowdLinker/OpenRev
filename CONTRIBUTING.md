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

## Releasing OpenRev

OpenRev itself (server, dashboard and tracker) is versioned with Git tags, separately from the npm packages below.

1. In a PR, set the new version in `package.json` with `npm version <x.y.z> --no-git-tag-version` (it updates the
   lockfile too) and in `VERSION` in `src/server/context.ts`. A test checks that they match: it's the version
   `/api/health`, the OpenAPI spec and the MCP server report.
2. After it merges, publish a GitHub release from `main` with a new tag `v<x.y.z>`. The **Publish Docker image**
   workflow pushes `ghcr.io/crowdlinker/openrev:<x.y.z>` and `:<x.y>`; `latest` always follows `main`.
3. Before 1.0, a release with new features bumps the minor version (`0.2.0`); one with only fixes bumps the patch
   (`0.2.1`).

## Releasing the npm packages

Three packages live in `packages/`:

- [`create-openrev`](https://www.npmjs.com/package/create-openrev), the installer behind `npm create openrev`;
- [`openrev-cli`](https://www.npmjs.com/package/openrev-cli), the [CLI](docs/guides/cli.md), in `packages/openrev`
  (the command is `openrev`, but npm refuses that package name as too close to `opener`);
- [`openrev-react-native`](https://www.npmjs.com/package/openrev-react-native), the
  [mobile SDK](docs/tracking/mobile-apps.md), in `packages/react-native`.

They are published by the **Publish an npm package** workflow through npm trusted publishing, so no npm token is
stored anywhere, and every release needs a maintainer's 2FA:

1. Bump `version` in `packages/<package>/package.json` and merge the PR.
2. Run the workflow from the Actions tab on `main`, picking the package's folder. It stages the release with
   `npm stage publish`. It doesn't run on tags, so an OpenRev release (`v0.1.0`, ...) never republishes them.
3. A package maintainer approves the staged version on npmjs.com (package → Staged Packages) with 2FA. It goes
   public with a provenance attestation that links it to the workflow run.

Each package needs a trusted publisher on npmjs.com (package → Settings → Trusted publishing: GitHub Actions,
`CrowdLinker/OpenRev`, workflow `publish-cli.yml`). If npm doesn't offer that before a package exists, a maintainer
publishes its first version once by hand (`npm publish` in its folder, with 2FA), then adds the trusted publisher.

The installer clones `main`, so most changes to OpenRev reach users without a new installer release. Release it only
when `packages/create-openrev` itself changes. Release the CLI and the SDK when their folders change. Their versions
don't follow OpenRev's: each README says which OpenRev version it needs, so update that line when a package starts
using something newer.
