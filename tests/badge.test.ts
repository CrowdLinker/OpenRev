import { beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { Runtime } from "../src/server/context";
import type { Database } from "../src/server/db/types";
import { BADGE_TTL_MS, badgeData, badgeSvg, clearBadgeCache } from "../src/server/services/badge";
import { testDb, testRuntime } from "./helpers";
import { pgliteDb } from "./pglite";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const BASE = "http://openrev.test";

describe.each([
  ["sqlite", testDb],
  ["pglite", pgliteDb],
] as [string, () => Promise<Database>][])("live badge (%s)", (_name, makeDb) => {
  let rt: Runtime;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let siteId = "";
  let token = "";

  const call = async (path: string, init: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "User-Agent": UA, ...(init.headers ?? {}) };
    if (cookie) headers.Cookie = cookie;
    const body = init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await app.request(BASE + path, { method: body !== undefined ? "POST" : "GET", headers, body });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie?.startsWith("openrev_auth=")) cookie = setCookie.split(";")[0];
    return res;
  };

  beforeAll(async () => {
    rt = await testRuntime(await makeDb());
    app = createApp(() => rt);
    await call("/api/auth/signup", { body: { email: "owner@example.com", password: "supersecret" } });
    const site = await (await call("/api/sites", { body: { domain: "example.com", timezone: "Europe/Paris" } })).json();
    siteId = site.site.id;
    for (const visitorId of ["visitor-aaaa1", "visitor-bbbb2"]) {
      const r = await call("/api/events", {
        raw: JSON.stringify({ websiteId: siteId, type: "pageview", href: "https://example.com/", visitorId }),
        headers: { "Content-Type": "text/plain" },
      });
      expect(r.status).toBe(202);
    }
    token = (await (await call(`/api/sites/${siteId}/share`, { body: { enabled: true } })).json()).share_token;
    clearBadgeCache();
  });

  it("returns visitors online and today, readable from any site", async () => {
    const res = await call(`/api/badge/${token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ online: 2, today: 2 });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe(`public, max-age=${BADGE_TTL_MS / 1000}`);
  });

  it("renders an SVG version", async () => {
    const res = await call(`/api/badge/${token}/badge.svg?theme=dark`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const svg = await res.text();
    expect(svg).toContain(">2 online<");
    expect(svg).toContain("2 visitors today");
    expect(svg).toContain('fill="#18181b"');
  });

  it("is 404 for unknown or malformed tokens", async () => {
    expect((await call("/api/badge/zzzzzzzzzzzzzzzzzzzz")).status).toBe(404);
    expect((await call("/api/badge/Not-A-Token")).status).toBe(404);
    expect((await call("/api/badge/zzzzzzzzzzzzzzzzzzzz/badge.svg")).status).toBe(404);
  });

  it("stops working when the public link is turned off", async () => {
    await call(`/api/sites/${siteId}/share`, { body: { enabled: false } });
    clearBadgeCache(token);
    expect((await call(`/api/badge/${token}`)).status).toBe(404);
  });
});

describe("badge cache", () => {
  it("serves cached counts within the TTL and refreshes after it", async () => {
    clearBadgeCache();
    const first = vi
      .fn()
      .mockResolvedValueOnce({ id: "s1", timezone: "UTC" })
      .mockResolvedValueOnce({ today: 5, online: 1 })
      .mockResolvedValueOnce({ id: "s1", timezone: "UTC" })
      .mockResolvedValueOnce({ today: 6, online: 2 });
    const db = { first } as unknown as Database;
    const t0 = 1_800_000_000_000;
    expect(await badgeData(db, "cachetoken01", t0)).toEqual({ today: 5, online: 1 });
    expect(await badgeData(db, "cachetoken01", t0 + BADGE_TTL_MS - 1)).toEqual({ today: 5, online: 1 });
    expect(first).toHaveBeenCalledTimes(2);
    expect(await badgeData(db, "cachetoken01", t0 + BADGE_TTL_MS)).toEqual({ today: 6, online: 2 });
    expect(first).toHaveBeenCalledTimes(4);
  });

  it("uses the singular for one visitor", () => {
    expect(badgeSvg({ online: 0, today: 1 })).toContain("1 visitor today");
    expect(badgeSvg({ online: 1234, today: 56789 })).toContain(">1,234 online<");
  });
});
