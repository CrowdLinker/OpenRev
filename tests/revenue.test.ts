import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { Runtime } from "../src/server/context";
import { migrate, migrations } from "../src/server/db/migrations";
import { nodeSqliteDatabase } from "../src/server/db/sqlite-node";
import type { Database } from "../src/server/db/types";
import { REVENUE_FIELDS } from "../src/server/lib/revenue";
import { notifyGoal, notifyPayment } from "../src/server/services/alerts";
import { createUser } from "../src/server/services/auth";
import { recordCrawls } from "../src/server/services/crawlers";
import { ingestEvent } from "../src/server/services/ingest";
import { recordPayment } from "../src/server/services/payments";
import { getSite } from "../src/server/services/sites";
import { ALL_DIMENSIONS } from "../src/server/services/stats";
import { realPostgresDb, TEST_DATABASE_URL, testDb, testRuntime } from "./helpers";
import { pgliteDb } from "./pglite";

const BASE = "http://openrev.test";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const DATABASES: [string, () => Promise<Database>][] = [
  ["sqlite", testDb],
  ["pglite", pgliteDb],
  ...(TEST_DATABASE_URL ? ([["postgres", realPostgresDb]] as [string, () => Promise<Database>][]) : []),
];

/** Every key of a JSON value, at any depth. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

// Besides the server's own list, any key that looks like money catches a revenue field added later and not listed.
const LOOKS_LIKE_REVENUE = /revenue|payment|customer|mrr|ltv|refund|arpu|churn|subscriber|^arr$|^amount$/i;
/** Flags the viewer's own permission, not revenue data. */
const ALLOWED = new Set(["canSeeRevenue"]);

function revenueKeys(body: unknown): string[] {
  return [...keysOf(body)].filter((k) => !ALLOWED.has(k) && ((REVENUE_FIELDS as readonly string[]).includes(k) || LOOKS_LIKE_REVENUE.test(k)));
}

/** A JSON response without any revenue: no revenue field, and no purchase conversion rate next to the visitor counts. */
function expectNoRevenue(label: string, body: Json) {
  expect(revenueKeys(body), label).toEqual([]);
}

/** Calls the app as one person: each client keeps its own session cookie. */
function client(app: ReturnType<typeof createApp>) {
  let cookie = "";
  return async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "User-Agent": CHROME, ...(init.headers ?? {}) };
    if (cookie) headers.Cookie = cookie;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await app.request(BASE + path, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie?.startsWith("openrev_auth=")) cookie = setCookie.split(";")[0];
    const text = await res.text();
    let json: Json = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* CSV */
    }
    return { status: res.status, json };
  };
}
type Client = ReturnType<typeof client>;

/** Joins a website through an invitation from `inviter`, as a new account. */
async function join(app: ReturnType<typeof createApp>, inviter: Client, siteId: string, email: string, invite: Record<string, unknown>) {
  const link = await inviter(`/api/sites/${siteId}/invites`, { body: invite });
  const member = client(app);
  const signup = await member("/api/auth/signup", { body: { email, password: "supersecret", invite: new URL(link.json.url).pathname.split("/").pop() } });
  expect(signup.status).toBe(200);
  return { call: member, id: signup.json.user.id as string };
}

/** Stats endpoints shared by the dashboard and share links (relative to …/stats). */
function statsEndpoints(funnelId: string): [string, { method?: string; body?: unknown }?][] {
  return [
    ["/overview?period=today"],
    ["/timeseries?period=today"],
    ...ALL_DIMENSIONS.map((d): [string] => [`/breakdown/${d}?period=today&sort=revenue&limit=50`]),
    ["/breakdown/channel?period=today&sort=conversion_rate"],
    ["/goals/signup/properties?period=today"],
    ["/live"],
    ["/realtime"],
    ["/crawlers?period=today"],
    ["/social?period=today"],
    ["/search-keywords?period=today&sort=revenue"],
    [`/funnels/${funnelId}?period=today`],
    ["/funnels/preview?period=today", { body: { steps: [{ type: "page", value: "/pricing" }, { type: "payment" }, { type: "goal", value: "signup" }] } }],
    ["/notes?period=today"],
    ["/meta"],
    ["/overview?period=all"],
  ];
}
/** Reports that are revenue as a whole: refused when revenue is hidden. */
const REVENUE_REPORTS = ["/payments?period=today", "/ltv?period=today", "/mrr?period=today", "/mrr/breakdown?period=today"];

