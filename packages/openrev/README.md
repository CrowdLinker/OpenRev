# openrev

[OpenRev](https://github.com/CrowdLinker/OpenRev) analytics in your terminal: visitors and revenue, top pages and
sources, live visitors, MRR, payments, search keywords, social posts and AI crawlers. No dependencies; Node.js 18.3
or later. Needs OpenRev 0.2.0 or later.

```bash
npx openrev login     # your OpenRev address and an API key (Settings → API & MCP)
npx openrev stats     # visitors, revenue and conversion for the last 7 days
```

```text
lumen.app  Overview · 2026-09-27 → 2026-10-26

  Visitors                       9,355  ▲ 45%
  Pageviews                     26,989  ▲ 44%
  Bounce rate                      34%  ▼ 2.3%
  Visit duration                2m 28s  ▲ 3.1%
  Revenue                   $25,460.00  ▲ 28%
  Customers                        326  ▲ 92%
  Conversion rate                2.12%  ▲ 19%
  Revenue per visitor            $2.72  ▼ 11%

  Visitors  ▃▄▄▄▄▄▃▃▄█▇▅▄▃▃▄▄▄▄▄▃▃▄▄▄▄▅▃▃▁
  Revenue   ▁▆▃▂▂▃▂▅▄▆█▂▃▂▅▃▁▃▄▄▃▄▄▄▃▇▁▂▃▁
```

| Command | Shows |
| --- | --- |
| `openrev stats` | The overview, compared with the previous period |
| `openrev top <report>` | Top `pages`, `referrers`, `channels`, `countries`, `campaigns`, `devices`, `goals`… (`--by revenue`) |
| `openrev live [--watch]` | Visitors online now |
| `openrev mrr` | MRR, churn and net revenue retention |
| `openrev payments` | Recent payments and what brought them |
| `openrev keywords` | Google search keywords and their revenue |
| `openrev social` | Posts on 𝕏 and Hacker News and what they brought |
| `openrev crawlers` | AI crawler requests |
| `openrev crawls send <log>` | Send the crawler requests in nginx or Apache access logs |
| `openrev sites` | Websites the key can read |

Options: `-p 30d` (or `today`, `mtd`, `12m`…), `--from`/`--to`, `-s <site>`, `-n <rows>`, `--json`. In scripts, set
`OPENREV_URL` and `OPENREV_API_KEY` instead of logging in. A key whose member can't see revenue gets the reports without
it.

Full guide: [docs/guides/cli.md](https://github.com/CrowdLinker/OpenRev/blob/main/docs/guides/cli.md). MIT license.
