const digitsCache = new Map<string, number>();
export function currencyDigits(code: string) {
  let d = digitsCache.get(code);
  if (d === undefined) {
    try {
      d = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      d = 2;
    }
    digitsCache.set(code, d);
  }
  return d;
}

/** Formats an amount stored in minor units (cents). */
export function money(minor: number, currency = "USD", opts: { compact?: boolean; cents?: boolean } = {}) {
  const value = (minor || 0) / 10 ** currencyDigits(currency);
  try {
    if (opts.compact && Math.abs(value) >= 10_000) {
      return new Intl.NumberFormat("en-US", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(value);
    }
    const whole = Math.abs(value) >= 1000 && !opts.cents;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: whole ? 0 : currencyDigits(currency),
      minimumFractionDigits: whole ? 0 : Number.isInteger(value) && !opts.cents ? 0 : currencyDigits(currency),
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function num(n: number, compact = true) {
  if (!Number.isFinite(n)) return "0";
  if (compact && Math.abs(n) >= 10_000) return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

export function pct(ratio: number, digits = 1) {
  if (!Number.isFinite(ratio)) return "0%";
  const v = ratio * 100;
  return `${v.toFixed(v > 0 && v < 1 ? 2 : digits).replace(/\.0+$/, "")}%`;
}

export function duration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function change(current: number, previous: number | undefined | null): number | null {
  if (previous === undefined || previous === null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / previous;
}

let regionNames: Intl.DisplayNames | null = null;
export function countryName(code: string | null | undefined) {
  if (!code) return "Unknown";
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export function flag(code: string | null | undefined) {
  if (!code || code.length !== 2) return "🌐";
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function timeAgo(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function dateTime(ts: number, tz?: string) {
  try {
    return new Date(ts).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return new Date(ts).toLocaleString();
  }
}

/** Label for chart buckets: "2025-03-04" / "2025-03-04T15:00". */
export function bucketLabel(date: string, interval: string, long = false) {
  const [d, t] = date.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  const month = dt.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  if (interval === "hour") {
    const h = Number(t?.slice(0, 2) ?? 0);
    const hour = `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "am" : "pm"}`;
    return long ? `${month} ${day}, ${hour}` : hour;
  }
  if (interval === "month") return long ? `${month} ${y}` : `${month}${long ? "" : ` '${String(y).slice(2)}`}`;
  if (interval === "week") return long ? `Week of ${month} ${day}, ${y}` : `${month} ${day}`;
  return long ? dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : `${month} ${day}`;
}

export function initials(name: string) {
  return name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

/** Deterministic pleasant color from a string (for avatars). */
export function colorFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${h} 65% 55%)`;
}

const ADJ = ["Swift", "Calm", "Brave", "Clever", "Happy", "Lucky", "Bright", "Gentle", "Bold", "Witty", "Sunny", "Quiet", "Eager", "Jolly", "Mellow", "Noble"];
const ANIMALS = ["Otter", "Falcon", "Panda", "Fox", "Koala", "Lynx", "Heron", "Badger", "Dolphin", "Owl", "Tiger", "Whale", "Rabbit", "Bison", "Gecko", "Moose"];
/** Friendly pseudonym for anonymous visitors, stable per visitor id. */
export function visitorName(id: string, name?: string | null) {
  if (name) return name;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) >>> 0;
  return `${ADJ[h % ADJ.length]} ${ANIMALS[(h >>> 4) % ANIMALS.length]}`;
}
