import { Hono } from "hono";
import type { AppEnv } from "../context";
import { mrrBreakdown, mrrGroup, mrrReport } from "../services/mrr";
import * as stats from "../services/stats";
import { fail, rangeInfo, readJson, statsQuery } from "./helpers";

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

/**
 * Read-only analytics endpoints. Mounted for signed-in members (/api/sites/:siteId/stats)
 * and for public share links (/api/share/:token/stats). Expects `site` to be set.
 */
export function statsRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/overview", async (c) => {
    const q = await statsQuery(c, c.get("site"));
    const result = await stats.overview(c.get("rt").db, q, c.req.query("compare") !== "0");
    return c.json({ range: rangeInfo(q), currency: q.site.currency, ...result });
  });

  app.get("/timeseries", async (c) => {
    const q = await statsQuery(c, c.get("site"));
    const points = await stats.timeseries(c.get("rt").db, q);
    return c.json({ range: rangeInfo(q), currency: q.site.currency, interval: q.range.interval, points });
  });

  app.get("/breakdown/:dimension", async (c) => {
    const dim = c.req.param("dimension");
    if (!stats.isDimension(dim)) fail(400, `Unknown dimension "${dim}"`);
    const q = await statsQuery(c, c.get("site"));
    const sort = c.req.query("sort") as "visitors" | "revenue" | "conversion_rate" | "completions" | undefined;
    const rows = await stats.breakdown(c.get("rt").db, q, dim, { limit: Number(c.req.query("limit") || 10), sort });
    return c.json({ range: rangeInfo(q), currency: q.site.currency, dimension: dim, rows });
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
    const data = await stats.realtime(c.get("rt").db, c.get("site"));
    if (c.get("isPublic")) {
      data.sessions = data.sessions.map((s) => scrub({ ...s, id: null }));
      // Event names are goal/outbound labels the public feed shows, so only drop the identifiers.
      data.events = data.events.map((e) => ({ ...e, visitor_id: null, session_id: null }));
      data.payments = data.payments.map((p) => scrub(p));
    }
    return c.json({ currency: c.get("site").currency, ...data });
  });

  app.get("/visitors", async (c) => {
    if (c.get("isPublic")) fail(403, "Visitor details are not available on public dashboards");
    const q = await statsQuery(c, c.get("site"));
    const rows = await stats.listVisitors(c.get("rt").db, q, {
      search: c.req.query("search") || undefined,
      customersOnly: c.req.query("customers") === "1",
      goal: c.req.query("goal") || null,
      limit: Number(c.req.query("limit") || 50),
      offset: Number(c.req.query("offset") || 0),
    });
    return c.json({ range: rangeInfo(q), currency: q.site.currency, visitors: rows });
  });

  app.get("/visitors/:visitorId", async (c) => {
    if (c.get("isPublic")) fail(403, "Visitor details are not available on public dashboards");
    const profile = await stats.visitorProfile(c.get("rt").db, c.get("site"), c.req.param("visitorId"));
    if (!profile) fail(404, "Visitor not found");
    return c.json({ currency: c.get("site").currency, ...profile });
  });

  app.get("/payments", async (c) => {
    const q = await statsQuery(c, c.get("site"));
    let rows = await stats.listPayments(c.get("rt").db, q, {
      limit: Number(c.req.query("limit") || 50),
      offset: Number(c.req.query("offset") || 0),
    });
    if (c.get("isPublic")) rows = rows.map((r) => scrub(r));
    return c.json({ range: rangeInfo(q), currency: q.site.currency, payments: rows });
  });

  app.get("/ltv", async (c) => {
    const q = await statsQuery(c, c.get("site"));
    const group = (c.req.query("group") ?? "source") as "source" | "channel" | "country" | "utm_campaign";
    return c.json({ range: rangeInfo(q), currency: q.site.currency, rows: await stats.customerLtv(c.get("rt").db, q, group) });
  });

  app.get("/mrr", async (c) => {
    const q = await statsQuery(c, c.get("site"));
    const report = await mrrReport(c.get("rt").db, q);
    return c.json({ range: rangeInfo(q), currency: q.site.currency, interval: q.range.interval, ...report });
  });

  app.get("/mrr/breakdown", async (c) => {
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
    return c.json({ range: rangeInfo(q), currency: site.currency, funnel: { id: row.id, name: row.name, steps }, results: await stats.funnelResults(c.get("rt").db, q, steps) });
  });

  app.post("/funnels/preview", async (c) => {
    const body = await readJson<{ steps?: stats.FunnelStep[] }>(c);
    const q = await statsQuery(c, c.get("site"));
    return c.json({ results: await stats.funnelResults(c.get("rt").db, q, Array.isArray(body.steps) ? body.steps : []) });
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
    const [funnels, goals] = await Promise.all([
      db.all<{ id: string; name: string; steps: string }>("SELECT id, name, steps FROM funnels WHERE site_id = ? ORDER BY created_at ASC", [site.id]),
      db.all<{ name: string }>(
        "SELECT DISTINCT name FROM events WHERE site_id = ? AND type = 'goal' AND ts > ? ORDER BY name LIMIT 200",
        [site.id, Date.now() - 365 * 24 * 60 * 60 * 1000],
      ),
    ]);
    return c.json({
      site: {
        id: site.id,
        name: site.name,
        domain: site.domain,
        timezone: site.timezone,
        currency: site.currency,
        kpiGoal: site.settings.kpiGoal ?? null,
        hideRevenue: !!site.settings.hideRevenue,
        attribution: site.settings.attribution ?? "last_non_direct",
        created_at: site.created_at,
      },
      funnels: funnels.map((f) => ({ id: f.id, name: f.name, steps: JSON.parse(f.steps) })),
      goals: goals.map((g) => g.name),
    });
  });

  return app;
}
