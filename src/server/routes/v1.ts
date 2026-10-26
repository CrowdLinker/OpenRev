import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../context";
import { parseInterval } from "../lib/billing";
import { isValidCurrency, toMinor } from "../lib/currency";
import { isValidClientId } from "../lib/ids";
import { clampString, isEmail, sanitizeGoalName, sanitizeProps } from "../lib/validate";
import { verifyApiKey } from "../services/auth";
import { identifyVisitor, recordServerGoal } from "../services/ingest";
import { mrrBreakdown, mrrGroup, mrrReport } from "../services/mrr";
import { deletePayment, recordPayment } from "../services/payments";
import { notifyPayment } from "../services/notify";
import type { Site } from "../services/sites";
import * as stats from "../services/stats";
import { buildStatsQuery, fail, rangeInfo, readJson, siteForUser } from "./helpers";
import { openApiSpec } from "./openapi";

/** Breakdown names used by DataFast's API, mapped to OpenRev dimensions. */
const DIMENSION_ALIASES: Record<string, stats.Dimension> = {
  pages: "page",
  "entry-pages": "entry_page",
  "exit-pages": "exit_page",
  referrers: "source",
  sources: "source",
  channels: "channel",
  countries: "country",
  regions: "region",
  cities: "city",
  devices: "device",
  browsers: "browser",
  "operating-systems": "os",
  os: "os",
  campaigns: "utm_campaign",
  hostnames: "hostname",
  "exit-clicks": "outbound",
  goals: "goal",
};

export function resolveDimension(name: string): stats.Dimension | null {
  const d = DIMENSION_ALIASES[name] ?? name.replace(/-/g, "_");
  return stats.isDimension(d) ? d : null;
}

/** Unix seconds, unix milliseconds or ISO 8601 → epoch ms. */
function parseTimestamp(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : /^\d+$/.test(String(v)) ? Number(v) : NaN;
  const t = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

function visitorFrom(body: Record<string, unknown>): string | null {
  for (const k of ["openrev_visitor_id", "visitor_id", "visitorId", "datafast_visitor_id"]) {
    const v = body[k];
    if (isValidClientId(v)) return v;
  }
  return null;
}

/** Converts a Payments API body (DataFast-compatible) into a recorded payment. */
export async function createPaymentFromApi(c: Context<AppEnv>, site: Site, body: Record<string, unknown>) {
  const rt = c.get("rt");
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) fail(422, "`amount` must be a positive number (e.g. 29.99)");
  const currency = String(body.currency ?? site.currency).toUpperCase();
  if (!isValidCurrency(currency)) fail(422, "`currency` must be an ISO 4217 code like USD");
  const transactionId = clampString(body.transaction_id ?? body.transactionId, 200);
  if (!transactionId) fail(422, "`transaction_id` is required");
  const refunded = body.refunded === true || body.type === "refund";
  const renewal = body.renewal === true || body.type === "renewal";
  const ts = parseTimestamp(body.timestamp);
  const provider = clampString(body.provider, 40)?.toLowerCase().replace(/[^a-z0-9_-]/g, "") || "api";
  const { payment, created } = await recordPayment(rt, site, {
    provider,
    transactionId,
    type: refunded ? "refund" : renewal ? "renewal" : "new",
    amount: toMinor(amount, currency),
    currency,
    timestamp: ts,
    visitorId: visitorFrom(body),
    sessionId: isValidClientId(body.openrev_session_id ?? body.datafast_session_id) ? String(body.openrev_session_id ?? body.datafast_session_id) : null,
    customerId: clampString(body.customer_id, 200),
    email: isEmail(body.email) ? body.email : null,
    name: clampString(body.name, 200),
    description: clampString(body.description, 300),
    subscriptionId: clampString(body.subscription_id, 200),
    interval: parseInterval(body.interval, body.interval_count),
    relatedTransactionId: clampString(body.related_transaction_id ?? (refunded ? body.original_transaction_id : null), 200),
  });
  if (created) rt.waitUntil(notifyPayment(rt, site, payment).catch(() => {}));
  return { payment, created };
}

