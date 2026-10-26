import { Hono, type Context } from "hono";
import type { AppEnv } from "../context";
import { withoutRevenue } from "../lib/revenue";
import { mrrBreakdown, mrrGroup, mrrReport } from "../services/mrr";
import { crawlerReport } from "../services/crawlers";
import { searchKeywords } from "../services/search-console";
import { hasSocialPosts, socialReport } from "../services/social";
import * as stats from "../services/stats";
import { fail, rangeInfo, readJson, requireRevenue, statsQuery } from "./helpers";

// Hidden on public share links: personal data, plus identifiers that would let a viewer follow one
// visitor or customer across responses (row ids stay, they're random and only used as list keys).
const PII_FIELDS = [
  "email",
  "name",
  "image",
  "user_id",
  "visitor_name",
  "visitor_image",
  "customer_id",
  "visitor_id",
  "session_id",
  "first_session_id",
  "last_session_id",
  "touch_session_id",
  "transaction_id",
  "subscription_id",
  "ref",
  "description",
];

function scrub<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const f of PII_FIELDS) if (f in out) out[f] = null;
  return out as T;
}

/** Visitor lists and profiles are personal data: members see them, share links only on a demo instance (DEMO_MODE). */
function showsVisitors(c: Context<AppEnv>): boolean {
  return !c.get("isPublic") || !!c.get("rt").config.demoMode;
}

/** Sends a response, without its revenue data for viewers who can't see revenue (lib/revenue.ts). */
function send(c: Context<AppEnv>, data: Record<string, unknown>, opts: { purchaseConversion?: boolean } = {}) {
  return c.json(c.get("canSeeRevenue") ? data : withoutRevenue(data, opts));
}

/**
 * Read-only analytics endpoints. Mounted for signed-in members (/api/sites/:siteId/stats)
 * and for public share links (/api/share/:token/stats). Expects `site` and `canSeeRevenue` to be set.
 */
