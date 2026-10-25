import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { Runtime } from "../src/server/context";
import { hmacHex } from "../src/server/lib/crypto";
import { realPostgresDb, TEST_DATABASE_URL, testDb, testRuntime } from "./helpers";
import { pgliteDb } from "./pglite";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const BASE = "http://openrev.test";

let rt: Runtime;
let app: ReturnType<typeof createApp>;
let cookie = "";

async function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { "User-Agent": UA, ...(init.headers ?? {}) };
  if (cookie) headers.Cookie = cookie;
  let body: string | undefined = init.raw;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  }
  const res = await app.request(BASE + path, { method: init.method ?? (body !== undefined ? "POST" : "GET"), headers, body });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie?.startsWith("openrev_auth=")) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, res };
}

const DATABASES: [string, () => Promise<import("../src/server/db/types").Database>][] = [
  ["sqlite", testDb],
  ["pglite", pgliteDb],
  ...(TEST_DATABASE_URL ? ([["postgres", realPostgresDb]] as [string, () => Promise<import("../src/server/db/types").Database>][]) : []),
];

describe.each(DATABASES)("HTTP API (%s)", (_name, makeDb) => {
  let siteId = "";
  let apiKey = "";

  beforeAll(async () => {
    cookie = "";
    rt = await testRuntime(await makeDb());
    app = createApp(() => rt);
  });

  it("runs the first-run setup and creates a website", async () => {
    const inst = await call("/api/instance");
    expect(inst.json).toMatchObject({ hasUsers: false, signupEnabled: true });
    const signup = await call("/api/auth/signup", { body: { email: "owner@example.com", password: "supersecret", name: "Owner" } });
    expect(signup.status).toBe(200);
    expect(signup.json.user.is_admin).toBe(1);
    expect(cookie).toContain("openrev_auth=");

    // second sign-up is closed by default
    const saved = cookie;
    cookie = "";
    const second = await call("/api/auth/signup", { body: { email: "someone@example.com", password: "supersecret" } });
    expect(second.status).toBe(403);
    cookie = saved;

    const site = await call("/api/sites", { body: { domain: "https://www.Example.com/", timezone: "Europe/Paris", currency: "EUR" } });
    expect(site.status).toBe(200);
    expect(site.json.site.domain).toBe("example.com");
    siteId = site.json.site.id;
  });

  it("blocks cross-origin cookie requests", async () => {
    const r = await call("/api/sites", { body: { domain: "evil.com" }, headers: { Origin: "https://evil.com" } });
    expect(r.status).toBe(403);
  });

  it("collects events from the tracker", async () => {
    const send = (payload: Record<string, unknown>) =>
      call("/api/events", { raw: JSON.stringify({ websiteId: siteId, ...payload }), headers: { "Content-Type": "text/plain", "cf-ipcountry": "FR" } });
    const r = await send({ type: "pageview", href: "https://example.com/?utm_source=newsletter&utm_medium=email", visitorId: "visitor-1111-aaaa", sessionId: "session-1111-aaaa" });
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ ok: true });
    expect(r.res.headers.get("access-control-allow-origin")).toBe("*");
    await send({ type: "goal", name: "signup", href: "https://example.com/pricing", visitorId: "visitor-1111-aaaa", sessionId: "session-1111-aaaa" });
    const bad = await send({ type: "pageview", href: "https://other.com/" });
    expect(bad.json.reason).toBe("hostname_not_allowed");

    const ov = await call(`/api/sites/${siteId}/stats/overview?period=today`);
    expect(ov.json.current.visitors).toBe(1);
    const countries = await call(`/api/sites/${siteId}/stats/breakdown/country?period=today`);
    expect(countries.json.rows[0].value).toBe("FR");
    const channels = await call(`/api/sites/${siteId}/stats/breakdown/channel?period=today`);
    expect(channels.json.rows[0].value).toBe("Email");
  });

  it("uses the original client IP and location for proxied events", async () => {
    await call(`/api/sites/${siteId}`, { method: "PATCH", body: { settings: { excludedIps: ["203.0.113.9"], excludedHostnames: ["www.staging.example.com"] } } });
    const send = (payload: Record<string, unknown>, headers: Record<string, string>) =>
      call("/api/events", { raw: JSON.stringify({ websiteId: siteId, type: "pageview", ...payload }), headers: { "Content-Type": "text/plain", ...headers } });
    // proxied through the website (e.g. a Next.js rewrite): the first X-Forwarded-For entry is the visitor
    const excluded = await send(
      { href: "https://example.com/", visitorId: "visitor-2222-bbbb", sessionId: "session-2222-bbbb" },
      { "X-Forwarded-For": "203.0.113.9, 10.0.0.1", "CF-Connecting-IP": "10.0.0.1", "CF-IPCountry": "US" },
    );
    expect(excluded.json.reason).toBe("excluded");
    // the edge location describes the proxy, so it is ignored; X-OpenRev-* headers from the proxy are used
    await send({ href: "https://example.com/", visitorId: "visitor-3333-cccc", sessionId: "session-3333-cccc" }, { "X-Forwarded-For": "198.51.100.7, 10.0.0.1", "CF-Connecting-IP": "10.0.0.1", "CF-IPCountry": "US" });
    await send(
      { href: "https://example.com/", visitorId: "visitor-4444-dddd", sessionId: "session-4444-dddd" },
      { "X-Forwarded-For": "198.51.100.8, 10.0.0.1", "CF-Connecting-IP": "10.0.0.1", "CF-IPCountry": "US", "X-OpenRev-Country": "DE", "X-OpenRev-City": "Berlin" },
    );
    const rows = await rt.db.all<{ visitor_id: string; country: string | null; city: string | null }>(
      "SELECT visitor_id, country, city FROM sessions WHERE visitor_id IN ('visitor-3333-cccc', 'visitor-4444-dddd') ORDER BY visitor_id",
    );
    expect(rows).toEqual([
      { visitor_id: "visitor-3333-cccc", country: null, city: null },
      { visitor_id: "visitor-4444-dddd", country: "DE", city: "Berlin" },
    ]);
    // www. is ignored in hostname exclusions
    const staging = await send({ href: "https://staging.example.com/", visitorId: "visitor-5555-eeee" }, {});
    expect(staging.json.reason).toBe("excluded");
    await rt.db.run("DELETE FROM sessions WHERE visitor_id IN ('visitor-3333-cccc', 'visitor-4444-dddd')");
    await rt.db.run("DELETE FROM visitors WHERE id IN ('visitor-3333-cccc', 'visitor-4444-dddd')");
    await rt.db.run("DELETE FROM events WHERE visitor_id IN ('visitor-3333-cccc', 'visitor-4444-dddd')");
    await call(`/api/sites/${siteId}`, { method: "PATCH", body: { settings: { excludedIps: [], excludedHostnames: [] } } });
  });

  it("verifies and records Stripe webhooks", async () => {
    const created = await call(`/api/sites/${siteId}/integrations`, { body: { provider: "stripe", config: { webhookSecret: "whsec_test" } } });
    expect(created.status).toBe(200);
    const url = new URL(created.json.integration.webhook_url);
    expect(created.json.integration.config.webhookSecret).toMatch(/^••••/);

    const event = {
      id: "evt_1",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "cs_test_1",
          object: "checkout.session",
          mode: "payment",
          status: "complete",
          payment_status: "paid",
          amount_total: 4900,
          currency: "usd",
          payment_intent: "pi_1",
          customer: "cus_1",
          customer_details: { email: "buyer@example.com", name: "Buyer" },
          metadata: { openrev_visitor_id: "visitor-1111-aaaa" },
          created: Math.floor(Date.now() / 1000),
        },
      },
    };
    const raw = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = await hmacHex("SHA-256", "whsec_test", `${t}.${raw}`);

    const forged = await call(url.pathname, { raw, headers: { "Stripe-Signature": `t=${t},v1=deadbeef`, "Content-Type": "application/json" } });
    expect(forged.status).toBe(401);

    const ok = await call(url.pathname, { raw, headers: { "Stripe-Signature": `t=${t},v1=${sig}`, "Content-Type": "application/json" } });
    expect(ok.status).toBe(200);
    expect(ok.json.payments).toBe(1);

    const ov = await call(`/api/sites/${siteId}/stats/overview?period=today`);
    expect(ov.json.current.payments).toBe(1);
    expect(ov.json.current.revenue).toBeGreaterThan(0); // converted USD -> EUR
    const ch = await call(`/api/sites/${siteId}/stats/breakdown/channel?period=today&sort=revenue`);
    expect(ch.json.rows[0]).toMatchObject({ value: "Email", customers: 1 });
  });

  it("serves the public REST API with API keys", async () => {
    const key = await call(`/api/sites/${siteId}/keys`, { body: { name: "backend" } });
    apiKey = key.json.key;
    expect(apiKey).toMatch(/^or_/);
    const saved = cookie;
    cookie = "";
    const unauth = await call("/api/v1/analytics/overview");
    expect(unauth.status).toBe(401);
    const auth = { Authorization: `Bearer ${apiKey}` };
    const ov = await call("/api/v1/analytics/overview?period=today", { headers: auth });
    expect(ov.json.status).toBe("success");
    expect(ov.json.data.visitors).toBe(1);

    const pay = await call("/api/v1/payments", { headers: auth, body: { amount: 19.99, currency: "EUR", transaction_id: "ext_1", datafast_visitor_id: "visitor-1111-aaaa", renewal: true } });
    expect(pay.status).toBe(201);
    expect(pay.json.data).toMatchObject({ amount: 1999, type: "renewal", visitor_id: "visitor-1111-aaaa" });
    const again = await call("/api/v1/payments", { headers: auth, body: { amount: 19.99, currency: "EUR", transaction_id: "ext_1" } });
    expect(again.status).toBe(200);

    const goal = await call("/api/v1/goals", { headers: auth, body: { name: "activated", openrev_visitor_id: "visitor-1111-aaaa", metadata: { plan: "pro" }, timestamp: Math.floor(Date.now() / 1000) } });
    expect(goal.status).toBe(201);
    const ident = await call("/api/v1/identify", { headers: auth, body: { openrev_visitor_id: "visitor-1111-aaaa", user_id: "u_1", name: "Jane", email: "jane@example.com", plan: "pro" } });
    expect(ident.status).toBe(200);
    // identifying or tracking goals for unknown visitors never invents sessions
    const before = await rt.db.first<{ c: number }>("SELECT COUNT(*) AS c FROM sessions");
    expect((await call("/api/v1/identify", { headers: auth, body: { openrev_visitor_id: "visitor-9999-zzzz", user_id: "u_9" } })).status).toBe(200);
    expect((await call("/api/v1/goals", { headers: auth, body: { name: "x", openrev_visitor_id: "visitor-9999-zzzz" } })).status).toBe(422);
    const after = await rt.db.first<{ c: number }>("SELECT COUNT(*) AS c FROM sessions");
    expect(Number(after?.c)).toBe(Number(before?.c));
    const visitor = await call("/api/v1/visitors/visitor-1111-aaaa", { headers: auth });
    expect(visitor.json.data.visitor).toMatchObject({ name: "Jane", user_id: "u_1" });
    expect(visitor.json.data.payments).toHaveLength(2);

    const pages = await call("/api/v1/analytics/pages?period=today", { headers: auth });
    expect(pages.json.dimension).toBe("page");
    const spec = await call("/api/v1/openapi.json");
    expect(spec.json.openapi).toBe("3.1.0");
    cookie = saved;
  });

  it("exposes an MCP server", async () => {
    const auth = { Authorization: `Bearer ${apiKey}` };
    const init = await call("/mcp", { headers: auth, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } } });
    expect(init.json.result.serverInfo.name).toBe("openrev");
    const tools = await call("/mcp", { headers: auth, body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    expect(tools.json.result.tools.map((t: { name: string }) => t.name)).toContain("get_breakdown");
    const res = await call("/mcp", { headers: auth, body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_overview", arguments: { period: "today" } } } });
    const payload = JSON.parse(res.json.result.content[0].text);
    expect(payload.current.visitors).toBe(1);
  });

  it("shares a public dashboard without personal data", async () => {
    const share = await call(`/api/sites/${siteId}/share`, { body: { enabled: true } });
    const token = share.json.share_token;
    const saved = cookie;
    cookie = "";
    const meta = await call(`/api/share/${token}/stats/meta`);
    expect(meta.json.site.domain).toBe("example.com");
    const visitors = await call(`/api/share/${token}/stats/visitors`);
    expect(visitors.status).toBe(403);
    const payments = await call(`/api/share/${token}/stats/payments?period=today`);
    expect(payments.json.payments.every((p: { email: string | null }) => p.email === null)).toBe(true);
    const nope = await call(`/api/sites/${siteId}/stats/overview`);
    expect(nope.status).toBe(401);
    cookie = saved;
  });

  it("manages funnels, notes, alerts and team invites", async () => {
    const f = await call(`/api/sites/${siteId}/funnels`, { body: { name: "Signup", steps: [{ type: "page", value: "/" }, { type: "goal", value: "signup" }, { type: "payment" }] } });
    const results = await call(`/api/sites/${siteId}/stats/funnels/${f.json.funnel.id}?period=today`);
    expect(results.json.results.map((r: { visitors: number }) => r.visitors)).toEqual([1, 1, 1]);
    const note = await call(`/api/sites/${siteId}/notes`, { body: { text: "Launch", date: "2026-01-01" } });
    expect(note.status).toBe(200);
    const alert = await call(`/api/sites/${siteId}/alerts`, { body: { type: "payment", channel: "webhook", config: { url: "https://example.com/hook" } } });
    expect(alert.status).toBe(200);
    const badAlert = await call(`/api/sites/${siteId}/alerts`, { body: { type: "payment", channel: "slack", config: { url: "not a url" } } });
    expect(badAlert.status).toBe(400);
    const invite = await call(`/api/sites/${siteId}/invites`, { body: { role: "viewer" } });
    expect(invite.json.url).toContain("/invite/");
    const token = new URL(invite.json.url).pathname.split("/").pop()!;
    const saved = cookie;
    cookie = "";
    const joined = await call("/api/auth/signup", { body: { email: "viewer@example.com", password: "supersecret", invite: token } });
    expect(joined.status).toBe(200);
    const viewerSites = await call("/api/sites");
    expect(viewerSites.json.sites).toHaveLength(1);
    const forbidden = await call(`/api/sites/${siteId}/keys`, { body: { name: "x" } });
    expect(forbidden.status).toBe(403);
    cookie = saved;
  });

  it("enforces roles across the dashboard, the API and MCP", async () => {
    const owner = cookie;
    const members = await call(`/api/sites/${siteId}/members`);
    const ownerId = members.json.members.find((m: { email: string }) => m.email === "owner@example.com").id;
    const adminInvite = await call(`/api/sites/${siteId}/invites`, { body: { role: "admin" } });
    cookie = "";
    await call("/api/auth/signup", { body: { email: "admin@example.com", password: "supersecret", invite: new URL(adminInvite.json.url).pathname.split("/").pop() } });
    const admin = cookie;

    // admins can't demote or remove owners, or demote them through an invite
    expect((await call(`/api/sites/${siteId}/members/${ownerId}`, { method: "PATCH", body: { role: "viewer" } })).status).toBe(403);
    expect((await call(`/api/sites/${siteId}/members/${ownerId}`, { method: "DELETE" })).status).toBe(403);
    await call(`/api/sites/${siteId}/invites`, { body: { email: "owner@example.com", role: "viewer" } });
    cookie = owner;
    const after = await call(`/api/sites/${siteId}/members`);
    expect(after.json.members.find((m: { id: string }) => m.id === ownerId).role).toBe("owner");
    // ...and the last owner can't step down
    expect((await call(`/api/sites/${siteId}/members/${ownerId}`, { method: "PATCH", body: { role: "admin" } })).status).toBe(400);

    // a viewer's account token can read but not write
    cookie = "";
    await call("/api/auth/login", { body: { email: "viewer@example.com", password: "supersecret" } });
    const token = (await call("/api/account/tokens", { body: { name: "viewer" } })).json.key;
    cookie = "";
    const auth = { Authorization: `Bearer ${token}` };
    expect((await call(`/api/v1/analytics/overview?websiteId=${siteId}`, { headers: auth })).status).toBe(200);
    expect((await call(`/api/v1/payments?websiteId=${siteId}`, { headers: auth, body: { amount: 1, transaction_id: "fake" } })).status).toBe(403);
    expect((await call(`/api/v1/goals?websiteId=${siteId}`, { headers: auth, body: { name: "x", openrev_visitor_id: "visitor-1111-aaaa" } })).status).toBe(403);
    expect((await call(`/api/v1/identify?websiteId=${siteId}`, { headers: auth, body: { openrev_visitor_id: "visitor-1111-aaaa", user_id: "x" } })).status).toBe(403);
    const note = await call("/mcp", { headers: auth, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_note", arguments: { websiteId: siteId, text: "hi" } } } });
    expect(note.json.result.isError).toBe(true);

    // alert destinations must be public
    cookie = admin;
    for (const url of ["https://127.0.0.1/hook", "https://169.254.169.254/latest", "https://localhost/x", "https://[::1]/x", "https://10.0.0.8/x", "https://intranet/x", "http://example.com/x"]) {
      const r = await call(`/api/sites/${siteId}/alerts`, { body: { type: "payment", channel: "webhook", config: { url } } });
      expect(r.status, url).toBe(400);
    }
    expect((await call(`/api/sites/${siteId}/alerts`, { body: { type: "payment", channel: "slack", config: { url: "https://hooks.slack.com/services/T0/B0/x" } } })).status).toBe(200);

    // CSV exports neutralise spreadsheet formulas from visitor-controlled fields
    await call("/api/events", { raw: JSON.stringify({ websiteId: siteId, type: "pageview", href: "https://example.com/?utm_source=%3D1%2B1", visitorId: "visitor-csv1-aaaa", sessionId: "session-csv1-aaaa" }), headers: { "Content-Type": "text/plain" } });
    const csv = await call(`/api/sites/${siteId}/export/sessions`);
    expect(csv.json).toContain("'=1+1");
    expect(csv.json).not.toMatch(/(^|,)=1\+1/m);
    cookie = owner;
  });

  it("limits failed logins per account even when the client address changes", async () => {
    const saved = cookie;
    cookie = "";
    const email = `throttle-${_name}@example.com`;
    for (let i = 0; i < 10; i++) {
      const r = await call("/api/auth/login", { body: { email, password: "wrong-password" }, headers: { "X-Forwarded-For": `203.0.113.${i}` } });
      expect(r.status).toBe(401);
    }
    const blocked = await call("/api/auth/login", { body: { email, password: "wrong-password" }, headers: { "X-Forwarded-For": "198.51.100.7" } });
    expect(blocked.status).toBe(429);
    // other accounts are unaffected
    expect((await call("/api/auth/login", { body: { email: "viewer@example.com", password: "supersecret" } })).status).toBe(200);
    cookie = saved;
  });
});
