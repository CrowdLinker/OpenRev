import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { Runtime } from "../src/server/context";
import type { Database, SqlValue } from "../src/server/db/types";
import { accessToken, clearGoogleTokens, parseServiceAccountKey } from "../src/server/lib/google";
import { GA4_REPORTS, GA4_SCOPE, parsePropertyId } from "../src/server/services/ga4";
import { mapRow } from "../src/server/services/imports";
import { testDb, testRuntime } from "./helpers";
import { pgliteDb } from "./pglite";

const SITE = { domain: "example.com", settings: {} };

/** A service account key with a new RSA private key, as in the JSON key file Google downloads. */
async function serviceAccountKey(clientEmail = "openrev@p.iam.gserviceaccount.com") {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
  return { pair, key: { type: "service_account", project_id: "p", client_email: clientEmail, private_key: pem, token_uri: "https://oauth2.googleapis.com/token" } };
}
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe("mapping export rows", () => {
  const values = (table: Parameters<typeof mapRow>[1], row: Record<string, string | number>) =>
    Object.fromEntries(mapRow(SITE, table, row).map((c) => [c.dim, c.value]));

  it("classifies sources like OpenRev's own visits", () => {
    expect(values("sources", { referrer: "news.ycombinator.com/item", source: "Hacker News", visitors: 3 })).toMatchObject({
      source: "Hacker News",
      referrer: "news.ycombinator.com",
      utm_source: "",
    });
    expect(values("sources", { source: "", referrer: "", visitors: 1 })).toMatchObject({ source: "Direct", channel: "Direct" });
    expect(values("sources", { source: "Newsletter", utm_source: "newsletter", utm_medium: "email", utm_campaign: "launch" })).toMatchObject({
      channel: "Email",
      utm_campaign: "launch",
    });
    // GA4 rows: session source and medium, without UTM tags.
    expect(values("sources", { source: "google", medium: "organic" })).toMatchObject({ source: "Google", channel: "Organic Search", utm_medium: "" });
    // A referral from the site itself is direct traffic.
    expect(values("sources", { referrer: "www.example.com/pricing" })).toMatchObject({ source: "Direct" });
  });

  it("uses OpenRev's names for devices, browsers and systems, and keeps only location names", () => {
    expect(values("devices", { device: "Laptop" }).device).toBe("desktop");
    expect(values("browsers", { browser: "Microsoft Edge" }).browser).toBe("Edge");
    expect(values("browsers", { browser: "Mobile Safari" }).browser).toBe("Safari");
    expect(values("operating_systems", { operating_system: "Mac" }).os).toBe("macOS");
    expect(values("operating_systems", { operating_system: "GNU/Linux" }).os).toBe("Linux");
    expect(values("locations", { country: "US", region: "US-CA", city: "5391959" })).toEqual({ country: "US" });
    expect(values("locations", { country: "US", region: "California", city: "San Francisco" })).toEqual({ country: "US", region: "California", city: "San Francisco" });
  });

  it("turns custom events into goals and outbound clicks", () => {
    expect(mapRow(SITE, "custom_events", { name: "Signup", visitors: 4, events: 5 })).toEqual([{ dim: "goal", value: "Signup", m: { visitors: 4, events: 5 } }]);
    expect(values("custom_events", { name: "Outbound Link: Click", link_url: "https://github.com/x/y?z=1" })).toEqual({ outbound: "https://github.com/x/y" });
    expect(mapRow(SITE, "custom_events", { name: "engagement", visitors: 9 })).toEqual([]);
  });

  it("reads GA4 property ids and service account keys", () => {
    expect(parsePropertyId("properties/123456789")).toBe("123456789");
    expect(() => parsePropertyId("G-ABC123")).toThrow(/measurement ID/);
    expect(() => parseServiceAccountKey("{}")).toThrow(/service account key/);
    expect(() => parseServiceAccountKey("nope")).toThrow(/JSON key file/);
  });
});

