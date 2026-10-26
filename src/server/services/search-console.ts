import type { Runtime } from "../context";
import type { Database, SqlValue, Statement } from "../db/types";
import { decryptString, encryptString } from "../lib/crypto";
import { accessToken, GoogleError, googleJson, parseServiceAccountKey, type ServiceAccountKey } from "../lib/google";
import { dayStart } from "./imports";
import { getSecret } from "./instance";
import { getSite, type Site } from "./sites";
import { attributionColumn, includesRevenue, type StatsQuery } from "./stats";

/**
 * Google Search Console: clicks, impressions and positions per day, query and landing page, read with a service
 * account that's a user on the property. Each query's revenue is estimated from the landing pages it brought clicks
 * to: the revenue of Google organic visits that entered on a page is shared between that page's queries by clicks.
 */

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API = "https://searchconsole.googleapis.com/webmasters/v3";
/** Search Console keeps 16 months of data. */
export const HISTORY_DAYS = 486;
const ROWS_PER_DAY = 10_000;
const RECENT_EVERY_MS = 6 * 3_600_000;
const DAY = 86_400_000;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface SearchConsoleRow {
  site_id: string;
  property: string;
  config: string;
  oldest: string | null;
  newest: string | null;
  recent_synced_at: number | null;
  last_error: string | null;
  created_at: number;
}

