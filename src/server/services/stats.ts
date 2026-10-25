import type { Database, SqlValue } from "../db/types";
import { planBuckets, type Interval, type ResolvedRange } from "../lib/time";
import type { AttributionModel, Site } from "./sites";

// ---------------------------------------------------------------------------
// Dimensions & filters
// ---------------------------------------------------------------------------

export const SESSION_DIMENSIONS = {
  channel: "channel",
  source: "source",
  referrer: "referrer_domain",
  utm_source: "utm_source",
  utm_medium: "utm_medium",
  utm_campaign: "utm_campaign",
  utm_term: "utm_term",
  utm_content: "utm_content",
  ref: "ref",
  entry_page: "entry_page",
  exit_page: "exit_page",
  hostname: "hostname",
  country: "country",
  region: "region",
  city: "city",
  device: "device",
  browser: "browser",
  os: "os",
} as const;

export type SessionDimension = keyof typeof SESSION_DIMENSIONS;
export const EVENT_DIMENSIONS = ["page", "goal", "outbound"] as const;
export type EventDimension = (typeof EVENT_DIMENSIONS)[number];
export type Dimension = SessionDimension | EventDimension;

export const ALL_DIMENSIONS: Dimension[] = [...(Object.keys(SESSION_DIMENSIONS) as SessionDimension[]), ...EVENT_DIMENSIONS];

export type FilterOp = "is" | "is_not" | "contains" | "not_contains";

export interface Filter {
  dim: Dimension;
  op: FilterOp;
  values: string[];
}

export function isDimension(d: string): d is Dimension {
  return (ALL_DIMENSIONS as string[]).includes(d);
}

/** Parses filters from `filters=[{"dim":"country","op":"is","values":["US"]}]` or `filter_country=US` params. */
export function parseFilters(query: Record<string, string | undefined>): Filter[] {
  const out: Filter[] = [];
  if (query.filters) {
    try {
      const arr = JSON.parse(query.filters);
      if (Array.isArray(arr)) {
        for (const f of arr) {
          if (!f || typeof f.dim !== "string" || !isDimension(f.dim)) continue;
          const op: FilterOp = ["is", "is_not", "contains", "not_contains"].includes(f.op) ? f.op : "is";
          const values = (Array.isArray(f.values) ? f.values : [f.value]).filter((v: unknown) => v !== undefined && v !== null).map(String);
          if (values.length) out.push({ dim: f.dim, op, values: values.slice(0, 20) });
        }
      }
    } catch {
      /* ignore malformed */
    }
  }
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith("filter_") || value === undefined) continue;
    let dim = key.slice(7);
    if (dim === "goal" || dim === "page") {
      /* event dims */
    }
    if (!isDimension(dim)) continue;
    let op: FilterOp = "is";
    let v = value;
    const m = value.match(/^(is|is_not|contains|not_contains|does_not_contain):(.*)$/);
    if (m) {
      op = m[1] === "does_not_contain" ? "not_contains" : (m[1] as FilterOp);
      v = m[2];
    }
    out.push({ dim, op, values: v.split("|").slice(0, 20) });
  }
  return out;
}

interface SqlPart {
  sql: string;
  params: SqlValue[];
}

function valueCondition(column: string, f: Filter): SqlPart {
  const col = `COALESCE(${column}, '')`;
  if (f.op === "contains" || f.op === "not_contains") {
    const parts = f.values.map(() => `LOWER(${col}) LIKE ?`);
    const params = f.values.map((v) => `%${v.toLowerCase().replace(/[%_]/g, "")}%`);
    const sql = `(${parts.join(" OR ")})`;
    return { sql: f.op === "contains" ? sql : `NOT ${sql}`, params };
  }
  const placeholders = f.values.map(() => "?").join(", ");
  return { sql: `${col} ${f.op === "is" ? "IN" : "NOT IN"} (${placeholders})`, params: f.values };
}

/** WHERE fragment applying filters to a sessions alias. */
export function sessionFilterSql(filters: Filter[], alias = "s"): SqlPart {
  const parts: string[] = [];
  const params: SqlValue[] = [];
  for (const f of filters) {
    if (f.dim in SESSION_DIMENSIONS) {
      const c = valueCondition(`${alias}.${SESSION_DIMENSIONS[f.dim as SessionDimension]}`, f);
      parts.push(c.sql);
      params.push(...c.params);
    } else {
      const type = f.dim === "page" ? "pageview" : f.dim === "goal" ? "goal" : "outbound";
      const column = f.dim === "page" ? "fe.path" : "fe.name";
      const positive: Filter = { ...f, op: f.op === "is_not" ? "is" : f.op === "not_contains" ? "contains" : f.op };
      const c = valueCondition(column, positive);
      const negate = f.op === "is_not" || f.op === "not_contains";
      parts.push(`${negate ? "NOT " : ""}EXISTS (SELECT 1 FROM events fe WHERE fe.session_id = ${alias}.id AND fe.type = '${type}' AND ${c.sql})`);
      params.push(...c.params);
    }
  }
  return { sql: parts.length ? " AND " + parts.join(" AND ") : "", params };
}

export function attributionColumn(site: Site, override?: string | null): string {
  const model = (override ?? site.settings.attribution ?? "last_non_direct") as AttributionModel;
  if (model === "first_touch") return "first_session_id";
  if (model === "last_touch") return "last_session_id";
  return "touch_session_id";
}

