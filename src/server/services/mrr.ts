import type { Database } from "../db/types";
import { intervalFromDays, intervalMs, isBillingUnit, monthlyFactor, type BillingInterval } from "../lib/billing";
import { planBuckets, type Interval } from "../lib/time";
import { attributionColumn, sessionFilterSql, UNATTRIBUTED, type StatsQuery } from "./stats";

/**
 * Monthly recurring revenue, built from subscription payments only (no provider API calls), so it works the same
 * for every provider and for imported history.
 *
 * Each subscription charge pays for one billing period. A subscription counts towards MRR from its first charge
 * for as long as charges keep covering time: a renewal that arrives within GRACE of the period's end continues it,
 * anything later is a churn followed by a reactivation. Its MRR is its latest charge spread over that charge's
 * interval (a $120 yearly charge is $10 MRR). Refunds don't change MRR: it measures recurring commitments, and
 * net revenue already shows them.
 */

const DAY = 86_400_000;
/** Late renewals (card retries, dunning) within this window don't count as churn. */
const GRACE_MS = 7 * DAY;
/** D1 accepts at most 100 bound parameters per query. */
const CHUNK = 90;

interface Charge {
  ts: number;
  revenue: number;
  interval: BillingInterval | null;
  session: string | null;
}

interface Segment {
  from: number;
  to: number; // exclusive; Infinity while the subscription is still active
  mrr: number;
}

export interface Subscription {
  key: string;
  firstTs: number;
  session: string | null;
  /** True when no charge had a billing interval and none could be inferred, so monthly was assumed. */
  assumedInterval: boolean;
  segments: Segment[];
}

/** Builds a subscription's coverage segments from its charges (sorted by time). */
export function buildSubscription(key: string, charges: Charge[], now: number): Subscription {
  const known = charges.find((c) => c.interval)?.interval ?? null;
  let fallback = known;
  if (!fallback && charges.length > 1) {
    const gaps = charges
      .slice(1)
      .map((c, i) => (c.ts - charges[i].ts) / DAY)
      .filter((d) => d > 0.5)
      .sort((a, b) => a - b);
    fallback = gaps.length ? intervalFromDays(gaps[Math.floor(gaps.length / 2)]) : null;
  }
  const assumedInterval = !fallback;
  const base: BillingInterval = fallback ?? { unit: "month", count: 1 };

  const segments: Segment[] = [];
  charges.forEach((c, i) => {
    const interval = c.interval ?? base;
    const mrr = Math.round(c.revenue * monthlyFactor(interval));
    const end = c.ts + intervalMs(interval);
    const next = charges[i + 1];
    let to: number;
    if (next) to = next.ts <= end + GRACE_MS ? next.ts : end;
    else to = now < end + GRACE_MS ? Infinity : end;
    if (to > c.ts) segments.push({ from: c.ts, to, mrr });
  });
  return { key, firstTs: charges[0].ts, session: charges[0].session, assumedInterval, segments };
}

/** A subscription's MRR at instant `t`. */
export function mrrAt(sub: Subscription, t: number): number {
  for (const s of sub.segments) if (s.from <= t && t < s.to) return s.mrr;
  return 0;
}

export interface Movements {
  new: number;
  expansion: number;
  reactivation: number;
  contraction: number;
  churn: number;
  new_subscribers: number;
  churned_subscribers: number;
}

const emptyMovements = (): Movements => ({ new: 0, expansion: 0, reactivation: 0, contraction: 0, churn: 0, new_subscribers: 0, churned_subscribers: 0 });

/** How each subscription's MRR changed between the instants `a` and `b` (a < b). Churn and contraction are negative. */
export function movements(subs: Subscription[], a: number, b: number): Movements {
  const m = emptyMovements();
  for (const s of subs) {
    const before = mrrAt(s, a);
    const after = mrrAt(s, b);
    if (before === after) continue;
    if (before === 0) {
      if (s.firstTs > a) {
        m.new += after;
        m.new_subscribers++;
      } else m.reactivation += after;
    } else if (after === 0) {
      m.churn -= before;
      m.churned_subscribers++;
    } else if (after > before) m.expansion += after - before;
    else m.contraction += after - before;
  }
  return m;
}