describe("Google access tokens", () => {
  afterEach(() => clearGoogleTokens());

  it("reuses a token only for the private key that signed for it", async () => {
    const { key } = await serviceAccountKey("shared@p.iam.gserviceaccount.com");
    const { key: other } = await serviceAccountKey("shared@p.iam.gserviceaccount.com"); // same account name, another key
    let calls = 0;
    const fetchFn = async () => Response.json({ access_token: `token-${++calls}`, expires_in: 3600 });
    expect(await accessToken(parseServiceAccountKey(key), GA4_SCOPE, fetchFn)).toBe("token-1");
    expect(await accessToken(parseServiceAccountKey(key), GA4_SCOPE, fetchFn)).toBe("token-1");
    expect(await accessToken(parseServiceAccountKey(other), GA4_SCOPE, fetchFn)).toBe("token-2");
    expect(calls).toBe(2);
  });
});

describe.each([
  ["sqlite", testDb],
  ["pglite", pgliteDb],
] as [string, () => Promise<Database>][])("imports (%s)", (_name, makeDb) => {
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
  const stats = (path: string) => call(`/api/sites/${siteId}/stats/${path}`);

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

  it("adds a Plausible export to the reports, once, and only without filters", async () => {
    const created = await call(`/api/sites/${siteId}/imports`, { body: { source: "plausible", date_from: "2025-01-01", date_to: "2025-01-31" } });
    expect(created.status).toBe(200);
    const id = created.json.import.id;
    const rows = (seq: number, table: string, data: Record<string, unknown>[]) => call(`/api/sites/${siteId}/imports/${id}/rows`, { body: { seq, table, rows: data } });

    const visitors = [
      { date: "2025-01-10", visitors: 100, pageviews: 250, bounces: 40, visits: 120, visit_duration: 6000 },
      { date: "2025-01-11", visitors: 50, pageviews: 100, bounces: 10, visits: 60, visit_duration: 3000 },
      { date: "2025-02-15", visitors: 999, pageviews: 999, bounces: 0, visits: 999, visit_duration: 0 }, // after date_to: dropped
    ];
    expect((await rows(0, "visitors", visitors)).json).toMatchObject({ ok: true, duplicate: false });
    expect((await rows(0, "visitors", visitors)).json).toMatchObject({ ok: true, duplicate: true }); // a retry adds nothing
    await rows(1, "sources", [
      { date: "2025-01-10", source: "Hacker News", referrer: "news.ycombinator.com", visitors: 70, visits: 80, pageviews: 180, bounces: 20, visit_duration: 4000 },
      { date: "2025-01-10", source: "", referrer: "", visitors: 30, visits: 40, pageviews: 70, bounces: 20, visit_duration: 2000 },
      { date: "2025-01-11", source: "Hacker News", referrer: "news.ycombinator.com/item", visitors: 50, visits: 60, pageviews: 100, bounces: 10, visit_duration: 3000 },
    ]);
    await rows(2, "pages", [{ date: "2025-01-10", hostname: "example.com", page: "/pricing", visitors: 40, visits: 45, pageviews: 60 }]);
    await rows(3, "custom_events", [{ date: "2025-01-11", name: "Signup", link_url: "", path: "", visitors: 5, events: 6 }]);
    expect((await call(`/api/sites/${siteId}/imports/${id}/finish`, { body: {} })).json.import).toMatchObject({ status: "done", imported_rows: 7 });

    const range = "period=custom&from=2025-01-01&to=2025-01-31";
    const overview = (await stats(`overview?${range}`)).json.current;
    expect(overview).toMatchObject({ visitors: 150, sessions: 180, pageviews: 350, new_visitors: 150 });
    expect(overview.bounce_rate).toBeCloseTo(50 / 180);
    expect(overview.avg_session_duration).toBeCloseTo(9000 / 180);

    const series = (await stats(`timeseries?${range}&interval=day`)).json.points;
    expect(series.find((p: { date: string }) => p.date === "2025-01-10")).toMatchObject({ visitors: 100, pageviews: 250 });

    const sources = (await stats(`breakdown/source?${range}`)).json.rows;
    expect(sources[0]).toMatchObject({ value: "Hacker News", meta: "news.ycombinator.com", visitors: 120, sessions: 140 });
    expect(sources[0].avg_session_duration).toBeCloseTo(7000 / 140);
    expect((await stats(`breakdown/channel?${range}`)).json.rows.map((r: { value: string }) => r.value)).toContain("Direct");
    expect((await stats(`breakdown/page?${range}`)).json.rows[0]).toMatchObject({ value: "/pricing", visitors: 40, pageviews: 60 });
    expect((await stats(`breakdown/goal?${range}`)).json.rows[0]).toMatchObject({ value: "Signup", visitors: 5, completions: 6, conversion_rate: 5 / 150 });

    // Imported totals can't be filtered, so filters leave them out; so does imported=false.
    expect((await stats(`overview?${range}&filter_country=US`)).json.current.visitors).toBe(0);
    expect((await stats(`overview?${range}&imported=false`)).json.current.visitors).toBe(0);
    expect((await stats(`meta`)).json.imports).toEqual([{ source: "plausible", date_from: "2025-01-01", date_to: "2025-01-31" }]);
  });

  it("refuses overlapping imports and imports into OpenRev's own data, and deletes cleanly", async () => {
    const overlap = await call(`/api/sites/${siteId}/imports`, { body: { source: "plausible", date_from: "2025-01-20", date_to: "2025-02-10" } });
    expect(overlap.status).toBe(400);
    expect(overlap.json.error).toMatch(/overlaps the Plausible import/);

    // A native visit on 2025-03-05 means imports must end before that day.
    await rt.db.run("INSERT INTO sessions (id, site_id, visitor_id, started_at, last_seen_at, channel) VALUES ('s-native-1', ?, 'v-native-1', ?, ?, 'Direct')", [
      siteId,
      Date.UTC(2025, 2, 5, 12),
      Date.UTC(2025, 2, 5, 12),
    ]);
    const late = await call(`/api/sites/${siteId}/imports`, { body: { source: "plausible", date_from: "2025-02-01", date_to: "2025-03-05" } });
    expect(late.json.error).toMatch(/own data from 2025-03-05/);
    expect((await call(`/api/sites/${siteId}/imports`)).json.first_native_date).toBe("2025-03-05");

    const id = (await call(`/api/sites/${siteId}/imports`)).json.imports[0].id;
    expect((await call(`/api/sites/${siteId}/imports/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await stats("overview?period=custom&from=2025-01-01&to=2025-01-31")).json.current.visitors).toBe(0);
    expect(await rt.db.first("SELECT COUNT(*) AS n FROM import_chunks")).toEqual({ n: 0 });
  });

  it("imports Google Analytics 4 through the Data API with a service account", async () => {
    const { pair, key } = await serviceAccountKey();

    const requests: { dims: string[]; offset: number }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url === "https://oauth2.googleapis.com/token") {
        // The assertion must be a JWT signed with the key's private key.
        const assertion = new URLSearchParams(String(init.body)).get("assertion")!;
        const [h, c, sig] = assertion.split(".");
        const bytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
        const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, bytes, new TextEncoder().encode(`${h}.${c}`));
        const claims = JSON.parse(atob(c.replace(/-/g, "+").replace(/_/g, "/")));
        if (!ok || claims.iss !== key.client_email || !String(claims.scope).includes("analytics.readonly")) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: "token-1", expires_in: 3600 });
      }
      expect(url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
      const body = JSON.parse(String(init.body));
      const dims: string[] = body.dimensions.map((d: { name: string }) => d.name);
      requests.push({ dims, offset: body.offset });
      const row = (d: string[], m: number[]) => ({ dimensionValues: d.map((value) => ({ value })), metricValues: m.map((v) => ({ value: String(v) })) });
      const session = [20, 25, 60, 15, 30]; // users, sessions, views, engaged sessions, average duration
      const byDim: Record<string, ReturnType<typeof row>[]> = {
        "": [row(["20240601"], session)],
        sessionSource: [row(["20240601", "google", "organic", "(organic)"], session)],
        pagePath: [row(["20240601", "/blog"], [10, 12, 30])],
        landingPage: [row(["20240601", "/blog"], session)],
        countryId: [row(["20240601", "DE", "Berlin", "Berlin"], session)],
        deviceCategory: [row(["20240601", "mobile"], session)],
        browser: [row(["20240601", "Chrome"], session)],
        operatingSystem: [row(["20240601", "Android"], session)],
        eventName: [row(["20240601", "page_view"], [20, 60]), row(["20240601", "purchase"], [2, 2])],
      };
      const rows = byDim[dims[1] ?? ""];
      return Response.json({ rows: body.limit === 1 ? rows.slice(0, 1) : rows, rowCount: rows.length });
    });

    const created = await call(`/api/sites/${siteId}/imports`, {
      body: { source: "ga4", date_from: "2024-06-01", date_to: "2024-06-30", property_id: "123456789", key: JSON.stringify(key) },
    });
    expect(created.status).toBe(200);
    const id = created.json.import.id;
    let steps = 0;
    let res;
    do {
      res = await call(`/api/sites/${siteId}/imports/${id}/step`, { body: {} });
      expect(res.status).toBe(200);
    } while (!res.json.done && ++steps < 20);
    expect(res.json.import).toMatchObject({ status: "done", source: "ga4" });
    expect(requests.filter((r) => r.offset === 0).length).toBe(GA4_REPORTS.length + 1); // the access check, then each report
    const stored = await rt.db.first<{ config: string | null }>("SELECT config FROM imports WHERE id = ?", [id]);
    expect(stored?.config).toBeNull(); // the key is dropped once the import is done

    const range = "period=custom&from=2024-06-01&to=2024-06-30";
    expect((await stats(`overview?${range}`)).json.current).toMatchObject({ visitors: 20, sessions: 25, pageviews: 60 });
    expect((await stats(`overview?${range}`)).json.current.bounce_rate).toBeCloseTo(10 / 25);
    expect((await stats(`breakdown/channel?${range}`)).json.rows[0]).toMatchObject({ value: "Organic Search", visitors: 20 });
    expect((await stats(`breakdown/city?${range}`)).json.rows[0]).toMatchObject({ value: "Berlin", meta: "DE" });
    expect((await stats(`breakdown/goal?${range}`)).json.rows.map((r: { value: string }) => r.value)).toEqual(["purchase"]);
  });

  it("explains a property the service account can't read", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("oauth2")
        ? Response.json({ access_token: "t", expires_in: 3600 })
        : Response.json({ error: { code: 403, message: "User does not have sufficient permissions for this property.", status: "PERMISSION_DENIED" } }, { status: 403 }),
    );
    const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const key = { type: "service_account", client_email: "x@p.iam.gserviceaccount.com", private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----` };
    const res = await call(`/api/sites/${siteId}/imports`, { body: { source: "ga4", date_from: "2023-01-01", date_to: "2023-01-31", property_id: "987654321", key } });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/add x@p\.iam\.gserviceaccount\.com as a Viewer/);
  });

  it("imports a large GA4 report in pages that each fit in one chunk", async () => {
    const { key } = await serviceAccountKey();
    // 1,700 referral sources with a campaign each: every row adds to the source, referrer, utm_source and utm_campaign
    // reports, more cells than one chunk can store if the report came in one page.
    const sources = Array.from({ length: 1700 }, (_, i) => ({
      dimensionValues: ["20230301", `site${i}.example`, "referral", `campaign-${i}`].map((value) => ({ value })),
      metricValues: [1, 1, 2, 1, 30].map((v) => ({ value: String(v) })),
    }));
    const limits: number[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "token-1", expires_in: 3600 });
      const body = JSON.parse(String(init.body));
      const dims: string[] = body.dimensions.map((d: { name: string }) => d.name);
      const rows =
        dims[1] === "sessionSource"
          ? sources
          : dims.length === 1
            ? [{ dimensionValues: [{ value: "20230301" }], metricValues: [1700, 1700, 3400, 1700, 30].map((v) => ({ value: String(v) })) }]
            : [];
      if (dims[1] === "sessionSource") limits.push(body.limit);
      return Response.json({ rows: rows.slice(body.offset, body.offset + body.limit), rowCount: rows.length });
    });

    const created = await call(`/api/sites/${siteId}/imports`, {
      body: { source: "ga4", date_from: "2023-03-01", date_to: "2023-03-31", property_id: "123456789", key: JSON.stringify(key) },
    });
    expect(created.status).toBe(200);
    const id = created.json.import.id;
    let res;
    let steps = 0;
    do {
      res = await call(`/api/sites/${siteId}/imports/${id}/step`, { body: {} });
      expect(res.status).toBe(200);
    } while (!res.json.done && ++steps < 30);
    expect(res.json.import).toMatchObject({ status: "done", imported_rows: 1 + 1700 });
    expect(limits.length).toBeGreaterThan(1);
    expect(await rt.db.first("SELECT COUNT(*) AS n FROM imported_stats WHERE import_id = ? AND dim = 'source'", [id])).toEqual({ n: 1700 });
  });

  it("counts an import once it's complete, and keeps nothing of a failed one", async () => {
    const range = "period=custom&from=2023-05-01&to=2023-05-31";
    const start = async () => (await call(`/api/sites/${siteId}/imports`, { body: { source: "plausible", date_from: "2023-05-01", date_to: "2023-05-31" } })).json.import.id as string;
    const upload = (id: string) =>
      call(`/api/sites/${siteId}/imports/${id}/rows`, {
        body: { seq: 0, table: "visitors", rows: [{ date: "2023-05-10", visitors: 40, visits: 50, pageviews: 90, bounces: 10, visit_duration: 1000 }] },
      });

    const first = await start();
    await upload(first);
    expect((await stats(`overview?${range}`)).json.current.visitors).toBe(0); // not complete yet
    const failed = await call(`/api/sites/${siteId}/imports/${first}/finish`, { body: { error: "The upload stopped" } });
    expect(failed.json.import).toMatchObject({ status: "failed", imported_rows: 0 });
    expect(await rt.db.first("SELECT COUNT(*) AS n FROM imported_stats WHERE import_id = ?", [first])).toEqual({ n: 0 });

    // Importing the same days again counts them once.
    const second = await start();
    await upload(second);
    await call(`/api/sites/${siteId}/imports/${second}/finish`, { body: {} });
    expect((await stats(`overview?${range}`)).json.current.visitors).toBe(40);
  });

  it("creates only one of two overlapping imports sent at the same time", async () => {
    const create = () => call(`/api/sites/${siteId}/imports`, { body: { source: "plausible", date_from: "2022-01-01", date_to: "2022-01-31" } });
    // Both requests read the existing imports before either one writes, as two app instances can.
    const all = rt.db.all;
    rt.db.all = (async (sql: string, params?: SqlValue[]) => {
      const rows = await all.call(rt.db, sql, params);
      if (sql.includes("FROM imports WHERE site_id")) await new Promise((r) => setTimeout(r, 50));
      return rows;
    }) as typeof all;
    const results = await Promise.all([create(), create()]).finally(() => (rt.db.all = all));
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await rt.db.first("SELECT COUNT(*) AS n FROM imports WHERE site_id = ? AND date_from = '2022-01-01'", [siteId])).toEqual({ n: 1 });
  });
});