const BOUNCE = "CASE WHEN s.pageviews <= 1 AND s.goals = 0 THEN 1 ELSE 0 END";
const PAYING = "CASE WHEN p.type <> 'refund' AND p.visitor_id IS NOT NULL THEN p.visitor_id END";

export interface StatsQuery {
  site: Site;
  range: ResolvedRange;
  filters: Filter[];
  attribution?: string | null;
}

function n(v: unknown): number {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface OverviewMetrics {
  visitors: number;
  new_visitors: number;
  returning_visitors: number;
  sessions: number;
  pageviews: number;
  bounce_rate: number;
  avg_session_duration: number;
  revenue: number;
  refunds: number;
  new_revenue: number;
  renewal_revenue: number;
  payments: number;
  customers: number;
  conversion_rate: number;
  revenue_per_visitor: number;
  kpi?: { goal: string; conversions: number; visitors: number; conversion_rate: number } | null;
}

async function overviewFor(db: Database, q: StatsQuery, from: number, to: number): Promise<OverviewMetrics> {
  const f = sessionFilterSql(q.filters);
  const hasFilters = q.filters.length > 0;
  const attr = attributionColumn(q.site, q.attribution);
  const [s, p] = await Promise.all([
    db.first<Record<string, number>>(
      `SELECT COUNT(DISTINCT s.visitor_id) AS visitors,
              COUNT(DISTINCT CASE WHEN s.is_new = 1 THEN s.visitor_id END) AS new_visitors,
              COUNT(*) AS sessions,
              SUM(s.pageviews) AS pageviews,
              SUM(${BOUNCE}) AS bounces,
              SUM(s.duration) AS duration
       FROM sessions s
       WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ?${f.sql}`,
      [q.site.id, from, to, ...f.params],
    ),
    db.first<Record<string, number>>(
      `SELECT SUM(p.revenue) AS revenue,
              SUM(CASE WHEN p.type = 'refund' THEN -p.revenue ELSE 0 END) AS refunds,
              SUM(CASE WHEN p.type = 'new' THEN p.revenue ELSE 0 END) AS new_revenue,
              SUM(CASE WHEN p.type = 'renewal' THEN p.revenue ELSE 0 END) AS renewal_revenue,
              SUM(CASE WHEN p.type <> 'refund' THEN 1 ELSE 0 END) AS payments,
              COUNT(DISTINCT ${PAYING}) AS paying_visitors,
              COUNT(DISTINCT CASE WHEN p.type <> 'refund' THEN COALESCE(p.visitor_id, p.customer_id, p.email, p.id) END) AS customers
       FROM payments p ${hasFilters ? `JOIN sessions s ON s.id = p.${attr}` : ""}
       WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?${f.sql}`,
      [q.site.id, from, to, ...f.params],
    ),
  ]);

  const visitors = n(s?.visitors);
  const sessions = n(s?.sessions);
  const revenue = n(p?.revenue);
  let kpi: OverviewMetrics["kpi"] = null;
  if (q.site.settings.kpiGoal) {
    const k = await db.first<{ conversions: number; visitors: number }>(
      `SELECT COUNT(*) AS conversions, COUNT(DISTINCT e.visitor_id) AS visitors
       FROM events e JOIN sessions s ON s.id = e.session_id
       WHERE e.site_id = ? AND e.type = 'goal' AND e.name = ? AND e.ts >= ? AND e.ts < ?${f.sql}`,
      [q.site.id, q.site.settings.kpiGoal, from, to, ...f.params],
    );
    kpi = {
      goal: q.site.settings.kpiGoal,
      conversions: n(k?.conversions),
      visitors: n(k?.visitors),
      conversion_rate: visitors ? n(k?.visitors) / visitors : 0,
    };
  }
  return {
    visitors,
    new_visitors: n(s?.new_visitors),
    returning_visitors: Math.max(0, visitors - n(s?.new_visitors)),
    sessions,
    pageviews: n(s?.pageviews),
    bounce_rate: sessions ? n(s?.bounces) / sessions : 0,
    avg_session_duration: sessions ? n(s?.duration) / sessions / 1000 : 0,
    revenue,
    refunds: n(p?.refunds),
    new_revenue: n(p?.new_revenue),
    renewal_revenue: n(p?.renewal_revenue),
    payments: n(p?.payments),
    customers: n(p?.customers),
    conversion_rate: visitors ? Math.min(1, n(p?.paying_visitors) / visitors) : 0,
    revenue_per_visitor: visitors ? revenue / visitors : 0,
    kpi,
  };
}

export async function overview(db: Database, q: StatsQuery, compare = true) {
  const [current, previous] = await Promise.all([
    overviewFor(db, q, q.range.from, q.range.to),
    compare ? overviewFor(db, q, q.range.previous.from, q.range.previous.to) : Promise.resolve(null),
  ]);
  return { current, previous };
}

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

export interface TimeseriesPoint {
  date: string;
  start: number;
  visitors: number;
  sessions: number;
  pageviews: number;
  bounce_rate: number;
  avg_session_duration: number;
  revenue: number;
  payments: number;
  customers: number;
  conversions?: number;
}

export async function timeseries(db: Database, q: StatsQuery, interval?: Interval): Promise<TimeseriesPoint[]> {
  const plan = planBuckets(q.site.timezone, q.range.from, q.range.to, interval ?? q.range.interval);
  const f = sessionFilterSql(q.filters);
  const attr = attributionColumn(q.site, q.attribution);
  const hasFilters = q.filters.length > 0;

  const [sessions, payments, goals] = await Promise.all([
    db.all<Record<string, number>>(
      `SELECT ${plan.sql("s.started_at")} AS b,
              COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, SUM(s.pageviews) AS pageviews,
              SUM(${BOUNCE}) AS bounces, SUM(s.duration) AS duration
       FROM sessions s
       WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ?${f.sql}
       GROUP BY b`,
      [q.site.id, q.range.from, q.range.to, ...f.params],
    ),
    db.all<Record<string, number>>(
      `SELECT ${plan.sql("p.ts")} AS b, SUM(p.revenue) AS revenue,
              SUM(CASE WHEN p.type <> 'refund' THEN 1 ELSE 0 END) AS payments,
              COUNT(DISTINCT ${PAYING}) AS customers
       FROM payments p ${hasFilters ? `JOIN sessions s ON s.id = p.${attr}` : ""}
       WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?${f.sql}
       GROUP BY b`,
      [q.site.id, q.range.from, q.range.to, ...f.params],
    ),
    q.site.settings.kpiGoal
      ? db.all<Record<string, number>>(
          `SELECT ${plan.sql("e.ts")} AS b, COUNT(DISTINCT e.visitor_id) AS conversions
           FROM events e JOIN sessions s ON s.id = e.session_id
           WHERE e.site_id = ? AND e.type = 'goal' AND e.name = ? AND e.ts >= ? AND e.ts < ?${f.sql}
           GROUP BY b`,
          [q.site.id, q.site.settings.kpiGoal, q.range.from, q.range.to, ...f.params],
        )
      : Promise.resolve([]),
  ]);

  const sMap = new Map(sessions.map((r) => [n(r.b), r]));
  const pMap = new Map(payments.map((r) => [n(r.b), r]));
  const gMap = new Map(goals.map((r) => [n(r.b), r]));
  return plan.buckets.map((bucket) => {
    const s = sMap.get(bucket.key);
    const p = pMap.get(bucket.key);
    const g = gMap.get(bucket.key);
    const sess = n(s?.sessions);
    return {
      date: bucket.label,
      start: bucket.start,
      visitors: n(s?.visitors),
      sessions: sess,
      pageviews: n(s?.pageviews),
      bounce_rate: sess ? n(s?.bounces) / sess : 0,
      avg_session_duration: sess ? n(s?.duration) / sess / 1000 : 0,
      revenue: n(p?.revenue),
      payments: n(p?.payments),
      customers: n(p?.customers),
      ...(q.site.settings.kpiGoal ? { conversions: n(g?.conversions) } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Breakdowns
// ---------------------------------------------------------------------------

export interface BreakdownRow {
  value: string;
  /** Secondary information: favicon domain for sources, country code for regions/cities. */
  meta?: string | null;
  visitors: number;
  sessions?: number;
  pageviews?: number;
  bounce_rate?: number;
  avg_session_duration?: number;
  completions?: number;
  revenue: number;
  payments: number;
  customers: number;
  conversion_rate: number;
  revenue_per_visitor: number;
}

export const UNATTRIBUTED = "__unattributed__";

export async function breakdown(
  db: Database,
  q: StatsQuery,
  dim: Dimension,
  opts: { limit?: number; sort?: "visitors" | "revenue" | "conversion_rate" | "completions" } = {},
): Promise<BreakdownRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 1000);
  const f = sessionFilterSql(q.filters);
  const attr = attributionColumn(q.site, q.attribution);
  const base = [q.site.id, q.range.from, q.range.to];
  const rows = new Map<string, BreakdownRow>();
  const key = (value: string, meta?: string | null) => `${meta ?? ""}\u0000${value}`;
  const get = (value: string, meta?: string | null) => {
    const k = key(value, meta);
    let r = rows.get(k);
    if (!r) {
      r = { value, meta: meta ?? null, visitors: 0, revenue: 0, payments: 0, customers: 0, conversion_rate: 0, revenue_per_visitor: 0 };
      rows.set(k, r);
    }
    return r;
  };

  if (dim in SESSION_DIMENSIONS) {
    const col = `s.${SESSION_DIMENSIONS[dim as SessionDimension]}`;
    const withCountry = dim === "region" || dim === "city";
    const metaSel = dim === "source" ? ", MAX(s.referrer_domain) AS meta" : withCountry ? ", COALESCE(s.country, '') AS meta" : "";
    const groupExtra = withCountry ? ", COALESCE(s.country, '')" : "";
    const visitors = await db.all<Record<string, unknown>>(
      `SELECT COALESCE(${col}, '') AS value${metaSel},
              COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, SUM(s.pageviews) AS pageviews,
              SUM(${BOUNCE}) AS bounces, SUM(s.duration) AS duration
       FROM sessions s
       WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ?${f.sql}
       GROUP BY COALESCE(${col}, '')${groupExtra}
       ORDER BY visitors DESC
       LIMIT 1000`,
      [...base, ...f.params],
    );
    for (const v of visitors) {
      const r = get(String(v.value ?? ""), withCountry || dim === "source" ? (v.meta as string | null) : null);
      r.visitors = n(v.visitors);
      r.sessions = n(v.sessions);
      r.pageviews = n(v.pageviews);
      r.bounce_rate = r.sessions ? n(v.bounces) / r.sessions : 0;
      r.avg_session_duration = r.sessions ? n(v.duration) / r.sessions / 1000 : 0;
    }
    const join = q.filters.length ? "JOIN" : "LEFT JOIN";
    const revenue = await db.all<Record<string, unknown>>(
      `SELECT CASE WHEN s.id IS NULL THEN '${UNATTRIBUTED}' ELSE COALESCE(${col}, '') END AS value
              ${withCountry ? ", COALESCE(s.country, '') AS meta" : dim === "source" ? ", MAX(s.referrer_domain) AS meta" : ""},
              SUM(p.revenue) AS revenue, SUM(CASE WHEN p.type <> 'refund' THEN 1 ELSE 0 END) AS payments,
              COUNT(DISTINCT ${PAYING}) AS customers
       FROM payments p ${join} sessions s ON s.id = p.${attr}
       WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?${f.sql}
       GROUP BY CASE WHEN s.id IS NULL THEN '${UNATTRIBUTED}' ELSE COALESCE(${col}, '') END${groupExtra}`,
      [...base, ...f.params],
    );
    for (const v of revenue) {
      const value = String(v.value ?? "");
      let r: BreakdownRow | undefined;
      if (dim === "source") {
        // the favicon domain may differ between queries; match on value only
        r = [...rows.values()].find((x) => x.value === value) ?? get(value, v.meta as string | null);
      } else {
        r = get(value, withCountry ? (v.meta as string | null) : null);
      }
      r.revenue = n(v.revenue);
      r.payments = n(v.payments);
      r.customers = n(v.customers);
    }
  } else if (dim === "page") {
    const pageFilter = q.filters.filter((x) => x.dim === "page");
    const pf = pageFilter.length
      ? pageFilter.map((x) => valueCondition("e.path", x)).reduce((acc, c) => ({ sql: acc.sql + " AND " + c.sql, params: [...acc.params, ...c.params] }), { sql: "", params: [] as SqlValue[] })
      : { sql: "", params: [] as SqlValue[] };
    const needsJoin = q.filters.length > 0;
    const visitors = await db.all<Record<string, unknown>>(
      `SELECT e.path AS value, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS pageviews
       FROM events e ${needsJoin ? "JOIN sessions s ON s.id = e.session_id" : ""}
       WHERE e.site_id = ? AND e.type = 'pageview' AND e.ts >= ? AND e.ts < ?${needsJoin ? f.sql : ""}${pf.sql}
       GROUP BY e.path
       ORDER BY visitors DESC
       LIMIT 1000`,
      [...base, ...(needsJoin ? f.params : []), ...pf.params],
    );
    for (const v of visitors) {
      const r = get(String(v.value ?? ""));
      r.visitors = n(v.visitors);
      r.pageviews = n(v.pageviews);
    }
    // Revenue influenced by a page: payments whose visitor viewed the page before paying.
    const revenue = await db.all<Record<string, unknown>>(
      `SELECT x.path AS value, SUM(x.revenue) AS revenue, SUM(x.is_payment) AS payments, COUNT(DISTINCT x.paying) AS customers
       FROM (
         SELECT DISTINCT p.id, p.revenue, e.path,
                CASE WHEN p.type <> 'refund' THEN 1 ELSE 0 END AS is_payment,
                ${PAYING} AS paying
         FROM payments p
         JOIN events e ON e.site_id = p.site_id AND e.visitor_id = p.visitor_id AND e.type = 'pageview' AND e.ts <= p.ts
         ${needsJoin ? `JOIN sessions s ON s.id = p.${attr}` : ""}
         WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ? AND p.visitor_id IS NOT NULL${needsJoin ? f.sql : ""}${pf.sql}
       ) x
       GROUP BY x.path`,
      [...base, ...(needsJoin ? f.params : []), ...pf.params],
    );
    for (const v of revenue) {
      const r = get(String(v.value ?? ""));
      r.revenue = n(v.revenue);
      r.payments = n(v.payments);
      r.customers = n(v.customers);
    }
  } else {
    // goal / outbound: events by name
    const type = dim === "goal" ? "goal" : "outbound";
    const needsJoin = q.filters.length > 0;
    const visitors = await db.all<Record<string, unknown>>(
      `SELECT e.name AS value, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS completions
       FROM events e ${needsJoin ? "JOIN sessions s ON s.id = e.session_id" : ""}
       WHERE e.site_id = ? AND e.type = '${type}' AND e.ts >= ? AND e.ts < ?${needsJoin ? f.sql : ""}
       GROUP BY e.name
       ORDER BY visitors DESC
       LIMIT 1000`,
      [...base, ...(needsJoin ? f.params : [])],
    );
    for (const v of visitors) {
      const r = get(String(v.value ?? ""));
      r.visitors = n(v.visitors);
      r.completions = n(v.completions);
    }
    if (dim === "goal") {
      const revenue = await db.all<Record<string, unknown>>(
        `SELECT g.name AS value, SUM(p.revenue) AS revenue, SUM(CASE WHEN p.type <> 'refund' THEN 1 ELSE 0 END) AS payments,
                COUNT(DISTINCT ${PAYING}) AS customers
         FROM (SELECT DISTINCT e.name, e.visitor_id FROM events e ${needsJoin ? "JOIN sessions s ON s.id = e.session_id" : ""}
               WHERE e.site_id = ? AND e.type = 'goal' AND e.ts >= ? AND e.ts < ?${needsJoin ? f.sql : ""}) g
         JOIN payments p ON p.site_id = ? AND p.visitor_id = g.visitor_id AND p.ts >= ? AND p.ts < ?
         GROUP BY g.name`,
        [...base, ...(needsJoin ? f.params : []), ...base],
      );
      for (const v of revenue) {
        const r = get(String(v.value ?? ""));
        r.revenue = n(v.revenue);
        r.payments = n(v.payments);
        r.customers = n(v.customers);
      }
    }
  }

  // total visitors for goal conversion rates
  let totalVisitors = 0;
  if (dim === "goal") {
    const t = await db.first<{ visitors: number }>(
      `SELECT COUNT(DISTINCT s.visitor_id) AS visitors FROM sessions s WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ?${f.sql}`,
      [...base, ...f.params],
    );
    totalVisitors = n(t?.visitors);
  }

  const out = [...rows.values()].map((r) => {
    r.conversion_rate = dim === "goal" ? (totalVisitors ? r.visitors / totalVisitors : 0) : r.visitors ? Math.min(1, r.customers / r.visitors) : 0;
    r.revenue_per_visitor = r.visitors ? r.revenue / r.visitors : 0;
    return r;
  });
  const sort = opts.sort ?? "visitors";
  out.sort((a, b) => {
    const d =
      sort === "revenue"
        ? b.revenue - a.revenue
        : sort === "conversion_rate"
          ? b.conversion_rate - a.conversion_rate
          : sort === "completions"
            ? (b.completions ?? 0) - (a.completions ?? 0)
            : b.visitors - a.visitors;
    return d !== 0 ? d : b.revenue - a.revenue || b.visitors - a.visitors;
  });
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Goal properties
// ---------------------------------------------------------------------------

export async function goalProperties(db: Database, q: StatsQuery, goal: string) {
  const f = sessionFilterSql(q.filters);
  const rows = await db.all<{ props: string | null; visitor_id: string }>(
    `SELECT e.props, e.visitor_id FROM events e JOIN sessions s ON s.id = e.session_id
     WHERE e.site_id = ? AND e.type = 'goal' AND e.name = ? AND e.ts >= ? AND e.ts < ?${f.sql}
     ORDER BY e.ts DESC LIMIT 20000`,
    [q.site.id, goal, q.range.from, q.range.to, ...f.params],
  );
  const props = new Map<string, Map<string, { count: number; visitors: Set<string> }>>();
  for (const r of rows) {
    if (!r.props) continue;
    let obj: Record<string, string>;
    try {
      obj = JSON.parse(r.props);
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(obj)) {
      let values = props.get(k);
      if (!values) props.set(k, (values = new Map()));
      let entry = values.get(v);
      if (!entry) values.set(v, (entry = { count: 0, visitors: new Set() }));
      entry.count++;
      entry.visitors.add(r.visitor_id);
    }
  }
  return [...props.entries()].map(([key, values]) => ({
    key,
    values: [...values.entries()]
      .map(([value, e]) => ({ value, completions: e.count, visitors: e.visitors.size }))
      .sort((a, b) => b.visitors - a.visitors)
      .slice(0, 100),
  }));
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

export const REALTIME_WINDOW = 5 * 60 * 1000;

export async function realtime(db: Database, site: Site, now = Date.now()) {
  const since = now - REALTIME_WINDOW;
  const [count, sessions, events, payments, perMinute, convRates] = await Promise.all([
    db.first<{ visitors: number }>("SELECT COUNT(DISTINCT visitor_id) AS visitors FROM sessions WHERE site_id = ? AND last_seen_at > ?", [
      site.id,
      since,
    ]),
    db.all<Record<string, unknown>>(
      `SELECT s.id, s.visitor_id, s.started_at, s.last_seen_at, s.pageviews, s.goals, s.exit_page AS page, s.entry_page,
              s.source, s.referrer_domain, s.channel, s.country, s.region, s.city, s.latitude, s.longitude,
              s.device, s.browser, s.os, s.is_new, s.utm_campaign,
              v.name, v.email, v.image, v.user_id, v.sessions AS visits
       FROM sessions s LEFT JOIN visitors v ON v.site_id = s.site_id AND v.id = s.visitor_id
       WHERE s.site_id = ? AND s.last_seen_at > ?
       ORDER BY s.last_seen_at DESC LIMIT 300`,
      [site.id, since],
    ),
    db.all<Record<string, unknown>>(
      `SELECT e.id, e.ts, e.type, e.name, e.path, e.visitor_id, e.session_id, s.country, s.city, s.source, s.referrer_domain, s.device, s.browser
       FROM events e JOIN sessions s ON s.id = e.session_id
       WHERE e.site_id = ? AND e.ts > ? ORDER BY e.ts DESC LIMIT 50`,
      [site.id, now - 30 * 60 * 1000],
    ),
    db.all<Record<string, unknown>>(
      `SELECT p.id, p.ts, p.type, p.revenue, p.revenue_currency, p.amount, p.currency, p.visitor_id, p.email, p.name, p.provider,
              s.country, s.city, s.source, s.referrer_domain
       FROM payments p LEFT JOIN sessions s ON s.id = p.touch_session_id
       WHERE p.site_id = ? AND p.ts > ? ORDER BY p.ts DESC LIMIT 20`,
      [site.id, now - 24 * 60 * 60 * 1000],
    ),
    db.all<{ m: number; pageviews: number; visitors: number }>(
      `SELECT (${Math.floor(now)} - ts) / 60000 AS m, COUNT(*) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors
       FROM events WHERE site_id = ? AND type = 'pageview' AND ts > ? GROUP BY m`,
      [site.id, now - 30 * 60 * 1000],
    ),
    db.all<{ channel: string; visitors: number; customers: number }>(
      `SELECT s.channel, COUNT(DISTINCT s.visitor_id) AS visitors,
              COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM payments p WHERE p.site_id = s.site_id AND p.visitor_id = s.visitor_id AND p.type <> 'refund') THEN s.visitor_id END) AS customers
       FROM sessions s WHERE s.site_id = ? AND s.started_at > ? GROUP BY s.channel`,
      [site.id, now - 90 * 24 * 60 * 60 * 1000],
    ),
  ]);

  // Pages seen by live sessions, used for the buyer-intent score.
  const liveIds = sessions.map((s) => String(s.id));
  const pagesBySession = new Map<string, string[]>();
  if (liveIds.length) {
    for (let i = 0; i < liveIds.length; i += 80) {
      const chunk = liveIds.slice(i, i + 80);
      const rows = await db.all<{ session_id: string; path: string }>(
        `SELECT session_id, path FROM events WHERE type = 'pageview' AND session_id IN (${chunk.map(() => "?").join(",")})`,
        chunk,
      );
      for (const r of rows) {
        const list = pagesBySession.get(r.session_id) ?? [];
        list.push(r.path);
        pagesBySession.set(r.session_id, list);
      }
    }
  }
  const totals = convRates.reduce((acc, r) => ({ v: acc.v + n(r.visitors), c: acc.c + n(r.customers) }), { v: 0, c: 0 });
  const baseRate = totals.v ? totals.c / totals.v : 0.01;
  const channelRate = new Map(convRates.map((r) => [r.channel, n(r.visitors) >= 20 ? n(r.customers) / n(r.visitors) : baseRate]));

  const visitors = sessions.map((s) => {
    const pages = pagesBySession.get(String(s.id)) ?? [];
    let score = channelRate.get(String(s.channel)) ?? baseRate;
    if (!score) score = 0.005;
    if (n(s.visits) > 1) score *= 1.6;
    if (n(s.pageviews) >= 3) score *= 1.3;
    if (n(s.goals) > 0) score *= 1.5;
    if (pages.some((p) => /pric|plan|checkout|buy|upgrade|billing|cart|subscribe|signup|register/i.test(p))) score *= 2.2;
    if (s.email || s.user_id) score *= 1.5;
    return { ...s, pages: pages.slice(-20), buyer_score: Math.min(0.99, score) };
  });

  const minutes = Array.from({ length: 30 }, (_, i) => {
    const row = perMinute.find((r) => n(r.m) === 29 - i);
    return { minute: 29 - i, pageviews: n(row?.pageviews), visitors: n(row?.visitors) };
  });

  return { visitors: n(count?.visitors), sessions: visitors, events, payments, minutes };
}

// ---------------------------------------------------------------------------
// Visitors & journeys
// ---------------------------------------------------------------------------

export async function listVisitors(
  db: Database,
  q: StatsQuery,
  opts: { search?: string; customersOnly?: boolean; limit?: number; offset?: number; goal?: string | null },
) {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const f = sessionFilterSql(q.filters);
  const extraParams: SqlValue[] = [];
  let extra = "";
  if (opts.search) {
    extra += " AND (LOWER(COALESCE(v.name, '')) LIKE ? OR LOWER(COALESCE(v.email, '')) LIKE ? OR LOWER(COALESCE(v.user_id, '')) LIKE ? OR v.id = ?)";
    const like = `%${opts.search.toLowerCase()}%`;
    extraParams.push(like, like, like, opts.search);
  }
  if (opts.customersOnly) extra += " AND EXISTS (SELECT 1 FROM payments p WHERE p.site_id = v.site_id AND p.visitor_id = v.id AND p.type <> 'refund')";
  if (opts.goal) {
    extra += " AND EXISTS (SELECT 1 FROM events ge WHERE ge.site_id = v.site_id AND ge.visitor_id = v.id AND ge.type = 'goal' AND ge.name = ?)";
    extraParams.push(opts.goal);
  }
  const rows = await db.all<Record<string, unknown>>(
    `SELECT v.id, v.first_seen, v.last_seen, v.sessions, v.user_id, v.name, v.email, v.image,
            (SELECT SUM(p.revenue) FROM payments p WHERE p.site_id = v.site_id AND p.visitor_id = v.id) AS revenue,
            (SELECT COUNT(*) FROM payments p WHERE p.site_id = v.site_id AND p.visitor_id = v.id AND p.type <> 'refund') AS payments,
            fs.source, fs.channel, fs.referrer_domain, fs.country, fs.city, fs.device, fs.browser, fs.os, fs.entry_page
     FROM visitors v
     JOIN (SELECT s.visitor_id FROM sessions s
           WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ?${f.sql}
           GROUP BY s.visitor_id) r ON r.visitor_id = v.id
     LEFT JOIN sessions fs ON fs.id = (SELECT s2.id FROM sessions s2 WHERE s2.site_id = v.site_id AND s2.visitor_id = v.id ORDER BY s2.started_at ASC LIMIT 1)
     WHERE v.site_id = ?${extra}
     ORDER BY v.last_seen DESC
     LIMIT ${limit} OFFSET ${offset}`,
    [q.site.id, q.range.from, q.range.to, ...f.params, q.site.id, ...extraParams],
  );
  return rows.map((r) => ({ ...r, revenue: n(r.revenue), payments: n(r.payments) }));
}

export async function visitorProfile(db: Database, site: Site, visitorId: string) {
  const visitor = await db.first<Record<string, unknown>>("SELECT * FROM visitors WHERE site_id = ? AND id = ?", [site.id, visitorId]);
  if (!visitor) return null;
  // Visitors identified with the same user id are merged into one profile (cross-device).
  let ids = [visitorId];
  if (visitor.user_id) {
    const linked = await db.all<{ id: string }>("SELECT id FROM visitors WHERE site_id = ? AND user_id = ? LIMIT 20", [site.id, visitor.user_id as string]);
    ids = [...new Set([visitorId, ...linked.map((l) => l.id)])];
  }
  const ph = ids.map(() => "?").join(",");
  const [sessions, events, payments] = await Promise.all([
    db.all<Record<string, unknown>>(
      `SELECT * FROM sessions WHERE site_id = ? AND visitor_id IN (${ph}) ORDER BY started_at DESC LIMIT 200`,
      [site.id, ...ids],
    ),
    db.all<Record<string, unknown>>(
      `SELECT id, session_id, ts, type, name, path, hostname, props FROM events WHERE site_id = ? AND visitor_id IN (${ph}) ORDER BY ts DESC LIMIT 2000`,
      [site.id, ...ids],
    ),
    db.all<Record<string, unknown>>(`SELECT * FROM payments WHERE site_id = ? AND visitor_id IN (${ph}) ORDER BY ts DESC`, [site.id, ...ids]),
  ]);
  const revenue = payments.reduce((acc, p) => acc + n(p.revenue), 0);
  return {
    visitor: { ...visitor, props: visitor.props ? JSON.parse(String(visitor.props)) : null, linked_ids: ids },
    sessions,
    events: events.map((e) => ({ ...e, props: e.props ? JSON.parse(String(e.props)) : null })),
    payments,
    revenue,
  };
}

// ---------------------------------------------------------------------------
// Funnels
// ---------------------------------------------------------------------------

export interface FunnelStep {
  type: "page" | "goal" | "payment";
  value?: string;
  match?: "equals" | "contains" | "starts_with";
  label?: string;
}

function stepCondition(step: FunnelStep, alias: string): SqlPart {
  if (step.type === "payment") return { sql: "", params: [] };
  const col = step.type === "page" ? `${alias}.path` : `${alias}.name`;
  const type = step.type === "page" ? "pageview" : "goal";
  const v = step.value ?? "";
  if (step.match === "contains") return { sql: `${alias}.type = '${type}' AND ${col} LIKE ?`, params: [`%${v}%`] };
  if (step.match === "starts_with") return { sql: `${alias}.type = '${type}' AND ${col} LIKE ?`, params: [`${v}%`] };
  if (v.includes("*")) return { sql: `${alias}.type = '${type}' AND ${col} LIKE ?`, params: [v.replace(/\*+/g, "%")] };
  return { sql: `${alias}.type = '${type}' AND ${col} = ?`, params: [v] };
}

export async function funnelResults(db: Database, q: StatsQuery, steps: FunnelStep[]) {
  if (!steps.length) return [];
  steps = steps.slice(0, 10);
  const f = sessionFilterSql(q.filters);
  const ctes: string[] = [];
  const params: SqlValue[] = [];
  steps.forEach((step, i) => {
    const name = `s${i}`;
    if (step.type === "payment") {
      const prev = i > 0 ? `JOIN s${i - 1} ON s${i - 1}.visitor_id = p.visitor_id AND p.ts >= s${i - 1}.t` : "";
      ctes.push(
        `${name} AS (SELECT p.visitor_id, MIN(p.ts) AS t FROM payments p ${prev}
          ${q.filters.length ? `JOIN sessions s ON s.id = p.touch_session_id` : ""}
          WHERE p.site_id = ? AND p.type <> 'refund' AND p.visitor_id IS NOT NULL AND p.ts >= ? AND p.ts < ?${q.filters.length ? f.sql : ""}
          GROUP BY p.visitor_id)`,
      );
      params.push(q.site.id, q.range.from, q.range.to, ...(q.filters.length ? f.params : []));
      return;
    }
    const cond = stepCondition(step, "e");
    const prev = i > 0 ? `JOIN s${i - 1} ON s${i - 1}.visitor_id = e.visitor_id AND e.ts >= s${i - 1}.t` : "";
    ctes.push(
      `${name} AS (SELECT e.visitor_id, MIN(e.ts) AS t FROM events e ${prev}
        ${q.filters.length ? "JOIN sessions s ON s.id = e.session_id" : ""}
        WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ? AND ${cond.sql}${q.filters.length ? f.sql : ""}
        GROUP BY e.visitor_id)`,
    );
    params.push(q.site.id, q.range.from, q.range.to, ...cond.params, ...(q.filters.length ? f.params : []));
  });
  const selects = steps
    .map(
      (_, i) =>
        `(SELECT COUNT(*) FROM s${i}) AS c${i}, (SELECT SUM(p.revenue) FROM payments p JOIN s${i} ON s${i}.visitor_id = p.visitor_id WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?) AS r${i}`,
    )
    .join(", ");
  steps.forEach(() => params.push(q.site.id, q.range.from, q.range.to));
  const row = await db.first<Record<string, number>>(`WITH ${ctes.join(",\n")} SELECT ${selects}`, params);
  const first = n(row?.c0);
  return steps.map((step, i) => {
    const visitors = n(row?.[`c${i}`]);
    const prev = i === 0 ? visitors : n(row?.[`c${i - 1}`]);
    return {
      step,
      visitors,
      revenue: n(row?.[`r${i}`]),
      conversion_rate: first ? visitors / first : 0,
      step_conversion_rate: prev ? visitors / prev : 0,
      dropoff: Math.max(0, prev - visitors),
    };
  });
}

// ---------------------------------------------------------------------------
// Revenue reports
// ---------------------------------------------------------------------------

export async function listPayments(db: Database, q: StatsQuery, opts: { limit?: number; offset?: number } = {}) {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const attr = attributionColumn(q.site, q.attribution);
  const f = sessionFilterSql(q.filters);
  return db.all<Record<string, unknown>>(
    `SELECT p.*, s.source, s.channel, s.referrer_domain, s.country, s.city, s.device, s.utm_campaign, v.name AS visitor_name, v.image AS visitor_image
     FROM payments p
     ${q.filters.length ? "JOIN" : "LEFT JOIN"} sessions s ON s.id = p.${attr}
     LEFT JOIN visitors v ON v.site_id = p.site_id AND v.id = p.visitor_id
     WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?${f.sql}
     ORDER BY p.ts DESC LIMIT ${limit} OFFSET ${offset}`,
    [q.site.id, q.range.from, q.range.to, ...f.params],
  );
}

/** Customers acquired in the range, grouped by first-touch source, with lifetime value to date. */
export async function customerLtv(db: Database, q: StatsQuery, groupBy: "source" | "channel" | "country" | "utm_campaign" = "source") {
  const col = groupBy === "channel" ? "s.channel" : groupBy === "country" ? "s.country" : groupBy === "utm_campaign" ? "s.utm_campaign" : "s.source";
  const rows = await db.all<Record<string, unknown>>(
    `WITH c AS (
       SELECT COALESCE(p.visitor_id, p.customer_id, p.email, p.id) AS ck,
              MIN(p.ts) AS first_ts, SUM(p.revenue) AS ltv,
              SUM(CASE WHEN p.type = 'renewal' THEN 1 ELSE 0 END) AS renewals,
              SUM(CASE WHEN p.type <> 'refund' THEN 1 ELSE 0 END) AS orders,
              MAX(p.first_session_id) AS fs
       FROM payments p WHERE p.site_id = ?
       GROUP BY COALESCE(p.visitor_id, p.customer_id, p.email, p.id)
     )
     SELECT CASE WHEN s.id IS NULL THEN '${UNATTRIBUTED}' ELSE COALESCE(${col}, '') END AS value,
            MAX(s.referrer_domain) AS meta,
            COUNT(*) AS customers, SUM(c.ltv) AS revenue, SUM(c.renewals) AS renewals,
            SUM(CASE WHEN c.orders > 1 THEN 1 ELSE 0 END) AS repeat_customers
     FROM c LEFT JOIN sessions s ON s.id = c.fs
     WHERE c.first_ts >= ? AND c.first_ts < ?
     GROUP BY CASE WHEN s.id IS NULL THEN '${UNATTRIBUTED}' ELSE COALESCE(${col}, '') END
     ORDER BY revenue DESC`,
    [q.site.id, q.range.from, q.range.to],
  );
  return rows.map((r) => ({
    value: String(r.value ?? ""),
    meta: (r.meta as string | null) ?? null,
    customers: n(r.customers),
    revenue: n(r.revenue),
    avg_ltv: n(r.customers) ? n(r.revenue) / n(r.customers) : 0,
    renewals: n(r.renewals),
    repeat_rate: n(r.customers) ? n(r.repeat_customers) / n(r.customers) : 0,
  }));
}

export async function firstDataTimestamp(db: Database, siteId: string): Promise<number | null> {
  const row = await db.first<{ t: number | null; p: number | null }>(
    "SELECT (SELECT MIN(started_at) FROM sessions WHERE site_id = ?) AS t, (SELECT MIN(ts) FROM payments WHERE site_id = ?) AS p",
    [siteId, siteId],
  );
  const vals = [row?.t, row?.p].filter((x): x is number => x !== null && x !== undefined).map(Number);
  return vals.length ? Math.min(...vals) : null;
}
