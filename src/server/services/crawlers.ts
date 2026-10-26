import type { Database, SqlValue, Statement } from "../db/types";
import { CRAWLER_CATEGORIES, CRAWLER_PATTERN, CRAWLERS, crawlerByName, matchCrawler, type CrawlerCategory } from "../lib/crawlers";
import { localParts, planBuckets, startOfLocalDay, zonedTime, type Interval } from "../lib/time";
import type { Site } from "./sites";
import { attributionColumn, includesRevenue, type StatsQuery } from "./stats";

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
 *
 * Hits are stored per day at midnight in the website's timezone (`opts.timezone`, which the query may override). So
 * the hits cover every website day the range overlaps: "Last 24 hours" reads yesterday and today. The AI visits and
 * revenue use the exact range, like the rest of the dashboard.
 */
export async function crawlerReport(db: Database, q: StatsQuery, opts: { timezone: string; interval?: Interval; category?: string | null }) {
  const tz = opts.timezone;
  const from = startOfLocalDay(tz, q.range.from);
  const last = localParts(tz, q.range.to - 1);
  const to = zonedTime(tz, last.year, last.month, last.day + 1);
  const plan = planBuckets(tz, from, to, opts.interval ?? (q.range.interval === "hour" ? "day" : q.range.interval));
  const base = [q.site.id, from, to];
  const exact = [q.site.id, q.range.from, q.range.to];
  const category = (CRAWLER_CATEGORIES as readonly string[]).includes(opts.category ?? "") ? (opts.category as CrawlerCategory) : null;
  const attr = attributionColumn(q.site, q.attribution);
  // Viewers who can't see revenue (`q.revenue` false) get the AI visits without what they paid.
  const withRevenue = includesRevenue(q);
  const aiRevenue = withRevenue
    ? `(SELECT SUM(p.revenue) FROM payments p JOIN sessions ps ON ps.id = p.${attr} WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ? AND ps.channel = 'AI')`
    : "0";
  // Pages are added up in SQL: a large website can have tens of thousands of crawled paths in a range.
  const names = category ? CRAWLERS.filter((c) => c.category === category).map((c) => c.name) : [];
  const botFilter = category ? ` AND bot IN (${names.map(() => "?").join(", ")})` : "";
  const [series, bots, topPages, pageCount, ai] = await Promise.all([
    db.all<{ b: number; bot: string; hits: number }>(
      `SELECT ${plan.sql("ts")} AS b, bot, SUM(hits) AS hits FROM crawler_stats WHERE site_id = ? AND ts >= ? AND ts < ? GROUP BY b, bot`,
      base,
    ),
    db.all<{ bot: string; hits: number; pages: number; last_seen: number }>(
      `SELECT bot, SUM(hits) AS hits, COUNT(DISTINCT path) AS pages, MAX(ts) AS last_seen FROM crawler_stats
       WHERE site_id = ? AND ts >= ? AND ts < ? GROUP BY bot ORDER BY hits DESC`,
      base,
    ),
    db.all<{ path: string; hits: number }>(
      `SELECT path, SUM(hits) AS hits FROM crawler_stats WHERE site_id = ? AND ts >= ? AND ts < ?${botFilter}
       GROUP BY path ORDER BY hits DESC, path LIMIT 50`,
      [...base, ...names],
    ),
    db.first<{ n: number }>("SELECT COUNT(DISTINCT path) AS n FROM crawler_stats WHERE site_id = ? AND ts >= ? AND ts < ?", base),
    db.first<{ visitors: number; sessions: number; revenue: number }>(
      `SELECT COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(DISTINCT s.id) AS sessions, ${aiRevenue} AS revenue
       FROM sessions s WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ? AND s.channel = 'AI'`,
      withRevenue ? [...exact, ...exact] : exact,
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
  // The crawlers of the top pages only: 3 + 50 + at most a category's names parameters, under D1's 100.
  const pageBots = topPages.length
    ? await db.all<{ path: string; bot: string }>(
        `SELECT DISTINCT path, bot FROM crawler_stats WHERE site_id = ? AND ts >= ? AND ts < ?${botFilter} AND path IN (${topPages.map(() => "?").join(", ")})`,
        [...base, ...names, ...topPages.map((p) => p.path)],
      )
    : [];
  const botsOf = new Map<string, string[]>();
  for (const r of pageBots) botsOf.set(r.path, [...(botsOf.get(r.path) ?? []), r.bot]);

  return {
    summary: {
      hits: Object.values(totals).reduce((a, b) => a + b, 0),
      ...totals,
      crawlers: bots.length,
      pages: Number(pageCount?.n) || 0,
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
    pages: topPages.map((p) => ({ path: p.path, hits: Number(p.hits), crawlers: (botsOf.get(p.path) ?? []).sort() })),
    pattern: CRAWLER_PATTERN,
  };
}
