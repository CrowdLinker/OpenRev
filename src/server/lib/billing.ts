/**
 * Subscription billing intervals, used to turn payments into MRR. Providers spell them in many ways
 * ("month", "monthly", "every-month", "annually", "P1M"...) or only report a period's start and end, so this
 * normalizes both into a unit and a count.
 */
export type BillingUnit = "day" | "week" | "month" | "year";
export interface BillingInterval {
  unit: BillingUnit;
  count: number;
}

const DAY_MS = 86_400_000;
/** Average lengths, so a yearly plan isn't credited 12.17 months of MRR. */
const UNIT_DAYS: Record<BillingUnit, number> = { day: 1, week: 7, month: 365.25 / 12, year: 365.25 };
const UNIT_MONTHS: Record<BillingUnit, number> = { day: 12 / 365.25, week: 12 / 52.1786, month: 1, year: 12 };

const WORDS: [RegExp, BillingInterval][] = [
  [/^(day|days|daily)$/, { unit: "day", count: 1 }],
  [/^(week|weeks|weekly)$/, { unit: "week", count: 1 }],
  [/^(fortnight|fortnightly|biweekly)$/, { unit: "week", count: 2 }],
  [/^(month|months|monthly|mo|m|1m|p1m)$/, { unit: "month", count: 1 }],
  [/^(quarter|quarters|quarterly|threemonths|3months|3m|p3m)$/, { unit: "month", count: 3 }],
  [/^(biannual|biannually|semiannual|semiannually|halfyearly|sixmonths|6months|6m|p6m)$/, { unit: "month", count: 6 }],
  [/^(year|years|yearly|annual|annually|yr|y|1y|p1y)$/, { unit: "year", count: 1 }],
  [/^(twoyears|biennial|biennially|2y|p2y)$/, { unit: "year", count: 2 }],
];

function clampCount(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 1 && v <= 1000 ? v : 1;
}

/** Parses a provider's interval word (and optional count), or returns null when it isn't one. */
export function parseInterval(unit: unknown, count?: unknown): BillingInterval | null {
  if (typeof unit !== "string") return null;
  const key = unit.toLowerCase().replace(/^every[-_ ]?/, "").replace(/[-_ ]/g, "");
  for (const [re, base] of WORDS) {
    if (!re.test(key)) continue;
    const interval: BillingInterval = { unit: base.unit, count: base.count * clampCount(count ?? 1) };
    // Providers bill at most every 3 years (Stripe's limit); a longer "interval" is a mistake, not a billing period.
    return intervalDays(interval) <= 3 * 366 ? interval : null;
  }
  return null;
}

/**
 * Snaps a billing period length (in days) to the interval it most likely is: 7 → weekly, 28 to 31 → monthly,
 * about 91 → quarterly, 365 → yearly. Lengths that match nothing within 15% are rejected.
 */
export function intervalFromDays(days: number): BillingInterval | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  const candidates: BillingInterval[] = [
    { unit: "day", count: 1 },
    { unit: "week", count: 1 },
    { unit: "week", count: 2 },
    { unit: "month", count: 1 },
    { unit: "month", count: 2 },
    { unit: "month", count: 3 },
    { unit: "month", count: 6 },
    { unit: "year", count: 1 },
    { unit: "year", count: 2 },
    { unit: "year", count: 3 },
  ];
  let best: BillingInterval | null = null;
  let bestErr = Infinity;
  for (const c of candidates) {
    const err = Math.abs(days - intervalDays(c)) / intervalDays(c);
    if (err < bestErr) {
      best = c;
      bestErr = err;
    }
  }
  return bestErr <= 0.15 ? best : null;
}

/** The interval of a period given its start and end (seconds or milliseconds since the epoch). */
export function intervalFromPeriod(start: unknown, end: unknown): BillingInterval | null {
  const toMs = (v: unknown) => {
    const n = typeof v === "string" && !/^\d+$/.test(v) ? Date.parse(v) : Number(v);
    if (!Number.isFinite(n) || n <= 0) return NaN;
    return n < 1e11 ? n * 1000 : n;
  };
  const a = toMs(start);
  const b = toMs(end);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? intervalFromDays((b - a) / DAY_MS) : null;
}

export const intervalDays = (i: BillingInterval) => UNIT_DAYS[i.unit] * i.count;
export const intervalMs = (i: BillingInterval) => intervalDays(i) * DAY_MS;
/** How much of a payment is one month's worth: 1 for monthly, 1/12 for yearly, ~4.35 for weekly. */
export const monthlyFactor = (i: BillingInterval) => 1 / (UNIT_MONTHS[i.unit] * i.count);

export function isBillingUnit(v: unknown): v is BillingUnit {
  return v === "day" || v === "week" || v === "month" || v === "year";
}