export function v1Routes() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    if (c.req.method === "GET" && c.req.path === "/api/v1/openapi.json") return next();
    const auth = c.req.header("authorization") ?? "";
    const key = auth.replace(/^Bearer\s+/i, "").trim();
    const apiKey = key ? await verifyApiKey(c.get("rt").db, key) : null;
    if (!apiKey) return c.json({ status: "error", error: { code: 401, message: "Missing or invalid API key (Authorization: Bearer <key>)" } }, 401);
    c.set("apiKey", apiKey);
    await next();
  });

  app.onError((err, c) => {
    const status = err instanceof HTTPException ? err.status : 500;
    return c.json({ status: "error", error: { code: status, message: err.message } }, status);
  });

  const site = async (c: Context<AppEnv>, min: "viewer" | "admin" = "viewer") => {
    const apiKey = c.get("apiKey")!;
    const id = apiKey.siteId ?? c.req.query("websiteId") ?? c.req.query("website_id");
    if (!id) fail(400, "`websiteId` query parameter is required with account tokens");
    return (await siteForUser(c, id, min)).site;
  };
  const ok = (c: Context, data: unknown, extra: Record<string, unknown> = {}) => c.json({ status: "success", data, ...extra });

  app.get("/openapi.json", (c) => c.json(openApiSpec(new URL(c.req.url).origin)));

  app.get("/websites", async (c) => {
    const apiKey = c.get("apiKey")!;
    const db = c.get("rt").db;
    const rows = apiKey.siteId
      ? await db.all("SELECT id, domain, name, timezone, currency, created_at FROM sites WHERE id = ?", [apiKey.siteId])
      : await db.all(
          "SELECT s.id, s.domain, s.name, s.timezone, s.currency, s.created_at, m.role FROM sites s JOIN site_members m ON m.site_id = s.id WHERE m.user_id = ?",
          [apiKey.userId],
        );
    return ok(c, rows);
  });

  app.get("/analytics/overview", async (c) => {
    const s = await site(c);
    const q = await buildStatsQuery(c.get("rt").db, s, c.req.query());
    const { current, previous } = await stats.overview(c.get("rt").db, q, c.req.query("compare") !== "0");
    return ok(c, { ...current, currency: s.currency }, { previous, range: rangeInfo(q) });
  });

  app.get("/analytics/timeseries", async (c) => {
    const s = await site(c);
    const q = await buildStatsQuery(c.get("rt").db, s, c.req.query());
    return ok(c, await stats.timeseries(c.get("rt").db, q), { currency: s.currency, interval: q.range.interval, range: rangeInfo(q) });
  });

  app.get("/analytics/realtime", async (c) => {
    const s = await site(c);
    const r = await stats.realtime(c.get("rt").db, s);
    return ok(c, { visitors: r.visitors, sessions: r.sessions, recent_events: r.events, recent_payments: r.payments }, { currency: s.currency });
  });

  const breakdownHandler = async (c: Context<AppEnv>, dimName: string) => {
    const dim = resolveDimension(dimName);
    if (!dim) fail(404, `Unknown breakdown "${dimName}"`);
    const s = await site(c);
    const q = await buildStatsQuery(c.get("rt").db, s, c.req.query());
    const rows = await stats.breakdown(c.get("rt").db, q, dim, {
      limit: Number(c.req.query("limit") || 50),
      sort: c.req.query("sort") as never,
    });
    return ok(c, rows, { dimension: dim, currency: s.currency, range: rangeInfo(q) });
  };
  // Registered before /analytics/:dimension, which would otherwise take "mrr".
  app.get("/analytics/mrr", async (c) => {
    const s = await site(c);
    const q = await buildStatsQuery(c.get("rt").db, s, c.req.query());
    return ok(c, await mrrReport(c.get("rt").db, q), { currency: s.currency, interval: q.range.interval, range: rangeInfo(q) });
  });

  app.get("/analytics/mrr/breakdown", async (c) => {
    const s = await site(c);
    const q = await buildStatsQuery(c.get("rt").db, s, c.req.query());
    const group = mrrGroup(c.req.query("group"));
    return ok(c, await mrrBreakdown(c.get("rt").db, q, group), { currency: s.currency, group, range: rangeInfo(q) });
  });

  app.get("/analytics/breakdowns/:dimension", (c) => breakdownHandler(c, c.req.param("dimension")));
  app.get("/analytics/:dimension", (c) => breakdownHandler(c, c.req.param("dimension")));

  app.get("/visitors", async (c) => {
    const s = await site(c);
    const q = await buildStatsQuery(c.get("rt").db, s, c.req.query());
    const rows = await stats.listVisitors(c.get("rt").db, q, {
      search: c.req.query("search"),
      customersOnly: c.req.query("customers") === "1" || c.req.query("customers") === "true",
      goal: c.req.query("goal") ?? c.req.query("completed_goal") ?? null,
      limit: Number(c.req.query("limit") || 50),
      offset: Number(c.req.query("offset") || 0),
    });
    return ok(c, rows, { currency: s.currency, range: rangeInfo(q) });
  });

  app.get("/visitors/:visitorId", async (c) => {
    const s = await site(c);
    const profile = await stats.visitorProfile(c.get("rt").db, s, c.req.param("visitorId"));
    if (!profile) fail(404, "Visitor not found");
    return ok(c, profile, { currency: s.currency });
  });

  app.get("/payments", async (c) => {
    const s = await site(c);
    const q = await buildStatsQuery(c.get("rt").db, s, c.req.query());
    return ok(c, await stats.listPayments(c.get("rt").db, q, { limit: Number(c.req.query("limit") || 50), offset: Number(c.req.query("offset") || 0) }), {
      currency: s.currency,
      range: rangeInfo(q),
    });
  });

  app.post("/payments", async (c) => {
    const s = await site(c, "admin");
    const body = await readJson(c);
    const { payment, created } = await createPaymentFromApi(c, s, body);
    return c.json({ status: "success", data: payment, created }, created ? 201 : 200);
  });

  app.delete("/payments/:id", async (c) => {
    const s = await site(c, "admin");
    const deleted = await deletePayment(c.get("rt").db, s.id, c.req.param("id"));
    if (!deleted) fail(404, "Payment not found");
    return ok(c, { deleted: true });
  });

  app.post("/goals", async (c) => {
    const s = await site(c, "admin");
    const body = await readJson(c);
    const name = sanitizeGoalName(body.name ?? body.goal);
    if (!name) fail(422, "`name` is required (lowercase letters, numbers, _ - :)");
    const visitorId = visitorFrom(body);
    if (!visitorId) fail(422, "`openrev_visitor_id` (or `visitor_id`) is required");
    const result = await recordServerGoal(c.get("rt"), s, {
      name,
      visitorId,
      props: sanitizeProps(body.metadata ?? body.props ?? body.properties),
      timestamp: parseTimestamp(body.timestamp),
    });
    if (!result.ok) {
      fail(422, result.reason === "unknown_visitor" ? "No visit recorded for this visitor yet — make sure the tracking script runs before sending server-side goals." : result.reason);
    }
    return c.json({ status: "success", data: { name, visitor_id: visitorId } }, 201);
  });

  app.get("/goals", async (c) => {
    const s = await site(c);
    const q = await buildStatsQuery(c.get("rt").db, s, c.req.query());
    return ok(c, await stats.breakdown(c.get("rt").db, q, "goal", { limit: 200 }), { range: rangeInfo(q) });
  });

  app.post("/identify", async (c) => {
    const s = await site(c, "admin");
    const body = await readJson(c);
    const visitorId = visitorFrom(body);
    if (!visitorId) fail(422, "`openrev_visitor_id` (or `visitor_id`) is required");
    const { user_id, name, image, email, ...rest } = body as Record<string, unknown>;
    for (const k of ["openrev_visitor_id", "visitor_id", "visitorId", "datafast_visitor_id"]) delete rest[k];
    if (!user_id && !isEmail(email)) fail(422, "`user_id` (or `email`) is required");
    await identifyVisitor(c.get("rt"), s, {
      visitorId,
      userId: clampString(user_id, 200),
      name: clampString(name, 200),
      email: isEmail(email) ? email : null,
      image: clampString(image, 250),
      props: rest as Record<string, unknown>,
    });
    return ok(c, { visitor_id: visitorId });
  });

  app.get("/funnels", async (c) => {
    const s = await site(c);
    const rows = await c.get("rt").db.all<{ id: string; name: string; steps: string }>("SELECT id, name, steps FROM funnels WHERE site_id = ?", [s.id]);
    return ok(c, rows.map((r) => ({ ...r, steps: JSON.parse(r.steps) })));
  });

  app.get("/funnels/:funnelId", async (c) => {
    const s = await site(c);
    const row = await c.get("rt").db.first<{ id: string; name: string; steps: string }>("SELECT * FROM funnels WHERE id = ? AND site_id = ?", [c.req.param("funnelId"), s.id]);
    if (!row) fail(404, "Funnel not found");
    const q = await buildStatsQuery(c.get("rt").db, s, c.req.query());
    const steps = JSON.parse(row.steps);
    return ok(c, await stats.funnelResults(c.get("rt").db, q, steps), { funnel: { id: row.id, name: row.name, steps }, range: rangeInfo(q) });
  });

  app.get("/ltv", async (c) => {
    const s = await site(c);
    const q = await buildStatsQuery(c.get("rt").db, s, c.req.query());
    return ok(c, await stats.customerLtv(c.get("rt").db, q, (c.req.query("group") as "source") ?? "source"), { currency: s.currency, range: rangeInfo(q) });
  });

  return app;
}
