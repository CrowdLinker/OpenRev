# The openrev CLI

Your OpenRev numbers in the terminal: visitors and revenue, top pages and sources, live visitors, MRR, payments,
search keywords, social posts and AI crawlers. It talks to the [REST API](../api/README.md) with an API key, has no
dependencies, and runs on Node.js 18.3 or later.

```bash
npx openrev-cli login
npx openrev-cli stats
```

Or install it once with `npm install -g openrev-cli` and run `openrev stats`. The examples below use the installed
`openrev` command; with npx, type `npx openrev-cli` in its place. (npm refuses `openrev` as a package name, as too
close to `opener`, so the package and the command have different names.)

AI assistants are better served by the [MCP server](../api/README.md#mcp-server), which exposes the same data.

## Log in

Create an API key in OpenRev, **Settings → API & MCP**: a website key (`or_…`) for one website, or an account token
(`ort_…`) for all of yours. Then:

```bash
openrev login
# OpenRev address (https://analytics.example.com): analytics.example.com
# API key (Settings → API & MCP): ••••••••
```

The address and key are saved in `~/.config/openrev/config.json` (or `$XDG_CONFIG_HOME/openrev/config.json`;
`%APPDATA%\openrev\config.json` on Windows), readable only by you. `openrev logout` deletes it. In scripts and CI,
use environment variables instead: `OPENREV_URL` and `OPENREV_API_KEY` (and `OPENREV_SITE`).

With an account token that reads several websites, pick one with `--site example.com` (a domain or website id), or
save a default: `openrev login --site example.com`.

Keys see revenue when the member who created them has
[**Can see revenue**](../features/team-and-sharing.md#who-sees-revenue) on the website. Otherwise the reports leave out
the revenue lines and columns, and `openrev mrr` and `openrev payments` say the key can't see revenue.

## Commands

| Command | Shows |
| --- | --- |
| `openrev stats` | Visitors, pageviews, bounce rate, visit duration, revenue, customers, conversion rate and revenue per visitor, each compared with the previous period, and a chart of visitors and revenue. The default command. |
| `openrev top <report>` | The top `pages`, `referrers`, `channels`, `countries`, `regions`, `cities`, `campaigns`, `devices`, `browsers`, `os`, `goals`, `entry-pages`, `exit-pages`, `hostnames` or `exit-clicks`, with visitors, revenue and conversion rate. `--by revenue` or `--by conversion` sorts them. |
| `openrev live` | Visitors online now: their page, source and location, and the payments of the last 24 hours. `--watch` refreshes every 5 seconds until you press Ctrl+C. |
| `openrev mrr` | MRR, ARR, subscribers, churn, net revenue retention, and the movements (new, expansion, reactivation, contraction, churn). |
| `openrev payments` | Recent payments, with the customer, source, campaign and country. |
| `openrev keywords` | [Google search keywords](../features/search-console.md) with clicks, position and estimated revenue. `--by revenue` sorts by revenue. |
| `openrev social` | [Posts on 𝕏 and Hacker News](../features/social.md) and the visitors and revenue each one brought. |
| `openrev crawlers` | [AI crawler](../features/ai-crawlers.md) and search engine requests, by crawler. |
| `openrev crawls send <log>` | Sends the crawler requests in access logs to OpenRev (see below). |
| `openrev sites` | The websites the key can read. |

Options for every report:

- `-p, --period`: `today`, `yesterday`, `24h`, `7d` (the default), `30d`, `90d`, `wtd`, `mtd`, `ytd`, `12m` or `all`.
- `--from 2026-09-01 --to 2026-09-30`: a date range, in the website's time zone.
- `-n, --limit`: how many rows, from 1 to 200 (10 by default).
- `--json`: the API's JSON, for `jq` and scripts.
- `--no-color` (or `NO_COLOR=1`): plain text. Colors are off anyway when the output isn't a terminal.

```bash
openrev top referrers -p 30d --by revenue
openrev top pages --from 2026-09-01 --to 2026-09-30 -n 20
openrev stats -p mtd --json | jq '.overview.data.revenue'
openrev live --watch
```

## Send crawler requests from access logs

`openrev crawls send` reads access logs in the "combined" format (the default for nginx and Apache), keeps the
`GET` and `HEAD` requests from known crawlers, and sends them to OpenRev in batches of 1,000 with their time. The
crawler list comes from your OpenRev server, so it stays current.

```bash
openrev crawls send /var/log/nginx/access.log.1
openrev crawls send access.log --dry-run      # count, send nothing
zcat access.log.*.gz | openrev crawls send -   # "-" reads standard input
```

Sending the same log twice counts its requests twice, so send each log once, for example yesterday's rotated log from
a daily cron job:

```bash
15 0 * * * OPENREV_URL=https://analytics.example.com OPENREV_API_KEY=or_xxx npx -y openrev-cli crawls send /var/log/nginx/access.log.1
```

It needs a key whose user is an admin of the website.

## Exit codes

`0` on success, `1` when the API or a file returns an error (the message says what to do), `2` for an unknown option.
