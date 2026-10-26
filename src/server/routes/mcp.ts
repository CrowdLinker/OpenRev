import { Hono } from "hono";
import { VERSION, type AppEnv, type ApiKeyAuth, type Runtime } from "../context";
import { uuid } from "../lib/ids";
import { verifyApiKey } from "../services/auth";
import { mrrBreakdown, mrrGroup, mrrReport } from "../services/mrr";
import { getMemberRole, getSite, roleAtLeast, type Role, type Site } from "../services/sites";
import * as stats from "../services/stats";
import { buildStatsQuery, rangeInfo } from "./helpers";
import { resolveDimension } from "./v1";

/** Each batch entry can run a full stats query, so keep batches small. */
const MAX_BATCH = 20;

/**
 * Minimal Model Context Protocol server (Streamable HTTP transport, JSON responses).
 * Connect Claude, Cursor or any MCP client to https://your-openrev/mcp with
 * `Authorization: Bearer <OpenRev API key>`.
 */

type Args = Record<string, unknown>;

const rangeProps = {
  period: { type: "string", enum: ["today", "yesterday", "24h", "7d", "30d", "90d", "wtd", "mtd", "ytd", "12m", "all"], description: "Date range preset (default 7d)" },
  from: { type: "string", description: "Custom start date YYYY-MM-DD" },
  to: { type: "string", description: "Custom end date YYYY-MM-DD (inclusive)" },
  filters: {
    type: "array",
    description: "Filters, e.g. [{dim:'country', op:'is', values:['US']}]",
    items: { type: "object", properties: { dim: { type: "string" }, op: { type: "string" }, values: { type: "array", items: { type: "string" } } } },
  },
};
const websiteProp = { websiteId: { type: "string", description: "Website id (required with account tokens; see list_websites)" } };

