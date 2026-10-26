import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { Runtime } from "../src/server/context";
import type { Database } from "../src/server/db/types";
import { intervalFromDays, intervalFromPeriod, monthlyFactor, parseInterval } from "../src/server/lib/billing";
import { buildSubscription, movements, mrrAt } from "../src/server/services/mrr";
import { testDb, testRuntime } from "./helpers";
import { pgliteDb } from "./pglite";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const month = { unit: "month", count: 1 } as const;
const charge = (day: number, revenue: number, interval: { unit: "day" | "week" | "month" | "year"; count: number } | null = month) => ({
  ts: T0 + day * DAY,
  revenue,
  interval,
  session: null,
});

describe("billing intervals", () => {
  it("parses the words providers use", () => {
    expect(parseInterval("month")).toEqual({ unit: "month", count: 1 });
    expect(parseInterval("Monthly")).toEqual({ unit: "month", count: 1 });
    expect(parseInterval("every-month")).toEqual({ unit: "month", count: 1 });
    expect(parseInterval("every-three-months")).toEqual({ unit: "month", count: 3 });
    expect(parseInterval("quarterly")).toEqual({ unit: "month", count: 3 });
    expect(parseInterval("biannually")).toEqual({ unit: "month", count: 6 });
    expect(parseInterval("annually")).toEqual({ unit: "year", count: 1 });
    expect(parseInterval("every_two_years")).toEqual({ unit: "year", count: 2 });
    expect(parseInterval("year", 2)).toEqual({ unit: "year", count: 2 });
    expect(parseInterval("week", "0")).toEqual({ unit: "week", count: 1 });
    expect(parseInterval("hourly")).toBeNull();
    expect(parseInterval(42)).toBeNull();
  });

  it("snaps period lengths to an interval", () => {
    expect(intervalFromDays(31)).toEqual({ unit: "month", count: 1 });
    expect(intervalFromDays(28)).toEqual({ unit: "month", count: 1 });
    expect(intervalFromDays(7)).toEqual({ unit: "week", count: 1 });
    expect(intervalFromDays(92)).toEqual({ unit: "month", count: 3 });
    expect(intervalFromDays(366)).toEqual({ unit: "year", count: 1 });
    expect(intervalFromDays(50)).toBeNull();
    expect(intervalFromPeriod(1735689600, 1738368000)).toEqual({ unit: "month", count: 1 });
    expect(intervalFromPeriod("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).toEqual({ unit: "year", count: 1 });
    expect(intervalFromPeriod(null, 5)).toBeNull();
  });

  it("spreads a charge over its interval", () => {
    expect(monthlyFactor({ unit: "year", count: 1 })).toBeCloseTo(1 / 12);
    expect(monthlyFactor({ unit: "month", count: 3 })).toBeCloseTo(1 / 3);
    expect(monthlyFactor({ unit: "week", count: 1 })).toBeCloseTo(4.348, 2);
  });
});

describe("subscription coverage", () => {
  const now = T0 + 400 * DAY;

  it("keeps a subscription active while renewals keep coming, late ones included", () => {
    const sub = buildSubscription("s", [charge(0, 1000), charge(31, 1000), charge(65, 1000)], T0 + 70 * DAY);
    expect(mrrAt(sub, T0 + 10 * DAY)).toBe(1000);
    expect(mrrAt(sub, T0 + 63 * DAY)).toBe(1000); // renewal 3 days late: still active
    expect(mrrAt(sub, T0 + 69 * DAY)).toBe(1000); // current period, open
    expect(mrrAt(sub, T0 - 1)).toBe(0);
  });

  it("churns at the end of the paid period when no renewal comes, and reactivates later", () => {
    const sub = buildSubscription("s", [charge(0, 1000), charge(120, 1500)], now);
    expect(mrrAt(sub, T0 + 29 * DAY)).toBe(1000);
    expect(mrrAt(sub, T0 + 40 * DAY)).toBe(0); // lapsed after ~30 days
    expect(mrrAt(sub, T0 + 121 * DAY)).toBe(1500);
    expect(mrrAt(sub, T0 + 200 * DAY)).toBe(0); // last period over, grace passed
  });

  it("spreads yearly charges and infers the interval from renewals when none is reported", () => {
    expect(mrrAt(buildSubscription("y", [charge(0, 12000, { unit: "year", count: 1 })], T0 + 100 * DAY), T0 + 100 * DAY)).toBe(1000);
    const inferred = buildSubscription("i", [charge(0, 12000, null), charge(365, 12000, null)], T0 + 400 * DAY);
    expect(inferred.assumedInterval).toBe(false);
    expect(mrrAt(inferred, T0 + 380 * DAY)).toBe(1000);
    const single = buildSubscription("one", [charge(0, 900, null)], T0 + 5 * DAY);
    expect(single.assumedInterval).toBe(true);
    expect(mrrAt(single, T0 + 5 * DAY)).toBe(900);
  });

  it("classifies movements between two instants", () => {
    const a = T0 + 45 * DAY;
    const b = T0 + 75 * DAY;
    const subs = [
      buildSubscription("new", [charge(50, 1000), charge(80, 1000)], now),
      buildSubscription("up", [charge(0, 1000), charge(30, 1000), charge(60, 3000), charge(90, 3000)], now),
      buildSubscription("down", [charge(0, 2000), charge(30, 2000), charge(60, 500), charge(90, 500)], now),
      buildSubscription("gone", [charge(0, 700), charge(30, 700)], now),
      buildSubscription("back", [charge(0, 400), charge(70, 400), charge(100, 400)], now),
      buildSubscription("same", [charge(0, 100), charge(30, 100), charge(60, 100), charge(90, 100)], now),
    ];
    expect(movements(subs, a, b)).toEqual({
      new: 1000,
      expansion: 2000,
      reactivation: 400,
      contraction: -1500,
      churn: -700,
      new_subscribers: 1,
      churned_subscribers: 1,
    });
  });
});

describe.each([
  ["sqlite", testDb],
  ["pglite", pgliteDb],
] as [string, () => Promise<Database>][])("MRR report (%s)", (_name, makeDb) => {
  let rt: Runtime;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let siteId = "";
  let apiKey = "";
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

  const call = async (path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "User-Agent": UA, ...(init.headers ?? {}) };
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
    apiKey = (await call(`/api/sites/${siteId}/keys`, { body: { name: "test" } })).json.key;
    const now = Date.now();
    const pay = (transaction_id: string, subscription_id: string, amount: number, daysAgo: number, extra: Record<string, unknown> = {}) =>
      call("/api/v1/payments", {
        body: { transaction_id, subscription_id, amount, currency: "USD", timestamp: now - daysAgo * DAY, ...extra },
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    // A: monthly $30, active throughout. B: yearly $240 ($20 MRR), active. C: monthly $10, churned ~45 days ago.
    for (const d of [70, 40, 10]) await pay(`a${d}`, "sub_a", 30, d, { interval: "month" });
    await pay("b1", "sub_b", 240, 100, { interval: "year" });
    await pay("c1", "sub_c", 10, 80, { interval: "month" });
    // A one-off sale doesn't count.
    await pay("x1", "", 99, 5);
  });

  it("reports MRR, ARR, subscribers and churn for the period", async () => {
    const r = await call(`/api/sites/${siteId}/stats/mrr?period=90d`);
    expect(r.status).toBe(200);
    const s = r.json.summary;
    expect(s.mrr).toBe(5000); // $30 + $20, in cents
    expect(s.arr).toBe(60000);
    expect(s.subscribers).toBe(2);
    expect(s.arpu).toBe(2500);
    expect(s.churned_subscribers).toBe(1);
    expect(s.churn).toBe(-1000);
    expect(s.assumed_interval).toBe(0);
    expect(r.json.timeseries.length).toBeGreaterThan(10);
    expect(r.json.timeseries.at(-1).mrr).toBe(5000);
  });

  it("serves the same report through the REST API and breaks MRR down", async () => {
    const v1 = await call("/api/v1/analytics/mrr?period=30d", { headers: { Authorization: `Bearer ${apiKey}` } });
    expect(v1.status).toBe(200);
    expect(v1.json.data.summary).toMatchObject({ mrr: 5000, subscribers: 2, mrr_start: 5000, churn_rate: 0, net_revenue_retention: 1 });
    const breakdown = await call(`/api/sites/${siteId}/stats/mrr/breakdown?period=30d&group=channel`);
    expect(breakdown.json.group).toBe("channel");
    expect(breakdown.json.rows).toEqual([expect.objectContaining({ value: "__unattributed__", mrr: 5000, subscribers: 2 })]);
  });

  it("stores the interval sent with a payment", async () => {
    const row = await rt.db.first<{ billing_interval: string; billing_interval_count: number }>(
      "SELECT billing_interval, billing_interval_count FROM payments WHERE site_id = ? AND transaction_id = 'b1'",
      [siteId],
    );
    expect(row).toMatchObject({ billing_interval: "year", billing_interval_count: 1 });
  });
});
