import { Hono } from "hono";
import { publicUrl, type AppEnv } from "../context";
import type { Statement } from "../db/types";
import { isValidCurrency } from "../lib/currency";
import { sha256Hex } from "../lib/crypto";
import { randomId, randomToken, uuid } from "../lib/ids";
import { isValidTimezone, resolveRange } from "../lib/time";
import { publicHttpsUrl } from "../lib/net";
import { isEmail, sanitizeGoalName } from "../lib/validate";
import { getProvider, providerCatalog } from "../providers";
import { ALERT_CHANNELS, ALERT_TYPES, invalidateAlerts, sendTestAlert, TELEGRAM_TOKEN, type AlertRow } from "../services/alerts";
import { createApiKey } from "../services/auth";
import { clearBadgeCache } from "../services/badge";
import { emailEnabled, escapeHtml, sendEmail } from "../services/email";
import { decryptConfig, encryptConfig, importPage, publicIntegration, type IntegrationRow } from "../services/integrations";
import { recomputeRevenue } from "../services/payments";
import {
  claimInvite,
  findInvite,
  getMemberRole,
  getSite,
  invalidateSite,
  isValidDomain,
  normalizeDomain,
  parseSite,
  roleAtLeast,
  type AttributionModel,
  type Role,
  type SiteSettings,
} from "../services/sites";
import * as stats from "../services/stats";
import { fail, readJson, requireUser, siteForUser, stringList } from "./helpers";
import { importRoutes } from "./imports";
import { statsRoutes } from "./stats";

const ROLES: Role[] = ["owner", "admin", "viewer"];

