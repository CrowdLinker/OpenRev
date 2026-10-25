import { ExternalLink, Maximize2, Target } from "lucide-react";
import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { useApi, useLocalStorage } from "../lib/api";
import { useSite } from "../lib/context";
import { CHANNEL_COLORS, displayValue, UNATTRIBUTED } from "../lib/dims";
import { countryName, duration, money, num, pct } from "../lib/format";
import { addFilter, toSearch, useDashQuery } from "../lib/query";
import type { BreakdownRow } from "../lib/types";
import { cx, DeviceIcon, Empty, Favicon, Flag, Modal, Spinner, Tabs } from "./ui";

const WorldMap = lazy(() => import("./WorldMap").then((m) => ({ default: m.WorldMap })));

export interface PanelTab {
  key: string;
  label: string;
  dim: string;
  map?: boolean;
}

export function RowIcon({ dim, row }: { dim: string; row: BreakdownRow }) {
  if (row.value === UNATTRIBUTED) return <span className="h-4 w-4 shrink-0 rounded-full border border-dashed border-zinc-400" />;
  switch (dim) {
    case "source":
      return row.value === "" || row.value === "Direct" ? <span className="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-400">↗</span> : <Favicon domain={row.meta} />;
    case "referrer":
      return <Favicon domain={row.value || null} />;
    case "channel":
      return <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: CHANNEL_COLORS[row.value] ?? "#a1a1aa" }} />;
    case "country":
      return <Flag country={row.value} />;
    case "region":
    case "city":
      return <Flag country={row.meta} />;
    case "device":
      return <DeviceIcon device={row.value} />;
    case "outbound":
      try {
        return <Favicon domain={new URL(row.value).hostname} />;
      } catch {
        return null;
      }
    case "goal":
      return <Target className="h-4 w-4 shrink-0 text-zinc-400" />;
    default:
      return null;
  }
}