describe.each(DATABASES)("revenue visibility (%s)", (_name, makeDb) => {
  let rt: Runtime;
  let app: ReturnType<typeof createApp>;
  let owner: Client;
  let siteId = "";
  let token = "";
  let funnelId = "";

  beforeAll(async () => {
    rt = await testRuntime(await makeDb());
    app = createApp(() => rt);
    owner = client(app);
    await owner("/api/auth/signup", { body: { email: "owner@example.com", password: "supersecret", name: "Owner" } });
    siteId = (await owner("/api/sites", { body: { domain: "example.com", timezone: "UTC", currency: "USD" } })).json.site.id;
    const site = (await getSite(rt.db, siteId))!;
    const geo = { ip: "1.2.3.4", userAgent: CHROME, geo: { country: "CA", city: "Toronto" } };
    const visit = (visitorId: string, href: string, referrer: string) =>
      ingestEvent(rt, { type: "pageview", websiteId: siteId, href, referrer, visitorId, sessionId: visitorId.replace("visitor", "session") }, geo);
    await visit("visitor-rev-0001", "https://example.com/pricing", "https://news.ycombinator.com/");
    await visit("visitor-rev-0002", "https://example.com/", "https://www.google.com/");
    await visit("visitor-rev-0003", "https://example.com/docs", "https://chatgpt.com/");
    await ingestEvent(rt, { type: "goal", websiteId: siteId, href: "https://example.com/pricing", name: "signup", visitorId: "visitor-rev-0001", sessionId: "session-rev-0001" }, geo);
    for (const [tx, visitorId] of [
      ["pi_rev_1", "visitor-rev-0001"],
      ["pi_rev_2", "visitor-rev-0002"],
      ["pi_rev_3", "visitor-rev-0003"],
    ]) {
      await recordPayment(rt, site, {
        provider: "stripe",
        transactionId: tx,
        type: "new",
        amount: 4900,
        currency: "USD",
        visitorId,
        email: `${visitorId}@example.com`,
        name: "Ada",
        subscriptionId: `sub_${tx}`,
        interval: { unit: "month", count: 1 },
      });
    }
    // Search keywords, a Hacker News post that brought the first visit, and crawler requests.
    const now = Date.now();
    await rt.db.run("INSERT INTO search_console (site_id, property, config, created_at) VALUES (?, ?, ?, ?)", [siteId, "sc-domain:example.com", "{}", now]);
    await rt.db.run("INSERT INTO search_stats (site_id, ts, query, page, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?, ?)", [siteId, now - 60_000, "openrev", "/", 10, 100, 300]);
    await rt.db.run(
      "INSERT INTO social_posts (site_id, platform, id, kind, url, author, text, created_at, likes, reposts, replies, links, updated_at) VALUES (?, 'hn', 'hn1', 'post', ?, 'pg', 'OpenRev', ?, 1, 0, 0, ?, ?)",
      [siteId, "https://news.ycombinator.com/item?id=1", now - 60_000, JSON.stringify(["https://example.com/pricing"]), now],
    );
    await rt.db.run("INSERT INTO social_links (site_id, platform, post_id, path, kind, created_at) VALUES (?, 'hn', 'hn1', '/pricing', 'post', ?)", [siteId, now - 3_600_000]);
    await recordCrawls(rt.db, site, [{ path: "/", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot" }]);
    funnelId = (await owner(`/api/sites/${siteId}/funnels`, { body: { name: "Buy", steps: [{ type: "page", value: "/pricing" }, { type: "goal", value: "signup" }, { type: "payment" }] } })).json.funnel.id;
    token = (await owner(`/api/sites/${siteId}/share`, { body: { enabled: true } })).json.share_token;
  });

  const setHideRevenue = (hideRevenue: boolean) => owner(`/api/sites/${siteId}`, { method: "PATCH", body: { settings: { hideRevenue } } });

  it("leaves revenue out of every share-link response when the website hides it", async () => {
    await setHideRevenue(true);
    const share = client(app);
    const base = `/api/share/${token}/stats`;
    for (const [path, init] of statsEndpoints(funnelId)) {
      const r = await share(base + path, init);
      expect(r.status, path).toBe(200);
      expectNoRevenue(path, r.json);
    }
    for (const path of REVENUE_REPORTS) {
      const r = await share(base + path);
      expect(r.status, path).toBe(403);
      expectNoRevenue(path, r.json);
    }
    const ov = (await share(`${base}/overview?period=today`)).json;
    expect(ov.current.visitors).toBe(3);
    // The share of visitors who paid is a customer count in disguise; goal conversion rates stay.
    expect(ov.current).not.toHaveProperty("conversion_rate");
    expect((await share(`${base}/breakdown/goal?period=today`)).json.rows[0]).toHaveProperty("conversion_rate");
    expect((await share(`${base}/breakdown/channel?period=today`)).json.rows[0]).not.toHaveProperty("conversion_rate");
    // The funnel stops before its payment step: that step, and every later one, counts customers.
    const funnel = (await share(`${base}/funnels/${funnelId}?period=today`)).json;
    expect(funnel.results.map((r: { visitors: number }) => r.visitors)).toEqual([1, 1]);
    // No row exists only because of payments, and a sort by revenue falls back to visitors.
    const sources = (await share(`${base}/breakdown/source?period=today&sort=revenue`)).json.rows;
    expect(sources.every((r: { visitors: number }) => r.visitors > 0)).toBe(true);
    const meta = (await share(`${base}/meta`)).json;
    expect(meta.canSeeRevenue).toBe(false);
    expect((await share(`${base}/realtime`)).json).not.toHaveProperty("payments");
    // The live badge is unchanged: visitor counts only.
    expect((await share(`/api/badge/${token}`)).json).toEqual({ online: 3, today: 3 });
  });

  it("keeps revenue on share links when the website doesn't hide it", async () => {
    await setHideRevenue(false);
    const share = client(app);
    const base = `/api/share/${token}/stats`;
    expect((await share(`${base}/meta`)).json.canSeeRevenue).toBe(true);
    const ov = (await share(`${base}/overview?period=today`)).json;
    expect(ov.current).toMatchObject({ revenue: 14700, customers: 3, payments: 3 });
    expect(ov.current.conversion_rate).toBeGreaterThan(0);
    const payments = await share(`${base}/payments?period=today`);
    expect(payments.status).toBe(200);
    expect(payments.json.payments).toHaveLength(3);
    // Personal data stays hidden, as before.
    expect(payments.json.payments.every((p: { email: string | null }) => p.email === null)).toBe(true);
    expect((await share(`${base}/mrr?period=today`)).json.summary.mrr).toBe(14700);
    expect((await share(`${base}/realtime`)).json.payments).toHaveLength(3);
    expect((await share(`${base}/funnels/${funnelId}?period=today`)).json.results).toHaveLength(3);
  });

  it("shows revenue to the owner and to members allowed to see it, even when share links hide it", async () => {
    await setHideRevenue(true);
    const member = await join(app, owner, siteId, "allowed@example.com", { role: "viewer", can_see_revenue: true });
    for (const who of [owner, member.call]) {
      expect((await who(`/api/sites/${siteId}`)).json.canSeeRevenue).toBe(true);
      expect((await who(`/api/sites/${siteId}/stats/meta`)).json.canSeeRevenue).toBe(true);
      expect((await who(`/api/sites/${siteId}/stats/overview?period=today`)).json.current.revenue).toBe(14700);
      expect((await who(`/api/sites/${siteId}/stats/payments?period=today`)).json.payments).toHaveLength(3);
      const sites = (await who("/api/sites")).json.sites;
      expect(sites[0]).toMatchObject({ canSeeRevenue: true, revenue: 14700 });
    }
  });

  it("gives a member without the permission no revenue through the session, an account token, MCP or CSV export", async () => {
    const member = await join(app, owner, siteId, "admin-norev@example.com", { role: "admin" });
    const call = member.call;
    expect((await call(`/api/sites/${siteId}`)).json.canSeeRevenue).toBe(false);

    // Dashboard session
    const base = `/api/sites/${siteId}/stats`;
    for (const [path, init] of [...statsEndpoints(funnelId), ["/visitors?period=today"], ["/visitors/visitor-rev-0001"]] as [string, { body?: unknown }?][]) {
      const r = await call(base + path, init);
      expect(r.status, path).toBe(200);
      expectNoRevenue(path, r.json);
    }
    for (const path of [...REVENUE_REPORTS, "/visitors?period=today&customers=1"]) {
      expect((await call(base + path)).status, path).toBe(403);
    }
    const profile = (await call(`${base}/visitors/visitor-rev-0001`)).json;
    expect(profile.visitor.id).toBe("visitor-rev-0001");
    expect(profile).not.toHaveProperty("payments");
    const sites = (await call("/api/sites")).json.sites;
    expect(sites[0]).toMatchObject({ canSeeRevenue: false, visitors: 3 });
    expectNoRevenue("/api/sites", sites);

    // CSV export
    expect((await call(`/api/sites/${siteId}/export/payments`)).status).toBe(403);
    for (const kind of ["sessions", "events", "visitors"]) {
      const csv = await call(`/api/sites/${siteId}/export/${kind}`);
      expect(csv.status, kind).toBe(200);
      expect(String(csv.json).split("\n")[0], kind).not.toMatch(LOOKS_LIKE_REVENUE);
    }

    // Account token (REST API, and so the CLI)
    const key = (await call("/api/account/tokens", { body: { name: "mine" } })).json.key;
    const auth = { Authorization: `Bearer ${key}` };
    const q = `websiteId=${siteId}&period=today`;
    for (const path of [
      `/api/v1/analytics/overview?${q}`,
      `/api/v1/analytics/timeseries?${q}`,
      `/api/v1/analytics/realtime?${q}`,
      ...ALL_DIMENSIONS.map((d) => `/api/v1/analytics/${d}?${q}&sort=revenue`),
      `/api/v1/analytics/search-keywords?${q}&sort=revenue`,
      `/api/v1/analytics/crawlers?${q}`,
      `/api/v1/analytics/social?${q}`,
      `/api/v1/visitors?${q}`,
      `/api/v1/visitors/visitor-rev-0001?${q}`,
      `/api/v1/goals?${q}`,
      `/api/v1/funnels?${q}`,
      `/api/v1/funnels/${funnelId}?${q}`,
      `/api/v1/websites`,
    ]) {
      const r = await call(path, { headers: auth });
      expect(r.status, path).toBe(200);
      expectNoRevenue(path, r.json);
    }
    for (const path of ["/api/v1/analytics/mrr", "/api/v1/analytics/mrr/breakdown", "/api/v1/payments", "/api/v1/ltv", "/api/v1/visitors?customers=1&x=1"]) {
      const r = await call(`${path}${path.includes("?") ? "&" : "?"}${q}`, { headers: auth });
      expect(r.status, path).toBe(403);
      expect(r.json.error.message).toContain("Can see revenue");
    }
    // An admin can still send payments, but only gets their id back (a repeat would otherwise return the stored one).
    const sent = await call(`/api/v1/payments?websiteId=${siteId}`, { headers: auth, body: { amount: 10, currency: "USD", transaction_id: "pi_rev_1", provider: "stripe" } });
    expect(sent.status).toBe(200);
    expect(sent.json.data).toEqual({ id: expect.any(String), transaction_id: "pi_rev_1" });

    // MCP
    const rpc = async (name: string, args: Record<string, unknown> = {}) =>
      (await call("/mcp", { headers: auth, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { websiteId: siteId, period: "today", ...args } } } })).json.result;
    const tools = (await call("/mcp", { headers: auth, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).json.result.tools as { name: string }[];
    for (const { name } of tools) {
      if (name === "add_note") continue;
      const args = name === "get_breakdown" ? { dimension: "channel", sort: "revenue" } : name === "get_visitor" ? { visitor_id: "visitor-rev-0001" } : name === "get_funnel" ? { funnel_id: funnelId } : {};
      const result = await rpc(name, args);
      if (["list_payments", "get_ltv", "get_mrr", "get_mrr_breakdown"].includes(name)) {
        expect(result.isError, name).toBe(true);
        expect(result.content[0].text).toContain("Can see revenue");
      } else {
        expect(result.isError, `${name}: ${result.content[0].text}`).toBeFalsy();
        expectNoRevenue(name, JSON.parse(result.content[0].text));
      }
    }
    expect((await rpc("list_visitors", { customers_only: true })).isError).toBe(true);
    for (const dimension of ALL_DIMENSIONS) expectNoRevenue(dimension, JSON.parse((await rpc("get_breakdown", { dimension })).content[0].text));
  });

  it("keeps website keys to admins and owners, and a key follows its creator's permission", async () => {
    const viewer = await join(app, owner, siteId, "viewer-keys@example.com", { role: "viewer" });
    expect((await viewer.call(`/api/sites/${siteId}/keys`, { body: { name: "x" } })).status).toBe(403);
    const admin = await join(app, owner, siteId, "admin-keys@example.com", { role: "admin" });
    const key = (await admin.call(`/api/sites/${siteId}/keys`, { body: { name: "backend" } })).json.key;
    expect(key).toMatch(/^or_/);
    const auth = { Authorization: `Bearer ${key}` };
    const before = await admin.call("/api/v1/analytics/overview?period=today", { headers: auth });
    expectNoRevenue("website key", before.json);
    expect((await admin.call("/api/v1/payments?period=today", { headers: auth })).status).toBe(403);
    await owner(`/api/sites/${siteId}/members/${admin.id}`, { method: "PATCH", body: { can_see_revenue: true } });
    expect((await admin.call("/api/v1/analytics/overview?period=today", { headers: auth })).json.data.revenue).toBe(14700);
  });

  it("locks the owner on, starts invites without the permission, and applies a grant right away", async () => {
    const members = (await owner(`/api/sites/${siteId}/members`)).json.members as { id: string; email: string; role: string; can_see_revenue: boolean }[];
    const me = members.find((m) => m.email === "owner@example.com")!;
    expect(me.can_see_revenue).toBe(true);
    expect((await owner(`/api/sites/${siteId}/members/${me.id}`, { method: "PATCH", body: { can_see_revenue: false } })).status).toBe(400);

    const viewer = await join(app, owner, siteId, "new-viewer@example.com", { role: "viewer" });
    const listed = (await owner(`/api/sites/${siteId}/members`)).json.members.find((m: { id: string }) => m.id === viewer.id);
    expect(listed.can_see_revenue).toBe(false);
    const overview = `/api/sites/${siteId}/stats/overview?period=today`;
    expect((await viewer.call(overview)).json.current).not.toHaveProperty("revenue");
    // Viewers can't grant it, even to themselves.
    expect((await viewer.call(`/api/sites/${siteId}/members/${viewer.id}`, { method: "PATCH", body: { can_see_revenue: true } })).status).toBe(403);

    // An admin without the permission can grant it, as admins manage members.
    const admin = await join(app, owner, siteId, "admin-grants@example.com", { role: "admin" });
    expect((await admin.call(`/api/sites/${siteId}/members/${viewer.id}`, { method: "PATCH", body: { can_see_revenue: true } })).status).toBe(200);
    expect((await viewer.call(overview)).json.current.revenue).toBe(14700);
    await owner(`/api/sites/${siteId}/members/${viewer.id}`, { method: "PATCH", body: { can_see_revenue: false } });
    expect((await viewer.call(overview)).json.current).not.toHaveProperty("revenue");

    // A member promoted to owner sees revenue, and keeps it if they step back down to admin.
    await owner(`/api/sites/${siteId}/members/${viewer.id}`, { method: "PATCH", body: { role: "owner" } });
    expect((await viewer.call(overview)).json.current.revenue).toBe(14700);
    await owner(`/api/sites/${siteId}/members/${viewer.id}`, { method: "PATCH", body: { role: "admin" } });
    expect((await viewer.call(overview)).json.current.revenue).toBe(14700);
  });

  describe("emailed alerts", () => {
    let sent: { url: string; body: Json }[] = [];
    afterEach(() => {
      vi.unstubAllGlobals();
      rt.config.resendApiKey = undefined;
    });
    const stubFetch = () => {
      sent = [];
      rt.config.resendApiKey = "re_test";
      vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response("{}", { status: 200 });
      });
    };
    const emails = () => sent.filter((s) => s.url === "https://api.resend.com/emails").map((s) => s.body as { to: string[]; text: string; html: string });

    it("follow each member's permission: no payment alerts and revenue-free digests without it", async () => {
      await join(app, owner, siteId, "digest-viewer@example.com", { role: "viewer" });
      const to = "owner@example.com, digest-viewer@example.com, investor@example.org";
      const create = async (type: string, config: Record<string, unknown>) =>
        (await owner(`/api/sites/${siteId}/alerts`, { body: { type, channel: "email", config: { email: to, ...config } } })).json.alert.id as string;
      const paymentAlert = await create("payment", {});
      const digestAlert = await create("digest", { frequency: "daily" });
      const goalAlert = await create("goal", { goal: "signup" });
      const webhook = (await owner(`/api/sites/${siteId}/alerts`, { body: { type: "payment", channel: "webhook", config: { url: "https://hooks.example.com/pay" } } })).json.alert.id;
      const site = (await getSite(rt.db, siteId))!;

      stubFetch();
      const { payment } = await recordPayment(rt, site, { provider: "stripe", transactionId: "pi_rev_alert", type: "new", amount: 2500, currency: "USD", visitorId: "visitor-rev-0001" });
      await notifyPayment(rt, site, payment);
      // Members who can see revenue, and addresses that aren't members, get the payment; the viewer gets nothing.
      expect(emails().map((e) => e.to)).toEqual([["owner@example.com", "investor@example.org"]]);
      // Channels admins set up are unchanged.
      expect(sent.find((s) => s.url === "https://hooks.example.com/pay")?.body.data.revenue).toBe(25);

      stubFetch();
      await notifyGoal(rt, site, "signup", "visitor-rev-0001", "session-rev-0001");
      expect(emails().map((e) => e.to)).toEqual([["owner@example.com", "digest-viewer@example.com", "investor@example.org"]]);

      stubFetch();
      expect((await owner(`/api/sites/${siteId}/alerts/${digestAlert}/test`, { body: {} })).status).toBe(200);
      const digests = emails();
      expect(digests.map((e) => e.to).sort()).toEqual([["digest-viewer@example.com"], ["owner@example.com", "investor@example.org"]]);
      const full = digests.find((e) => e.to.includes("owner@example.com"))!;
      const restricted = digests.find((e) => e.to.includes("digest-viewer@example.com"))!;
      expect(full.text).toContain("Revenue");
      expect(restricted.text).toContain("Visitors");
      for (const body of [restricted.text, restricted.html]) expect(body).not.toMatch(/revenue|payment|customer|conversion|mrr|\$|€/i);

      // A payment alert's test skips the viewer too, and says so when no one is left.
      stubFetch();
      await owner(`/api/sites/${siteId}/alerts/${paymentAlert}/test`, { body: {} });
      expect(emails().map((e) => e.to)).toEqual([["owner@example.com", "investor@example.org"]]);
      await owner(`/api/sites/${siteId}/alerts/${paymentAlert}`, { method: "PATCH", body: { config: { email: "digest-viewer@example.com" } } });
      const none = await owner(`/api/sites/${siteId}/alerts/${paymentAlert}/test`, { body: {} });
      expect(none.status).toBe(400);
      expect(none.json.error).toContain("can see revenue");
      for (const id of [paymentAlert, digestAlert, goalAlert, webhook]) await owner(`/api/sites/${siteId}/alerts/${id}`, { method: "DELETE" });
    });
  });
});

/** Applies the migrations up to `last`, as an older OpenRev would have. */
async function migrateUpTo(db: Database, last: number) {
  await db.exec("CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)");
  for (const m of migrations.filter((x) => x.id <= last)) {
    await db.exec(m.sql);
    await db.run("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)", [m.id, m.name, Date.now()]);
  }
}

describe.each([
  ["sqlite", () => nodeSqliteDatabase(":memory:")],
  ["pglite", () => pgliteDb({ migrate: false })],
] as [string, () => Promise<Database>][])("upgrading to 'Can see revenue' (%s)", (_name, makeDb) => {
  it("takes revenue from every existing member but the owner, tells owners and admins once, and lets them grant it back", async () => {
    const db = await makeDb();
    await migrateUpTo(db, 6);
    const now = Date.now();
    const users: Record<string, string> = {};
    for (const who of ["owner", "admin", "viewer"]) users[who] = (await createUser(db, { email: `${who}@example.com`, password: "supersecret", isAdmin: who === "owner" })).id;
    for (const id of ["site-a", "site-b"]) {
      await db.run("INSERT INTO sites (id, domain, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)", [id, `${id}.example.com`, id, users.owner, now]);
    }
    await db.batch([
      { sql: "INSERT INTO site_members (site_id, user_id, role, created_at) VALUES ('site-a', ?, 'owner', ?)", params: [users.owner, now] },
      { sql: "INSERT INTO site_members (site_id, user_id, role, created_at) VALUES ('site-a', ?, 'admin', ?)", params: [users.admin, now] },
      { sql: "INSERT INTO site_members (site_id, user_id, role, created_at) VALUES ('site-a', ?, 'viewer', ?)", params: [users.viewer, now] },
      // A website with only its owner: nothing changes there, so it gets no notice.
      { sql: "INSERT INTO site_members (site_id, user_id, role, created_at) VALUES ('site-b', ?, 'owner', ?)", params: [users.owner, now] },
    ]);
    await migrate(db);
    const rows = await db.all<{ site_id: string; user_id: string; can_see_revenue: number; revenue_notice: number }>(
      "SELECT site_id, user_id, can_see_revenue, revenue_notice FROM site_members ORDER BY site_id, created_at",
    );
    const flags = (site: string, user: string) => rows.find((r) => r.site_id === site && r.user_id === user)!;
    expect(flags("site-a", users.owner)).toMatchObject({ can_see_revenue: 1, revenue_notice: 1 });
    expect(flags("site-a", users.admin)).toMatchObject({ can_see_revenue: 0, revenue_notice: 1 });
    expect(flags("site-a", users.viewer)).toMatchObject({ can_see_revenue: 0, revenue_notice: 0 });
    expect(flags("site-b", users.owner)).toMatchObject({ can_see_revenue: 1, revenue_notice: 0 });

    const rt = await testRuntime(db);
    const app = createApp(() => rt);
    const site = (await getSite(db, "site-a"))!;
    await ingestEvent(rt, { type: "pageview", websiteId: "site-a", href: "https://site-a.example.com/", visitorId: "visitor-upg-0001", sessionId: "session-upg-0001" }, { ip: "1.2.3.4", userAgent: CHROME, geo: { country: "CA" } });
    await recordPayment(rt, site, { provider: "stripe", transactionId: "pi_upg", type: "new", amount: 1000, currency: "USD", visitorId: "visitor-upg-0001" });
    const signIn = async (who: string) => {
      const c = client(app);
      expect((await c("/api/auth/login", { body: { email: `${who}@example.com`, password: "supersecret" } })).status).toBe(200);
      return c;
    };
    const [owner, admin, viewer] = [await signIn("owner"), await signIn("admin"), await signIn("viewer")];
    const overview = "/api/sites/site-a/stats/overview?period=today";
    expect((await owner(overview)).json.current.revenue).toBe(1000);
    for (const member of [admin, viewer]) expect((await member(overview)).json.current).not.toHaveProperty("revenue");

    // The owner can't lose it.
    expect((await owner(`/api/sites/site-a/members/${users.owner}`, { method: "PATCH", body: { can_see_revenue: false } })).status).toBe(400);

    // The notice shows once to owners and admins, until each dismisses it.
    expect((await owner("/api/sites/site-a/members")).json.revenue_notice).toBe(true);
    expect((await admin("/api/sites/site-a/members")).json.revenue_notice).toBe(true);
    expect((await viewer("/api/sites/site-a/members")).json.revenue_notice).toBe(false);
    expect((await owner("/api/sites/site-b/members")).json.revenue_notice).toBe(false);
    await owner("/api/sites/site-a/revenue-notice", { method: "DELETE" });
    expect((await owner("/api/sites/site-a/members")).json.revenue_notice).toBe(false);
    expect((await admin("/api/sites/site-a/members")).json.revenue_notice).toBe(true);

    // New invitations start without it.
    const link = (await owner("/api/sites/site-a/invites", { body: { role: "admin" } })).json.url as string;
    const newcomer = client(app);
    await newcomer("/api/auth/signup", { body: { email: "newcomer@example.com", password: "supersecret", invite: link.split("/").pop() } });
    expect((await newcomer(overview)).json.current).not.toHaveProperty("revenue");

    // Granting it restores revenue at once.
    await owner(`/api/sites/site-a/members/${users.admin}`, { method: "PATCH", body: { can_see_revenue: true } });
    expect((await admin(overview)).json.current.revenue).toBe(1000);
    await db.close?.();
  });
});
