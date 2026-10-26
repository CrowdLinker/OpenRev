# AI crawlers

See which AI crawlers read your website, which pages they read, and what the visits from AI assistants are worth. The
**Crawlers** page shows requests from AI training crawlers (GPTBot, ClaudeBot…), AI search crawlers, AI assistants
fetching a page for someone (ChatGPT-User, Claude-User…) and, for comparison, search engines. Next to them are the
visitors and revenue that came from ChatGPT, Claude, Perplexity and other assistants (the AI channel).

## Why your server reports them

Crawlers don't run JavaScript, so the tracking script never sees them. Your website's server does: it receives every
request with its user agent. A few lines of server code (a Next.js proxy, a Cloudflare Worker, an Express middleware)
send the crawler requests to OpenRev in the background, without slowing the page down.

## Set up

1. Create a website API key in **Settings → API & MCP** and add it to your website's server as an environment variable,
   `OPENREV_API_KEY`. The key can also send payments and goals, so keep it on the server.
2. Add the code for your platform below, replacing `https://analytics.example.com` with your OpenRev address. The
   **Crawlers** page shows the same code with your address filled in.

Each example only reports requests whose user agent matches a known crawler. `CRAWLERS` lists them: copy the full
expression from the setup panel on the Crawlers page, or from the `pattern` field of
[`GET /analytics/crawlers`](../api/README.md#get-analyticscrawlers). The short version below is enough to start. OpenRev
checks the user agent again and ignores anything it doesn't recognize, so a loose filter does no harm.

```js
const CRAWLERS = /GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-SearchBot|Claude-User|PerplexityBot|Perplexity-User|Google-CloudVertexBot|meta-externalagent|Bytespider|CCBot|Amazonbot|Googlebot|bingbot|Applebot/i;
```

### Next.js

`proxy.ts` next to your `app` folder (Next.js 16). On Next.js 15 or earlier, name the file `middleware.ts` and the
function `middleware`.

```ts
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

const CRAWLERS = /GPTBot|ClaudeBot|ChatGPT-User|Claude-User|PerplexityBot|Googlebot|bingbot/i; // the full list above
const OPENREV_API_KEY = process.env.OPENREV_API_KEY;

export function proxy(req: NextRequest, event: NextFetchEvent) {
  const ua = req.headers.get("user-agent") ?? "";
  if (OPENREV_API_KEY && CRAWLERS.test(ua)) {
    event.waitUntil(
      fetch("https://analytics.example.com/api/v1/crawls", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENREV_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: req.nextUrl.pathname, user_agent: ua }),
      }).catch(() => {}),
    );
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
```

The matcher leaves out Next.js's own assets but keeps `robots.txt` and `sitemap.xml`, which crawlers read first.

### Cloudflare Workers

A Worker in front of your site, with `OPENREV_API_KEY` as a secret (`npx wrangler secret put OPENREV_API_KEY`). On
Cloudflare Pages, put the same check in `functions/_middleware.js`: `export async function onRequest(context)`, with
`context.request`, `context.env` and `context.waitUntil`, and `return context.next()` at the end.

```js
const CRAWLERS = /GPTBot|ClaudeBot|ChatGPT-User|Claude-User|PerplexityBot|Googlebot|bingbot/i; // the full list above

export default {
  async fetch(request, env, ctx) {
    const ua = request.headers.get("user-agent") || "";
    if (env.OPENREV_API_KEY && CRAWLERS.test(ua)) {
      ctx.waitUntil(
        fetch("https://analytics.example.com/api/v1/crawls", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.OPENREV_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ path: new URL(request.url).pathname, user_agent: ua }),
        }).catch(() => {}),
      );
    }
    return fetch(request);
  },
};
```

### Express and other Node.js servers

Before your routes. Node.js 18 or later has `fetch` built in.

```js
const CRAWLERS = /GPTBot|ClaudeBot|ChatGPT-User|Claude-User|PerplexityBot|Googlebot|bingbot/i; // the full list above
const OPENREV_API_KEY = process.env.OPENREV_API_KEY;

app.use((req, res, next) => {
  const ua = req.get("user-agent") || "";
  if (OPENREV_API_KEY && CRAWLERS.test(ua)) {
    fetch("https://analytics.example.com/api/v1/crawls", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENREV_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path: req.path, user_agent: ua }),
    }).catch(() => {});
  }
  next();
});
```

### Access logs

Any other server (nginx, Apache, Caddy, a CDN's log export) can send its logs in batches of up to 1,000 requests, with
the time of each one:

```bash
curl -X POST https://analytics.example.com/api/v1/crawls \
  -H "Authorization: Bearer $OPENREV_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"hits": [
    {"path": "/pricing", "user_agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", "timestamp": "2026-10-26T09:12:00Z"},
    {"path": "/blog/launch", "user_agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot@anthropic.com"}
  ]}'
```

The [openrev CLI](../guides/cli.md) does it for you: `npx openrev crawls send /var/log/nginx/access.log.1` reads a log
in the default "combined" format (nginx and Apache) and sends its crawler requests. Run it once a day on the previous
day's log: sending the same log twice counts its requests twice.

Without Node.js packages, this script does the same:

```js
// node send-crawls.mjs /var/log/nginx/access.log.1
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const OPENREV = "https://analytics.example.com";
const CRAWLERS = /GPTBot|ClaudeBot|ChatGPT-User|Claude-User|PerplexityBot|Googlebot|bingbot/i; // the full list above
// 1.2.3.4 - - [26/Oct/2026:09:12:00 +0000] "GET /pricing HTTP/1.1" 200 5120 "-" "Mozilla/5.0 (compatible; GPTBot/1.2)"
const LINE = /^\S+ \S+ \S+ \[([^\]]+)\] "(?:GET|HEAD) (\S+)[^"]*" \d{3} \S+ "[^"]*" "([^"]*)"/;

const send = async (hits) => {
  const res = await fetch(`${OPENREV}/api/v1/crawls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENREV_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ hits }),
  });
  if (!res.ok) throw new Error(`OpenRev answered ${res.status}: ${await res.text()}`);
};

