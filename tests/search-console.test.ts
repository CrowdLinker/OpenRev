import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { Runtime } from "../src/server/context";
import type { Database } from "../src/server/db/types";
import { clearGoogleTokens } from "../src/server/lib/google";
import { ingestEvent } from "../src/server/services/ingest";
import { recordPayment } from "../src/server/services/payments";
import { getSearchConsole, HISTORY_DAYS, pagePath, syncSearchConsole } from "../src/server/services/search-console";
import { getSite } from "../src/server/services/sites";
import { testDb, testRuntime } from "./helpers";
import { pgliteDb } from "./pglite";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const DAY = 86_400_000;

async function serviceAccountKey() {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return {
    type: "service_account",
    client_email: "openrev@p.iam.gserviceaccount.com",
    private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`,
  };
}

/** A fake Search Console: two properties, and the same three rows for every day. */
function fakeGoogle(properties = ["https://other.com/", "sc-domain:example.com"]) {
  const queried: string[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "gsc-token", expires_in: 3600 });
    if (url === "https://searchconsole.googleapis.com/webmasters/v3/sites") {
      return Response.json({ siteEntry: properties.map((siteUrl) => ({ siteUrl, permissionLevel: "siteFullUser" })) });
    }
    expect(url).toBe("https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ dimensions: ["query", "page"], type: "web" });
    queried.push(body.startDate);
    return Response.json({
      rows: [
        { keys: ["openrev", "https://example.com/pricing/"], clicks: 6, impressions: 50, position: 2 },
        { keys: ["openrev", "http://example.com/pricing?ref=x"], clicks: 4, impressions: 30, position: 4 },
        { keys: ["open source analytics", "https://example.com/"], clicks: 5, impressions: 200, position: 8 },
        { keys: ["openrev pricing", "https://example.com/pricing"], clicks: 10, impressions: 20, position: 1 },
      ],
    });
  };
  return { fetchFn, queried };
}

describe("search console helpers", () => {
  it("stores landing pages like entry pages", () => {
    expect(pagePath("https://example.com/pricing/")).toBe("/pricing");
    expect(pagePath("https://example.com/caf%C3%A9?x=1")).toBe("/café");
    expect(pagePath("https://example.com")).toBe("/");
  });
});

describe.each([
  ["sqlite", testDb],
  ["pglite", pgliteDb],
] as [string, () => Promise<Database>][])("search console (%s)", (_name, makeDb) => {
  let rt: Runtime;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let siteId = "";

  const call = async (path: string, init: { body?: unknown; method?: string } = {}) => {
    const headers: Record<string, string> = { "User-Agent": UA };
    if (cookie) headers.Cookie = cookie;
    const body = init.body !== undefined ? JSON.stringify(init.body) : undefined;
    if (body) headers["Content-Type"] = "application/json";
    const res = await app.request("http://openrev.test" + path, { method: init.method ?? (body ? "POST" : "GET"), headers, body });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie?.startsWith("openrev_auth=")) cookie = setCookie.split(";")[0];
    return { status: res.status, json: await res.json() };
  };

  beforeAll(async () => {
    rt = await testRuntime(await makeDb());
    app = createApp(() => rt);
    await call("/api/auth/signup", { body: { email: "owner@example.com", password: "supersecret" } });
    siteId = (await call("/api/sites", { body: { domain: "example.com", timezone: "UTC", currency: "USD" } })).json.site.id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearGoogleTokens();
  });

  it("connects to the property that matches the website, or asks which one", async () => {
    const key = await serviceAccountKey();
    vi.stubGlobal("fetch", fakeGoogle(["https://other.com/", "https://blog.example.org/"]).fetchFn);
    const none = await call(`/api/sites/${siteId}/search-console`, { body: { key: JSON.stringify(key) } });
    expect(none.status).toBe(400);
    expect(none.json.properties).toEqual(["https://blog.example.org/", "https://other.com/"]);

    vi.stubGlobal("fetch", fakeGoogle().fetchFn);
    const ok = await call(`/api/sites/${siteId}/search-console`, { body: { key: JSON.stringify(key) } });
    expect(ok.status).toBe(200);
    expect(ok.json.connection).toMatchObject({ property: "sc-domain:example.com", oldest: null, backfilled: false });
    expect((await call(`/api/sites/${siteId}/stats/meta`)).json.searchConsole).toBe(true);
  });

  it("syncs recent days, then history, and estimates revenue per keyword from landing pages", async () => {
    const site = (await getSite(rt.db, siteId))!;
    const now = Date.UTC(2026, 5, 15, 12);
    const google = fakeGoogle();
    let row = (await getSearchConsole(rt.db, siteId))!;
    const first = await syncSearchConsole(rt, site, row, { now, fetchFn: google.fetchFn });
    expect(google.queried).toEqual(["2026-06-12", "2026-06-13", "2026-06-14"]); // recent days first
    expect(first).toMatchObject({ newest: "2026-06-14", oldest: "2026-06-12", backfilled: false });

    row = (await getSearchConsole(rt.db, siteId))!;
    const history = await syncSearchConsole(rt, site, row, { now: now + 60_000, fetchFn: google.fetchFn, maxDays: 1000, maxStatements: 100_000 });
    expect(history.backfilled).toBe(true);
    expect(history.oldest).toBe(new Date(Date.UTC(2026, 5, 14) - HISTORY_DAYS * DAY).toISOString().slice(0, 10));
    expect(google.queried.length).toBe(HISTORY_DAYS + 1);

    // A Google organic visit that landed on /pricing and paid $49.
    const visit = await ingestEvent(
      rt,
      { type: "pageview", websiteId: siteId, href: "https://example.com/pricing", referrer: "https://www.google.com/", visitorId: "visitor-gsc-0001", sessionId: "session-gsc-0001" },
      { ip: "1.2.3.4", userAgent: UA, geo: null },
    );
    expect(visit.ok).toBe(true);
    await rt.db.run("UPDATE sessions SET started_at = ?, last_seen_at = ? WHERE id = 'session-gsc-0001'", [Date.UTC(2026, 5, 14, 8), Date.UTC(2026, 5, 14, 8)]);
    await rt.db.run("UPDATE events SET ts = ? WHERE session_id = 'session-gsc-0001'", [Date.UTC(2026, 5, 14, 8)]);
    await recordPayment(rt, site, {
      provider: "api",
      transactionId: "pi_gsc",
      type: "new",
      amount: 4900,
      currency: "USD",
      timestamp: Date.UTC(2026, 5, 14, 9),
      visitorId: "visitor-gsc-0001",
      sessionId: "session-gsc-0001",
    });

    const res = await call(`/api/sites/${siteId}/stats/search-keywords?from=2026-06-08&to=2026-06-14&sort=revenue`);
    expect(res.status).toBe(200);
    const byQuery = Object.fromEntries(res.json.rows.map((r: { query: string }) => [r.query, r]));
    // /pricing's $49 is split 70:70 by clicks between the two queries that led there; "/" earned nothing.
    expect(byQuery["openrev pricing"]).toMatchObject({ page: "/pricing", clicks: 70, revenue: 2450 });
    expect(byQuery["openrev"]).toMatchObject({ page: "/pricing", clicks: 70, impressions: 560, revenue: 2450 });
    expect(byQuery["openrev"].position).toBeCloseTo((2 * 50 + 4 * 30) / 80);
    expect(byQuery["open source analytics"]).toMatchObject({ page: "/", revenue: 0 });
    expect(res.json.rows[2].query).toBe("open source analytics");
    expect(res.json.totals).toMatchObject({ revenue: 4900, organic_revenue: 4900 });
  });

  it("disconnects and deletes the synced data", async () => {
    expect((await call(`/api/sites/${siteId}/search-console`, { method: "DELETE" })).status).toBe(200);
    expect(await rt.db.first("SELECT COUNT(*) AS n FROM search_stats")).toEqual({ n: 0 });
    expect((await call(`/api/sites/${siteId}/stats/meta`)).json.searchConsole).toBe(false);
  });
});
