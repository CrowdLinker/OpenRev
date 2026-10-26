import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import sdkPackage from "../packages/react-native/package.json";
import { createClient, VERSION } from "../packages/react-native/core.js";
import { createApp } from "../src/server/app";
import type { Runtime } from "../src/server/context";
import type { Database } from "../src/server/db/types";
import { ingestEvent } from "../src/server/services/ingest";
import { invalidateSite } from "../src/server/services/sites";
import { testDb, testRuntime } from "./helpers";
import { pgliteDb } from "./pglite";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const OKHTTP = "okhttp/4.12.0";

describe("React Native SDK package", () => {
  const options = (sent: string[], host = "https://openrev.test") => ({
    host,
    websiteId: "site1234",
    appId: "com.lumen.app",
    storage: { getItem: () => null, setItem: () => {} },
    fetch: (async (url: string, init?: RequestInit) => {
      sent.push(url, String(init?.body));
      return new Response("{}");
    }) as typeof fetch,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the version in its package.json", () => {
    expect(VERSION).toBe(sdkPackage.version);
  });

  it("makes ids only from a secure random source", async () => {
    // React Native with react-native-get-random-values: getRandomValues, no randomUUID.
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array<ArrayBuffer>) => real.getRandomValues(a) });
    const client = createClient(options([]));
    expect(await client.visitorId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Without one, it says what to install instead of making guessable ids.
    vi.stubGlobal("crypto", undefined);
    expect(() => createClient(options([]))).toThrow(/react-native-get-random-values/);
  });

  it("trims the host's trailing slashes, quickly even for a long run of them", async () => {
    const sent: string[] = [];
    await createClient(options(sent, "https://openrev.test///")).screen("Home");
    expect(sent[0]).toBe("https://openrev.test/api/events");

    const started = performance.now();
    createClient(options([], `https://openrev.test${"/".repeat(100_000)}x`));
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe.each([
  ["sqlite", testDb],
  ["pglite", pgliteDb],
] as [string, () => Promise<Database>][])("mobile apps (%s)", (_name, makeDb) => {
  let rt: Runtime;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let siteId = "";

  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { "User-Agent": CHROME };
    if (cookie) headers.Cookie = cookie;
    const body = init.body !== undefined ? JSON.stringify(init.body) : undefined;
    if (body) headers["Content-Type"] = "application/json";
    const res = await app.request("http://openrev.test" + path, { method: init.method ?? (body ? "POST" : "GET"), headers, body });
    const sc = res.headers.get("set-cookie");
    if (sc?.startsWith("openrev_auth=")) cookie = sc.split(";")[0];
    return { status: res.status, json: await res.json() };
  };

  /** An SDK client whose requests reach the app in this process, with the user agent React Native's HTTP client sends. */
  const sdk = (opts: { storage?: Map<string, string>; now?: () => number; initialURL?: string; platform?: object } = {}) => {
    const store = opts.storage ?? new Map<string, string>();
    return createClient({
      host: "https://openrev.test",
      websiteId: siteId,
      appId: "com.Lumen.app",
      appVersion: "2.3.1",
      storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
      platform: opts.platform ?? { os: "ios", osVersion: "17.4", device: "phone", screenWidth: 393, language: "en-CA" },
      initialURL: opts.initialURL ?? null,
      now: opts.now,
      fetch: ((input: string, init?: RequestInit) =>
        app.request(input, { ...init, headers: { ...(init?.headers as Record<string, string>), "User-Agent": OKHTTP } })) as typeof fetch,
    });
  };

  beforeAll(async () => {
    rt = await testRuntime(await makeDb());
    app = createApp(() => rt);
    await call("/api/auth/signup", { body: { email: "owner@example.com", password: "supersecret" } });
    siteId = (await call("/api/sites", { body: { domain: "lumen.app", timezone: "UTC", currency: "USD" } })).json.site.id;
  });

  it("accepts app events only from the listed app ids", async () => {
    const event = { type: "pageview", websiteId: siteId, href: "app://com.lumen.app/Home", visitorId: "visitor-app-0001", sessionId: "session-app-0001" };
    expect(await ingestEvent(rt, event, { ip: "1.2.3.4", userAgent: OKHTTP, geo: null })).toEqual({ ok: false, reason: "app_not_allowed" });
    expect((await call(`/api/sites/${siteId}`, { method: "PATCH", body: { settings: { appIds: ["not an id"] } } })).status).toBe(400);
    const saved = await call(`/api/sites/${siteId}`, { method: "PATCH", body: { settings: { appIds: ["com.Lumen.app", "com.lumen.app", "app.lumen.android"] } } });
    expect(saved.json.site.settings.appIds).toEqual(["com.lumen.app", "app.lumen.android"]);
    invalidateSite(siteId);
    // A browser can't pass for the app, and an okhttp user agent still isn't a website visitor.
    expect((await ingestEvent(rt, { ...event, href: "https://lumen.app/" }, { ip: "1.2.3.4", userAgent: OKHTTP, geo: null })).ok).toBe(false);
    expect((await ingestEvent(rt, event, { ip: "1.2.3.4", userAgent: OKHTTP, geo: null })).ok).toBe(true);
  });

  it("records screens, goals and the device from the SDK", async () => {
    const client = sdk();
    await client.screen("Home");
    await client.screen("Settings/Billing");
    await client.track("trial_started", { plan: "pro" });
    await client.identify({ user_id: "usr_1", email: "ada@example.com", name: "Ada" });
    const vid = await client.visitorId();
    const s = await rt.db.first<Record<string, unknown>>("SELECT * FROM sessions WHERE visitor_id = ?", [vid]);
    expect(s).toMatchObject({
      hostname: "com.lumen.app",
      entry_page: "/Home",
      exit_page: "/Settings/Billing",
      pageviews: 2,
      goals: 1,
      browser: "App",
      browser_version: "2.3.1",
      os: "iOS",
      os_version: "17",
      device: "mobile",
      language: "en-CA",
      channel: "Direct",
    });
    const v = await rt.db.first<{ email: string }>("SELECT email FROM visitors WHERE id = ?", [vid]);
    expect(v?.email).toBe("ada@example.com");

    const tablet = sdk({ platform: { os: "android", osVersion: "14", device: "tablet", screenWidth: 800 } });
    await tablet.screen("Home");
    const t = await rt.db.first<Record<string, unknown>>("SELECT os, os_version, device FROM sessions WHERE visitor_id = ?", [await tablet.visitorId()]);
    expect(t).toEqual({ os: "Android", os_version: "14", device: "tablet" });
  });

  it("keeps the visitor across launches and starts a new session after 30 minutes", async () => {
    const storage = new Map<string, string>();
    let t = Date.now();
    const first = sdk({ storage, now: () => t });
    await first.screen("Home");
    const vid = await first.visitorId();
    const sid = await first.sessionId();
    t += 10 * 60_000;
    const relaunch = sdk({ storage, now: () => t });
    await relaunch.screen("Feed");
    expect(await relaunch.visitorId()).toBe(vid);
    expect(await relaunch.sessionId()).toBe(sid);
    t += 31 * 60_000;
    await relaunch.screen("Feed");
    expect(await relaunch.sessionId()).not.toBe(sid);
  });

  it("continues a website visitor's journey in the app: web-to-app funnels and revenue", async () => {
    // On the website: a visit from a newsletter, then the download page.
    const web = { websiteId: siteId, visitorId: "visitor-web-0001", sessionId: "session-web-0001", referrer: "https://news.ycombinator.com/" };
    const meta = { ip: "5.6.7.8", userAgent: CHROME, geo: null };
    await ingestEvent(rt, { type: "pageview", ...web, href: "https://lumen.app/" }, meta);
    await ingestEvent(rt, { type: "pageview", ...web, href: "https://lumen.app/download" }, meta);

    // The app opens from a link carrying the visitor id and a campaign.
    const client = sdk({ initialURL: "lumen://welcome?_or_vid=visitor-web-0001&_or_sid=session-web-0001&utm_source=website&utm_campaign=download-page" });
    await client.screen("Onboarding");
    await client.track("subscribed");
    expect(await client.visitorId()).toBe("visitor-web-0001");
    const appSession = await rt.db.first<Record<string, unknown>>("SELECT * FROM sessions WHERE visitor_id = ? AND hostname = 'com.lumen.app'", ["visitor-web-0001"]);
    expect(appSession).toMatchObject({ entry_page: "/Onboarding", is_new: 0, utm_source: "website", utm_campaign: "download-page" });

    // A funnel from the website's download page to the app's onboarding and subscription.
    const funnel = (
      await call(`/api/sites/${siteId}/funnels`, {
        body: {
          name: "Web to app",
          steps: [
            { type: "page", value: "/download" },
            { type: "page", value: "/Onboarding" },
            { type: "goal", value: "subscribed" },
          ],
        },
      })
    ).json.funnel;
    const results = (await call(`/api/sites/${siteId}/stats/funnels/${funnel.id}?period=today`)).json;
    expect(results.results.map((s: { visitors: number }) => s.visitors)).toEqual([1, 1, 1]);

    // A link can't move an established install to another visitor.
    const installed = Date.now();
    const storage = new Map<string, string>();
    const own = await sdk({ storage, now: () => installed }).visitorId();
    const later = sdk({ storage, now: () => installed + 2 * 86_400_000 });
    await later.handleURL("https://lumen.app/open?_or_vid=visitor-web-0002");
    expect(await later.visitorId()).toBe(own);
  });

  it("reads the Play Store install referrer once", async () => {
    const client = sdk();
    await client.setInstallReferrer("utm_source%3Dgoogle-play%26utm_medium%3Dbanner%26_or_vid%3Dvisitor-web-0003");
    await client.screen("Home");
    expect(await client.visitorId()).toBe("visitor-web-0003");
    const s = await rt.db.first<Record<string, unknown>>("SELECT utm_source, utm_medium FROM sessions WHERE visitor_id = ?", ["visitor-web-0003"]);
    expect(s).toEqual({ utm_source: "google-play", utm_medium: "banner" });
  });

  it("stops sending after opting out", async () => {
    const client = sdk();
    await client.optOut(true);
    await client.screen("Secret");
    expect(await rt.db.first("SELECT 1 AS found FROM events WHERE path = '/Secret'")).toBeFalsy();
  });
});