export class SearchConsoleError extends Error {
  constructor(
    message: string,
    readonly properties: string[] = [],
  ) {
    super(message);
  }
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => isoDay(Date.parse(date) + n * DAY);

export function publicSearchConsole(row: SearchConsoleRow | null, now = Date.now()) {
  if (!row) return null;
  const limit = addDays(isoDay(now - DAY), -HISTORY_DAYS);
  return {
    property: row.property,
    oldest: row.oldest,
    newest: row.newest,
    backfilled: !!row.oldest && row.oldest <= limit,
    last_error: row.last_error,
    created_at: Number(row.created_at),
  };
}

export async function getSearchConsole(db: Database, siteId: string): Promise<SearchConsoleRow | null> {
  return db.first<SearchConsoleRow>("SELECT * FROM search_console WHERE site_id = ?", [siteId]);
}

/** Properties the service account can read, best match for the website first. */
export async function listProperties(key: ServiceAccountKey, site: Pick<Site, "domain">, fetchFn: FetchFn = fetch): Promise<string[]> {
  const token = await accessToken(key, GSC_SCOPE, fetchFn);
  const res = await googleJson<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(`${API}/sites`, token, undefined, fetchFn);
  const urls = (res.siteEntry ?? []).filter((s) => s.permissionLevel !== "siteUnverifiedUser").map((s) => s.siteUrl);
  const domain = site.domain.replace(/^www\./, "").toLowerCase();
  const rank = (u: string) => {
    const host = u.startsWith("sc-domain:") ? u.slice(10) : (() => {
      try {
        return new URL(u).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    })();
    return host === domain ? (u.startsWith("sc-domain:") ? 0 : 1) : 2;
  };
  return urls.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Connects a website to a Search Console property. Without `property`, picks the one that matches the website's
 * domain; when none does, throws with the properties the key can read, so the user can choose.
 */
export async function connectSearchConsole(
  rt: Runtime,
  site: Site,
  input: { key: unknown; property?: unknown },
  fetchFn: FetchFn = fetch,
  now = Date.now(),
): Promise<SearchConsoleRow> {
  const key = parseServiceAccountKey(input.key);
  const properties = await listProperties(key, site, fetchFn);
  if (!properties.length) {
    throw new SearchConsoleError(
      `The service account can't see any Search Console property. In Search Console, open Settings → Users and permissions and add ${key.client_email} as a user.`,
    );
  }
  const wanted = typeof input.property === "string" && input.property ? input.property : null;
  if (wanted && !properties.includes(wanted)) throw new SearchConsoleError(`The service account can't read ${wanted}.`, properties);
  const domain = site.domain.replace(/^www\./, "");
  const property = wanted ?? properties.find((p) => p === `sc-domain:${domain}` || /^https?:\/\/(www\.)?/.test(p) && p.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") === domain);
  if (!property) throw new SearchConsoleError(`None of the service account's properties is for ${domain}. Choose one:`, properties);

  const previous = await getSearchConsole(rt.db, site.id);
  const config = await encryptString(await getSecret(rt), JSON.stringify(key));
  const statements: Statement[] = [];
  if (previous && previous.property !== property) statements.push({ sql: "DELETE FROM search_stats WHERE site_id = ?", params: [site.id] });
  const keep = previous?.property === property;
  statements.push({
    sql: `INSERT INTO search_console (site_id, property, config, oldest, newest, recent_synced_at, last_error, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
          ON CONFLICT (site_id) DO UPDATE SET property = excluded.property, config = excluded.config, oldest = excluded.oldest,
            newest = excluded.newest, recent_synced_at = excluded.recent_synced_at, last_error = NULL`,
    params: [site.id, property, config, keep ? previous!.oldest : null, keep ? previous!.newest : null, keep ? previous!.recent_synced_at : null, now],
  });
  await rt.db.batch(statements);
  return (await getSearchConsole(rt.db, site.id))!;
}

export function disconnectStatements(siteId: string): Statement[] {
  return [
    { sql: "DELETE FROM search_stats WHERE site_id = ?", params: [siteId] },
    { sql: "DELETE FROM search_console WHERE site_id = ?", params: [siteId] },
  ];
}

/**
 * Deletes the synced days and starts the history again, keeping the connection. Days are stored at their start in the
 * website's timezone, so a new timezone needs new rows: the old ones wouldn't be replaced and would count twice.
 */
export function resyncStatements(siteId: string): Statement[] {
  return [
    { sql: "DELETE FROM search_stats WHERE site_id = ?", params: [siteId] },
    { sql: "UPDATE search_console SET oldest = NULL, newest = NULL, recent_synced_at = NULL WHERE site_id = ?", params: [siteId] },
  ];
}

/** The landing page as OpenRev stores entry pages: the path, decoded, without a trailing slash. */
export function pagePath(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname || "/";
  } catch {
    return "/";
  }
  try {
    path = decodeURI(path);
  } catch {
    /* keep encoded */
  }
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path.slice(0, 500);
}

interface QueryRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  position?: number;
}

async function fetchDay(key: ServiceAccountKey, property: string, date: string, fetchFn: FetchFn): Promise<QueryRow[]> {
  const token = await accessToken(key, GSC_SCOPE, fetchFn);
  const res = await googleJson<{ rows?: QueryRow[] }>(
    `${API}/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
    token,
    { startDate: date, endDate: date, dimensions: ["query", "page"], type: "web", dataState: "all", rowLimit: ROWS_PER_DAY },
    fetchFn,
  );
  return res.rows ?? [];
}

const ROWS_PER_INSERT = 14; // 7 parameters each: D1 allows 100 per statement

/** Replaces one day's rows. Pages that differ only by protocol or query string are added together. */
function dayStatements(site: Site, date: string, rows: QueryRow[]): Statement[] {
  const ts = dayStart(site, date);
  const merged = new Map<string, { query: string; page: string; clicks: number; impressions: number; position: number }>();
  for (const r of rows) {
    const [query = "", url = ""] = r.keys ?? [];
    if (!query) continue;
    const page = pagePath(url);
    const k = `${query}\u0000${page}`;
    const m = merged.get(k) ?? { query: query.slice(0, 300), page, clicks: 0, impressions: 0, position: 0 };
    m.clicks += Math.max(0, Math.round(r.clicks ?? 0));
    m.impressions += Math.max(0, Math.round(r.impressions ?? 0));
    m.position += (r.position ?? 0) * Math.max(0, r.impressions ?? 0);
    merged.set(k, m);
  }
  const cells = [...merged.values()];
  const out: Statement[] = [{ sql: "DELETE FROM search_stats WHERE site_id = ? AND ts = ?", params: [site.id, ts] }];
  for (let i = 0; i < cells.length; i += ROWS_PER_INSERT) {
    const part = cells.slice(i, i + ROWS_PER_INSERT);
    const params: SqlValue[] = [];
    for (const c of part) params.push(site.id, ts, c.query, c.page, c.clicks, c.impressions, c.position);
    out.push({
      sql: `INSERT INTO search_stats (site_id, ts, query, page, clicks, impressions, position) VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
      params,
    });
  }
  return out;
}

