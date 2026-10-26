import { Bot, Info } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { StackedBars, type StackedSeries } from "../components/Chart";
import { PeriodPicker } from "../components/Filters";
import { Badge, Card, CodeBlock, Empty, ErrorBox, Spinner, Tabs } from "../components/ui";
import { useApi } from "../lib/api";
import { canEdit, useSite } from "../lib/context";
import { money, num, timeAgo } from "../lib/format";
import { toSearch, useDashQuery } from "../lib/query";

type Category = "ai_training" | "ai_search" | "ai_user" | "search";

interface CrawlerRow {
  name: string;
  operator: string | null;
  category: Category;
  hits: number;
  pages: number;
  last_seen: number;
}

interface CrawlerResponse {
  currency: string;
  range: { from: number; to: number; interval: string };
  summary: Record<Category, number> & { hits: number; crawlers: number; pages: number; ai_visitors: number; ai_sessions: number; ai_revenue: number };
  timeseries: ({ date: string; start: number } & Record<Category, number>)[];
  crawlers: CrawlerRow[];
  pages: { path: string; hits: number; crawlers: string[] }[];
  pattern: string;
}

const CATEGORIES: (StackedSeries & { key: Category; sub: string; help: string })[] = [
  { key: "ai_training", label: "AI training", fill: "fill-violet-500", dot: "bg-violet-500", sub: "to train models", help: "Crawlers that collect pages to train AI models" },
  { key: "ai_search", label: "AI search", fill: "fill-sky-500", dot: "bg-sky-500", sub: "for AI answers", help: "Crawlers that index pages for AI search and answer engines" },
  { key: "ai_user", label: "AI assistants", fill: "fill-money-500", dot: "bg-money-500", sub: "on a person's request", help: "Fetches made because someone asked an AI assistant about the page" },
  { key: "search", label: "Search engines", fill: "fill-zinc-300 dark:fill-zinc-600", dot: "bg-zinc-300 dark:bg-zinc-600", sub: "for comparison", help: "Classic search engine crawlers" },
];
const categoryLabel = (c: Category) => CATEGORIES.find((x) => x.key === c)?.label ?? c;