export function statsRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/overview", async (c) => {
    const q = await statsQuery(c, c.get("site"));
    const result = await stats.overview(c.get("rt").db, q, c.req.query("compare") !== "0");
    return send(c, { range: rangeInfo(q), currency: q.site.currency, ...result }, { purchaseConversion: true });
  });

  app.get("/timeseries", async (c) => {
    const q = await statsQuery(c, c.get("site"));
    const points = await stats.timeseries(c.get("rt").db, q);
    return send(c, { range: rangeInfo(q), currency: q.site.currency, interval: q.range.interval, points });
  });

  app.get("/breakdown/:dimension", async (c) => {
    const dim = c.req.param("dimension");
    if (!stats.isDimension(dim)) fail(400, `Unknown dimension "${dim}"`);
    const q = await statsQuery(c, c.get("site"));
    const sort = c.req.query("sort") as "visitors" | "revenue" | "conversion_rate" | "completions" | undefined;
    const rows = await stats.breakdown(c.get("rt").db, q, dim, { limit: Number(c.req.query("limit") || 10), sort });
    return send(c, { range: rangeInfo(q), currency: q.site.currency, dimension: dim, rows }, { purchaseConversion: dim !== "goal" });
  });

  app.get("/goals/:goal/properties", async (c) => {
    const q = await statsQuery(c, c.get("site"));
    return c.json({ properties: await stats.goalProperties(c.get("rt").db, q, c.req.param("goal")) });
  });

  /** Lightweight "visitors online" counter for the dashboard header. */
  app.get("/live", async (c) => {
    const row = await c
      .get("rt")
      .db.first<{ visitors: number }>("SELECT COUNT(DISTINCT visitor_id) AS visitors FROM sessions WHERE site_id = ? AND last_seen_at > ?", [
        c.get("site").id,
        Date.now() - stats.REALTIME_WINDOW,
      ]);
    return c.json({ visitors: Number(row?.visitors ?? 0) });
  });

  app.get("/realtime", async (c) => {
    const data = await stats.realtime(c.get("rt").db, c.get("site"), Date.now(), { revenue: c.get("canSeeRevenue") });
    if (c.get("isPublic")) {
      data.sessions = data.sessions.map((s) => scrub({ ...s, id: null }));
      // Event names are goal/outbound labels the public feed shows, so only drop the identifiers.
      data.events = data.events.map((e) => ({ ...e, visitor_id: null, session_id: null }));
      data.payments = data.payments.map((p) => scrub(p));
    }
    return send(c, { currency: c.get("site").currency, ...data });
  });

  app.get("/visitors", async (c) => {
    if (!showsVisitors(c)) fail(403, "Visitor details are not available on public dashboards");
    // Listing only the visitors who paid would list the customers.
    if (c.req.query("customers") === "1") requireRevenue(c);
    const q = await statsQuery(c, c.get("site"));
    const rows = await stats.listVisitors(c.get("rt").db, q, {
      search: c.req.query("search") || undefined,
      customersOnly: c.req.query("customers") === "1",
      goal: c.req.query("goal") || null,
      limit: Number(c.req.query("limit") || 50),
      offset: Number(c.req.query("offset") || 0),
    });
    return send(c, { range: rangeInfo(q), currency: q.site.currency, visitors: rows });
  });

  app.get("/visitors/:visitorId", async (c) => {
    if (!showsVisitors(c)) fail(403, "Visitor details are not available on public dashboards");
    const profile = await stats.visitorProfile(c.get("rt").db, c.get("site"), c.req.param("visitorId"), { revenue: c.get("canSeeRevenue") });
    if (!profile) fail(404, "Visitor not found");
    return send(c, { currency: c.get("site").currency, ...profile });
  });

  // Payments, lifetime value and MRR are revenue as a whole: refused to viewers who can't see revenue.
  app.get("/payments", async (c) => {
    requireRevenue(c);
    const q = await statsQuery(c, c.get("site"));
    let rows = await stats.listPayments(c.get("rt").db, q, {
      limit: Number(c.req.query("limit") || 50),
      offset: Number(c.req.query("offset") || 0),
    });
    if (c.get("isPublic")) rows = rows.map((r) => scrub(r));
    return c.json({ range: rangeInfo(q), currency: q.site.currency, payments: rows });
  });

  app.get("/ltv", async (c) => {
    requireRevenue(c);
    const q = await statsQuery(c, c.get("site"));
    const group = (c.req.query("group") ?? "source") as "source" | "channel" | "country" | "utm_campaign";
    return c.json({ range: rangeInfo(q), currency: q.site.currency, rows: await stats.customerLtv(c.get("rt").db, q, group) });
  });

  app.get("/mrr", async (c) => {
    requireRevenue(c);
    const q = await statsQuery(c, c.get("site"));
    const report = await mrrReport(c.get("rt").db, q);
    return c.json({ range: rangeInfo(q), currency: q.site.currency, interval: q.range.interval, ...report });
  });

  app.get("/crawlers", async (c) => {
    const q = await statsQuery(c, c.get("site"));
    const report = await crawlerReport(c.get("rt").db, q, { timezone: c.get("site").timezone, category: c.req.query("category") });
    return send(c, { range: rangeInfo(q), currency: q.site.currency, ...report });
  });

  app.get("/social", async (c) => {
    const q = await statsQuery(c, c.get("site"));
    const report = await socialReport(c.get("rt").db, q, { platform: c.req.query("platform"), limit: Number(c.req.query("limit")) || undefined });
    return send(c, { range: rangeInfo(q), currency: q.site.currency, ...report });
  });

  app.get("/search-keywords", async (c) => {
    const q = await statsQuery(c, c.get("site"));
    const sort = c.req.query("sort");
    const report = await searchKeywords(c.get("rt").db, q, {
      limit: Number(c.req.query("limit") || 10),
      sort: sort === "revenue" || sort === "impressions" ? sort : "clicks",
    });
    return send(c, { range: rangeInfo(q), currency: q.site.currency, ...report });
  });

  app.get("/mrr/breakdown", async (c) => {
    requireRevenue(c);
    const q = await statsQuery(c, c.get("site"));
    const group = mrrGroup(c.req.query("group"));
    return c.json({ range: rangeInfo(q), currency: q.site.currency, group, rows: await mrrBreakdown(c.get("rt").db, q, group) });
  });

  app.get("/funnels/:funnelId", async (c) => {
    const site = c.get("site");
    const row = await c
      .get("rt")
      .db.first<{ id: string; name: string; steps: string }>("SELECT id, name, steps FROM funnels WHERE id = ? AND site_id = ?", [
        c.req.param("funnelId"),
        site.id,
      ]);
    if (!row) fail(404, "Funnel not found");
    const q = await statsQuery(c, site);
    const steps = JSON.parse(row.steps) as stats.FunnelStep[];
    return send(c, { range: rangeInfo(q), currency: site.currency, funnel: { id: row.id, name: row.name, steps }, results: await stats.funnelResults(c.get("rt").db, q, steps) });
  });

  app.post("/funnels/preview", async (c) => {
    const body = await readJson<{ steps?: stats.FunnelStep[] }>(c);
    const q = await statsQuery(c, c.get("site"));
    return send(c, { results: await stats.funnelResults(c.get("rt").db, q, Array.isArray(body.steps) ? body.steps : []) });
  });

  app.get("/notes", async (c) => {
    const q = await statsQuery(c, c.get("site"));
    const notes = await c
      .get("rt")
      .db.all("SELECT id, ts, text, url FROM notes WHERE site_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC", [q.site.id, q.range.from, q.range.to]);
    return c.json({ notes });
  });

  app.get("/meta", async (c) => {
    const site = c.get("site");
    const db = c.get("rt").db;
    const [funnels, goals, imports, searchConsole, crawlers, social] = await Promise.all([
      db.all<{ id: string; name: string; steps: string }>("SELECT id, name, steps FROM funnels WHERE site_id = ? ORDER BY created_at ASC", [site.id]),
      db.all<{ name: string }>(
        "SELECT DISTINCT name FROM events WHERE site_id = ? AND type = 'goal' AND ts > ? ORDER BY name LIMIT 200",
        [site.id, Date.now() - 365 * 24 * 60 * 60 * 1000],
      ),
      db.all<{ source: string; date_from: string; date_to: string }>(
        "SELECT source, date_from, date_to FROM imports WHERE site_id = ? AND status = 'done' ORDER BY date_from",
        [site.id],
      ),
      db.first<{ oldest: string | null }>("SELECT oldest FROM search_console WHERE site_id = ?", [site.id]),
      db.first("SELECT 1 AS found FROM crawler_stats WHERE site_id = ? LIMIT 1", [site.id]),
      hasSocialPosts(db, site.id),
    ]);
    return c.json({
      site: {
        id: site.id,
        name: site.name,
        domain: site.domain,
        timezone: site.timezone,
        currency: site.currency,
        kpiGoal: site.settings.kpiGoal ?? null,
        attribution: site.settings.attribution ?? "last_non_direct",
        created_at: site.created_at,
      },
      /** Whether this viewer sees revenue. When not, the server leaves it out of every response, and the dashboard hides it. */
      canSeeRevenue: c.get("canSeeRevenue"),
      funnels: funnels.map((f) => ({ id: f.id, name: f.name, steps: JSON.parse(f.steps) })),
      goals: goals.map((g) => g.name),
      /** Completed history imports: the dashboard says when a chart includes them, or leaves them out under filters. */
      imports,
      /** Whether Google Search Console is connected, so the dashboard shows search keywords. */
      searchConsole: !!searchConsole,
      /** Whether the website's server has reported crawler requests: shared dashboards only show the Crawlers page then. */
      crawlers: !!crawlers,
      /** Whether posts on X or Hacker News were found: shared dashboards only show the Social page then. */
      social,
      /** Whether this dashboard has the Visitors tab: always for members, on share links only on a demo instance. */
      visitors: showsVisitors(c),
    });
  });

  return app;
}