export interface SyncResult {
  oldest: string | null;
  newest: string | null;
  backfilled: boolean;
  days: number;
  /** The round stopped because the statement budget ran out. */
  stopped: boolean;
}

/**
 * Statements a sync may still write. The first day written against a budget is written even when it's larger, so a
 * day bigger than the budget can't hold up the sync forever. The scheduler shares one budget between all websites.
 */
export interface SyncBudget {
  left: number;
  wrote: boolean;
}

/** Statements one scheduled run spends on Search Console: a Worker invocation may run 1,000 queries, and the other jobs need some. */
const RUN_BUDGET = 600;
/** What visiting a website costs a scheduled run besides the days it writes: reading the site, saving its progress. */
const VISIT_COST = 2;

/**
 * One bounded round of syncing: first the recent days (every 6 hours, since Search Console revises the last few
 * days), otherwise the next older days back to 16 months. Small enough for a Worker invocation's query limit.
 */
export async function syncSearchConsole(
  rt: Runtime,
  site: Site,
  row: SearchConsoleRow,
  opts: { now?: number; fetchFn?: FetchFn; maxDays?: number; maxStatements?: number; budget?: SyncBudget } = {},
): Promise<SyncResult> {
  const now = opts.now ?? Date.now();
  const fetchFn = opts.fetchFn ?? fetch;
  const maxDays = opts.maxDays ?? 6;
  const budget = opts.budget ?? { left: opts.maxStatements ?? 600, wrote: false };
  const yesterday = isoDay(now - DAY);
  const limit = addDays(yesterday, -HISTORY_DAYS);
  let key: ServiceAccountKey;
  try {
    key = JSON.parse(await decryptString(await getSecret(rt), row.config));
  } catch {
    throw new SearchConsoleError("The saved key can't be read (OPENREV_SECRET changed). Connect Search Console again.");
  }

  let { oldest, newest } = row;
  let recentSyncedAt = row.recent_synced_at;
  const recentDue = !newest || !recentSyncedAt || now - Number(recentSyncedAt) > RECENT_EVERY_MS;
  // Recent days, oldest first so `newest` only moves forward over days that are stored.
  const recentFrom = newest ? (addDays(newest, -2) > addDays(yesterday, -29) ? addDays(newest, -2) : addDays(yesterday, -29)) : addDays(yesterday, -2);
  const days: { date: string; recent: boolean }[] = [];
  if (recentDue) for (let d = recentFrom; d <= yesterday && days.length < maxDays; d = addDays(d, 1)) days.push({ date: d, recent: true });
  else for (let d = oldest ? addDays(oldest, -1) : addDays(yesterday, -3); d >= limit && days.length < maxDays; d = addDays(d, -1)) days.push({ date: d, recent: false });

  let done = 0;
  let stopped = false;
  try {
    for (const { date, recent } of days) {
      if (budget.wrote && budget.left <= 0) {
        stopped = true;
        break;
      }
      const stmts = dayStatements(site, date, await fetchDay(key, row.property, date, fetchFn));
      if (budget.wrote && stmts.length > budget.left) {
        stopped = true;
        break;
      }
      await rt.db.batch(stmts);
      budget.left -= stmts.length;
      budget.wrote = true;
      done++;
      if (recent) {
        if (!newest || date > newest) newest = date;
        if (!oldest || date < oldest) oldest = date;
        if (date === yesterday) recentSyncedAt = now;
      } else oldest = date;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await rt.db.run("UPDATE search_console SET oldest = ?, newest = ?, recent_synced_at = ?, last_error = ? WHERE site_id = ?", [
      oldest,
      newest,
      recentSyncedAt,
      message.slice(0, 500),
      site.id,
    ]);
    throw err;
  }
  await rt.db.run("UPDATE search_console SET oldest = ?, newest = ?, recent_synced_at = ?, last_error = NULL WHERE site_id = ?", [oldest, newest, recentSyncedAt, site.id]);
  return { oldest, newest, backfilled: !!oldest && oldest <= limit && !!recentSyncedAt && now - Number(recentSyncedAt) <= RECENT_EVERY_MS, days: done, stopped };
}

/**
 * Called by the scheduler: a round for each connected website, within one statement budget for the whole run. Each run
 * starts from a different website, so on an instance with many of them none waits behind the others.
 */
export async function syncAllSearchConsole(rt: Runtime, now = Date.now(), budget: SyncBudget = { left: RUN_BUDGET, wrote: false }) {
  const rows = await rt.db.all<SearchConsoleRow>("SELECT * FROM search_console ORDER BY site_id");
  const start = rows.length ? Math.floor(now / 600_000) % rows.length : 0;
  for (let i = 0; i < rows.length && budget.left > 0; i++) {
    const row = rows[(start + i) % rows.length];
    budget.left -= VISIT_COST;
    const site = await getSite(rt.db, row.site_id);
    if (!site) continue;
    try {
      if ((await syncSearchConsole(rt, site, row, { now, maxDays: 4, budget })).stopped) break;
    } catch (err) {
      if (!(err instanceof GoogleError || err instanceof SearchConsoleError)) console.error(`[openrev] Search Console sync for ${site.id} failed:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Keywords report
// ---------------------------------------------------------------------------

export interface KeywordRow {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  /** Estimated: see the module comment. */
  revenue: number;
  /** The landing page that got the most clicks from this query. */
  page: string;
}

/** Keywords with their estimated revenue. Without revenue (`q.revenue` false) payments aren't read or sorted on. */
export async function searchKeywords(db: Database, q: StatsQuery, opts: { limit?: number; sort?: "clicks" | "revenue" | "impressions" } = {}) {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 10) || 10, 1), 1000);
  const attr = attributionColumn(q.site, q.attribution);
  const withRevenue = includesRevenue(q);
  const [pairs, pages] = await Promise.all([
    db.all<{ query: string; page: string; clicks: number; impressions: number; position: number }>(
      `SELECT query, page, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position) AS position
       FROM search_stats WHERE site_id = ? AND ts >= ? AND ts < ? GROUP BY query, page`,
      [q.site.id, q.range.from, q.range.to],
    ),
    withRevenue
      ? db.all<{ page: string; revenue: number }>(
          `SELECT COALESCE(s.entry_page, '/') AS page, SUM(p.revenue) AS revenue
           FROM payments p JOIN sessions s ON s.id = p.${attr}
           WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ? AND s.channel = 'Organic Search' AND s.source = 'Google'
           GROUP BY COALESCE(s.entry_page, '/')`,
          [q.site.id, q.range.from, q.range.to],
        )
      : Promise.resolve([] as { page: string; revenue: number }[]),
  ]);
  const pageRevenue = new Map(pages.map((p) => [p.page, Number(p.revenue) || 0]));
  const pageClicks = new Map<string, number>();
  for (const r of pairs) pageClicks.set(r.page, (pageClicks.get(r.page) ?? 0) + Number(r.clicks));

  const byQuery = new Map<string, KeywordRow & { position_sum: number; top: number }>();
  let clicks = 0;
  let impressions = 0;
  let attributed = 0;
  for (const r of pairs) {
    const c = Number(r.clicks) || 0;
    const i = Number(r.impressions) || 0;
    const row = byQuery.get(r.query) ?? { query: r.query, clicks: 0, impressions: 0, ctr: 0, position: 0, revenue: 0, page: r.page, position_sum: 0, top: -1 };
    row.clicks += c;
    row.impressions += i;
    row.position_sum += Number(r.position) || 0;
    const total = pageClicks.get(r.page) ?? 0;
    const share = total ? ((pageRevenue.get(r.page) ?? 0) * c) / total : 0;
    row.revenue += share;
    attributed += share;
    if (c > row.top) {
      row.top = c;
      row.page = r.page;
    }
    byQuery.set(r.query, row);
    clicks += c;
    impressions += i;
  }
  const sort = opts.sort === "revenue" && !withRevenue ? "clicks" : (opts.sort ?? "clicks");
  const rows: KeywordRow[] = [...byQuery.values()]
    .map(({ position_sum, top: _top, ...r }) => ({
      ...r,
      revenue: Math.round(r.revenue),
      ctr: r.impressions ? r.clicks / r.impressions : 0,
      position: r.impressions ? position_sum / r.impressions : 0,
    }))
    .sort((a, b) => b[sort] - a[sort] || b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, limit);
  const organicRevenue = [...pageRevenue.values()].reduce((a, b) => a + b, 0);
  return { rows, totals: { clicks, impressions, revenue: Math.round(attributed), organic_revenue: organicRevenue } };
}
