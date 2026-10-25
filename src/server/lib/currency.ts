import type { Database } from "../db/types";

const digitsCache = new Map<string, number>();

/** Number of minor-unit digits for an ISO 4217 currency (USD=2, JPY=0, KWD=3). */
export function currencyDigits(code: string): number {
  const c = code.toUpperCase();
  let d = digitsCache.get(c);
  if (d === undefined) {
    try {
      d = new Intl.NumberFormat("en", { style: "currency", currency: c }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      d = 2;
    }
    digitsCache.set(c, d);
  }
  return d;
}

export function isValidCurrency(code: unknown): code is string {
  if (typeof code !== "string" || !/^[A-Za-z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: code.toUpperCase() });
    return true;
  } catch {
    return false;
  }
}

export function toMinor(major: number, currency: string): number {
  return Math.round(major * 10 ** currencyDigits(currency));
}

export function fromMinor(minor: number, currency: string): number {
  return minor / 10 ** currencyDigits(currency);
}

/** Approximate USD-based rates used only when no live rates can be fetched. */
export const FALLBACK_RATES: Record<string, number> = {
  USD: 1, EUR: 0.92, GBP: 0.79, CAD: 1.37, AUD: 1.52, NZD: 1.66, JPY: 150, CNY: 7.2, HKD: 7.8, SGD: 1.34,
  INR: 84, IDR: 15800, PHP: 57, THB: 35, MYR: 4.5, VND: 25000, KRW: 1350, TWD: 32, BRL: 5.5, MXN: 18,
  ARS: 950, CLP: 950, COP: 4100, PEN: 3.75, CHF: 0.88, SEK: 10.5, NOK: 10.8, DKK: 6.9, PLN: 4.0, CZK: 23,
  HUF: 365, RON: 4.6, BGN: 1.8, ISK: 138, TRY: 34, ILS: 3.7, AED: 3.67, SAR: 3.75, QAR: 3.64, ZAR: 18,
  NGN: 1600, KES: 129, GHS: 15.5, EGP: 48, MAD: 9.9, PKR: 278, BDT: 118, LKR: 300, UAH: 41, RUB: 95,
};

export type Rates = Record<string, number>;

const memory = new Map<string, { rates: Rates; at: number }>();

async function fetchRates(): Promise<Rates | null> {
  const sources = [
    async () => {
      const res = await fetch("https://api.frankfurter.dev/v1/latest?base=USD");
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as { rates: Rates };
      return { USD: 1, ...j.rates };
    },
    async () => {
      const res = await fetch("https://open.er-api.com/v6/latest/USD");
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as { rates: Rates };
      return j.rates;
    },
  ];
  let merged: Rates | null = null;
  for (const src of sources) {
    try {
      const r = await src();
      merged = { ...r, ...(merged ?? {}) };
    } catch {
      /* try next */
    }
  }
  return merged;
}

/** USD-based FX rates for the current UTC day (cached in memory and in the database). */
export async function getRates(db: Database, now = Date.now()): Promise<Rates> {
  const day = new Date(now).toISOString().slice(0, 10);
  const cached = memory.get(day);
  if (cached) return cached.rates;

  const row = await db.first<{ rates: string }>("SELECT rates FROM fx_rates WHERE day = ?", [day]);
  if (row) {
    const rates = JSON.parse(row.rates) as Rates;
    memory.set(day, { rates, at: now });
    return rates;
  }

  const fetched = await fetchRates();
  if (fetched) {
    const rates = { ...FALLBACK_RATES, ...fetched };
    await db
      .run("INSERT INTO fx_rates (day, base, rates, fetched_at) VALUES (?, 'USD', ?, ?) ON CONFLICT (day) DO NOTHING", [
        day,
        JSON.stringify(rates),
        now,
      ])
      .catch(() => {});
    memory.set(day, { rates, at: now });
    return rates;
  }

  const latest = await db.first<{ rates: string }>("SELECT rates FROM fx_rates ORDER BY day DESC LIMIT 1");
  const rates = latest ? (JSON.parse(latest.rates) as Rates) : FALLBACK_RATES;
  memory.set(day, { rates, at: now });
  return rates;
}

export function convertMinor(amountMinor: number, from: string, to: string, rates: Rates): number {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return Math.round(amountMinor);
  const rf = rates[f] ?? FALLBACK_RATES[f];
  const rt = rates[t] ?? FALLBACK_RATES[t];
  if (!rf || !rt) return Math.round(amountMinor * 10 ** (currencyDigits(t) - currencyDigits(f)));
  const major = fromMinor(amountMinor, f);
  return toMinor((major / rf) * rt, t);
}