let batch = [];
let sent = 0;
for await (const line of createInterface({ input: createReadStream(process.argv[2]) })) {
  const m = LINE.exec(line);
  if (!m || !CRAWLERS.test(m[3])) continue;
  // "26/Oct/2026:09:12:00 +0000" → "26 Oct 2026 09:12:00 +0000"
  const timestamp = Date.parse(m[1].replace(":", " ").replaceAll("/", " "));
  batch.push({ path: m[2], user_agent: m[3], timestamp });
  if (batch.length === 1000) {
    await send(batch);
    sent += batch.length;
    batch = [];
  }
}
if (batch.length) await send(batch);
console.log(`Sent ${sent + batch.length} crawler requests`);
```

## What OpenRev counts

- One request is one hit. OpenRev keeps the number of hits per day, crawler and page, nothing else: no IP addresses
  and no full user agents.
- Pages are stored like entry pages: the path, without the query string or a trailing slash.
- Requests from user agents OpenRev doesn't recognize are ignored, and the response says how many
  (`{"recorded": 12, "ignored": 3}`).
- Days follow the website's time zone. Without a `timestamp`, a hit counts at the time OpenRev receives it.
- Because hits are counted per day, a report covers whole days: **Last 24 hours** shows yesterday's and today's hits.
- **Visitors from AI** and **Revenue from AI** are visits and payments from the AI channel: people who came from
  ChatGPT, Claude, Perplexity, Gemini, Copilot and other assistants. They come from the tracking script, like the rest
  of the dashboard, and use your attribution model.

## Categories and crawlers

| Category | What it means | Crawlers |
| --- | --- | --- |
| AI training | Collect pages to train AI models | GPTBot, ClaudeBot, anthropic-ai, meta-externalagent, Amazonbot, Bytespider, CCBot, cohere-ai, AI2Bot, Diffbot, Timpibot |
| AI search | Index pages for AI search and answer engines | OAI-SearchBot, Claude-SearchBot, PerplexityBot, DuckAssistBot, YouBot |
| AI assistants | Fetch a page because a person asked an AI assistant about it: the closest thing to a visit | ChatGPT-User, Claude-User, Perplexity-User, Google-CloudVertexBot, meta-externalfetcher, MistralAI-User |
| Search engines | Classic search crawlers, for comparison | Googlebot, bingbot, Applebot, DuckDuckBot, YandexBot, Baiduspider |

A crawler is recognized by its token anywhere in the user agent, as a whole word: `Googlebot-Image` counts as
Googlebot, `NotGooglebot` doesn't. The list is in
[`src/server/lib/crawlers.ts`](../../src/server/lib/crawlers.ts); pull requests for new crawlers are welcome.

## Limits

- User agents can be copied, so a scraper can claim to be GPTBot. Some operators publish their IP ranges if you want to
  check requests on your side before sending them.
- Filters (country, campaign…) don't apply: crawler hits have no visitor attributes.
- Every reported request is a call to OpenRev. On a busy site, send search engines' requests from logs in batches, or
  drop `Googlebot` and `bingbot` from your `CRAWLERS` expression.
- Shared dashboards show the Crawlers page once the server has reported crawler requests.

## API and MCP

- `POST /api/v1/crawls` records requests: `{ "path": "/pricing", "user_agent": "…" }`, or `{ "hits": [...] }` with up to
  1,000 of them. `url` and `userAgent` work too, and `timestamp` is optional (milliseconds, seconds or ISO 8601). See the
  [REST API](../api/README.md#post-crawls).
- `GET /api/v1/analytics/crawlers?period=30d` returns the report: `summary`, `timeseries`, `crawlers`, `pages` and
  `pattern`. `category` (`ai_training`, `ai_search`, `ai_user` or `search`) narrows the crawlers and pages.
- AI assistants can use the MCP tool `get_crawlers`, for example: *"Which pages did AI crawlers read most last month?"*