/** Loads the site's subscriptions (with filters applied to the session that brought each one in). */
export async function loadSubscriptions(db: Database, q: StatsQuery, now = Date.now()): Promise<Subscription[]> {
  const attr = attributionColumn(q.site, q.attribution);
  const rows = await db.all<{
    provider: string;
    subscription_id: string;
    ts: number;
    revenue: number;
    billing_interval: string | null;
    billing_interval_count: number | null;
    sid: string | null;
  }>(
    `SELECT provider, subscription_id, ts, revenue, billing_interval, billing_interval_count, ${attr} AS sid
     FROM payments
     WHERE site_id = ? AND subscription_id IS NOT NULL AND type <> 'refund' AND revenue > 0 AND ts < ?
     ORDER BY ts`,
    [q.site.id, Math.min(q.range.to, now)],
  );
  const byKey = new Map<string, Charge[]>();
  for (const r of rows) {
    const key = `${r.provider}:${r.subscription_id}`;
    const unit = r.billing_interval;
    const interval = isBillingUnit(unit) ? { unit, count: Math.max(1, Number(r.billing_interval_count) || 1) } : null;
    const list = byKey.get(key) ?? [];
    list.push({ ts: Number(r.ts), revenue: Number(r.revenue), interval, session: r.sid });
    byKey.set(key, list);
  }
  let subs = [...byKey].map(([key, charges]) => buildSubscription(key, charges, now));

  if (q.filters.length) {
    const f = sessionFilterSql(q.filters);
    const ids = [...new Set(subs.map((s) => s.session).filter((x): x is string => !!x))];
    const keep = new Set<string>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const found = await db.all<{ id: string }>(
        `SELECT s.id FROM sessions s WHERE s.site_id = ? AND s.id IN (${chunk.map(() => "?").join(",")})${f.sql}`,
        [q.site.id, ...chunk, ...f.params],
      );
      for (const r of found) keep.add(r.id);
    }
    subs = subs.filter((s) => s.session && keep.has(s.session));
  }
  return subs;
}

export interface MrrPoint extends Movements {
  date: string;
  start: number;
  mrr: number;
  subscribers: number;
}

export interface MrrReport {
  summary: {
    mrr: number;
    arr: number;
    subscribers: number;
    arpu: number;
    mrr_start: number;
    subscribers_start: number;
    net_change: number;
    /** Share of subscribers active at the start who had churned by the end. */
    churn_rate: number | null;
    /** MRR lost to churn and contraction from subscribers active at the start, as a share of starting MRR. */
    revenue_churn_rate: number | null;
    /** End MRR of subscribers active at the start, as a share of starting MRR (includes expansion). */
    net_revenue_retention: number | null;
    /** Subscriptions whose interval was assumed to be monthly (no interval reported or inferable). */
    assumed_interval: number;
  } & Movements;
  timeseries: MrrPoint[];
}

const count = (subs: Subscription[], t: number) => subs.reduce((n, s) => n + (mrrAt(s, t) > 0 ? 1 : 0), 0);
const total = (subs: Subscription[], t: number) => subs.reduce((n, s) => n + mrrAt(s, t), 0);

