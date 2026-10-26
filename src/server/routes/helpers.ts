import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../context";
import type { Database } from "../db/types";
import { REVENUE_HIDDEN, REVENUE_HIDDEN_PUBLIC } from "../lib/revenue";
import { resolveRange } from "../lib/time";
import { firstDataTimestamp, parseFilters, type StatsQuery } from "../services/stats";
import { getMembership, getSite, roleAtLeast, type Role, type Site } from "../services/sites";

export function fail(status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500, message: string): never {
  throw new HTTPException(status, { message });
}

export async function readJson<T = Record<string, unknown>>(c: Context): Promise<T> {
  try {
    const text = await c.req.text();
    if (!text) return {} as T;
    if (text.length > 1_000_000) fail(413, "Request body too large");
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    fail(400, "Invalid JSON body");
  }
}

export function requireUser(c: Context<AppEnv>) {
  const user = c.get("user");
  if (!user) fail(401, "Not signed in");
  return user;
}

/**
 * Loads a site the current user (or API key) can access with at least `min` role, and whether they see revenue. API keys
 * act as the member who created them, so they see revenue when that member does.
 */
export async function siteForUser(c: Context<AppEnv>, siteId: string, min: Role = "viewer"): Promise<{ site: Site; role: Role; canSeeRevenue: boolean }> {
  const rt = c.get("rt");
  const site = await getSite(rt.db, siteId);
  if (!site) fail(404, "Website not found");
  const user = c.get("user");
  const apiKey = c.get("apiKey");
  const userId = user?.id ?? apiKey?.userId;
  if (!userId) fail(401, "Not signed in");
  if (apiKey?.siteId && apiKey.siteId !== site.id) fail(403, "This API key belongs to another website");
  const member = (await getMembership(rt.db, site.id, userId)) ?? (user?.is_admin ? { role: "owner" as const, canSeeRevenue: true } : null);
  if (!member) fail(404, "Website not found");
  if (!roleAtLeast(member.role, min)) fail(403, `This action requires the ${min} role`);
  return { site, role: member.role, canSeeRevenue: member.canSeeRevenue };
}

/** Refuses revenue reports (payments, LTV, MRR) to viewers who can't see revenue. */
export function requireRevenue(c: Context<AppEnv>) {
  if (!c.get("canSeeRevenue")) fail(403, c.get("isPublic") ? REVENUE_HIDDEN_PUBLIC : REVENUE_HIDDEN);
}

/** Builds the stats query (date range + filters) from request query params. */
export async function statsQuery(c: Context<AppEnv>, site: Site): Promise<StatsQuery> {
  return buildStatsQuery(c.get("rt").db, site, c.req.query(), { revenue: c.get("canSeeRevenue") });
}

/**
 * Builds a stats query from plain params (`period`, `from`, `to`, `interval`, `filters`, `filter_*`, `timezone`).
 * `revenue: false` is for viewers who can't see revenue: reports then skip payments.
 */
export async function buildStatsQuery(db: Database, site: Site, q: Record<string, string | undefined>, opts: { revenue: boolean }): Promise<StatsQuery> {
  const tz = q.timezone && isTz(q.timezone) ? q.timezone : site.timezone;
  const siteForTz = tz === site.timezone ? site : { ...site, timezone: tz };
  // "All time" starts at the first visit, payment or imported day; without revenue, payments don't move it.
  const first = q.period === "all" ? await firstDataTimestamp(db, site.id, { payments: opts.revenue }) : null;
  const range = resolveRange(
    tz,
    { period: q.period, from: q.from ?? q.startAt ?? q.start_at, to: q.to ?? q.endAt ?? q.end_at, interval: q.interval },
    Date.now(),
    first ?? site.created_at,
  );
  return {
    site: siteForTz,
    range,
    filters: parseFilters(q),
    attribution: q.attribution ?? null,
    imported: q.imported !== "false" && q.imported !== "0",
    revenue: opts.revenue,
  };
}

function isTz(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function rangeInfo(q: StatsQuery) {
  return {
    period: q.range.period,
    from: q.range.from,
    to: q.range.to,
    fromDate: q.range.fromDate,
    toDate: q.range.toDate,
    interval: q.range.interval,
    timezone: q.site.timezone,
  };
}

export function stringList(v: unknown, max = 200): string[] {
  if (!Array.isArray(v)) {
    if (typeof v === "string") v = v.split(/[\n,]/);
    else return [];
  }
  return (v as unknown[])
    .map((x) => String(x).trim())
    .filter(Boolean)
    .slice(0, max);
}
