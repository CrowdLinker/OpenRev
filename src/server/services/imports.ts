import type { Database, SqlValue, Statement } from "../db/types";
import { uuid } from "../lib/ids";
import { classify } from "../lib/referrers";
import { zonedTime } from "../lib/time";
import { siteHosts, type Site } from "./sites";

/**
 * History imported from other analytics tools (Plausible's CSV export, Google Analytics 4), stored as daily totals in
 * `imported_stats` and added to the dashboard's overview, chart and breakdowns when no filters are applied.
 *
 * Every source is converted to the tables of Plausible's CSV export (Plausible imports Google Analytics into the same
 * format), so one mapper turns them into OpenRev's dimensions and names.
 */

export const IMPORT_SOURCES = ["plausible", "ga4"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const IMPORT_TABLES = [
  "visitors",
  "sources",
  "pages",
  "entry_pages",
  "exit_pages",
  "custom_events",
  "locations",
  "devices",
  "browsers",
  "operating_systems",
] as const;
export type ImportTable = (typeof IMPORT_TABLES)[number];

/** One row of a Plausible export table: column name → value, as read from the CSV. */
export type ImportRow = Record<string, string | number | null | undefined>;

export interface ImportRecord {
  id: string;
  site_id: string;
  source: ImportSource;
  status: "running" | "done" | "failed";
  date_from: string;
  date_to: string;
  config: string | null;
  cursor: string | null;
  imported_rows: number;
  error: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export function publicImport(r: ImportRecord) {
  return {
    id: r.id,
    source: r.source,
    status: r.status,
    date_from: r.date_from,
    date_to: r.date_to,
    imported_rows: Number(r.imported_rows),
    error: r.error,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isImportDate = (d: unknown): d is string => typeof d === "string" && DATE_RE.test(d) && !Number.isNaN(Date.parse(d));

export function dayStart(site: Pick<Site, "timezone">, date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return zonedTime(site.timezone, y, m, d);
}

export async function listImports(db: Database, siteId: string): Promise<ImportRecord[]> {
  return db.all<ImportRecord>("SELECT * FROM imports WHERE site_id = ? ORDER BY date_from", [siteId]);
}

export async function getImport(db: Database, siteId: string, id: string): Promise<ImportRecord | null> {
  return db.first<ImportRecord>("SELECT * FROM imports WHERE id = ? AND site_id = ?", [id, siteId]);
}

/** The first day OpenRev itself recorded a visit for the website, or null. Imports must end before it. */
export async function firstNativeDate(db: Database, site: Site): Promise<string | null> {
  const row = await db.first<{ t: number | null }>("SELECT MIN(started_at) AS t FROM sessions WHERE site_id = ?", [site.id]);
  if (row?.t === null || row?.t === undefined) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: site.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(Number(row.t));
}

/** Creates an import after checking its dates: inside the past, before OpenRev's own data, overlapping no other import. */
export async function createImport(
  db: Database,
  site: Site,
  opts: { source: ImportSource; dateFrom: string; dateTo: string; config?: string | null; userId?: string | null },
  now = Date.now(),
): Promise<ImportRecord> {
  const { dateFrom, dateTo } = opts;
  if (!isImportDate(dateFrom) || !isImportDate(dateTo) || dateFrom > dateTo) throw new ImportError("Choose a valid date range");
  const native = await firstNativeDate(db, site);
  if (native && dateTo >= native) {
    throw new ImportError(`OpenRev has its own data from ${native}, so the import has to end before that day, or both would be counted.`);
  }
  for (const other of await listImports(db, site.id)) {
    if (other.status !== "failed" && other.date_from <= dateTo && dateFrom <= other.date_to) {
      throw new ImportError(
        `This overlaps the ${sourceLabel(other.source)} import from ${other.date_from} to ${other.date_to}. Delete that import first, or import other dates.`,
      );
    }
  }
  const row: ImportRecord = {
    id: uuid(),
    site_id: site.id,
    source: opts.source,
    status: "running",
    date_from: dateFrom,
    date_to: dateTo,
    config: opts.config ?? null,
    cursor: null,
    imported_rows: 0,
    error: null,
    created_by: opts.userId ?? null,
    created_at: now,
    updated_at: now,
  };
  await db.run(
    `INSERT INTO imports (id, site_id, source, status, date_from, date_to, config, cursor, imported_rows, error, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
    [row.id, row.site_id, row.source, row.status, row.date_from, row.date_to, row.config, row.cursor, row.created_by, now, now],
  );
  return row;
}

export async function finishImport(db: Database, imp: ImportRecord, error: string | null, now = Date.now()) {
  // Credentials are only kept while an import runs.
  await db.run("UPDATE imports SET status = ?, error = ?, config = NULL, cursor = NULL, updated_at = ? WHERE id = ?", [
    error ? "failed" : "done",
    error,
    now,
    imp.id,
  ]);
}

export function deleteImportStatements(importId: string): Statement[] {
  return [
    { sql: "DELETE FROM imported_stats WHERE import_id = ?", params: [importId] },
    { sql: "DELETE FROM import_chunks WHERE import_id = ?", params: [importId] },
    { sql: "DELETE FROM imports WHERE id = ?", params: [importId] },
  ];
}

export class ImportError extends Error {}

export function sourceLabel(source: string): string {
  return source === "ga4" ? "Google Analytics" : source === "plausible" ? "Plausible" : source;
}

// ---------------------------------------------------------------------------
// Mapping rows to OpenRev's dimensions
// ---------------------------------------------------------------------------

interface Metrics {
  visitors: number;
  visits: number;
  pageviews: number;
  bounces: number;
  /** Seconds. */
  duration: number;
  events: number;
}

interface Cell extends Metrics {
  ts: number;
  dim: string;
  value: string;
  meta: string;
}

const num = (v: unknown): number => {
  const x = Math.round(Number(v));
  return Number.isFinite(x) && x > 0 ? Math.min(x, 1e12) : 0;
};
const text = (v: unknown, max = 500): string => (v === null || v === undefined ? "" : String(v).trim().slice(0, max));
/** Values tools use for "unknown", which OpenRev stores as an empty string. */
const blank = (v: string) => (/^(\(not set\)|\(none\)|\(direct\)|\(other\)|\(not provided\)|unknown|none|null)$/i.test(v) ? "" : v);

const DEVICES: Record<string, string> = { desktop: "desktop", laptop: "desktop", mobile: "mobile", tablet: "tablet", "smart tv": "desktop" };

const BROWSERS: [RegExp, string][] = [
  [/^(microsoft )?edge/i, "Edge"],
  [/^opera/i, "Opera"],
  [/^samsung/i, "Samsung Internet"],
  [/^yandex/i, "Yandex Browser"],
  [/^uc ?browser/i, "UC Browser"],
  [/^duckduckgo/i, "DuckDuckGo"],
  [/^huawei/i, "Huawei Browser"],
  [/^miui/i, "MIUI Browser"],
  [/^(mobile )?safari|^safari/i, "Safari"],
  [/^(chrome|chromium|android webview|chrome webview)/i, "Chrome"],
  [/^firefox/i, "Firefox"],
  [/^(internet explorer|ie)\b/i, "Internet Explorer"],
];

const SYSTEMS: [RegExp, string][] = [
  [/^(mac|macintosh|mac os|mac os x|macos)$/i, "macOS"],
  [/^ios$/i, "iOS"],
  [/^ipados$/i, "iPadOS"],
  [/^android$/i, "Android"],
  [/^windows phone$/i, "Windows Phone"],
  [/^windows/i, "Windows"],
  [/^chrome ?os$/i, "ChromeOS"],
  [/^(gnu\/)?linux$/i, "Linux"],
  [/^ubuntu$/i, "Ubuntu"],
  [/^fedora$/i, "Fedora"],
  [/^freebsd$/i, "FreeBSD"],
  [/^harmonyos$/i, "HarmonyOS"],
];

const rename = (value: string, table: [RegExp, string][]) => table.find(([re]) => re.test(value))?.[1] ?? value;

/** Outbound link values are stored like the tracker sends them: origin and path. */
function outboundValue(url: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return (u.origin + u.pathname).slice(0, 500);
  } catch {
    return url;
  }
}

/** Plausible's built-in events that aren't goals (pageviews and engagement are counted elsewhere). */
const SKIPPED_EVENTS = new Set(["pageview", "engagement"]);

/** Turns one row of an export table into the dimension values it adds to. */
export function mapRow(site: Pick<Site, "domain" | "settings">, table: ImportTable, row: ImportRow): { dim: string; value: string; meta?: string; m: Partial<Metrics> }[] {
  const base: Partial<Metrics> = {
    visitors: num(row.visitors),
    visits: num(row.visits),
    pageviews: num(row.pageviews),
    bounces: num(row.bounces),
    duration: num(row.visit_duration),
  };
  switch (table) {
    case "visitors":
      return [{ dim: "", value: "", m: base }];
    case "sources": {
      const referrer = text(row.referrer);
      const utm = {
        source: blank(text(row.utm_source, 200)),
        medium: blank(text(row.utm_medium, 200)),
        campaign: blank(text(row.utm_campaign, 200)),
        term: blank(text(row.utm_term, 200)),
        content: blank(text(row.utm_content, 200)),
      };
      // Without a referrer, the tool's own source name (Plausible's "source", GA's session source) stands in for
      // utm_source, and GA's session medium for utm_medium, for classification only.
      const named = blank(text(row.source, 200));
      const a = classify({
        referrer: referrer ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(referrer) ? referrer : `https://${referrer}`) : null,
        ownHosts: siteHosts(site as Site),
        utm: { ...utm, source: utm.source || (referrer ? "" : named), medium: utm.medium || blank(text(row.medium, 200)) },
        clickIds: [],
        inApp: null,
        ref: null,
      });
      return [
        { dim: "source", value: a.source, meta: a.referrerDomain ?? "", m: base },
        { dim: "channel", value: a.channel, m: base },
        { dim: "referrer", value: a.referrerDomain ?? "", m: base },
        { dim: "utm_source", value: utm.source, m: base },
        { dim: "utm_medium", value: utm.medium, m: base },
        { dim: "utm_campaign", value: utm.campaign, m: base },
        { dim: "utm_term", value: utm.term, m: base },
        { dim: "utm_content", value: utm.content, m: base },
      ];
    }
    case "pages":
      return [{ dim: "page", value: text(row.page) || "/", m: { visitors: base.visitors, visits: base.visits, pageviews: base.pageviews } }];
    case "entry_pages":
      return [{ dim: "entry_page", value: text(row.entry_page) || "/", m: { ...base, visits: num(row.entrances ?? row.visits) } }];
    case "exit_pages":
      return [{ dim: "exit_page", value: text(row.exit_page) || "/", m: { ...base, visits: num(row.exits ?? row.visits) } }];
    case "custom_events": {
      const name = text(row.name, 120);
      if (!name || SKIPPED_EVENTS.has(name.toLowerCase())) return [];
      const m = { visitors: base.visitors, events: num(row.events) };
      if (name === "Outbound Link: Click") return text(row.link_url) ? [{ dim: "outbound", value: outboundValue(text(row.link_url)), m }] : [];
      return [{ dim: "goal", value: name, m }];
    }
    case "locations": {
      const country = text(row.country, 2).toUpperCase();
      const out: { dim: string; value: string; meta?: string; m: Partial<Metrics> }[] = [{ dim: "country", value: /^[A-Z]{2}$/.test(country) && country !== "ZZ" ? country : "", m: base }];
      // Plausible exports region codes (US-CA) and GeoNames ids for cities; OpenRev stores names, so only names are kept.
      const region = blank(text(row.region, 200));
      const city = blank(text(row.city, 200));
      if (region && !/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(region)) out.push({ dim: "region", value: region, meta: out[0].value, m: base });
      if (city && !/^\d+$/.test(city)) out.push({ dim: "city", value: city, meta: out[0].value, m: base });
      return out;
    }
    case "devices": {
      const d = text(row.device, 50).toLowerCase();
      return [{ dim: "device", value: DEVICES[d] ?? (blank(d) ? d : ""), m: base }];
    }
    case "browsers": {
      const b = blank(text(row.browser, 100));
      return [{ dim: "browser", value: b ? rename(b, BROWSERS) : "Unknown", m: base }];
    }
    case "operating_systems": {
      const o = blank(text(row.operating_system, 100));
      return [{ dim: "os", value: o ? rename(o, SYSTEMS) : "Unknown", m: base }];
    }
  }
}

/** Sums rows by day and dimension value. Rows outside the import's dates are left out. */
export function aggregateRows(site: Site, imp: Pick<ImportRecord, "date_from" | "date_to">, table: ImportTable, rows: ImportRow[]) {
  const cells = new Map<string, Cell>();
  const days = new Map<string, number>();
  let accepted = 0;
  for (const row of rows) {
    const date = text(row.date, 10);
    if (!isImportDate(date) || date < imp.date_from || date > imp.date_to) continue;
    accepted++;
    let ts = days.get(date);
    if (ts === undefined) days.set(date, (ts = dayStart(site, date)));
    for (const { dim, value, meta = "", m } of mapRow(site, table, row)) {
      const key = `${ts}\u0000${dim}\u0000${meta}\u0000${value}`;
      let c = cells.get(key);
      if (!c) cells.set(key, (c = { ts, dim, value, meta, visitors: 0, visits: 0, pageviews: 0, bounces: 0, duration: 0, events: 0 }));
      c.visitors += m.visitors ?? 0;
      c.visits += m.visits ?? 0;
      c.pageviews += m.pageviews ?? 0;
      c.bounces += m.bounces ?? 0;
      c.duration += m.duration ?? 0;
      c.events += m.events ?? 0;
    }
  }
  return { cells: [...cells.values()], accepted };
}

const ROWS_PER_INSERT = 8; // 12 parameters each: D1 allows 100 per statement
const MAX_STATEMENTS = 800; // a Worker invocation may run 1,000 queries

/**
 * Adds one chunk of an export table to an import. `seq` numbers the chunks of an import: a chunk that was already
 * stored (a retried upload) is skipped, so nothing is counted twice. Returns the number of cells written.
 */
export async function addImportChunk(db: Database, site: Site, imp: ImportRecord, seq: number, table: ImportTable, rows: ImportRow[], now = Date.now()) {
  if (!Number.isInteger(seq) || seq < 0) throw new ImportError("Invalid chunk number");
  if (await db.first("SELECT 1 AS x FROM import_chunks WHERE import_id = ? AND seq = ?", [imp.id, seq])) return { cells: 0, duplicate: true };
  const { cells, accepted } = aggregateRows(site, imp, table, rows);
  const statements: Statement[] = [{ sql: "INSERT INTO import_chunks (import_id, seq) VALUES (?, ?)", params: [imp.id, seq] }];
  for (let i = 0; i < cells.length; i += ROWS_PER_INSERT) {
    const part = cells.slice(i, i + ROWS_PER_INSERT);
    const params: SqlValue[] = [];
    for (const c of part) params.push(site.id, imp.id, c.ts, c.dim, c.value, c.meta, c.visitors, c.visits, c.pageviews, c.bounces, c.duration, c.events);
    statements.push({
      sql: `INSERT INTO imported_stats (site_id, import_id, ts, dim, value, meta, visitors, visits, pageviews, bounces, duration, events)
            VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
            ON CONFLICT (import_id, ts, dim, value, meta) DO UPDATE SET
              visitors = imported_stats.visitors + excluded.visitors, visits = imported_stats.visits + excluded.visits,
              pageviews = imported_stats.pageviews + excluded.pageviews, bounces = imported_stats.bounces + excluded.bounces,
              duration = imported_stats.duration + excluded.duration, events = imported_stats.events + excluded.events`,
      params,
    });
  }
  if (statements.length > MAX_STATEMENTS) throw new ImportError("This chunk has too many rows: send fewer at a time");
  statements.push({ sql: "UPDATE imports SET imported_rows = imported_rows + ?, updated_at = ? WHERE id = ?", params: [accepted, now, imp.id] });
  try {
    await db.batch(statements);
  } catch (err) {
    // Two uploads of the same chunk at once: the second one hits the chunk's primary key and changes nothing.
    if (await db.first("SELECT 1 AS x FROM import_chunks WHERE import_id = ? AND seq = ?", [imp.id, seq])) return { cells: 0, duplicate: true };
    throw err;
  }
  return { cells: cells.length, duplicate: false };
}
