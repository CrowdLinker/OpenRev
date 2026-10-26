export interface User {
  id: string;
  email: string;
  name: string | null;
  is_admin: number;
}

export interface Instance {
  version: string;
  platform: string;
  hasUsers: boolean;
  signupEnabled: boolean;
  emailEnabled: boolean;
}

export type AttributionModel = "last_non_direct" | "last_touch" | "first_touch";

export interface SiteSettings {
  allowedHostnames?: string[];
  excludedIps?: string[];
  excludedPaths?: string[];
  excludedCountries?: string[];
  excludedHostnames?: string[];
  cookieless?: boolean;
  allowLocalhost?: boolean;
  strictHostnames?: boolean;
  kpiGoal?: string | null;
  attribution?: AttributionModel;
  hideRevenue?: boolean;
}

export interface Site {
  id: string;
  domain: string;
  name: string;
  timezone: string;
  currency: string;
  settings: SiteSettings;
  share_token: string | null;
  created_at: number;
}

export type Role = "owner" | "admin" | "viewer";

export interface SiteSummary {
  id: string;
  name: string;
  domain: string;
  currency: string;
  timezone: string;
  role: Role;
  hideRevenue: boolean;
  visitors: number;
  revenue: number;
  online: number;
  series: { date: string; visitors: number; revenue: number }[];
}

export interface RangeInfo {
  period: string;
  from: number;
  to: number;
  fromDate: string;
  toDate: string;
  interval: "hour" | "day" | "week" | "month";
  timezone: string;
}

export interface Metrics {
  visitors: number;
  new_visitors: number;
  returning_visitors: number;
  sessions: number;
  pageviews: number;
  bounce_rate: number;
  avg_session_duration: number;
  revenue: number;
  refunds: number;
  new_revenue: number;
  renewal_revenue: number;
  payments: number;
  customers: number;
  conversion_rate: number;
  revenue_per_visitor: number;
  kpi?: { goal: string; conversions: number; visitors: number; conversion_rate: number } | null;
}

export interface Overview {
  range: RangeInfo;
  currency: string;
  current: Metrics;
  previous: Metrics | null;
}

export interface Point {
  date: string;
  start: number;
  visitors: number;
  sessions: number;
  pageviews: number;
  bounce_rate: number;
  avg_session_duration: number;
  revenue: number;
  payments: number;
  customers: number;
  conversions?: number;
}

export interface Timeseries {
  range: RangeInfo;
  currency: string;
  interval: RangeInfo["interval"];
  points: Point[];
}

export interface BreakdownRow {
  value: string;
  meta?: string | null;
  visitors: number;
  sessions?: number;
  pageviews?: number;
  bounce_rate?: number;
  avg_session_duration?: number;
  completions?: number;
  revenue: number;
  payments: number;
  customers: number;
  conversion_rate: number;
  revenue_per_visitor: number;
}

export interface Filter {
  dim: string;
  op: "is" | "is_not" | "contains" | "not_contains";
  values: string[];
}

export interface FunnelStep {
  type: "page" | "goal" | "payment";
  value?: string;
  match?: "equals" | "contains" | "starts_with";
  label?: string;
}

export interface Funnel {
  id: string;
  name: string;
  steps: FunnelStep[];
}

export interface FunnelResult {
  step: FunnelStep;
  visitors: number;
  revenue: number;
  conversion_rate: number;
  step_conversion_rate: number;
  dropoff: number;
}

export interface SiteMeta {
  site: {
    id: string;
    name: string;
    domain: string;
    timezone: string;
    currency: string;
    kpiGoal: string | null;
    hideRevenue: boolean;
    attribution: AttributionModel;
    created_at: number;
  };
  funnels: Funnel[];
  goals: string[];
  /** Completed history imports (Plausible, Google Analytics). */
  imports?: { source: "plausible" | "ga4"; date_from: string; date_to: string }[];
  /** Google Search Console is connected. */
  searchConsole?: boolean;
  /** The website's server has reported crawler requests. */
  crawlers?: boolean;
  /** Posts on X or Hacker News were found. */
  social?: boolean;
}

export interface Note {
  id: string;
  ts: number;
  text: string;
  url: string | null;
}

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
