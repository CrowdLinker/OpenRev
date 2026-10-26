import type { Database, SqlValue, Statement } from "../db/types";
import { CRAWLER_CATEGORIES, CRAWLER_PATTERN, crawlerByName, matchCrawler, type CrawlerCategory } from "../lib/crawlers";
import { planBuckets, startOfLocalDay, type Interval } from "../lib/time";
import type { Site } from "./sites";
import { attributionColumn, type StatsQuery } from "./stats";

/** A request the website's server saw, as reported to POST /api/v1/crawls. */
export interface CrawlHit {
  path: string;
  userAgent: string;
  /** Epoch milliseconds; defaults to now. */
  timestamp?: number | null;
}

/** The path as OpenRev stores pages: no query string or fragment, decoded, without a trailing slash. */
export function crawlPath(input: string): string {
  let path = input.trim();
  try {
    path = /^https?:\/\//i.test(path) ? new URL(path).pathname : new URL(path, "https://x.invalid").pathname;
  } catch {
    path = "/";
  }
  try {
    path = decodeURI(path);
  } catch {
    /* keep encoded */
  }
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path.slice(0, 500) || "/";
}

const ROWS_PER_INSERT = 18; // 5 parameters each: D1 allows 100 per statement
const MAX_FUTURE_MS = 5 * 60_000;

/** Counts the hits from known crawlers, per day, crawler and path. Others are ignored. */
export async function recordCrawls(db: Database, site: Site, hits: CrawlHit[], now = Date.now()) {
  const counts = new Map<string, { ts: number; bot: string; path: string; hits: number }>();
  let ignored = 0;
  for (const h of hits) {
    const crawler = matchCrawler(h.userAgent);
    if (!crawler) {
      ignored++;
      continue;
    }
    const at = h.timestamp && Number.isFinite(h.timestamp) && h.timestamp <= now + MAX_FUTURE_MS ? h.timestamp : now;
    const ts = startOfLocalDay(site.timezone, at);
    const path = crawlPath(h.path);
    const key = `${ts}\u0000${crawler.name}\u0000${path}`;
    const c = counts.get(key) ?? { ts, bot: crawler.name, path, hits: 0 };
    c.hits++;
    counts.set(key, c);
  }
  const rows = [...counts.values()];
  const statements: Statement[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const part = rows.slice(i, i + ROWS_PER_INSERT);
    const params: SqlValue[] = [];
    for (const r of part) params.push(site.id, r.ts, r.bot, r.path, r.hits);
    statements.push({
      sql: `INSERT INTO crawler_stats (site_id, ts, bot, path, hits) VALUES ${part.map(() => "(?, ?, ?, ?, ?)").join(", ")}
            ON CONFLICT (site_id, ts, bot, path) DO UPDATE SET hits = crawler_stats.hits + excluded.hits`,
      params,
    });
  }
  if (statements.length) await db.batch(statements);
  return { recorded: hits.length - ignored, ignored };
}

type ByCategory = Record<CrawlerCategory, number>;
const emptyCategories = (): ByCategory => ({ ai_training: 0, ai_search: 0, ai_user: 0, search: 0 });
const categoryOf = (bot: string): CrawlerCategory => crawlerByName(bot)?.category ?? "ai_training";

/**
 * Crawler hits in the range: totals per category, over time, per crawler and per page, next to the visits and revenue
 * that AI assistants sent (the AI channel). Filters don't apply: crawler hits have no visitor attributes.
 */
export async function crawlerReport(db: Database, q: StatsQuery, opts: { interval?: Interval; category?: string | null } = {}) {
  const plan = planBuckets(q.site.timezone, q.range.from, q.range.to, opts.interval ?? (q.range.interval === "hour" ? "day" : q.range.interval));
  const base = [q.site.id, q.range.from, q.range.to];
  const category = (CRAWLER_CATEGORIES as readonly string[]).includes(opts.category ?? "") ? (opts.category as CrawlerCategory) : null;
  const attr = attributionColumn(q.site, q.attribution);
  const [series, bots, pageRows, ai] = await Promise.all([
    db.all<{ b: number; bot: string; hits: number }>(
      `SELECT ${plan.sql("ts")} AS b, bot, SUM(hits) AS hits FROM crawler_stats WHERE site_id = ? AND ts >= ? AND ts < ? GROUP BY b, bot`,
      base,
    ),
    db.all<{ bot: string; hits: number; pages: number; last_seen: number }>(
      `SELECT bot, SUM(hits) AS hits, COUNT(DISTINCT path) AS pages, MAX(ts) AS last_seen FROM crawler_stats
       WHERE site_id = ? AND ts >= ? AND ts < ? GROUP BY bot ORDER BY hits DESC`,
      base,
    ),
    db.all<{ path: string; bot: string; hits: number }>(
      `SELECT path, bot, SUM(hits) AS hits FROM crawler_stats WHERE site_id = ? AND ts >= ? AND ts < ? GROUP BY path, bot`,
      base,
    ),
    db.first<{ visitors: number; sessions: number; revenue: number }>(
      `SELECT COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(DISTINCT s.id) AS sessions,
              (SELECT SUM(p.revenue) FROM payments p JOIN sessions ps ON ps.id = p.${attr}
               WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ? AND ps.channel = 'AI') AS revenue
       FROM sessions s WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ? AND s.channel = 'AI'`,
      [...base, ...base],
    ),
  ]);

  const totals = emptyCategories();
  for (const b of bots) totals[categoryOf(b.bot)] += Number(b.hits);
  const byBucket = new Map<number, ByCategory>();
  for (const r of series) {
    const m = byBucket.get(Number(r.b)) ?? emptyCategories();
    m[categoryOf(r.bot)] += Number(r.hits);
    byBucket.set(Number(r.b), m);
  }
  const pages = new Map<string, { path: string; hits: number; bots: Set<string> }>();
  for (const r of pageRows) {
    if (category && categoryOf(r.bot) !== category) continue;
    const p = pages.get(r.path) ?? { path: r.path, hits: 0, bots: new Set<string>() };
    p.hits += Number(r.hits);
    p.bots.add(r.bot);
    pages.set(r.path, p);
  }

  return {
    summary: {
      hits: Object.values(totals).reduce((a, b) => a + b, 0),
      ...totals,
      crawlers: bots.length,
      pages: new Set(pageRows.map((r) => r.path)).size,
      ai_visitors: Number(ai?.visitors) || 0,
      ai_sessions: Number(ai?.sessions) || 0,
      ai_revenue: Number(ai?.revenue) || 0,
    },
    timeseries: plan.buckets.map((b) => ({ date: b.label, start: b.start, ...(byBucket.get(b.key) ?? emptyCategories()) })),
    crawlers: bots
      .map((b) => {
        const c = crawlerByName(b.bot);
        return { name: b.bot, operator: c?.operator ?? null, category: categoryOf(b.bot), hits: Number(b.hits), pages: Number(b.pages), last_seen: Number(b.last_seen) };
      })
      .filter((b) => !category || b.category === category),
    pages: [...pages.values()]
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 50)
      .map((p) => ({ path: p.path, hits: p.hits, crawlers: [...p.bots].sort() })),
    pattern: CRAWLER_PATTERN,
  };
}
