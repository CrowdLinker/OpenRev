import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import type { Filter } from "./types";

export interface DashQuery {
  period: string;
  from?: string;
  to?: string;
  interval?: string;
  filters: Filter[];
}

export function parseQuery(search: string): DashQuery {
  const p = new URLSearchParams(search);
  let filters: Filter[] = [];
  try {
    const raw = p.get("filters");
    if (raw) filters = JSON.parse(raw);
  } catch {
    filters = [];
  }
  return {
    period: p.get("period") || (p.get("from") && p.get("to") ? "custom" : "30d"),
    from: p.get("from") || undefined,
    to: p.get("to") || undefined,
    interval: p.get("interval") || undefined,
    filters: Array.isArray(filters) ? filters.filter(isFilter) : [],
  };
}

// Filters come from shareable URLs: keep only well-formed entries so a bad link can't crash the page.
function isFilter(f: unknown): f is Filter {
  const x = f as Filter;
  return (
    !!x &&
    typeof x.dim === "string" &&
    ["is", "is_not", "contains", "not_contains"].includes(x.op) &&
    Array.isArray(x.values) &&
    x.values.every((v) => typeof v === "string")
  );
}

export function toSearch(q: DashQuery, extra: Record<string, string | undefined> = {}): string {
  const p = new URLSearchParams();
  if (q.period === "custom" && q.from && q.to) {
    p.set("from", q.from);
    p.set("to", q.to);
  } else {
    p.set("period", q.period);
  }
  if (q.interval) p.set("interval", q.interval);
  if (q.filters.length) p.set("filters", JSON.stringify(q.filters));
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== "") p.set(k, v);
  return p.toString();
}

/** Dashboard date range + filters, stored in the URL so views are shareable. */
export function useDashQuery(): [DashQuery, (patch: Partial<DashQuery>) => void] {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const q = useMemo(() => parseQuery(search), [search]);
  const update = useCallback(
    (patch: Partial<DashQuery>) => {
      const next = { ...q, ...patch };
      if (patch.period && patch.period !== "custom") {
        next.from = undefined;
        next.to = undefined;
      }
      if (patch.period || patch.from) next.interval = patch.interval;
      navigate(`${location}?${toSearch(next)}`, { replace: true });
    },
    [q, location, navigate],
  );
  return [q, update];
}

export function addFilter(filters: Filter[], f: Filter): Filter[] {
  const others = filters.filter((x) => x.dim !== f.dim);
  return [...others, f];
}

export const PERIODS: { value: string; label: string; short: string }[] = [
  { value: "today", label: "Today", short: "Today" },
  { value: "yesterday", label: "Yesterday", short: "Yesterday" },
  { value: "24h", label: "Last 24 hours", short: "24h" },
  { value: "7d", label: "Last 7 days", short: "7D" },
  { value: "30d", label: "Last 30 days", short: "30D" },
  { value: "90d", label: "Last 90 days", short: "90D" },
  { value: "wtd", label: "Week to date", short: "WTD" },
  { value: "mtd", label: "Month to date", short: "MTD" },
  { value: "ytd", label: "Year to date", short: "YTD" },
  { value: "12m", label: "Last 12 months", short: "12M" },
  { value: "all", label: "All time", short: "All" },
];