const TOOLS = [
  { name: "list_websites", description: "List the websites this key can access.", inputSchema: { type: "object", properties: {} } },
  {
    name: "get_overview",
    description: "Key metrics for a website: visitors, revenue, conversion rate, revenue per visitor, bounce rate, session duration, with comparison to the previous period.",
    inputSchema: { type: "object", properties: { ...websiteProp, ...rangeProps } },
  },
  {
    name: "get_timeseries",
    description: "Visitors, revenue and other metrics over time.",
    inputSchema: { type: "object", properties: { ...websiteProp, ...rangeProps, interval: { type: "string", enum: ["hour", "day", "week", "month"] } } },
  },
  {
    name: "get_breakdown",
    description:
      "Visitors, revenue, customers and conversion rate broken down by a dimension: channel, source, referrer, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref, page, entry_page, exit_page, hostname, outbound, country, region, city, device, browser, os, goal.",
    inputSchema: {
      type: "object",
      required: ["dimension"],
      properties: { ...websiteProp, ...rangeProps, dimension: { type: "string" }, limit: { type: "number" }, sort: { type: "string", enum: ["visitors", "revenue", "conversion_rate"] } },
    },
  },
  { name: "get_realtime", description: "Visitors online right now with their current page, location, source and buyer-intent score.", inputSchema: { type: "object", properties: { ...websiteProp } } },
  {
    name: "list_visitors",
    description: "Visitors in a period with identity, first source and revenue. Use customers_only to list paying customers.",
    inputSchema: { type: "object", properties: { ...websiteProp, ...rangeProps, search: { type: "string" }, customers_only: { type: "boolean" }, goal: { type: "string" } } },
  },
  { name: "get_visitor", description: "Full journey of one visitor: sessions, pages, goals and payments.", inputSchema: { type: "object", required: ["visitor_id"], properties: { ...websiteProp, visitor_id: { type: "string" } } } },
  { name: "list_payments", description: "Payments in a period with their attributed source.", inputSchema: { type: "object", properties: { ...websiteProp, ...rangeProps, limit: { type: "number" } } } },
  {
    name: "get_ltv",
    description: "Customers acquired in a period grouped by first-touch source with lifetime value, renewals and repeat purchase rate.",
    inputSchema: { type: "object", properties: { ...websiteProp, ...rangeProps, group_by: { type: "string", enum: ["source", "channel", "country", "utm_campaign"] } } },
  },
  {
    name: "get_mrr",
    description:
      "Monthly recurring revenue for a period: MRR and ARR at the end, subscribers, ARPU, new/expansion/reactivation/contraction/churn MRR, churn rate, revenue churn and net revenue retention, plus MRR over time.",
    inputSchema: { type: "object", properties: { ...websiteProp, ...rangeProps } },
  },
  {
    name: "get_mrr_breakdown",
    description: "Current MRR, MRR won and MRR churned in a period, grouped by the channel, source, campaign or country that brought each subscription in.",
    inputSchema: { type: "object", properties: { ...websiteProp, ...rangeProps, group_by: { type: "string", enum: ["channel", "source", "utm_campaign", "country"] } } },
  },
  { name: "list_funnels", description: "List the funnels defined for a website.", inputSchema: { type: "object", properties: { ...websiteProp } } },
  { name: "get_funnel", description: "Conversion and drop-off for each step of a funnel.", inputSchema: { type: "object", required: ["funnel_id"], properties: { ...websiteProp, ...rangeProps, funnel_id: { type: "string" } } } },
  {
    name: "add_note",
    description: "Add an annotation to the website chart (e.g. 'Launched on Product Hunt').",
    inputSchema: { type: "object", required: ["text"], properties: { ...websiteProp, text: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD, defaults to today" } } },
  },
];

async function resolveSite(rt: Runtime, key: ApiKeyAuth, args: Args): Promise<{ site: Site; role: Role }> {
  const id = key.siteId ?? (typeof args.websiteId === "string" ? args.websiteId : null);
  if (!id) throw new Error("websiteId is required with account tokens. Call list_websites first.");
  if (key.siteId && key.siteId !== id) throw new Error("This API key belongs to another website");
  const site = await getSite(rt.db, id);
  if (!site) throw new Error("Website not found");
  const user = await rt.db.first<{ is_admin: number }>("SELECT is_admin FROM users WHERE id = ?", [key.userId]);
  const role = (await getMemberRole(rt.db, id, key.userId)) ?? (user?.is_admin ? "owner" : null);
  if (!role) throw new Error("Website not found");
  return { site, role };
}

function queryArgs(args: Args): Record<string, string | undefined> {
  return {
    period: args.period as string | undefined,
    from: args.from as string | undefined,
    to: args.to as string | undefined,
    interval: args.interval as string | undefined,
    filters: Array.isArray(args.filters) ? JSON.stringify(args.filters) : undefined,
  };
}

async function callTool(rt: Runtime, key: ApiKeyAuth, name: string, args: Args): Promise<unknown> {
  if (name === "list_websites") {
    return key.siteId
      ? rt.db.all("SELECT id, domain, name, timezone, currency FROM sites WHERE id = ?", [key.siteId])
      : rt.db.all("SELECT s.id, s.domain, s.name, s.timezone, s.currency FROM sites s JOIN site_members m ON m.site_id = s.id WHERE m.user_id = ?", [key.userId]);
  }
  const { site, role } = await resolveSite(rt, key, args);
  const q = await buildStatsQuery(rt.db, site, queryArgs(args));
  const money = { currency: site.currency, note: "Monetary values are in minor units (cents) of `currency`." };
  switch (name) {
    case "get_overview":
      return { range: rangeInfo(q), ...money, ...(await stats.overview(rt.db, q)) };
    case "get_timeseries":
      return { range: rangeInfo(q), ...money, points: await stats.timeseries(rt.db, q) };
    case "get_breakdown": {
      const dim = resolveDimension(String(args.dimension ?? ""));
      if (!dim) throw new Error(`Unknown dimension ${args.dimension}`);
      return { range: rangeInfo(q), ...money, rows: await stats.breakdown(rt.db, q, dim, { limit: Number(args.limit ?? 20), sort: args.sort as never }) };
    }
    case "get_realtime": {
      const r = await stats.realtime(rt.db, site);
      return { visitors_online: r.visitors, sessions: r.sessions.slice(0, 50), recent_payments: r.payments, ...money };
    }
    case "list_visitors":
      return { range: rangeInfo(q), ...money, visitors: await stats.listVisitors(rt.db, q, { search: args.search as string, customersOnly: !!args.customers_only, goal: (args.goal as string) ?? null }) };
    case "get_visitor":
      return { ...money, ...(await stats.visitorProfile(rt.db, site, String(args.visitor_id))) };
    case "list_payments":
      return { range: rangeInfo(q), ...money, payments: await stats.listPayments(rt.db, q, { limit: Number(args.limit ?? 50) }) };
    case "get_ltv":
      return { range: rangeInfo(q), ...money, rows: await stats.customerLtv(rt.db, q, (args.group_by as "source") ?? "source") };
    case "get_mrr":
      return { range: rangeInfo(q), ...money, ...(await mrrReport(rt.db, q)) };
    case "get_mrr_breakdown": {
      const group = mrrGroup(args.group_by);
      return { range: rangeInfo(q), ...money, group, rows: await mrrBreakdown(rt.db, q, group) };
    }
    case "list_funnels": {
      const rows = await rt.db.all<{ id: string; name: string; steps: string }>("SELECT id, name, steps FROM funnels WHERE site_id = ?", [site.id]);
      return rows.map((r) => ({ ...r, steps: JSON.parse(r.steps) }));
    }
    case "get_funnel": {
      const row = await rt.db.first<{ steps: string; name: string }>("SELECT name, steps FROM funnels WHERE id = ? AND site_id = ?", [String(args.funnel_id), site.id]);
      if (!row) throw new Error("Funnel not found");
      return { name: row.name, range: rangeInfo(q), results: await stats.funnelResults(rt.db, q, JSON.parse(row.steps)) };
    }
    case "add_note": {
      if (!roleAtLeast(role, "admin")) throw new Error("Adding notes requires the admin role");
      const text = String(args.text ?? "").trim();
      if (!text) throw new Error("text is required");
      const date = typeof args.date === "string" ? args.date : null;
      const range = await buildStatsQuery(rt.db, site, date ? { from: date, to: date } : { period: "today" });
      const id = uuid();
      await rt.db.run("INSERT INTO notes (id, site_id, ts, text, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", [id, site.id, range.range.from, text.slice(0, 500), key.userId, Date.now()]);
      return { id, created: true };
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

async function handleRpc(rt: Runtime, key: ApiKeyAuth, req: RpcRequest) {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: req.id ?? null, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: req.id ?? null, error: { code, message } });
  switch (req.method) {
    case "initialize":
      return reply({
        protocolVersion: (req.params?.protocolVersion as string) ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "openrev", version: VERSION },
        instructions: "OpenRev web analytics with revenue attribution. Start with list_websites, then get_overview or get_breakdown.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const args = (req.params?.arguments as Args) ?? {};
      try {
        const result = await callTool(rt, key, name, args);
        return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        return reply({ content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true });
      }
    }
    default:
      if (req.method.startsWith("notifications/")) return null;
      return error(-32601, `Method not found: ${req.method}`);
  }
}

export function mcpRoutes() {
  const app = new Hono<AppEnv>();
  app.get("/", (c) => c.json({ error: "Use POST with JSON-RPC (MCP Streamable HTTP transport)." }, 405));
  app.delete("/", (c) => c.body(null, 204));
  app.post("/", async (c) => {
    const rt = c.get("rt");
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim() || c.req.query("key") || "";
    const key = token ? await verifyApiKey(rt.db, token) : null;
    if (!key) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: pass an OpenRev API key as a Bearer token" } }, 401);
    let body: RpcRequest | RpcRequest[];
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    if (Array.isArray(body)) {
      if (body.length > MAX_BATCH) {
        return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `Batches are limited to ${MAX_BATCH} requests` } }, 400);
      }
      const results = (await Promise.all(body.map((r) => handleRpc(rt, key, r)))).filter(Boolean);
      return results.length ? c.json(results) : c.body(null, 202);
    }
    const result = await handleRpc(rt, key, body);
    return result ? c.json(result) : c.body(null, 202);
  });
  return app;
}
