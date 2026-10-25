/**
 * Timezone-aware date math using only the Intl API (works on Workers, Node, Bun, Deno).
 *
 * Analytics buckets are computed inside SQL as integer arithmetic on UTC millisecond
 * timestamps plus the site's UTC offset. Because offsets change with daylight saving
 * time, the offset itself is expressed as a CASE over the (rare) transitions inside
 * the queried range, which keeps buckets exact and the SQL portable.
 */

export type Interval = "hour" | "day" | "week" | "month";

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Longest range a stats query may cover. */
const MAX_RANGE = 10 * 366 * DAY;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  try {
    formatter(tz).format(0);
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

export function localParts(tz: string, utcMs: number): LocalParts {
  const parts = formatter(tz).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute") };
}

/** Offset of `tz` from UTC in milliseconds at the given instant (e.g. -14400000 for EDT). */
export function offsetAt(tz: string, utcMs: number): number {
  const p = localParts(tz, utcMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const truncated = utcMs - (((utcMs % 60_000) + 60_000) % 60_000);
  return asUtc - truncated;
}

/** UTC timestamp of a local wall-clock time in `tz`. Month is 1-12 and may overflow (Date.UTC semantics). */
export function zonedTime(tz: string, year: number, month: number, day: number, hour = 0): number {
  const guess = Date.UTC(year, month - 1, day, hour);
  const off1 = offsetAt(tz, guess);
  let t = guess - off1;
  const off2 = offsetAt(tz, t);
  if (off2 !== off1) t = guess - off2;
  return t;
}

export function startOfLocalDay(tz: string, utcMs: number): number {
  const p = localParts(tz, utcMs);
  return zonedTime(tz, p.year, p.month, p.day);
}

export function formatLocalDate(tz: string, utcMs: number): string {
  const p = localParts(tz, utcMs);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export interface OffsetSegment {
  /** Segment applies to timestamps strictly lower than `until` (null = open-ended). */
  until: number | null;
  offset: number;
}

/** Returns the distinct UTC offsets in effect over [from, to). */
export function offsetSegments(tz: string, from: number, to: number): OffsetSegment[] {
  const segments: OffsetSegment[] = [];
  const step = to - from > 120 * DAY ? DAY : 6 * HOUR;
  let current = offsetAt(tz, from);
  let prev = from;
  let guard = 0;
  for (let t = from + step; t < to + step && guard++ < 25_000; t += step) {
    const probe = Math.min(t, to);
    const off = offsetAt(tz, probe);
    if (off !== current) {
      // binary search the exact transition (offsets change on a minute boundary)
      let lo = prev;
      let hi = probe;
      while (hi - lo > 60_000) {
        const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000;
        if (offsetAt(tz, mid) === current) lo = mid;
        else hi = mid;
      }
      segments.push({ until: hi, offset: current });
      current = off;
    }
    prev = probe;
    if (probe >= to) break;
  }
  segments.push({ until: null, offset: current });
  return segments;
}

/** SQL expression for the site's UTC offset at the instant stored in `col`. */
export function offsetSql(col: string, segments: OffsetSegment[]): string {
  if (segments.length === 1) return String(segments[0].offset);
  const whens = segments
    .filter((s) => s.until !== null)
    .map((s) => `WHEN ${col} < ${s.until} THEN ${s.offset}`)
    .join(" ");
  return `(CASE ${whens} ELSE ${segments[segments.length - 1].offset} END)`;
}

export interface Bucket {
  key: number;
  /** UTC timestamp of the start of the bucket */
  start: number;
  /** ISO-like local label: YYYY-MM-DD or YYYY-MM-DDTHH:00 */
  label: string;
}

export interface BucketPlan {
  /** SQL expression computing the integer bucket key from a timestamp column */
  sql: (col: string) => string;
  buckets: Bucket[];
}

function monthCode(year: number, month: number) {
  return year * 12 + (month - 1);
}

export function planBuckets(tz: string, from: number, to: number, interval: Interval): BucketPlan {
  const segments = offsetSegments(tz, from, to);
  const off = (col: string) => offsetSql(col, segments);
  const buckets: Bucket[] = [];
  const seen = new Set<number>();
  const push = (key: number, start: number, label: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    buckets.push({ key, start, label });
  };

  if (interval === "hour") {
    for (let t = from; t < to; t += HOUR) {
      const o = offsetAt(tz, t);
      const key = Math.floor((t + o) / HOUR);
      const p = localParts(tz, t);
      push(key, t, `${formatLocalDate(tz, t)}T${String(p.hour).padStart(2, "0")}:00`);
    }
    return { sql: (col) => `((${col} + ${off(col)}) / ${HOUR})`, buckets };
  }

  // Iterate local days
  const days: { key: number; start: number; label: string; parts: LocalParts }[] = [];
  let p = localParts(tz, from);
  let t = zonedTime(tz, p.year, p.month, p.day);
  let guard = 0;
  while (t < to && guard++ < 20000) {
    const parts = localParts(tz, t);
    const key = Math.floor((t + offsetAt(tz, t)) / DAY);
    days.push({ key, start: t, label: formatLocalDate(tz, t), parts });
    t = zonedTime(tz, parts.year, parts.month, parts.day + 1);
  }

  if (interval === "day") {
    for (const d of days) push(d.key, d.start, d.label);
    return { sql: (col) => `((${col} + ${off(col)}) / ${DAY})`, buckets };
  }

  if (interval === "week") {
    for (const d of days) {
      const key = Math.floor((d.key + 3) / 7);
      if (seen.has(key)) continue;
      // label = Monday of that week (may be before `from`)
      const mondayDayKey = key * 7 - 3;
      const mondayUtc = mondayDayKey * DAY;
      const label = new Date(mondayUtc).toISOString().slice(0, 10);
      push(key, d.start, label);
    }
    return { sql: (col) => `((((${col} + ${off(col)}) / ${DAY}) + 3) / 7)`, buckets };
  }

  // month: map local day number -> month code via CASE on month start day keys
  const monthStarts: { dayKey: number; code: number }[] = [];
  for (const d of days) {
    const code = monthCode(d.parts.year, d.parts.month);
    if (!seen.has(code)) {
      push(code, d.start, `${d.parts.year}-${String(d.parts.month).padStart(2, "0")}-01`);
      const firstOfMonth = Date.UTC(d.parts.year, d.parts.month - 1, 1) / DAY;
      monthStarts.push({ dayKey: firstOfMonth, code });
    }
  }
  return {
    sql: (col) => {
      const dayExpr = `((${col} + ${off(col)}) / ${DAY})`;
      if (monthStarts.length <= 1) return String(monthStarts[0]?.code ?? 0);
      const whens = [...monthStarts]
        .reverse()
        .map((m) => `WHEN ${dayExpr} >= ${m.dayKey} THEN ${m.code}`)
        .join(" ");
      return `(CASE ${whens} ELSE ${monthStarts[0].code} END)`;
    },
    buckets,
  };
}

// ---------------------------------------------------------------------------
// Period resolution
// ---------------------------------------------------------------------------

export const PERIODS = ["today", "yesterday", "24h", "7d", "30d", "90d", "wtd", "mtd", "ytd", "12m", "all", "custom"] as const;
export type Period = (typeof PERIODS)[number];

export interface ResolvedRange {
  period: Period;
  from: number;
  to: number;
  interval: Interval;
  /** previous period of the same length, for comparisons */
  previous: { from: number; to: number };
  fromDate: string;
  toDate: string;
}

function parseDate(s: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 1970 || y > 2100) return null;
  return { y, m: Number(m[2]), d: Number(m[3]) };
}

export function defaultInterval(from: number, to: number): Interval {
  const span = to - from;
  if (span <= 2 * DAY + HOUR) return "hour";
  if (span <= 120 * DAY) return "day";
  if (span <= 400 * DAY) return "week";
  return "month";
}

export function resolveRange(
  tz: string,
  opts: { period?: string | null; from?: string | null; to?: string | null; interval?: string | null },
  now = Date.now(),
  firstDataTs?: number | null,
): ResolvedRange {
  const today = localParts(tz, now);
  const dayStart = (offsetDays: number) => zonedTime(tz, today.year, today.month, today.day + offsetDays);
  let period = (PERIODS as readonly string[]).includes(opts.period ?? "") ? (opts.period as Period) : "7d";
  let from: number;
  let to: number;

  const customFrom = parseDate(opts.from);
  const customTo = parseDate(opts.to);
  if (customFrom && customTo) period = "custom";

  switch (period) {
    case "today":
      from = dayStart(0);
      to = dayStart(1);
      break;
    case "yesterday":
      from = dayStart(-1);
      to = dayStart(0);
      break;
    case "24h":
      to = Math.ceil((now + 1) / HOUR) * HOUR;
      from = to - 24 * HOUR;
      break;
    case "30d":
      from = dayStart(-29);
      to = dayStart(1);
      break;
    case "90d":
      from = dayStart(-89);
      to = dayStart(1);
      break;
    case "wtd": {
      const dow = (new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay() + 6) % 7; // Monday = 0
      from = dayStart(-dow);
      to = dayStart(1);
      break;
    }
    case "mtd":
      from = zonedTime(tz, today.year, today.month, 1);
      to = dayStart(1);
      break;
    case "ytd":
      from = zonedTime(tz, today.year, 1, 1);
      to = dayStart(1);
      break;
    case "12m":
      from = zonedTime(tz, today.year, today.month - 11, 1);
      to = dayStart(1);
      break;
    case "all": {
      const first = firstDataTs && firstDataTs < now ? firstDataTs : now;
      from = startOfLocalDay(tz, first);
      to = dayStart(1);
      break;
    }
    case "custom": {
      if (customFrom && customTo) {
        from = zonedTime(tz, customFrom.y, customFrom.m, customFrom.d);
        to = zonedTime(tz, customTo.y, customTo.m, customTo.d + 1);
        if (to <= from) to = zonedTime(tz, customFrom.y, customFrom.m, customFrom.d + 1);
      } else {
        from = dayStart(-6);
        to = dayStart(1);
        period = "7d";
      }
      break;
    }
    case "7d":
    default:
      from = dayStart(-6);
      to = dayStart(1);
  }

  // Keep every range bounded (custom dates and "all" alike) so one request can't plan decades of buckets.
  if (to - from > MAX_RANGE) from = startOfLocalDay(tz, to - MAX_RANGE);

  let interval = defaultInterval(from, to);
  if (period === "12m" || (period === "all" && to - from > 400 * DAY)) interval = "month";
  if (opts.interval && ["hour", "day", "week", "month"].includes(opts.interval)) {
    const requested = opts.interval as Interval;
    // avoid absurd bucket counts
    const span = to - from;
    if (!(requested === "hour" && span > 31 * DAY) && !(requested === "day" && span > 3 * 366 * DAY)) interval = requested;
  }

  const length = to - from;
  return {
    period,
    from,
    to,
    interval,
    previous: { from: from - length, to: from },
    fromDate: formatLocalDate(tz, from),
    toDate: formatLocalDate(tz, to - 1),
  };
}
