import { beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../src/server/context";
import { resolveRange } from "../src/server/lib/time";
import { ingestEvent, type RequestMeta } from "../src/server/services/ingest";
import { recordPayment } from "../src/server/services/payments";
import { invalidateSite, type Site } from "../src/server/services/sites";
import * as stats from "../src/server/services/stats";
import { testDb, testRuntime } from "./helpers";
import { pgliteDb } from "./pglite";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

let rt: Runtime;
let site: Site;

async function createSite(rt: Runtime, overrides: Partial<Site> = {}): Promise<Site> {
  const s: Site = {
    id: "site_test",
    domain: "example.com",
    name: "Example",
    timezone: "America/New_York",
    currency: "USD",
    settings: {},
    share_token: null,
    created_by: null,
    created_at: Date.now(),
    ...overrides,
  };
  await rt.db.run(
    "INSERT INTO sites (id, domain, name, timezone, currency, settings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [s.id, s.domain, s.name, s.timezone, s.currency, JSON.stringify(s.settings), s.created_at],
  );
  invalidateSite(s.id);
  return s;
}

const meta = (ua = CHROME, country = "US"): RequestMeta => ({ ip: "1.2.3.4", userAgent: ua, geo: { country, city: "Boston", region: "Massachusetts" } });

describe.each([
  ["sqlite", testDb],
  ["postgres", pgliteDb],
])("ingestion + stats (%s)", (_name, makeDb) => {
  beforeEach(async () => {
    rt = await testRuntime(await makeDb());
    site = await createSite(rt);
  });

  it("records sessions, pageviews, goals and attributes revenue", async () => {
    const r1 = await ingestEvent(
      rt,
      {
        type: "pageview",
        websiteId: site.id,
        href: "https://example.com/?utm_source=twitter&utm_medium=social",
        referrer: "https://t.co/abc",
        visitorId: "visitor-aaaa-1111",
        sessionId: "session-aaaa-1111",
      },
      meta(),
    );
    expect(r1.ok).toBe(true);
    await ingestEvent(rt, { type: "pageview", websiteId: site.id, href: "https://example.com/pricing", visitorId: "visitor-aaaa-1111", sessionId: "session-aaaa-1111" }, meta());
    await ingestEvent(rt, { type: "goal", name: "Signup Click", props: { plan: "pro" }, websiteId: site.id, href: "https://example.com/pricing", visitorId: "visitor-aaaa-1111", sessionId: "session-aaaa-1111" }, meta());
    await ingestEvent(rt, { type: "engagement", engagedMs: 42000, websiteId: site.id, href: "https://example.com/pricing", visitorId: "visitor-aaaa-1111", sessionId: "session-aaaa-1111" }, meta());

    // second visitor from Google on mobile, bounces
    await ingestEvent(rt, { type: "pageview", websiteId: site.id, href: "https://www.example.com/blog/post", referrer: "https://www.google.com/", visitorId: "visitor-bbbb-2222", sessionId: "session-bbbb-2222" }, meta(IPHONE, "GB"));
    // third: direct
    await ingestEvent(rt, { type: "pageview", websiteId: site.id, href: "https://example.com/", visitorId: "visitor-cccc-3333", sessionId: "session-cccc-3333" }, meta());

    // rejected: bot, foreign hostname
    expect((await ingestEvent(rt, { type: "pageview", websiteId: site.id, href: "https://example.com/" }, { ip: null, userAgent: "Googlebot/2.1", geo: null })).ok).toBe(false);
    expect((await ingestEvent(rt, { type: "pageview", websiteId: site.id, href: "https://evil.com/" }, meta())).ok).toBe(false);

    const { payment, created } = await recordPayment(rt, site, {
      provider: "stripe",
      transactionId: "pi_1",
      type: "new",
      amount: 4900,
      currency: "USD",
      visitorId: "visitor-aaaa-1111",
      email: "jane@example.com",
    });
    expect(created).toBe(true);
    expect(payment.touch_session_id).toBe("session-aaaa-1111");
    // idempotent
    expect((await recordPayment(rt, site, { provider: "stripe", transactionId: "pi_1", type: "new", amount: 4900, currency: "USD" })).created).toBe(false);
    // unattributed payment in EUR
    await recordPayment(rt, site, { provider: "api", transactionId: "x2", type: "new", amount: 1000, currency: "EUR" });

    const range = resolveRange(site.timezone, { period: "7d" });
    const q = { site, range, filters: [] };
    const ov = await stats.overview(rt.db, q);
    expect(ov.current.visitors).toBe(3);
    expect(ov.current.pageviews).toBe(4);
    expect(ov.current.sessions).toBe(3);
    expect(ov.current.bounce_rate).toBeCloseTo(2 / 3);
    expect(ov.current.revenue).toBeGreaterThan(4900);
    expect(ov.current.payments).toBe(2);
    expect(ov.current.conversion_rate).toBeCloseTo(1 / 3);

    const ts = await stats.timeseries(rt.db, q);
    expect(ts.length).toBe(7);
    expect(ts.reduce((a, p) => a + p.visitors, 0)).toBe(3);

    const channels = await stats.breakdown(rt.db, q, "channel");
    const social = channels.find((c) => c.value === "Organic Social");
    expect(social?.visitors).toBe(1);
    expect(social?.revenue).toBe(4900);
    expect(channels.find((c) => c.value === "Organic Search")?.visitors).toBe(1);
    expect(channels.find((c) => c.value === stats.UNATTRIBUTED)?.revenue).toBeGreaterThan(0);

    const sources = await stats.breakdown(rt.db, q, "source");
    expect(sources.find((s) => s.value === "X")?.meta).toBe("x.com");

    const pages = await stats.breakdown(rt.db, q, "page", { sort: "revenue" });
    expect(pages[0].revenue).toBe(4900);
    expect(pages.find((p) => p.value === "/blog/post")?.visitors).toBe(1);

    const countries = await stats.breakdown(rt.db, q, "country");
    expect(countries.find((c) => c.value === "GB")?.visitors).toBe(1);
    const cities = await stats.breakdown(rt.db, q, "city");
    expect(cities[0].meta).toBeTruthy();

    const devices = await stats.breakdown(rt.db, q, "device");
    expect(devices.find((d) => d.value === "mobile")?.visitors).toBe(1);

    const goals = await stats.breakdown(rt.db, q, "goal");
    expect(goals[0]).toMatchObject({ value: "signup_click", visitors: 1, completions: 1, revenue: 4900 });

    const props = await stats.goalProperties(rt.db, q, "signup_click");
    expect(props[0].key).toBe("plan");

    // filters
    const filtered = await stats.overview(rt.db, { ...q, filters: [{ dim: "country", op: "is", values: ["GB"] }] });
    expect(filtered.current.visitors).toBe(1);
    expect(filtered.current.revenue).toBe(0);
    const byPage = await stats.overview(rt.db, { ...q, filters: [{ dim: "page", op: "is", values: ["/pricing"] }] });
    expect(byPage.current.visitors).toBe(1);
    expect(byPage.current.revenue).toBe(4900);

    const rtStats = await stats.realtime(rt.db, site);
    expect(rtStats.visitors).toBe(3);
    expect(rtStats.sessions[0].buyer_score).toBeGreaterThan(0);

    const funnel = await stats.funnelResults(rt.db, q, [
      { type: "page", value: "/" },
      { type: "page", value: "/pricing" },
      { type: "goal", value: "signup_click" },
      { type: "payment" },
    ]);
    expect(funnel.map((s) => s.visitors)).toEqual([2, 1, 1, 1]);

    const visitors = await stats.listVisitors(rt.db, q, { customersOnly: true });
    expect(visitors).toHaveLength(1);
    expect(visitors[0].revenue).toBe(4900);

    const profile = await stats.visitorProfile(rt.db, site, "visitor-aaaa-1111");
    expect(profile?.sessions).toHaveLength(1);
    expect(profile?.events.length).toBe(3);
    expect(profile?.sessions[0].duration).toBe(42000);

    const ltv = await stats.customerLtv(rt.db, q);
    expect(ltv.find((r) => r.value === "X")?.revenue).toBe(4900);

    for (const interval of ["hour", "week", "month"] as const) {
      const pts = await stats.timeseries(rt.db, q, interval);
      expect(pts.reduce((a, p) => a + p.visitors, 0)).toBeGreaterThanOrEqual(3);
    }
  });

  it("links payments to visitors from checkout success-page hints", async () => {
    await ingestEvent(rt, { type: "pageview", websiteId: site.id, href: "https://example.com/", referrer: "https://news.ycombinator.com/", visitorId: "visitor-dddd-4444", sessionId: "session-dddd-4444" }, meta());
    // webhook arrives before the success page is seen
    await recordPayment(rt, site, { provider: "stripe", transactionId: "pi_2", type: "new", amount: 1500, currency: "USD", ref: "cs_test_123" });
    await ingestEvent(rt, { type: "payment", ref: "cs_test_123", websiteId: site.id, href: "https://example.com/success?session_id=cs_test_123", visitorId: "visitor-dddd-4444", sessionId: "session-dddd-4444" }, meta());
    const row = await rt.db.first<{ visitor_id: string; touch_session_id: string }>("SELECT visitor_id, touch_session_id FROM payments WHERE transaction_id = 'pi_2'");
    expect(row?.visitor_id).toBe("visitor-dddd-4444");
    expect(row?.touch_session_id).toBe("session-dddd-4444");
  });

  it("supports cookieless visitors and exclusions", async () => {
    await rt.db.run("UPDATE sites SET settings = ? WHERE id = ?", [JSON.stringify({ cookieless: true, excludedPaths: ["/admin/*"] }), site.id]);
    invalidateSite(site.id);
    const a = await ingestEvent(rt, { type: "pageview", websiteId: site.id, href: "https://example.com/" }, meta());
    const b = await ingestEvent(rt, { type: "pageview", websiteId: site.id, href: "https://example.com/about" }, meta());
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.visitorId).toBe(b.visitorId);
      expect(a.sessionId).toBe(b.sessionId);
    }
    const ex = await ingestEvent(rt, { type: "pageview", websiteId: site.id, href: "https://example.com/admin/users" }, meta());
    expect(ex.ok).toBe(false);
  });
});
