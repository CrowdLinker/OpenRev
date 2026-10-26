import { beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { Runtime } from "../src/server/context";
import type { Database } from "../src/server/db/types";
import { CRAWLER_PATTERN, matchCrawler } from "../src/server/lib/crawlers";
import { crawlPath } from "../src/server/services/crawlers";
import { ingestEvent } from "../src/server/services/ingest";
import { testDb, testRuntime } from "./helpers";
import { pgliteDb } from "./pglite";

const UA = {
  gptbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)",
  chatgptUser: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  claudebot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  perplexity: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

describe("crawler catalog", () => {
  it("recognizes crawlers by their user agent token", () => {
    expect(matchCrawler(UA.gptbot)).toMatchObject({ name: "GPTBot", operator: "OpenAI", category: "ai_training" });
    expect(matchCrawler(UA.chatgptUser)).toMatchObject({ name: "ChatGPT-User", category: "ai_user" });
    expect(matchCrawler(UA.claudebot)?.name).toBe("ClaudeBot");
    expect(matchCrawler(UA.perplexity)).toMatchObject({ name: "PerplexityBot", category: "ai_search" });
    expect(matchCrawler(UA.googlebot)).toMatchObject({ name: "Googlebot", category: "search" });
    expect(matchCrawler("Googlebot-Image/1.0")?.name).toBe("Googlebot");
    expect(matchCrawler("Mozilla/5.0 (Macintosh) Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)")?.name).toBe("Applebot");
    expect(matchCrawler("NotGooglebot/1.0")).toBeNull();
    expect(matchCrawler(UA.chrome)).toBeNull();
    expect(new RegExp(CRAWLER_PATTERN, "i").test(UA.chatgptUser)).toBe(true);
  });

  it("stores paths like pages", () => {
    expect(crawlPath("https://example.com/blog/post/?utm=x#top")).toBe("/blog/post");
    expect(crawlPath("/caf%C3%A9?x")).toBe("/café");
    expect(crawlPath("")).toBe("/");
  });
});

describe.each([
  ["sqlite", testDb],
  ["pglite", pgliteDb],
] as [string, () => Promise<Database>][])("crawler reports (%s)", (_name, makeDb) => {
  let rt: Runtime;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let siteId = "";
  let apiKey = "";

  const call = async (path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "User-Agent": UA.chrome, ...(init.headers ?? {}) };
    if (cookie) headers.Cookie = cookie;
    const body = init.body !== undefined ? JSON.stringify(init.body) : undefined;
    if (body) headers["Content-Type"] = "application/json";
    const res = await app.request("http://openrev.test" + path, { method: body ? "POST" : "GET", headers, body });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie?.startsWith("openrev_auth=")) cookie = setCookie.split(";")[0];
    return { status: res.status, json: await res.json() };
  };

  beforeAll(async () => {
    rt = await testRuntime(await makeDb());
    app = createApp(() => rt);
    await call("/api/auth/signup", { body: { email: "owner@example.com", password: "supersecret" } });
    siteId = (await call("/api/sites", { body: { domain: "example.com", timezone: "UTC", currency: "USD" } })).json.site.id;
    apiKey = (await call(`/api/sites/${siteId}/keys`, { body: { name: "middleware" } })).json.key;
  });

  it("records crawler hits sent by the website's server and ignores other requests", async () => {
    const auth = { Authorization: `Bearer ${apiKey}` };
    const now = Date.now();
    expect((await call(`/api/sites/${siteId}/stats/meta`)).json.crawlers).toBe(false);
    const one = await call("/api/v1/crawls", { body: { path: "/pricing?ref=x", user_agent: UA.gptbot }, headers: auth });
    expect(one.json.data).toEqual({ recorded: 1, ignored: 0 });
    const batch = await call("/api/v1/crawls", {
      body: {
        hits: [
          { url: "https://example.com/pricing/", user_agent: UA.gptbot, timestamp: now - 1000 },
          { path: "/docs", user_agent: UA.claudebot },
          { path: "/pricing", user_agent: UA.chatgptUser },
          { path: "/", user_agent: UA.googlebot },
          { path: "/", user_agent: UA.chrome },
        ],
      },
      headers: auth,
    });
    expect(batch.json.data).toEqual({ recorded: 4, ignored: 1 });
    expect((await call("/api/v1/crawls", { body: { path: "/", user_agent: UA.gptbot } })).status).toBe(401);
    expect((await call("/api/v1/crawls", { body: { path: 5 }, headers: auth })).status).toBe(422);

    // A visitor referred by ChatGPT.
    await ingestEvent(
      rt,
      { type: "pageview", websiteId: siteId, href: "https://example.com/pricing", referrer: "https://chatgpt.com/", visitorId: "visitor-ai-00001", sessionId: "session-ai-00001" },
      { ip: "1.2.3.4", userAgent: UA.chrome, geo: null },
    );

    const report = (await call(`/api/sites/${siteId}/stats/crawlers?period=7d`)).json;
    expect(report.summary).toMatchObject({ hits: 5, ai_training: 3, ai_user: 1, search: 1, ai_search: 0, crawlers: 4, pages: 3, ai_visitors: 1 });
    expect(report.crawlers[0]).toMatchObject({ name: "GPTBot", operator: "OpenAI", category: "ai_training", hits: 2, pages: 1 });
    expect(report.pages[0]).toEqual({ path: "/pricing", hits: 3, crawlers: ["ChatGPT-User", "GPTBot"] });
    expect(report.timeseries.reduce((n: number, p: { ai_training: number }) => n + p.ai_training, 0)).toBe(3);
    expect(report.pattern).toContain("ChatGPT-User");
    expect((await call(`/api/sites/${siteId}/stats/meta`)).json.crawlers).toBe(true);

    const userOnly = (await call(`/api/v1/analytics/crawlers?period=7d&category=ai_user`, { headers: auth })).json.data;
    expect(userOnly.crawlers.map((c: { name: string }) => c.name)).toEqual(["ChatGPT-User"]);
    expect(userOnly.pages).toEqual([{ path: "/pricing", hits: 1, crawlers: ["ChatGPT-User"] }]);
  });

  it("counts every website day a range overlaps, for Last 24 hours and in another timezone", async () => {
    const auth = { Authorization: `Bearer ${apiKey}` };
    const edge = (pages: { path: string; hits: number }[]) => pages.find((p) => p.path === "/day-edges")?.hits ?? 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-06-15T05:00:00Z"));
      // 19 hours ago, stored on June 14 (the website is in UTC).
      await call("/api/v1/crawls", { body: { path: "/day-edges", user_agent: UA.gptbot, timestamp: Date.UTC(2026, 5, 14, 10) }, headers: auth });

      const last24h = (await call(`/api/sites/${siteId}/stats/crawlers?period=24h`)).json;
      expect(edge(last24h.pages)).toBe(1);
      expect(last24h.timeseries.map((p: { date: string }) => p.date)).toEqual(["2026-06-14", "2026-06-15"]);

      // June 14 in New York starts at 04:00 UTC, after the stored midnight: the website's June 14 still counts.
      const newYork = (await call("/api/v1/analytics/crawlers?from=2026-06-14&to=2026-06-14&timezone=America/New_York", { headers: auth })).json.data;
      expect(edge(newYork.pages)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