export function siteRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/providers", (c) => c.json({ providers: providerCatalog() }));

  // ---- list & create ---------------------------------------------------------

  app.get("/sites", async (c) => {
    const user = requireUser(c);
    const db = c.get("rt").db;
    const rows = await db.all<Record<string, unknown>>(
      user.is_admin
        ? `SELECT s.*, COALESCE(m.role, 'owner') AS role FROM sites s LEFT JOIN site_members m ON m.site_id = s.id AND m.user_id = ? ORDER BY s.created_at ASC`
        : `SELECT s.*, m.role FROM sites s JOIN site_members m ON m.site_id = s.id AND m.user_id = ? ORDER BY s.created_at ASC`,
      [user.id],
    );
    const sites = await Promise.all(
      rows.map(async (row) => {
        const site = parseSite(row as never);
        const range = resolveRange(site.timezone, { period: "7d" });
        const q = { site, range, filters: [] };
        const [series, realtime] = await Promise.all([
          stats.timeseries(db, q, "day"),
          db.first<{ v: number }>("SELECT COUNT(DISTINCT visitor_id) AS v FROM sessions WHERE site_id = ? AND last_seen_at > ?", [site.id, Date.now() - stats.REALTIME_WINDOW]),
        ]);
        return {
          id: site.id,
          name: site.name,
          domain: site.domain,
          currency: site.currency,
          timezone: site.timezone,
          role: row.role,
          hideRevenue: !!site.settings.hideRevenue,
          visitors: series.reduce((a, p) => a + p.visitors, 0),
          revenue: series.reduce((a, p) => a + p.revenue, 0),
          online: Number(realtime?.v ?? 0),
          series: series.map((p) => ({ date: p.date, visitors: p.visitors, revenue: p.revenue })),
        };
      }),
    );
    return c.json({ sites });
  });

  app.post("/sites", async (c) => {
    const user = requireUser(c);
    const db = c.get("rt").db;
    const body = await readJson<{ domain?: string; name?: string; timezone?: string; currency?: string }>(c);
    const domain = normalizeDomain(body.domain ?? "");
    if (!isValidDomain(domain)) fail(400, "Please enter a valid domain, like example.com");
    const timezone = body.timezone && isValidTimezone(body.timezone) ? body.timezone : "UTC";
    const currency = body.currency && isValidCurrency(body.currency) ? body.currency.toUpperCase() : "USD";
    const id = randomId(12);
    const now = Date.now();
    await db.batch([
      {
        sql: "INSERT INTO sites (id, domain, name, timezone, currency, settings, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params: [id, domain, body.name?.trim() || domain, timezone, currency, JSON.stringify({ attribution: "last_non_direct" }), user.id, now],
      },
      { sql: "INSERT INTO site_members (site_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", params: [id, user.id, now] },
    ]);
    return c.json({ site: await getSite(db, id) });
  });

  // ---- single site -------------------------------------------------------------

  app.get("/sites/:siteId", async (c) => {
    const { site, role } = await siteForUser(c, c.req.param("siteId"));
    return c.json({ site, role });
  });

  app.patch("/sites/:siteId", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const rt = c.get("rt");
    const body = await readJson<{
      name?: string;
      domain?: string;
      timezone?: string;
      currency?: string;
      settings?: Partial<SiteSettings>;
    }>(c);
    const updates: Record<string, string> = {};
    if (body.name !== undefined) updates.name = String(body.name).trim().slice(0, 100) || site.domain;
    if (body.domain !== undefined) {
      const d = normalizeDomain(body.domain);
      if (!isValidDomain(d)) fail(400, "Invalid domain");
      updates.domain = d;
    }
    if (body.timezone !== undefined) {
      if (!isValidTimezone(body.timezone)) fail(400, "Invalid timezone");
      updates.timezone = body.timezone;
    }
    let currencyChanged = false;
    if (body.currency !== undefined) {
      if (!isValidCurrency(body.currency)) fail(400, "Invalid currency");
      updates.currency = body.currency.toUpperCase();
      currencyChanged = updates.currency !== site.currency;
    }
    if (body.settings) {
      const s = body.settings;
      const next: SiteSettings = { ...site.settings };
      if (s.allowedHostnames !== undefined) next.allowedHostnames = stringList(s.allowedHostnames).map(normalizeDomain).filter(isValidDomain);
      if (s.excludedIps !== undefined) next.excludedIps = stringList(s.excludedIps);
      if (s.excludedPaths !== undefined) {
        const paths = stringList(s.excludedPaths);
        if (paths.some((p) => p.length > 300)) fail(400, "Path patterns can be at most 300 characters");
        next.excludedPaths = paths;
      }
      if (s.excludedCountries !== undefined) next.excludedCountries = stringList(s.excludedCountries).map((x) => x.toUpperCase().slice(0, 2));
      if (s.excludedHostnames !== undefined) next.excludedHostnames = stringList(s.excludedHostnames).map((h) => h.toLowerCase().replace(/^www\./, ""));
      if (s.cookieless !== undefined) next.cookieless = !!s.cookieless;
      if (s.allowLocalhost !== undefined) next.allowLocalhost = !!s.allowLocalhost;
      if (s.strictHostnames !== undefined) next.strictHostnames = !!s.strictHostnames;
      if (s.hideRevenue !== undefined) next.hideRevenue = !!s.hideRevenue;
      if (s.kpiGoal !== undefined) next.kpiGoal = s.kpiGoal ? sanitizeGoalName(s.kpiGoal) : null;
      if (s.attribution !== undefined) {
        if (!["last_non_direct", "last_touch", "first_touch"].includes(s.attribution as string)) fail(400, "Invalid attribution model");
        next.attribution = s.attribution as AttributionModel;
      }
      updates.settings = JSON.stringify(next);
    }
    const keys = Object.keys(updates);
    if (keys.length) {
      await rt.db.run(`UPDATE sites SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => updates[k]), site.id]);
    }
    invalidateSite(site.id);
    const updated = (await getSite(rt.db, site.id))!;
    if (currencyChanged) rt.waitUntil(recomputeRevenue(rt, updated).catch(() => {}));
    return c.json({ site: updated });
  });

  app.delete("/sites/:siteId", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "owner");
    await c.get("rt").db.batch(deleteSiteStatements(site.id, true));
    invalidateSite(site.id);
    return c.json({ ok: true });
  });

  app.post("/sites/:siteId/reset", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "owner");
    await c.get("rt").db.batch(deleteSiteStatements(site.id, false));
    return c.json({ ok: true });
  });

  /** Installation check: has the tracker sent anything yet? */
  app.get("/sites/:siteId/verify", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"));
    const db = c.get("rt").db;
    const last = await db.first<{ ts: number; hostname: string; path: string }>(
      "SELECT ts, hostname, path FROM events WHERE site_id = ? ORDER BY ts DESC LIMIT 1",
      [site.id],
    );
    const count = await db.first<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE site_id = ?", [site.id]);
    return c.json({ installed: !!last, lastEvent: last ? { ...last, ts: Number(last.ts) } : null, events: Number(count?.c ?? 0) });
  });

  app.post("/sites/:siteId/share", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const body = await readJson<{ enabled?: boolean }>(c);
    const token = body.enabled ? site.share_token ?? randomId(20) : null;
    await c.get("rt").db.run("UPDATE sites SET share_token = ? WHERE id = ?", [token, site.id]);
    invalidateSite(site.id);
    // The live badge caches counts per token; drop them so a turned-off link stops answering here at once.
    if (!token && site.share_token) clearBadgeCache(site.share_token);
    return c.json({ share_token: token, url: token ? `${publicUrl(c)}/share/${token}` : null });
  });

  // ---- stats -------------------------------------------------------------------

  const statsApp = statsRoutes();
  app.use("/sites/:siteId/stats/*", async (c, next) => {
    const { site } = await siteForUser(c, c.req.param("siteId")!);
    c.set("site", site);
    c.set("isPublic", false);
    await next();
  });
  app.route("/sites/:siteId/stats", statsApp);
  app.route("/sites/:siteId/imports", importRoutes());

  // ---- team -------------------------------------------------------------------

  app.get("/sites/:siteId/members", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"));
    const db = c.get("rt").db;
    const [members, invites] = await Promise.all([
      db.all("SELECT u.id, u.email, u.name, m.role, m.created_at FROM site_members m JOIN users u ON u.id = m.user_id WHERE m.site_id = ? ORDER BY m.created_at ASC", [site.id]),
      db.all("SELECT id, email, role, created_at, expires_at FROM invites WHERE site_id = ? AND expires_at > ? ORDER BY created_at DESC", [site.id, Date.now()]),
    ]);
    return c.json({ members, invites: invites.map((i) => ({ ...i, id: String(i.id).slice(0, 12) })) });
  });

  app.post("/sites/:siteId/invites", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const rt = c.get("rt");
    const user = requireUser(c);
    const body = await readJson<{ email?: string; role?: Role }>(c);
    const role: Role = body.role && ROLES.includes(body.role) && body.role !== "owner" ? body.role : "viewer";
    const email = body.email && isEmail(body.email) ? body.email.toLowerCase() : null;
    // Everyone gets a link, even if an account with this email exists: account emails aren't verified,
    // so membership is only granted to whoever opens the link sent to that mailbox.
    const token = randomToken(24);
    await rt.db.run("INSERT INTO invites (id, site_id, email, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      await sha256Hex(token),
      site.id,
      email,
      role,
      user.id,
      Date.now(),
      Date.now() + 14 * 86_400_000,
    ]);
    const url = `${publicUrl(c)}/invite/${token}`;
    let emailed = false;
    if (email && emailEnabled(rt)) {
      try {
        await sendEmail(rt, {
          to: email,
          subject: `You've been invited to ${site.name} on OpenRev`,
          html: `<p>${escapeHtml(user.name || user.email)} invited you to view analytics for <b>${escapeHtml(site.domain)}</b> on OpenRev.</p><p><a href="${url}">Accept invitation →</a></p>`,
        });
        emailed = true;
      } catch {
        emailed = false;
      }
    }
    return c.json({ url, emailed });
  });

  app.delete("/sites/:siteId/invites/:inviteId", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    await c.get("rt").db.run("DELETE FROM invites WHERE site_id = ? AND id LIKE ?", [site.id, c.req.param("inviteId").replace(/[%_]/g, "") + "%"]);
    return c.json({ ok: true });
  });

  app.patch("/sites/:siteId/members/:userId", async (c) => {
    const { site, role: myRole } = await siteForUser(c, c.req.param("siteId"), "admin");
    const body = await readJson<{ role?: Role }>(c);
    if (!body.role || !ROLES.includes(body.role)) fail(400, "Invalid role");
    if (body.role === "owner" && myRole !== "owner") fail(403, "Only owners can grant the owner role");
    const db = c.get("rt").db;
    const target = c.req.param("userId");
    const current = await getMemberRole(db, site.id, target);
    if (current === "owner" && body.role !== "owner") {
      if (myRole !== "owner") fail(403, "Only owners can change an owner's role");
      const owners = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM site_members WHERE site_id = ? AND role = 'owner'", [site.id]);
      if (Number(owners?.n ?? 0) <= 1) fail(400, "A website needs at least one owner");
    }
    await db.batch([
      { sql: "UPDATE site_members SET role = ? WHERE site_id = ? AND user_id = ?", params: [body.role, site.id, target] },
      // A member who can no longer invite loses the invitation links they created.
      ...(roleAtLeast(body.role, "admin") ? [] : [{ sql: "DELETE FROM invites WHERE site_id = ? AND created_by = ?", params: [site.id, target] }]),
    ]);
    return c.json({ ok: true });
  });

  app.delete("/sites/:siteId/members/:userId", async (c) => {
    const user = requireUser(c);
    const target = c.req.param("userId");
    const { site, role: myRole } = await siteForUser(c, c.req.param("siteId"), target === user.id ? "viewer" : "admin");
    const db = c.get("rt").db;
    const owners = await db.all<{ user_id: string }>("SELECT user_id FROM site_members WHERE site_id = ? AND role = 'owner'", [site.id]);
    if (target !== user.id && myRole !== "owner" && owners.some((o) => o.user_id === target)) fail(403, "Only owners can remove an owner");
    if (owners.length === 1 && owners[0].user_id === target) fail(400, "A website needs at least one owner");
    await db.batch([
      { sql: "DELETE FROM site_members WHERE site_id = ? AND user_id = ?", params: [site.id, target] },
      { sql: "DELETE FROM invites WHERE site_id = ? AND created_by = ?", params: [site.id, target] },
    ]);
    return c.json({ ok: true });
  });

  // Invitations (accepting)
  app.get("/invites/:token", async (c) => {
    const db = c.get("rt").db;
    const invite = await findInvite(db, await sha256Hex(c.req.param("token")));
    if (!invite) fail(404, "This invitation is invalid or has expired");
    const site = await getSite(db, invite.site_id);
    return c.json({ site: site ? { name: site.name, domain: site.domain } : null, role: invite.role, email: invite.email });
  });

  app.post("/invites/:token/accept", async (c) => {
    const user = requireUser(c);
    const db = c.get("rt").db;
    const invite = await claimInvite(db, await sha256Hex(c.req.param("token")));
    if (!invite) fail(404, "This invitation is invalid or has expired");
    await db.run("INSERT INTO site_members (site_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (site_id, user_id) DO NOTHING", [
      invite.site_id,
      user.id,
      invite.role,
      Date.now(),
    ]);
    return c.json({ siteId: invite.site_id });
  });

  // ---- API keys ------------------------------------------------------------------

  app.get("/sites/:siteId/keys", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const keys = await c.get("rt").db.all("SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE site_id = ? ORDER BY created_at DESC", [site.id]);
    return c.json({ keys });
  });

  app.post("/sites/:siteId/keys", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const user = requireUser(c);
    const body = await readJson<{ name?: string }>(c);
    return c.json(await createApiKey(c.get("rt").db, { userId: user.id, siteId: site.id, name: body.name?.trim() || "API key" }));
  });

  app.delete("/sites/:siteId/keys/:keyId", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    await c.get("rt").db.run("DELETE FROM api_keys WHERE id = ? AND site_id = ?", [c.req.param("keyId"), site.id]);
    return c.json({ ok: true });
  });

  // ---- revenue integrations ------------------------------------------------------------

  app.get("/sites/:siteId/integrations", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const rt = c.get("rt");
    const rows = await rt.db.all<IntegrationRow>("SELECT * FROM integrations WHERE site_id = ? ORDER BY created_at ASC", [site.id]);
    const base = publicUrl(c);
    return c.json({ integrations: await Promise.all(rows.map((r) => publicIntegration(rt, r, base))), providers: providerCatalog() });
  });

  app.post("/sites/:siteId/integrations", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const rt = c.get("rt");
    const body = await readJson<{ provider?: string; name?: string; config?: Record<string, string> }>(c);
    const provider = getProvider(body.provider ?? "");
    if (!provider) fail(400, "Unknown provider");
    const config: Record<string, string> = {};
    for (const f of provider.fields) {
      const v = body.config?.[f.key];
      if (typeof v === "string" && v.trim()) config[f.key] = v.trim();
      // URL tokens are generated for the user; signing secrets can be added after the webhook is registered
      // (most providers only reveal the secret once the endpoint URL exists).
      else if (f.key === "token") config[f.key] = randomToken(24);
      else if (f.required && !f.secret) fail(400, `${f.label} is required`);
    }
    const id = randomId(24);
    await rt.db.run("INSERT INTO integrations (id, site_id, provider, name, config, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)", [
      id,
      site.id,
      provider.id,
      body.name?.trim() || provider.name,
      await encryptConfig(rt, config),
      Date.now(),
    ]);
    const row = (await rt.db.first<IntegrationRow>("SELECT * FROM integrations WHERE id = ?", [id]))!;
    return c.json({ integration: await publicIntegration(rt, row, publicUrl(c)) });
  });

  app.patch("/sites/:siteId/integrations/:integrationId", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const rt = c.get("rt");
    const row = await rt.db.first<IntegrationRow>("SELECT * FROM integrations WHERE id = ? AND site_id = ?", [c.req.param("integrationId"), site.id]);
    if (!row) fail(404, "Integration not found");
    const provider = getProvider(row.provider);
    const body = await readJson<{ name?: string; enabled?: boolean; config?: Record<string, string> }>(c);
    // Unreadable settings (OPENREV_SECRET changed) start empty, so re-entering the keys repairs the integration.
    const decrypted = await decryptConfig(rt, row);
    const config = decrypted ?? {};
    if (body.config && provider) {
      for (const f of provider.fields) {
        const v = body.config[f.key];
        if (v === undefined) continue;
        // masked values coming back from the UI are left unchanged
        if (typeof v === "string" && v.startsWith("••••")) continue;
        if (typeof v === "string" && v.trim()) config[f.key] = v.trim();
        else delete config[f.key];
      }
    }
    await rt.db.run("UPDATE integrations SET name = ?, enabled = ?, config = ?, last_error = ? WHERE id = ?", [
      body.name?.trim() || row.name,
      body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
      await encryptConfig(rt, config),
      decrypted ? row.last_error : null,
      row.id,
    ]);
    const updated = (await rt.db.first<IntegrationRow>("SELECT * FROM integrations WHERE id = ?", [row.id]))!;
    return c.json({ integration: await publicIntegration(rt, updated, publicUrl(c)) });
  });

  app.delete("/sites/:siteId/integrations/:integrationId", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    await c.get("rt").db.run("DELETE FROM integrations WHERE id = ? AND site_id = ?", [c.req.param("integrationId"), site.id]);
    return c.json({ ok: true });
  });

  /** Imports one page of past payments. The dashboard calls this repeatedly until `nextCursor` is null. */
  app.post("/sites/:siteId/integrations/:integrationId/import", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const rt = c.get("rt");
    const row = await rt.db.first<IntegrationRow>("SELECT * FROM integrations WHERE id = ? AND site_id = ?", [c.req.param("integrationId"), site.id]);
    if (!row) fail(404, "Integration not found");
    const body = await readJson<{ cursor?: string | null }>(c);
    try {
      return c.json(await importPage(rt, row, body.cursor ?? null));
    } catch (err) {
      fail(400, err instanceof Error ? err.message : String(err));
    }
  });

  // ---- funnels -------------------------------------------------------------------

  const cleanSteps = (steps: unknown) => {
    if (!Array.isArray(steps) || steps.length < 1) fail(400, "A funnel needs at least one step");
    return (steps as stats.FunnelStep[]).slice(0, 10).map((s) => {
      const type = ["page", "goal", "payment"].includes(s.type) ? s.type : "page";
      const value = type === "payment" ? undefined : String(s.value ?? "").trim().slice(0, 300);
      if (type !== "payment" && !value) fail(400, "Every funnel step needs a value");
      return {
        type,
        value,
        match: s.match && ["equals", "contains", "starts_with"].includes(s.match) ? s.match : "equals",
        label: s.label ? String(s.label).slice(0, 100) : undefined,
      } as stats.FunnelStep;
    });
  };

  app.get("/sites/:siteId/funnels", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"));
    const rows = await c.get("rt").db.all<{ id: string; name: string; steps: string; created_at: number }>(
      "SELECT * FROM funnels WHERE site_id = ? ORDER BY created_at ASC",
      [site.id],
    );
    return c.json({ funnels: rows.map((r) => ({ id: r.id, name: r.name, steps: JSON.parse(r.steps), created_at: r.created_at })) });
  });

  app.post("/sites/:siteId/funnels", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const body = await readJson<{ name?: string; steps?: unknown }>(c);
    const id = uuid();
    const steps = cleanSteps(body.steps);
    await c.get("rt").db.run("INSERT INTO funnels (id, site_id, name, steps, created_at) VALUES (?, ?, ?, ?, ?)", [
      id,
      site.id,
      body.name?.trim().slice(0, 100) || "Funnel",
      JSON.stringify(steps),
      Date.now(),
    ]);
    return c.json({ funnel: { id, name: body.name || "Funnel", steps } });
  });

  app.patch("/sites/:siteId/funnels/:funnelId", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const body = await readJson<{ name?: string; steps?: unknown }>(c);
    const steps = body.steps ? JSON.stringify(cleanSteps(body.steps)) : null;
    await c.get("rt").db.run("UPDATE funnels SET name = COALESCE(?, name), steps = COALESCE(?, steps) WHERE id = ? AND site_id = ?", [
      body.name?.trim().slice(0, 100) || null,
      steps,
      c.req.param("funnelId"),
      site.id,
    ]);
    return c.json({ ok: true });
  });

  app.delete("/sites/:siteId/funnels/:funnelId", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    await c.get("rt").db.run("DELETE FROM funnels WHERE id = ? AND site_id = ?", [c.req.param("funnelId"), site.id]);
    return c.json({ ok: true });
  });

  // ---- notes (chart annotations) ------------------------------------------------------

  app.post("/sites/:siteId/notes", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const user = requireUser(c);
    const body = await readJson<{ ts?: number; date?: string; text?: string; url?: string }>(c);
    const text = body.text?.trim();
    if (!text) fail(400, "Note text is required");
    let ts = Number(body.ts);
    if (!Number.isFinite(ts) && body.date) ts = resolveRange(site.timezone, { from: body.date, to: body.date }).from;
    if (!Number.isFinite(ts)) ts = Date.now();
    const id = uuid();
    await c.get("rt").db.run("INSERT INTO notes (id, site_id, ts, text, url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      id,
      site.id,
      ts,
      text.slice(0, 500),
      body.url?.trim().slice(0, 500) || null,
      user.id,
      Date.now(),
    ]);
    return c.json({ note: { id, ts, text, url: body.url ?? null } });
  });

  app.get("/sites/:siteId/notes", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"));
    const notes = await c.get("rt").db.all("SELECT id, ts, text, url, created_at FROM notes WHERE site_id = ? ORDER BY ts DESC LIMIT 500", [site.id]);
    return c.json({ notes });
  });

  app.delete("/sites/:siteId/notes/:noteId", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    await c.get("rt").db.run("DELETE FROM notes WHERE id = ? AND site_id = ?", [c.req.param("noteId"), site.id]);
    return c.json({ ok: true });
  });

  // ---- alerts ----------------------------------------------------------------------------

  const publicAlert = (a: AlertRow) => {
    const cfg = JSON.parse(a.config || "{}");
    if (cfg.botToken) cfg.botToken = "••••" + String(cfg.botToken).slice(-4);
    return { ...a, enabled: !!a.enabled, config: cfg };
  };

  app.get("/sites/:siteId/alerts", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const db = c.get("rt").db;
    const [alerts, history] = await Promise.all([
      db.all<AlertRow>("SELECT * FROM alerts WHERE site_id = ? ORDER BY created_at ASC", [site.id]),
      db.all("SELECT * FROM alert_history WHERE site_id = ? ORDER BY ts DESC LIMIT 50", [site.id]),
    ]);
    return c.json({ alerts: alerts.map(publicAlert), history, emailEnabled: emailEnabled(c.get("rt")) });
  });

  const cleanAlert = (body: Record<string, unknown>, existing?: Record<string, unknown>) => {
    const type = String(body.type ?? "");
    const channel = String(body.channel ?? "");
    if (!(ALERT_TYPES as readonly string[]).includes(type)) fail(400, "Invalid alert type");
    if (!(ALERT_CHANNELS as readonly string[]).includes(channel)) fail(400, "Invalid channel");
    const cfg = { ...(existing ?? {}), ...((body.config as Record<string, unknown>) ?? {}) } as Record<string, unknown>;
    if (typeof cfg.botToken === "string" && cfg.botToken.startsWith("••••")) cfg.botToken = existing?.botToken;
    if (["slack", "discord", "webhook"].includes(channel) && !publicHttpsUrl(cfg.url)) fail(400, "A public https:// URL is required");
    if (channel === "telegram" && (!cfg.botToken || !cfg.chatId)) fail(400, "Telegram needs a bot token and a chat id");
    if (channel === "telegram" && !TELEGRAM_TOKEN.test(String(cfg.botToken))) fail(400, "That doesn't look like a Telegram bot token");
    if (channel === "email" && !String(cfg.email ?? "").split(",").every((e) => isEmail(e.trim()))) fail(400, "Enter valid email addresses");
    if (type === "goal") {
      const g = sanitizeGoalName(cfg.goal);
      if (!g) fail(400, "Pick the goal to watch");
      cfg.goal = g;
    }
    return { type, channel, config: JSON.stringify(cfg) };
  };

  app.post("/sites/:siteId/alerts", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const body = await readJson(c);
    const a = cleanAlert(body);
    const id = uuid();
    await c.get("rt").db.run("INSERT INTO alerts (id, site_id, type, channel, config, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)", [
      id,
      site.id,
      a.type,
      a.channel,
      a.config,
      Date.now(),
    ]);
    invalidateAlerts(site.id);
    const row = (await c.get("rt").db.first<AlertRow>("SELECT * FROM alerts WHERE id = ?", [id]))!;
    return c.json({ alert: publicAlert(row) });
  });

  app.patch("/sites/:siteId/alerts/:alertId", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const db = c.get("rt").db;
    const row = await db.first<AlertRow>("SELECT * FROM alerts WHERE id = ? AND site_id = ?", [c.req.param("alertId"), site.id]);
    if (!row) fail(404, "Alert not found");
    const body = await readJson(c);
    const a = cleanAlert({ type: row.type, channel: row.channel, ...body }, JSON.parse(row.config || "{}"));
    const enabled = body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0;
    await db.run("UPDATE alerts SET type = ?, channel = ?, config = ?, enabled = ? WHERE id = ?", [a.type, a.channel, a.config, enabled, row.id]);
    invalidateAlerts(site.id);
    return c.json({ alert: publicAlert((await db.first<AlertRow>("SELECT * FROM alerts WHERE id = ?", [row.id]))!) });
  });

  app.delete("/sites/:siteId/alerts/:alertId", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    await c.get("rt").db.run("DELETE FROM alerts WHERE id = ? AND site_id = ?", [c.req.param("alertId"), site.id]);
    invalidateAlerts(site.id);
    return c.json({ ok: true });
  });

  app.post("/sites/:siteId/alerts/:alertId/test", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const rt = c.get("rt");
    const row = await rt.db.first<AlertRow>("SELECT * FROM alerts WHERE id = ? AND site_id = ?", [c.req.param("alertId"), site.id]);
    if (!row) fail(404, "Alert not found");
    try {
      await sendTestAlert(rt, row, site);
    } catch (err) {
      fail(400, err instanceof Error ? err.message : String(err));
    }
    return c.json({ ok: true });
  });

  // ---- data export ------------------------------------------------------------------------

  app.get("/sites/:siteId/export/:kind", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId"), "admin");
    const kind = c.req.param("kind");
    const tables: Record<string, string> = {
      sessions: "SELECT * FROM sessions WHERE site_id = ? ORDER BY started_at DESC LIMIT 100000",
      events: "SELECT * FROM events WHERE site_id = ? ORDER BY ts DESC LIMIT 100000",
      payments: "SELECT * FROM payments WHERE site_id = ? ORDER BY ts DESC LIMIT 100000",
      visitors: "SELECT * FROM visitors WHERE site_id = ? ORDER BY last_seen DESC LIMIT 100000",
    };
    const sql = tables[kind];
    if (!sql) fail(404, "Unknown export");
    const rows = await c.get("rt").db.all<Record<string, unknown>>(sql, [site.id]);
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const esc = (v: unknown) => {
      if (v === null || v === undefined) return "";
      let s = String(v);
      // Neutralise spreadsheet formulas in visitor-controlled text (paths, referrers, UTM values, goal names).
      if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(","), ...rows.map((r) => cols.map((k) => esc(r[k])).join(","))].join("\n");
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="openrev-${site.domain}-${kind}.csv"`,
      },
    });
  });

  return app;
}

export function deleteSiteStatements(siteId: string, includeSite: boolean): Statement[] {
  const analytics = ["events", "sessions", "visitors", "payments", "customers", "checkout_refs", "imported_stats", "imports"];
  const config = ["site_members", "invites", "api_keys", "integrations", "funnels", "notes", "alerts", "alert_history"];
  const tables = includeSite ? [...analytics, ...config] : analytics;
  const out: Statement[] = [
    { sql: "DELETE FROM import_chunks WHERE import_id IN (SELECT id FROM imports WHERE site_id = ?)", params: [siteId] },
    ...tables.map((t) => ({ sql: `DELETE FROM ${t} WHERE site_id = ?`, params: [siteId] })),
  ];
  if (includeSite) out.push({ sql: "DELETE FROM sites WHERE id = ?", params: [siteId] });
  return out;
}
