import type { Database } from "../db/types";
import { accessToken, GoogleError, googleJson, parseServiceAccountKey, type ServiceAccountKey } from "../lib/google";
import { addImportChunk, finishImport, ImportError, type ImportRecord, type ImportRow, type ImportTable } from "./imports";
import type { Site } from "./sites";

/**
 * Google Analytics 4 history, read with the Data API (runReport) and a service account that is a Viewer on the
 * property. Each report is one export table; the dashboard calls `ga4Step` until it's done, one page of rows per call.
 */

export const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const API = "https://analyticsdata.googleapis.com/v1beta";
const PAGE = 5000;

export interface Ga4Config {
  propertyId: string;
  key: ServiceAccountKey;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const SESSION_METRICS = ["totalUsers", "sessions", "screenPageViews", "engagedSessions", "averageSessionDuration"];

/** visitors, visits, pageviews, bounces and visit_duration from SESSION_METRICS. */
function sessionMetrics(m: number[]): ImportRow {
  const [users, sessions, views, engaged, avgDuration] = m;
  return { visitors: users, visits: sessions, pageviews: views, bounces: Math.max(0, sessions - engaged), visit_duration: Math.round(avgDuration * sessions) };
}

const isSet = (v: string) => !!v && !/^\(.*\)$/.test(v);

/** Events GA4 records on its own: not goals. */
const AUTOMATIC_EVENTS = new Set(["page_view", "session_start", "first_visit", "user_engagement", "scroll", "click", "first_open", "screen_view"]);

interface Report {
  table: ImportTable;
  label: string;
  dimensions: string[];
  metrics: string[];
  row(d: string[], m: number[]): ImportRow | null;
}

export const GA4_REPORTS: Report[] = [
  { table: "visitors", label: "Visitors", dimensions: [], metrics: SESSION_METRICS, row: (_d, m) => sessionMetrics(m) },
  {
    table: "sources",
    label: "Sources",
    dimensions: ["sessionSource", "sessionMedium", "sessionCampaignName"],
    metrics: SESSION_METRICS,
    row: ([source, medium, campaign], m) => {
      if (source === "(direct)") return { ...sessionMetrics(m), source: "" };
      const tagged = isSet(campaign);
      return {
        ...sessionMetrics(m),
        source,
        medium,
        referrer: medium === "referral" ? source : "",
        utm_source: tagged ? source : "",
        utm_medium: tagged ? medium : "",
        utm_campaign: tagged ? campaign : "",
      };
    },
  },
  {
    table: "pages",
    label: "Pages",
    dimensions: ["pagePath"],
    metrics: ["totalUsers", "sessions", "screenPageViews"],
    row: ([page], [users, sessions, views]) => (isSet(page) ? { page, visitors: users, visits: sessions, pageviews: views } : null),
  },
  {
    table: "entry_pages",
    label: "Entry pages",
    dimensions: ["landingPage"],
    metrics: SESSION_METRICS,
    row: ([page], m) => (isSet(page) ? { ...sessionMetrics(m), entry_page: page, entrances: m[1] } : null),
  },
  {
    table: "locations",
    label: "Locations",
    dimensions: ["countryId", "region", "city"],
    metrics: SESSION_METRICS,
    row: ([country, region, city], m) => ({ ...sessionMetrics(m), country, region, city }),
  },
  { table: "devices", label: "Devices", dimensions: ["deviceCategory"], metrics: SESSION_METRICS, row: ([device], m) => ({ ...sessionMetrics(m), device }) },
  { table: "browsers", label: "Browsers", dimensions: ["browser"], metrics: SESSION_METRICS, row: ([browser], m) => ({ ...sessionMetrics(m), browser }) },
  {
    table: "operating_systems",
    label: "Operating systems",
    dimensions: ["operatingSystem"],
    metrics: SESSION_METRICS,
    row: ([operating_system], m) => ({ ...sessionMetrics(m), operating_system }),
  },
  {
    table: "custom_events",
    label: "Goals",
    dimensions: ["eventName"],
    metrics: ["totalUsers", "eventCount"],
    row: ([name], [users, count]) => (AUTOMATIC_EVENTS.has(name) ? null : { name, visitors: users, events: count }),
  },
];

/** "123456789", "properties/123456789" → "123456789". A G- measurement id is a common mix-up. */
export function parsePropertyId(input: unknown): string {
  const v = String(input ?? "").trim().replace(/^properties\//, "");
  if (/^G-/i.test(v)) throw new ImportError("That's a measurement ID. Use the property ID: Admin → Property settings → Property details, a number like 123456789.");
  if (!/^\d{4,15}$/.test(v)) throw new ImportError("Enter the GA4 property ID: a number like 123456789, from Admin → Property settings → Property details.");
  return v;
}

interface RunReportResponse {
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  rowCount?: number;
}

async function runReport(cfg: Ga4Config, report: Report, from: string, to: string, offset: number, limit: number, fetchFn: FetchFn) {
  const token = await accessToken(cfg.key, GA4_SCOPE, fetchFn);
  try {
    return await googleJson<RunReportResponse>(
      `${API}/properties/${cfg.propertyId}:runReport`,
      token,
      {
        dateRanges: [{ startDate: from, endDate: to }],
        dimensions: [{ name: "date" }, ...report.dimensions.map((name) => ({ name }))],
        metrics: report.metrics.map((name) => ({ name })),
        limit,
        offset,
      },
      fetchFn,
    );
  } catch (err) {
    if (err instanceof GoogleError && err.status === 403 && !/isn't enabled/.test(err.message)) {
      throw new ImportError(
        `The service account can't read property ${cfg.propertyId}. In Google Analytics, open Admin → Property access management and add ${cfg.key.client_email} as a Viewer.`,
      );
    }
    throw err;
  }
}

/** Checks the key and property with a one-row report, before an import is created. */
export async function checkGa4Access(input: { propertyId: unknown; key: unknown }, from: string, to: string, fetchFn: FetchFn = fetch): Promise<Ga4Config> {
  const cfg: Ga4Config = { propertyId: parsePropertyId(input.propertyId), key: parseServiceAccountKey(input.key) };
  const res = await runReport(cfg, GA4_REPORTS[0], from, to, 0, 1, fetchFn);
  if (!res.rowCount) throw new ImportError(`Property ${cfg.propertyId} has no data between ${from} and ${to}.`);
  return cfg;
}

export interface Ga4Cursor {
  /** Index in GA4_REPORTS. */
  r: number;
  /** Row offset in that report. */
  o: number;
}

/** Imports the next page of rows and returns where to continue, or null when the import is complete. */
export async function ga4Step(db: Database, site: Site, imp: ImportRecord, cfg: Ga4Config, fetchFn: FetchFn = fetch, now = Date.now()) {
  const cursor: Ga4Cursor = imp.cursor ? JSON.parse(imp.cursor) : { r: 0, o: 0 };
  const report = GA4_REPORTS[cursor.r];
  if (!report) {
    await finishImport(db, imp, null, now);
    return null;
  }
  const res = await runReport(cfg, report, imp.date_from, imp.date_to, cursor.o, PAGE, fetchFn);
  const rows: ImportRow[] = [];
  for (const r of res.rows ?? []) {
    const d = (r.dimensionValues ?? []).map((x) => x.value ?? "");
    const m = (r.metricValues ?? []).map((x) => Number(x.value) || 0);
    const yyyymmdd = d[0];
    const row = report.row(d.slice(1), m);
    if (row && /^\d{8}$/.test(yyyymmdd)) rows.push({ ...row, date: `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` });
  }
  // Pages of a report are numbered so a step that runs twice (two open tabs) stores its rows once.
  await addImportChunk(db, site, imp, cursor.r * 100_000 + cursor.o / PAGE, report.table, rows, now);
  const fetched = res.rows?.length ?? 0;
  const next: Ga4Cursor = fetched === PAGE && cursor.o + PAGE < (res.rowCount ?? 0) ? { r: cursor.r, o: cursor.o + PAGE } : { r: cursor.r + 1, o: 0 };
  if (next.r >= GA4_REPORTS.length) {
    await finishImport(db, imp, null, now);
    return null;
  }
  await db.run("UPDATE imports SET cursor = ?, updated_at = ? WHERE id = ?", [JSON.stringify(next), now, imp.id]);
  return { next, report: GA4_REPORTS[next.r].label, reportIndex: next.r, reports: GA4_REPORTS.length };
}
