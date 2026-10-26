import { beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { Runtime } from "../src/server/context";
import type { Database } from "../src/server/db/types";
import { classify } from "../src/server/lib/referrers";
import { getSite, type Site } from "../src/server/services/sites";
import { getSocialConfig, parseHandles, parseKeywords, sitePaths, syncAllSocial, syncSocial, xQuery } from "../src/server/services/social";
import { testDb, testRuntime } from "./helpers";
import { pgliteDb } from "./pglite";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12);
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe("social helpers", () => {
  it("parses keywords and handles", () => {
    expect(parseKeywords("OpenRev, @openrev\n#buildinpublic, openrev, x")).toEqual(["OpenRev", "@openrev", "#buildinpublic"]);
    expect(parseHandles("@openrev https://x.com/Crowdlinker/status/1 twitter.com/jack")).toEqual(["openrev", "Crowdlinker", "jack"]);
    expect(() => parseHandles("not a handle!")).toThrow(/isn't an 𝕏 username/);
  });

  it("builds the search query and finds the website's pages in links", () => {
    const site = { domain: "example.com", settings: { allowedHostnames: ["app.example.io"] } } as unknown as Site;
    expect(xQuery(site, ["OpenRev", "@openrev"])).toBe('(url:"example.com" OR url:"app.example.io" OR "OpenRev" OR @openrev) -is:retweet');
    expect(sitePaths(["https://www.example.com/pricing/?ref=x", "https://blog.example.com/", "https://other.com/x", "example.com", null], ["example.com"])).toEqual([
      "/pricing",
      "/",
    ]);
  });

  it("recognizes link-in-bio pages", () => {
    expect(classify({ referrer: "https://linktr.ee/someone", utm: {} })).toMatchObject({ source: "Linktree", channel: "Organic Social" });
  });
});

/** Fake 𝕏 and Hacker News APIs, recording what was asked. */
function fakeApis() {
  const calls: string[] = [];
  const fetchFn = async (input: string, init?: RequestInit) => {
    calls.push(input);
    const url = new URL(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.hostname === "api.x.com") {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer AAAA-test-token%3Dabc1234567890");
      if (url.pathname === "/2/users/by") {
        return json({
          data: [
            {
              id: "u1",
              username: "openrev",
              name: "OpenRev",
              profile_image_url: "https://pbs.twimg.com/a.jpg",
              entities: { url: { urls: [{ url: "https://t.co/bio", expanded_url: "https://example.com" }] } },
            },
          ],
        });
      }
      if (url.searchParams.get("since_id")) return json({ meta: { result_count: 0 } });
      return json({
        data: [
          {
            id: "1001",
            author_id: "u2",
            text: "Switched to OpenRev https://t.co/abc",
            created_at: new Date(NOW - 2 * DAY).toISOString(),
            public_metrics: { like_count: 40, repost_count: 5, reply_count: 3, impression_count: 9000 },
            entities: { urls: [{ url: "https://t.co/abc", expanded_url: "https://example.com/pricing?utm_source=x", unwound_url: "https://example.com/pricing?utm_source=x" }] },
          },
          {
            id: "1002",
            author_id: "u3",
            text: "Has anyone tried OpenRev?",
            created_at: new Date(NOW - DAY).toISOString(),
            public_metrics: { like_count: 2, retweet_count: 0, reply_count: 1, impression_count: 300 },
          },
        ],
        includes: { users: [{ id: "u2", username: "ada", name: "Ada" }, { id: "u3", username: "bob", name: "Bob" }] },
        meta: { newest_id: "1002", result_count: 2 },
      });
    }
    if (url.hostname === "hn.algolia.com") {
      if (url.searchParams.get("tags") === "story" && url.searchParams.get("query") === "example.com") {
        return json({
          hits: [{ objectID: "500", created_at_i: Math.floor((NOW - 3 * DAY) / 1000), author: "pg", title: "Show HN: OpenRev", url: "https://example.com/blog/launch", points: 120, num_comments: 45 }],
        });
      }
      if (url.searchParams.get("tags") === "comment") {
        return json({
          hits: [
            {
              objectID: "501",
              created_at_i: Math.floor((NOW - 3 * DAY) / 1000),
              author: "dang",
              comment_text: 'Docs: <a href="https:&#x2F;&#x2F;example.com&#x2F;docs&#x2F;install" rel="nofollow">here</a> &amp; more',
              story_title: "Show HN: OpenRev",
            },
          ],
        });
      }
      if (url.searchParams.get("query") === "OpenRev") {
        return json({
          hits: [
            { objectID: "502", created_at_i: Math.floor((NOW - 2 * DAY) / 1000), author: "ann", comment_text: "We moved to OpenRev last month", story_title: "Ask HN: Analytics?" },
            // Matched loosely by the search (open… rev…), dropped.
            { objectID: "503", created_at_i: Math.floor((NOW - 2 * DAY) / 1000), author: "joe", comment_text: "Open source revenue is hard", story_title: "x" },
          ],
        });
      }
      return json({ hits: [] });
    }
    throw new Error(`unexpected fetch ${input}`);
  };
  return { calls, fetchFn };
}

describe.each([
  ["sqlite", testDb],
  ["pglite", pgliteDb],
] as [string, () => Promise<Database>][])("social posts (%s)", (_name, makeDb) => {
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

  it("saves the settings without ever returning the token", async () => {
    expect((await call(`/api/sites/${siteId}/social`, { method: "PATCH", body: { x_token: "short" } })).status).toBe(400);
    const saved = await call(`/api/sites/${siteId}/social`, {
      method: "PATCH",
      body: { x_token: "Bearer AAAA-test-token%3Dabc1234567890", keywords: "OpenRev", handles: "@openrev, @gone", x_monthly_cap: 500 },
    });
    expect(saved.json.config).toMatchObject({ x_connected: true, keywords: ["OpenRev"], handles: ["openrev", "gone"], x_monthly_cap: 500, hn: true });
    expect(JSON.stringify(saved.json)).not.toContain("test-token");
    const row = await getSocialConfig(rt.db, siteId);
    expect(row?.config).not.toContain("test-token");
  });

  it("finds posts on 𝕏 and Hacker News, and the profiles' bio links", async () => {
    // Removing a handle drops its profile.
    await call(`/api/sites/${siteId}/social`, { method: "PATCH", body: { handles: "openrev" } });
    const site = (await getSite(rt.db, siteId))!;
    const { calls, fetchFn } = fakeApis();
    const result = await syncSocial(rt, site, (await getSocialConfig(rt.db, siteId))!, { now: NOW, fetchFn });
    expect(result).toEqual({ x: 2, hn: 3, error: null, stopped: false });
    const search = new URL(calls.find((c) => c.includes("/tweets/search/recent"))!);
    expect(search.searchParams.get("query")).toBe('(url:"example.com" OR "OpenRev") -is:retweet');
    expect(search.searchParams.get("post.fields")).toBe("created_at,public_metrics,entities");
    expect(Date.parse(search.searchParams.get("start_time")!)).toBeGreaterThan(NOW - 7 * DAY);

    const posts = await rt.db.all<{ platform: string; id: string; kind: string; links: string; likes: number; reposts: number; text: string }>(
      "SELECT platform, id, kind, links, likes, reposts, text FROM social_posts WHERE site_id = ? ORDER BY platform, id",
      [siteId],
    );
    expect(posts.map((p) => [p.platform, p.id, p.kind, JSON.parse(p.links)])).toEqual([
      ["hn", "500", "post", ["/blog/launch"]],
      ["hn", "501", "post", ["/docs/install"]],
      ["hn", "502", "post", []],
      ["x", "1001", "post", ["/pricing"]],
      ["x", "1002", "post", []],
      ["x", "bio:openrev", "bio", ["/"]],
    ]);
    expect(posts.find((p) => p.id === "1001")).toMatchObject({ likes: 40, reposts: 5 });
    expect(posts.find((p) => p.id === "501")?.text).toBe('On "Show HN: OpenRev": Docs: here & more');
    const cfg = (await call(`/api/sites/${siteId}/social`)).json.config;
    expect(cfg).toMatchObject({ x_reads: 2, last_error: null });

    // The next run continues from the newest post, and stops at the monthly limit.
    const second = fakeApis();
    await syncSocial(rt, site, (await getSocialConfig(rt.db, siteId))!, { now: NOW + 7 * 3_600_000, fetchFn: second.fetchFn });
    expect(new URL(second.calls.find((c) => c.includes("/tweets/search/recent"))!).searchParams.get("since_id")).toBe("1002");
    await rt.db.run("UPDATE social_config SET x_reads = x_monthly_cap WHERE site_id = ?", [siteId]);
    const third = fakeApis();
    const paused = await syncSocial(rt, site, (await getSocialConfig(rt.db, siteId))!, { now: NOW + 14 * 3_600_000, fetchFn: third.fetchFn });
    expect(third.calls.some((c) => c.includes("api.x.com"))).toBe(false);
    expect(paused.error).toMatch(/Paused: 500 𝕏 posts read this month/);
    await rt.db.run("UPDATE social_config SET x_reads = 2 WHERE site_id = ?", [siteId]);
  });

  it("credits visits to the post or profile that links to their landing page", async () => {
    const visit = async (id: string, source: string, referrer: string, entry: string, startedAt: number, revenue = 0) => {
      await rt.db.run(
        `INSERT INTO sessions (id, site_id, visitor_id, started_at, last_seen_at, pageviews, entry_page, exit_page, hostname, referrer_domain, source, channel)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'example.com', ?, ?, 'Organic Social')`,
        [id, siteId, `v-${id}`, startedAt, startedAt, entry, entry, referrer, source],
      );
      if (revenue) {
        await rt.db.run(
          `INSERT INTO payments (id, site_id, provider, transaction_id, type, amount, currency, revenue, revenue_currency, ts, visitor_id, first_session_id, last_session_id, touch_session_id, created_at)
           VALUES (?, ?, 'api', ?, 'new', ?, 'USD', ?, 'USD', ?, ?, ?, ?, ?, ?)`,
          [`p-${id}`, siteId, `t-${id}`, revenue, revenue, startedAt + 60_000, `v-${id}`, id, id, id, startedAt],
        );
      }
    };
    await visit("x-post", "X", "t.co", "/pricing", NOW - DAY, 4900);
    await visit("x-post-2", "X", "t.co", "/pricing", NOW - DAY + 1000);
    await visit("x-bio", "X", "t.co", "/", NOW - DAY);
    await visit("x-old", "X", "t.co", "/pricing", NOW + 8 * DAY); // more than 7 days after the post
    await visit("x-none", "X", "t.co", "/careers", NOW - DAY);
    await visit("hn-story", "Hacker News", "news.ycombinator.com", "/blog/launch", NOW - 2 * DAY, 9900);
    await visit("google", "Google", "google.com", "/pricing", NOW - DAY);

    const range = `from=${new Date(NOW - 10 * DAY).toISOString().slice(0, 10)}&to=${new Date(NOW + 10 * DAY).toISOString().slice(0, 10)}`;
    const report = (await call(`/api/sites/${siteId}/stats/social?${range}`)).json;
    expect(report.summary).toMatchObject({
      mentions: 5,
      x: { mentions: 2, visits: 5, credited_visits: 3, revenue: 4900, credited_revenue: 4900 },
      hn: { mentions: 3, visits: 1, credited_visits: 1, revenue: 9900, credited_revenue: 9900 },
    });
    const post = (id: string) => report.posts.find((p: { id: string }) => p.id === id);
    expect(post("1001")).toMatchObject({ author: "ada", sessions: 2, visitors: 2, revenue: 4900, customers: 1, url: "https://x.com/ada/status/1001", views: 9000 });
    expect(post("500")).toMatchObject({ sessions: 1, revenue: 9900, url: "https://news.ycombinator.com/item?id=500" });
    expect(post("1002")).toMatchObject({ sessions: 0, revenue: 0 });
    expect(report.posts[0].id).toBe("500"); // most revenue first
    expect(report.profiles).toEqual([expect.objectContaining({ id: "bio:openrev", author: "openrev", sessions: 1, links: ["/"] })]);

    const xOnly = (await call(`/api/sites/${siteId}/stats/social?${range}&platform=x`)).json;
    expect(xOnly.posts.every((p: { platform: string }) => p.platform === "x")).toBe(true);
    expect((await call(`/api/sites/${siteId}/stats/meta`)).json.social).toBe(true);

    // Disconnecting removes the posts too.
    await call(`/api/sites/${siteId}/social`, { method: "DELETE" });
    expect(await rt.db.first("SELECT 1 AS found FROM social_posts WHERE site_id = ?", [siteId])).toBeFalsy();
  });

  it("stores many posts in few statements, within one budget per scheduled run", async () => {
    const ids: string[] = [];
    for (const domain of ["a.example.com", "b.example.com", "c.example.com"]) {
      const id = (await call("/api/sites", { body: { domain, timezone: "UTC", currency: "USD" } })).json.site.id;
      await rt.db.run("INSERT INTO social_config (site_id, created_at) VALUES (?, ?)", [id, 0]);
      ids.push(id);
    }
    // Hacker News finds 100 stories linking to each website.
    const searched: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const host = new URL(input).searchParams.get("query")!;
      searched.push(host);
      const hits = Array.from({ length: 100 }, (_, i) => ({ objectID: `${host}-${i}`, created_at_i: Math.floor((NOW - DAY) / 1000), title: `Post ${i}`, url: `https://${host}/p/${i}` }));
      return Response.json({ hits });
    });
    const batch = rt.db.batch;
    let written = 0;
    rt.db.batch = (async (statements) => {
      written += statements.length;
      return batch.call(rt.db, statements);
    }) as typeof batch;
    try {
      await syncAllSocial(rt, NOW, { left: 50, wrote: false });
      // A website's 100 posts and links take 27 statements, so the second website waits for the next run.
      expect(written).toBeLessThanOrEqual(50);
      const counts = await Promise.all(ids.map(async (id) => Number((await rt.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM social_posts WHERE site_id = ?", [id]))!.n)));
      expect(counts.sort()).toEqual([0, 0, 100]);
      const first = searched[0];
      searched.length = 0;
      await syncAllSocial(rt, NOW + 600_000, { left: 50, wrote: false });
      expect(searched[0]).not.toBe(first);
    } finally {
      rt.db.batch = batch;
      vi.unstubAllGlobals();
    }
  });
});