export function rowLabel(dim: string, row: BreakdownRow): string {
  if (dim === "country" && row.value && row.value !== UNATTRIBUTED) return countryName(row.value);
  if (dim === "outbound") return row.value.replace(/^https?:\/\//, "");
  return displayValue(dim, row.value);
}

function RowTooltip({ row, currency, showRevenue, dim }: { row: BreakdownRow; currency: string; showRevenue: boolean; dim: string }) {
  return (
    <div className="card pointer-events-none absolute top-full right-0 z-20 mt-1 hidden w-56 p-3 text-xs shadow-lg group-hover:block">
      <div className="mb-2 truncate font-medium">{rowLabel(dim, row)}</div>
      <div className="space-y-1">
        <Line label="Visitors" value={num(row.visitors, false)} />
        {row.completions !== undefined && <Line label="Completions" value={num(row.completions, false)} />}
        {row.pageviews !== undefined && <Line label="Pageviews" value={num(row.pageviews, false)} />}
        {row.bounce_rate !== undefined && <Line label="Bounce rate" value={pct(row.bounce_rate)} />}
        {row.avg_session_duration !== undefined && <Line label="Session time" value={duration(row.avg_session_duration)} />}
        {showRevenue && (
          <>
            <Line label="Revenue" value={money(row.revenue, currency)} money />
            <Line label="Customers" value={num(row.customers, false)} />
            <Line label={dim === "goal" ? "Conversion rate" : "Conversion rate"} value={pct(row.conversion_rate)} />
            <Line label="Revenue / visitor" value={money(row.revenue_per_visitor, currency, { cents: true })} />
          </>
        )}
      </div>
    </div>
  );
}

function Line({ label, value, money: isMoney }: { label: string; value: string; money?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-zinc-500">{label}</span>
      <span className={cx("font-medium tabular", isMoney && "text-money-600 dark:text-money-400")}>{value}</span>
    </div>
  );
}

export function BreakdownList({
  dim,
  rows,
  currency,
  showRevenue,
  sort,
  onSelect,
  domain,
}: {
  dim: string;
  rows: BreakdownRow[];
  currency: string;
  showRevenue: boolean;
  sort: "visitors" | "revenue";
  onSelect?: (row: BreakdownRow) => void;
  domain?: string;
}) {
  const maxV = Math.max(1, ...rows.map((r) => r.visitors));
  const maxR = Math.max(1, ...rows.map((r) => r.revenue));
  return (
    <div className="space-y-0.5">
      {rows.map((row) => {
        const primary = sort === "revenue" ? row.revenue / maxR : row.visitors / maxV;
        const secondary = sort === "revenue" ? row.visitors / maxV : row.revenue / maxR;
        const clickable = !!onSelect && row.value !== UNATTRIBUTED;
        return (
          <div key={`${row.meta ?? ""}|${row.value}`} className="group relative">
            <button
              onClick={() => clickable && onSelect?.(row)}
              className={cx("relative flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm", clickable ? "cursor-pointer" : "cursor-default")}
            >
              <span
                className={cx("absolute inset-y-0.5 left-0 rounded-md transition-all", sort === "revenue" ? "bg-money-100/80 dark:bg-money-500/15" : "bg-brand-100/70 dark:bg-brand-500/15")}
                style={{ width: `${Math.max(primary * 100, 0.5)}%` }}
              />
              {showRevenue && secondary > 0 && (
                <span className={cx("absolute bottom-0.5 left-0 h-[3px] rounded-full", sort === "revenue" ? "bg-brand-400/70" : "bg-money-400/80")} style={{ width: `${secondary * 100}%` }} />
              )}
              <span className="relative flex min-w-0 flex-1 items-center gap-2">
                <RowIcon dim={dim} row={row} />
                <span className="truncate group-hover:underline">{rowLabel(dim, row)}</span>
                {domain && ["page", "entry_page", "exit_page"].includes(dim) && row.value.startsWith("/") && (
                  <a
                    href={`https://${domain}${row.value}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="hidden shrink-0 text-zinc-400 hover:text-zinc-700 group-hover:inline"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </span>
              <span className="relative w-14 shrink-0 text-right tabular text-zinc-700 dark:text-zinc-300">{num(dim === "goal" ? row.visitors : row.visitors)}</span>
              {showRevenue && <span className="relative w-20 shrink-0 text-right font-medium tabular text-money-600 dark:text-money-400">{row.revenue ? money(row.revenue, currency, { compact: true }) : "–"}</span>}
            </button>
            <RowTooltip row={row} currency={currency} showRevenue={showRevenue} dim={dim} />
          </div>
        );
      })}
    </div>
  );
}

export function BreakdownPanel({ id, title, tabs, extra }: { id: string; title: ReactNode; tabs: PanelTab[]; extra?: ReactNode }) {
  const { statsBase, site, meta } = useSite();
  const [q, setQ] = useDashQuery();
  const [tabKey, setTabKey] = useLocalStorage(`openrev_tab_${id}`, tabs[0].key);
  const [sort, setSort] = useLocalStorage<"visitors" | "revenue">(`openrev_sort_${id}`, "visitors");
  const [details, setDetails] = useState(false);
  const tab = tabs.find((t) => t.key === tabKey) ?? tabs[0];
  const currency = meta?.site.currency ?? site?.currency ?? "USD";
  const showRevenue = !(meta?.site.hideRevenue ?? site?.settings.hideRevenue);
  const path = tab.map
    ? `${statsBase}/breakdown/country?${toSearch(q, { limit: "250" })}`
    : `${statsBase}/breakdown/${tab.dim}?${toSearch(q, { limit: "10", sort })}`;
  const { data, loading } = useApi<{ rows: BreakdownRow[] }>(path);
  const rows = data?.rows ?? [];
  const select = (row: BreakdownRow) => setQ({ filters: addFilter(q.filters, { dim: tab.map ? "country" : tab.dim, op: "is", values: [row.value] }) });

  return (
    <div className="card flex flex-col p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          {loading && <Spinner className="h-3.5 w-3.5" />}
        </div>
        <Tabs tabs={tabs.map((t) => ({ value: t.key, label: t.label }))} value={tab.key} onChange={setTabKey} />
      </div>
      {!tab.map && (
        <div className="mb-1 flex items-center justify-between px-2 text-[11px] font-medium tracking-wide text-zinc-400 uppercase">
          <span>{tab.label}</span>
          <span className="flex gap-3">
            <button onClick={() => setSort("visitors")} className={cx("w-14 text-right", sort === "visitors" && "text-brand-600")}>
              Visitors
            </button>
            {showRevenue && (
              <button onClick={() => setSort("revenue")} className={cx("w-20 text-right", sort === "revenue" && "text-money-600")}>
                Revenue
              </button>
            )}
          </span>
        </div>
      )}
      <div className="flex-1 lg:min-h-[300px]">
        {tab.map ? (
          <Suspense fallback={<div className="h-[260px]" />}>
            <WorldMap data={rows.map((r) => ({ country: r.value, visitors: r.visitors, revenue: r.revenue }))} onSelect={(c) => select({ value: c } as BreakdownRow)} />
          </Suspense>
        ) : rows.length === 0 && !loading ? (
          <Empty title="No data for this period" />
        ) : (
          <BreakdownList dim={tab.dim} rows={rows} currency={currency} showRevenue={showRevenue} sort={sort} onSelect={select} domain={meta?.site.domain} />
        )}
      </div>
      <div className="mt-2 flex items-center justify-between">
        {extra ?? <span />}
        {!tab.map && rows.length >= 10 && (
          <button onClick={() => setDetails(true)} className="flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
            <Maximize2 className="h-3 w-3" /> Details
          </button>
        )}
      </div>
      {details && <DetailsModal tab={tab} onClose={() => setDetails(false)} onSelect={select} />}
    </div>
  );
}

function DetailsModal({ tab, onClose, onSelect }: { tab: PanelTab; onClose: () => void; onSelect: (r: BreakdownRow) => void }) {
  const { statsBase, meta, site } = useSite();
  const [q] = useDashQuery();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<keyof BreakdownRow>("visitors");
  const { data, loading } = useApi<{ rows: BreakdownRow[] }>(`${statsBase}/breakdown/${tab.dim}?${toSearch(q, { limit: "500", sort: "visitors" })}`);
  const currency = meta?.site.currency ?? site?.currency ?? "USD";
  const showRevenue = !(meta?.site.hideRevenue ?? site?.settings.hideRevenue);
  const rows = useMemo(() => {
    const list = (data?.rows ?? []).filter((r) => rowLabel(tab.dim, r).toLowerCase().includes(search.toLowerCase()));
    return [...list].sort((a, b) => Number(b[sort] ?? 0) - Number(a[sort] ?? 0));
  }, [data, search, sort, tab.dim]);
  const sessionDim = !["page", "goal", "outbound"].includes(tab.dim);
  const cols: { key: keyof BreakdownRow; label: string; fmt: (r: BreakdownRow) => string; money?: boolean }[] = [
    { key: "visitors", label: "Visitors", fmt: (r) => num(r.visitors, false) },
    ...(tab.dim === "goal" ? [{ key: "completions" as const, label: "Completions", fmt: (r: BreakdownRow) => num(r.completions ?? 0, false) }] : []),
    ...(tab.dim === "page" ? [{ key: "pageviews" as const, label: "Pageviews", fmt: (r: BreakdownRow) => num(r.pageviews ?? 0, false) }] : []),
    ...(sessionDim
      ? [
          { key: "bounce_rate" as const, label: "Bounce", fmt: (r: BreakdownRow) => pct(r.bounce_rate ?? 0) },
          { key: "avg_session_duration" as const, label: "Time", fmt: (r: BreakdownRow) => duration(r.avg_session_duration ?? 0) },
        ]
      : []),
    ...(showRevenue
      ? [
          { key: "revenue" as const, label: "Revenue", fmt: (r: BreakdownRow) => money(r.revenue, currency), money: true },
          { key: "customers" as const, label: "Customers", fmt: (r: BreakdownRow) => num(r.customers, false) },
          { key: "conversion_rate" as const, label: "Conv.", fmt: (r: BreakdownRow) => pct(r.conversion_rate) },
          { key: "revenue_per_visitor" as const, label: "RPV", fmt: (r: BreakdownRow) => money(r.revenue_per_visitor, currency, { cents: true }) },
        ]
      : []),
  ];
  return (
    <Modal open onClose={onClose} title={tab.label} wide>
      <input className="input mb-3" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <div className="scrollbar-thin max-h-[60vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white text-xs text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="py-2 text-left font-medium">{tab.label}</th>
                {cols.map((c) => (
                  <th key={c.key} className="cursor-pointer py-2 pl-3 text-right font-medium whitespace-nowrap hover:text-zinc-900" onClick={() => setSort(c.key)}>
                    {c.label}
                    {sort === c.key ? " ↓" : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.meta}|${r.value}`}
                  className="cursor-pointer border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50"
                  onClick={() => {
                    if (r.value === UNATTRIBUTED) return;
                    onSelect(r);
                    onClose();
                  }}
                >
                  <td className="max-w-[320px] py-2">
                    <span className="flex items-center gap-2">
                      <RowIcon dim={tab.dim} row={r} />
                      <span className="truncate">{rowLabel(tab.dim, r)}</span>
                    </span>
                  </td>
                  {cols.map((c) => (
                    <td key={c.key} className={cx("py-2 pl-3 text-right tabular whitespace-nowrap", c.money && "text-money-600 dark:text-money-400")}>
                      {c.fmt(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <Empty title="No results" />}
        </div>
      )}
    </Modal>
  );
}