export async function mrrReport(db: Database, q: StatsQuery, interval?: Interval, now = Date.now()): Promise<MrrReport> {
  const subs = await loadSubscriptions(db, q, now);
  const start = q.range.from - 1;
  const end = Math.min(q.range.to, now) - 1;

  const plan = planBuckets(q.site.timezone, q.range.from, q.range.to, interval ?? q.range.interval);
  const timeseries: MrrPoint[] = [];
  plan.buckets.forEach((b, i) => {
    if (b.start > now) return;
    const bStart = Math.max(b.start, q.range.from) - 1;
    const bEnd = Math.min(plan.buckets[i + 1]?.start ?? q.range.to, q.range.to, now) - 1;
    timeseries.push({ date: b.label, start: b.start, mrr: total(subs, bEnd), subscribers: count(subs, bEnd), ...movements(subs, bStart, bEnd) });
  });

  const sums = emptyMovements();
  for (const p of timeseries) for (const k of Object.keys(sums) as (keyof Movements)[]) sums[k] += p[k];

  const mrrStart = total(subs, start);
  const mrrEnd = total(subs, end);
  const activeAtStart = subs.filter((s) => mrrAt(s, start) > 0);
  const lostFromStart = activeAtStart.reduce((n, s) => n + Math.max(0, mrrAt(s, start) - mrrAt(s, end)), 0);
  const subscribers = count(subs, end);

  return {
    summary: {
      mrr: mrrEnd,
      arr: mrrEnd * 12,
      subscribers,
      arpu: subscribers ? Math.round(mrrEnd / subscribers) : 0,
      mrr_start: mrrStart,
      subscribers_start: activeAtStart.length,
      net_change: mrrEnd - mrrStart,
      churn_rate: activeAtStart.length ? activeAtStart.filter((s) => mrrAt(s, end) === 0).length / activeAtStart.length : null,
      revenue_churn_rate: mrrStart ? lostFromStart / mrrStart : null,
      net_revenue_retention: mrrStart ? activeAtStart.reduce((n, s) => n + mrrAt(s, end), 0) / mrrStart : null,
      assumed_interval: subs.filter((s) => s.assumedInterval && s.segments.some((g) => g.to > q.range.from)).length,
      ...sums,
    },
    timeseries,
  };
}

const BREAKDOWN_COLUMNS = { channel: "channel", source: "source", utm_campaign: "utm_campaign", country: "country" } as const;
export type MrrGroup = keyof typeof BREAKDOWN_COLUMNS;
export const MRR_GROUPS = Object.keys(BREAKDOWN_COLUMNS) as MrrGroup[];
export const mrrGroup = (v: unknown): MrrGroup => (MRR_GROUPS.includes(v as MrrGroup) ? (v as MrrGroup) : "channel");

/** Current MRR and MRR won in the range, by what brought each subscription in. */
export async function mrrBreakdown(db: Database, q: StatsQuery, group: MrrGroup, now = Date.now()) {
  const subs = await loadSubscriptions(db, q, now);
  const start = q.range.from - 1;
  const end = Math.min(q.range.to, now) - 1;
  const col = BREAKDOWN_COLUMNS[group] ?? "source";

  const ids = [...new Set(subs.map((s) => s.session).filter((x): x is string => !!x))];
  const info = new Map<string, { value: string; meta: string | null }>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await db.all<{ id: string; value: string | null; referrer_domain: string | null }>(
      `SELECT id, ${col} AS value, referrer_domain FROM sessions WHERE site_id = ? AND id IN (${chunk.map(() => "?").join(",")})`,
      [q.site.id, ...chunk],
    );
    for (const r of rows) info.set(r.id, { value: r.value ?? "", meta: r.referrer_domain });
  }

  const rows = new Map<string, { value: string; meta: string | null; mrr: number; subscribers: number; new_mrr: number; new_subscribers: number; churned_mrr: number }>();
  for (const s of subs) {
    const at = s.session ? info.get(s.session) : undefined;
    const value = at ? at.value : UNATTRIBUTED;
    const row = rows.get(value) ?? { value, meta: at?.meta ?? null, mrr: 0, subscribers: 0, new_mrr: 0, new_subscribers: 0, churned_mrr: 0 };
    const before = mrrAt(s, start);
    const after = mrrAt(s, end);
    if (after > 0) {
      row.mrr += after;
      row.subscribers++;
    }
    if (s.firstTs > start && s.firstTs <= end && after > 0) {
      row.new_mrr += after;
      row.new_subscribers++;
    }
    if (before > 0 && after === 0) row.churned_mrr += before;
    rows.set(value, row);
  }
  return [...rows.values()].filter((r) => r.mrr || r.new_mrr || r.churned_mrr).sort((a, b) => b.mrr - a.mrr || b.new_mrr - a.new_mrr);
}