function Tile({ label, value, sub, dot, tone, help }: { label: string; value: string; sub?: string; dot?: string; tone?: "money"; help?: string }) {
  return (
    <div className="card p-4" title={help}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
        {dot && <span className={`h-2 w-2 rounded-full ${dot}`} />}
        {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular ${tone === "money" ? "text-money-600 dark:text-money-400" : ""}`}>{value}</div>
      <div className="h-4 truncate text-xs text-zinc-500">{sub}</div>
    </div>
  );
}

export function CrawlersPage() {
  const { statsBase, meta, role, isPublic, canSeeRevenue } = useSite();
  const [q] = useDashQuery();
  const [category, setCategory] = useState<"all" | Category>("all");
  const report = useApi<CrawlerResponse>(`${statsBase}/crawlers?${toSearch(q, { category: category === "all" ? undefined : category })}`);
  const d = report.data;
  const s = d?.summary;
  const cur = d?.currency ?? meta?.site.currency ?? "USD";
  const editor = !isPublic && canEdit(role);
  const hideRevenue = !canSeeRevenue;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">AI crawlers</h2>
          <p className="text-xs text-zinc-500">Requests from AI and search crawlers, reported by your website's server</p>
        </div>
        <PeriodPicker range={d?.range as never} storageKey={meta?.site.id ?? "site"} />
      </div>

      {report.loading && !d ? (
        <Spinner />
      ) : report.error ? (
        <ErrorBox error={report.error} />
      ) : s && d ? (
        <>
          {!s.hits && (
            <Card className="p-6">
              <Empty title="No crawler requests in this period" icon={<Bot className="h-6 w-6" />}>
                AI crawlers don't run JavaScript, so the tracking script never sees them. Your website's server reports them instead.
                {!editor && " Ask an admin of this website to set it up."}
              </Empty>
            </Card>
          )}
          {editor && !s.hits && <CrawlerSetup pattern={d.pattern} open />}

          {!!s.hits && (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                {CATEGORIES.map((c) => (
                  <Tile key={c.key} label={c.label} value={num(s[c.key], false)} sub={c.sub} help={c.help} dot={c.dot} />
                ))}
                <Tile label="Visitors from AI" value={num(s.ai_visitors, false)} sub={`${num(s.ai_sessions, false)} visits`} help="People who came from ChatGPT, Claude, Perplexity and other AI assistants" />
                {!hideRevenue && <Tile label="Revenue from AI" value={money(s.ai_revenue, cur)} sub="from those visits" tone="money" />}
              </div>

              <Card className="p-4">
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold">Crawler requests</h3>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
                    {CATEGORIES.map((c) => (
                      <span key={c.key} className="flex items-center gap-1.5">
                        <span className={`h-2 w-2 rounded-full ${c.dot}`} />
                        {c.label}
                      </span>
                    ))}
                  </div>
                </div>
                <StackedBars points={d.timeseries} series={CATEGORIES} interval={d.range.interval === "hour" ? "day" : d.range.interval} />
              </Card>

              <div className="flex justify-end">
                <Tabs
                  tabs={[{ value: "all", label: "All" }, ...CATEGORIES.map((c) => ({ value: c.key, label: c.label }))]}
                  value={category}
                  onChange={(v) => setCategory(v as "all" | Category)}
                />
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card className="p-4">
                  <h3 className="mb-3 text-sm font-semibold">Crawlers</h3>
                  {!d.crawlers.length ? (
                    <Empty title="None in this category" />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm [&_td+td]:pl-4 [&_th+th]:pl-4">
                        <thead className="text-xs whitespace-nowrap text-zinc-500">
                          <tr>
                            <th className="pb-2 text-left font-medium">Crawler</th>
                            <th className="pb-2 text-right font-medium">Requests</th>
                            <th className="hidden pb-2 text-right font-medium sm:table-cell">Pages</th>
                            <th className="hidden pb-2 text-right font-medium sm:table-cell">Last seen</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.crawlers.map((c) => (
                            <tr key={c.name} className="border-t border-zinc-100 dark:border-zinc-800">
                              <td className="py-2">
                                <div className="font-medium">{c.name}</div>
                                <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                                  <span className={`h-1.5 w-1.5 rounded-full ${CATEGORIES.find((x) => x.key === c.category)?.dot}`} />
                                  {c.operator ? `${c.operator} · ` : ""}
                                  {categoryLabel(c.category)}
                                </div>
                              </td>
                              <td className="py-2 text-right font-medium tabular">{num(c.hits, false)}</td>
                              <td className="hidden py-2 text-right tabular sm:table-cell">{num(c.pages, false)}</td>
                              <td className="hidden py-2 text-right whitespace-nowrap text-zinc-500 sm:table-cell">{dayAgo(c.last_seen)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>

                <Card className="p-4">
                  <h3 className="mb-3 text-sm font-semibold">Most crawled pages</h3>
                  {!d.pages.length ? (
                    <Empty title="None in this category" />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full table-fixed text-sm [&_td+td]:pl-4 [&_th+th]:pl-4">
                        <thead className="text-xs whitespace-nowrap text-zinc-500">
                          <tr>
                            <th className="pb-2 text-left font-medium">Page</th>
                            <th className="w-24 pb-2 text-right font-medium">Requests</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.pages.map((p) => (
                            <tr key={p.path} className="border-t border-zinc-100 dark:border-zinc-800">
                              <td className="py-2">
                                <div className="truncate" title={p.path}>
                                  {p.path}
                                </div>
                                <div className="truncate text-xs text-zinc-500" title={p.crawlers.join(", ")}>
                                  {p.crawlers.join(", ")}
                                </div>
                              </td>
                              <td className="py-2 text-right font-medium tabular">{num(p.hits, false)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              </div>

              <p className="flex items-start gap-1.5 text-xs text-zinc-500">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Crawlers are counted by user agent, which anyone can copy, and filters don't apply to them. Visitors from AI are people who came from ChatGPT,
                  Claude, Perplexity and other assistants{isPublic ? "" : <> (the AI channel on the <Link href="/" className="font-medium text-brand-600 hover:underline">dashboard</Link>)</>}.
                </span>
              </p>
              {editor && <CrawlerSetup pattern={d.pattern} />}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

/** Crawler hits are stored per day: "today" rather than "3 hours ago". */
function dayAgo(ts: number) {
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  return days < 1 ? "today" : days < 2 ? "yesterday" : timeAgo(ts);
}

type Platform = "nextjs" | "worker" | "express" | "curl";

/** How to report crawler requests from the website's server. */
export function CrawlerSetup({ pattern, open }: { pattern: string; open?: boolean }) {
  const [platform, setPlatform] = useState<Platform>("nextjs");
  const endpoint = `${window.location.origin}/api/v1/crawls`;
  const regex = `/${pattern}/i`;
  // The fetch call, with its continuation lines indented to match where it's placed.
  const report = (path: string, indent: string) =>
    `fetch("${endpoint}", {
  method: "POST",
  headers: { Authorization: \`Bearer \${OPENREV_API_KEY}\`, "Content-Type": "application/json" },
  body: JSON.stringify({ path: ${path}, user_agent: ua }),
})`.replace(/\n/g, `\n${indent}`);

  const guides: Record<Platform, { step: string; code: string }> = {
    nextjs: {
      step: "Add a proxy.ts next to your app folder (middleware.ts with a middleware function before Next.js 16). It reports crawlers in the background.",
      code: `import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

const CRAWLERS = ${regex};
const OPENREV_API_KEY = process.env.OPENREV_API_KEY;

export function proxy(req: NextRequest, event: NextFetchEvent) {
  const ua = req.headers.get("user-agent") ?? "";
  if (OPENREV_API_KEY && CRAWLERS.test(ua)) {
    event.waitUntil(${report("req.nextUrl.pathname", "    ")}.catch(() => {}));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };`,
    },
    worker: {
      step: "In a Cloudflare Worker in front of your site (or a Pages middleware), report crawlers without delaying the response.",
      code: `const CRAWLERS = ${regex};

export default {
  async fetch(request, env, ctx) {
    const ua = request.headers.get("user-agent") || "";
    const OPENREV_API_KEY = env.OPENREV_API_KEY;
    if (OPENREV_API_KEY && CRAWLERS.test(ua)) {
      ctx.waitUntil(${report("new URL(request.url).pathname", "      ")}.catch(() => {}));
    }
    return fetch(request);
  },
};`,
    },
    express: {
      step: "Add this middleware before your routes (Node.js 18 or later has fetch built in).",
      code: `const CRAWLERS = ${regex};
const OPENREV_API_KEY = process.env.OPENREV_API_KEY;

app.use((req, res, next) => {
  const ua = req.get("user-agent") || "";
  if (OPENREV_API_KEY && CRAWLERS.test(ua)) {
    ${report("req.path", "    ")}.catch(() => {});
  }
  next();
});`,
    },
    curl: {
      step: "From access logs or any other server, send up to 1,000 requests per call. timestamp is optional (milliseconds or ISO 8601).",
      code: `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer $OPENREV_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"hits": [
    {"path": "/pricing", "user_agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", "timestamp": "2026-10-26T09:12:00Z"},
    {"path": "/blog/launch", "user_agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot@anthropic.com"}
  ]}'`,
    },
  };
  const g = guides[platform];

  return (
    <details open={open} className="card group p-4">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-semibold">
        Report crawler requests from your server
        <Badge color="brand">Setup</Badge>
      </summary>
      <div className="mt-3 space-y-3 text-sm">
        <ol className="list-decimal space-y-1 pl-5 text-zinc-600 dark:text-zinc-400">
          <li>
            Create a website API key in{" "}
            <Link href="/settings/api" className="font-medium text-brand-600 hover:underline">
              Settings → API & MCP
            </Link>{" "}
            and add it to your website's server as <code className="font-mono text-xs">OPENREV_API_KEY</code>.
          </li>
          <li>{g.step}</li>
        </ol>
        <Tabs
          tabs={[
            { value: "nextjs", label: "Next.js" },
            { value: "worker", label: "Cloudflare" },
            { value: "express", label: "Express" },
            { value: "curl", label: "API" },
          ]}
          value={platform}
          onChange={(v) => setPlatform(v as Platform)}
        />
        <CodeBlock code={g.code} />
        <p className="text-xs text-zinc-500">
          OpenRev counts only the crawlers it knows and ignores other requests, so a loose filter does no harm. The full list is in{" "}
          <a href="https://github.com/CrowdLinker/OpenRev/blob/main/docs/features/ai-crawlers.md" target="_blank" rel="noreferrer" className="font-medium text-brand-600 hover:underline">
            the docs
          </a>
          .
        </p>
      </div>
    </details>
  );
}
