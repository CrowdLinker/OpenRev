import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getClientIpInfo, type AppEnv } from "../context";
import { geoFromHeaders } from "../lib/geo";
import { BADGE_TTL_MS, badgeData, badgeSvg, isShareToken } from "../services/badge";
import { handleWebhook } from "../services/integrations";
import { ingestEvent, type IncomingEvent } from "../services/ingest";
import { parseSite } from "../services/sites";
import { fail } from "./helpers";
import { statsRoutes } from "./stats";

const MAX_EVENT_BYTES = 32 * 1024;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const RASTER_TYPES = new Set(["image/x-icon", "image/vnd.microsoft.icon", "image/png", "image/gif", "image/jpeg", "image/webp"]);

export function publicRoutes() {
  const app = new Hono<AppEnv>();

  // ---- event collection (tracking script) -----------------------------------------

  const collect = async (c: Context<AppEnv>) => {
    const rt = c.get("rt");
    const text = await c.req.text();
    if (text.length > MAX_EVENT_BYTES) return c.json({ ok: false, reason: "payload_too_large" }, 413, corsHeaders);
    let body: IncomingEvent;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ ok: false, reason: "invalid_json" }, 400, corsHeaders);
    }
    const { ip, proxied } = getClientIpInfo(c);
    const resolved = rt.geo ? await rt.geo(ip, c.req.raw, proxied) : null;
    const geo = resolved?.country ? resolved : geoFromHeaders(c.req.raw.headers, { proxied });
    const result = await ingestEvent(rt, body, { ip, userAgent: c.req.header("user-agent") ?? "", geo });
    return c.json(result.ok ? { ok: true } : result, 202, corsHeaders);
  };

  const eventLimit = bodyLimit({ maxSize: MAX_EVENT_BYTES, onError: (c) => c.json({ ok: false, reason: "payload_too_large" }, 413, corsHeaders) });
  app.use("/api/events", eventLimit);
  app.use("/api/event", eventLimit);
  app.options("/api/events", (c) => c.body(null, 204, corsHeaders));
  app.post("/api/events", collect);
  // aliases (proxies, DataFast-style paths)
  app.options("/api/event", (c) => c.body(null, 204, corsHeaders));
  app.post("/api/event", collect);

  // ---- payment provider webhooks ------------------------------------------------------

  app.post("/api/webhooks/:integrationId", async (c) => {
    const rt = c.get("rt");
    const rawBody = await c.req.text();
    const outcome = await handleWebhook(rt, c.req.param("integrationId"), {
      rawBody,
      headers: c.req.raw.headers,
      url: new URL(c.req.url),
      method: c.req.method,
    });
    return c.json(outcome.body, outcome.status as 200);
  });

  // ---- public share links -----------------------------------------------------------------

  app.use("/api/share/:token/*", async (c, next) => {
    const token = c.req.param("token") ?? "";
    if (!/^[a-z0-9]{10,40}$/.test(token)) fail(404, "Dashboard not found");
    const row = await c.get("rt").db.first("SELECT * FROM sites WHERE share_token = ?", [token]);
    if (!row) fail(404, "Dashboard not found");
    c.set("site", parseSite(row as never));
    c.set("isPublic", true);
    await next();
  });
  app.route("/api/share/:token/stats", statsRoutes());

  // ---- live badge, embedded on other sites (docs/features/live-badge.md) --------------------------------

  const badgeHeaders = { "Access-Control-Allow-Origin": "*", "Cache-Control": `public, max-age=${BADGE_TTL_MS / 1000}` };

  app.get("/api/badge/:token", async (c) => {
    const token = c.req.param("token");
    const data = isShareToken(token) ? await badgeData(c.get("rt").db, token) : null;
    if (!data) return c.json({ error: "Badge not found" }, 404, badgeHeaders);
    return c.json(data, 200, badgeHeaders);
  });

  app.get("/api/badge/:token/badge.svg", async (c) => {
    const token = c.req.param("token");
    const data = isShareToken(token) ? await badgeData(c.get("rt").db, token) : null;
    if (!data) return c.text("Badge not found", 404, badgeHeaders);
    return c.body(badgeSvg(data, c.req.query("theme") === "dark" ? "dark" : "light"), 200, {
      ...badgeHeaders,
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    });
  });

  // ---- favicons for referrers (proxied so visitors' browsers don't call third parties) ----------

  app.get("/api/favicon/:domain", async (c) => {
    const domain = c.req.param("domain").toLowerCase();
    if (!/^[a-z0-9.-]{3,253}$/.test(domain)) return c.body(null, 404);
    try {
      const res = await fetch(`https://icons.duckduckgo.com/ip3/${domain}.ico`, { headers: { "User-Agent": "OpenRev" } });
      if (!res.ok || !res.body) return c.body(null, 404, { "Cache-Control": "public, max-age=86400" });
      // Served from our origin, so never trust the upstream type: raster images only, no sniffing, no scripts.
      const type = res.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
      return new Response(res.body, {
        headers: {
          "Content-Type": RASTER_TYPES.has(type) ? type : "image/x-icon",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cache-Control": "public, max-age=604800, immutable",
        },
      });
    } catch {
      return c.body(null, 404);
    }
  });

  return app;
}
