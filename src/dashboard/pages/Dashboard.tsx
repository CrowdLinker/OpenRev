import { History, StickyNote, Star, Target } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { BreakdownList, BreakdownPanel } from "../components/Breakdown";
import { formatMetric, MainChart, METRIC_LABELS, type ChartMetric } from "../components/Chart";
import { SearchKeywords } from "../components/SearchConsole";
import { FilterBar, PeriodPicker } from "../components/Filters";
import { Button, Card, cx, Delta, Empty, ErrorBox, Field, Modal, Spinner, Tabs } from "../components/ui";
import { api, useApi, useLocalStorage } from "../lib/api";
import { canEdit, useSite } from "../lib/context";
import { change, money, num, pct } from "../lib/format";
import { addFilter, toSearch, useDashQuery } from "../lib/query";
import type { BreakdownRow, FunnelResult, Metrics, Note, Overview, Timeseries } from "../lib/types";

function Kpi({
  label,
  value,
  delta,
  invert,
  active,
  onClick,
  tone = "default",
  hint,
}: {
  label: ReactNode;
  value: string;
  delta?: number | null;
  invert?: boolean;
  active?: boolean;
  onClick?: () => void;
  tone?: "default" | "money" | "live";
  hint?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={hint}
      className={cx(
        "relative flex min-w-0 flex-col items-start rounded-xl px-4 py-3 text-left transition",
        onClick ? "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50" : "cursor-default",
        active && "bg-zinc-50 ring-1 ring-zinc-200 dark:bg-zinc-800/60 dark:ring-zinc-700",
      )}
    >
      <span className="flex items-center gap-1.5 truncate text-xs font-medium text-zinc-500">{label}</span>
      <span
        className={cx(
          "mt-1 text-xl font-semibold tracking-tight tabular sm:text-2xl",
          tone === "money" && "text-money-600 dark:text-money-400",
          tone === "live" && "text-zinc-900 dark:text-white",
        )}
      >
        {value}
      </span>
      <span className="h-4">{delta !== undefined && <Delta value={delta ?? null} invert={invert} />}</span>
      {active && <span className="absolute inset-x-4 -bottom-px h-0.5 rounded-full bg-brand-500" />}
    </button>
  );
}

export function KpiRow({ overview, metric, setMetric, online, showRevenue, revenueBars, toggleRevenue, realtimeHref }: {
  overview?: Overview;
  metric: ChartMetric;
  setMetric: (m: ChartMetric) => void;
  online?: number;
  showRevenue: boolean;
  revenueBars: boolean;
  toggleRevenue: () => void;
  realtimeHref?: string;
}) {
  const c = overview?.current;
  const p = overview?.previous;
  const cur = overview?.currency ?? "USD";
  const d = (k: keyof Metrics) => (c && p ? change(Number(c[k]), Number(p[k])) : null);
  if (!c) return <div className="h-[88px]" />;
  return (
    <div className="grid grid-cols-2 gap-1 sm:grid-cols-4 lg:grid-cols-7">
      <Kpi label="Visitors" value={num(c.visitors)} delta={d("visitors")} active={metric === "visitors"} onClick={() => setMetric("visitors")} />
      {showRevenue ? (
        <>
          <Kpi
            label={
              <>
                <span className={cx("h-2 w-2 rounded-sm", revenueBars ? "bg-money-500" : "bg-zinc-300")} /> Revenue
              </>
            }
            value={money(c.revenue, cur, { compact: true })}
            delta={d("revenue")}
            tone="money"
            onClick={toggleRevenue}
            hint="Toggle revenue bars"
          />
          <Kpi label="Conversion rate" value={pct(c.conversion_rate, 2)} delta={d("conversion_rate")} active={metric === "conversion_rate"} onClick={() => setMetric("conversion_rate")} hint="Visitors who made a first purchase ÷ visitors" />
          <Kpi label="Revenue/visitor" value={money(c.revenue_per_visitor, cur, { cents: true })} delta={d("revenue_per_visitor")} active={metric === "revenue_per_visitor"} onClick={() => setMetric("revenue_per_visitor")} />
        </>
      ) : (
        <Kpi label="Pageviews" value={num(c.pageviews)} delta={d("pageviews")} active={metric === "pageviews"} onClick={() => setMetric("pageviews")} />
      )}
      {c.kpi ? (
        <Kpi
          label={
            <>
              <Star className="h-3 w-3 text-amber-500" /> {c.kpi.goal}
            </>
          }
          value={pct(c.kpi.conversion_rate, 2)}
          delta={p?.kpi ? change(c.kpi.conversion_rate, p.kpi.conversion_rate) : null}
          active={metric === "conversions"}
          onClick={() => setMetric("conversions")}
          hint={`${num(c.kpi.visitors, false)} visitors completed ${c.kpi.goal}`}
        />
      ) : (
        <Kpi label="Bounce rate" value={pct(c.bounce_rate, 0)} delta={d("bounce_rate")} invert active={metric === "bounce_rate"} onClick={() => setMetric("bounce_rate")} />
      )}
      <Kpi label="Session time" value={formatMetric("avg_session_duration", c.avg_session_duration, cur)} delta={d("avg_session_duration")} active={metric === "avg_session_duration"} onClick={() => setMetric("avg_session_duration")} />
      {realtimeHref ? (
        <Link href={realtimeHref} className="flex min-w-0 flex-col items-start rounded-xl px-4 py-3 transition hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
          <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
            <span className="live-dot relative h-2 w-2 rounded-full bg-money-500 text-money-500" /> Online now
          </span>
          <span className="mt-1 text-xl font-semibold tabular sm:text-2xl">{num(online ?? 0)}</span>
          <span className="h-4 text-xs text-zinc-400">View live →</span>
        </Link>
      ) : null}
    </div>
  );
}

function GoalsPanel() {
  const { statsBase, meta, role, isPublic, site, reloadSite, reloadMeta, canSeeRevenue: showRevenue } = useSite();
  const [q, setQ] = useDashQuery();
  const [selected, setSelected] = useState<BreakdownRow | null>(null);
  const { data, loading } = useApi<{ rows: BreakdownRow[] }>(`${statsBase}/breakdown/goal?${toSearch(q, { limit: "20", sort: "visitors" })}`);
  const currency = meta?.site.currency ?? "USD";
  const rows = data?.rows ?? [];
  return (
    <div className="card flex flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          Goals {loading && <Spinner className="h-3.5 w-3.5" />}
        </h3>
        <a className="text-xs text-zinc-400 hover:text-zinc-700 hover:underline" href="https://github.com/CrowdLinker/OpenRev/blob/main/docs/tracking/goals.md" target="_blank" rel="noreferrer">
          How to track goals
        </a>
      </div>
      {rows.length === 0 && !loading ? (
        <Empty title="No goals yet" icon={<Target className="h-6 w-6" />}>
          Track signups or clicks with <code className="code">openrev("signup")</code> or <code className="code">data-openrev-goal="signup"</code>.
        </Empty>
      ) : (
        <>
          <div className="mb-1 flex items-center justify-between px-2 text-[11px] font-medium tracking-wide text-zinc-400 uppercase">
            <span>Goal</span>
            <span className="flex gap-3">
              <span className="w-14 text-right">Visitors</span>
              {showRevenue && <span className="w-20 text-right">Revenue</span>}
            </span>
          </div>
          <BreakdownList dim="goal" rows={rows} currency={currency} showRevenue={showRevenue} sort="visitors" onSelect={setSelected} />
        </>
      )}
      {selected && (
        <GoalModal
          goal={selected}
          isKpi={meta?.site.kpiGoal === selected.value}
          canEdit={!isPublic && canEdit(role)}
          onFilter={() => {
            setQ({ filters: addFilter(q.filters, { dim: "goal", op: "is", values: [selected.value] }) });
            setSelected(null);
          }}
          onSetKpi={async () => {
            await api(`/api/sites/${site!.id}`, { method: "PATCH", body: { settings: { kpiGoal: meta?.site.kpiGoal === selected.value ? null : selected.value } } });
            reloadSite();
            reloadMeta();
            setSelected(null);
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function GoalModal({ goal, onClose, onFilter, onSetKpi, isKpi, canEdit: editable }: { goal: BreakdownRow; onClose: () => void; onFilter: () => void; onSetKpi: () => void; isKpi: boolean; canEdit: boolean }) {
  const { statsBase, meta, canSeeRevenue } = useSite();
  const [q] = useDashQuery();
  const { data, loading } = useApi<{ properties: { key: string; values: { value: string; visitors: number; completions: number }[] }[] }>(
    `${statsBase}/goals/${encodeURIComponent(goal.value)}/properties?${toSearch(q)}`,
  );
  const currency = meta?.site.currency ?? "USD";
  return (
    <Modal open onClose={onClose} title={<span className="flex items-center gap-2"><Target className="h-4 w-4" /> {goal.value}</span>}>
      <div className="mb-4 grid grid-cols-3 gap-3 text-center">
        <Stat label="Visitors" value={num(goal.visitors, false)} />
        <Stat label="Completions" value={num(goal.completions ?? 0, false)} />
        <Stat label="Conversion" value={pct(goal.conversion_rate, 2)} />
        {canSeeRevenue && <Stat label="Revenue" value={money(goal.revenue, currency)} />}
        {canSeeRevenue && <Stat label="Customers" value={num(goal.customers, false)} />}
      </div>
      <h4 className="mb-2 text-sm font-semibold">Custom properties</h4>
      {loading ? (
        <Spinner />
      ) : !data?.properties.length ? (
        <p className="text-sm text-zinc-500">No properties were sent with this goal.</p>
      ) : (
        <div className="space-y-4">
          {data.properties.map((p) => (
            <div key={p.key}>
              <div className="mb-1 font-mono text-xs text-zinc-500">{p.key}</div>
              {p.values.slice(0, 10).map((v) => (
                <div key={v.value} className="flex justify-between border-b border-zinc-100 py-1 text-sm dark:border-zinc-800">
                  <span className="truncate">{v.value}</span>
                  <span className="tabular text-zinc-500">{num(v.visitors, false)} visitors</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {editable && (
          <Button onClick={onSetKpi}>
            <Star className="h-4 w-4" /> {isKpi ? "Remove as #1 KPI" : "Set as #1 KPI"}
          </Button>
        )}
        <Button variant="primary" onClick={onFilter}>
          Filter dashboard
        </Button>
      </div>
    </Modal>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-zinc-50 p-2 dark:bg-zinc-800/50">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="font-semibold tabular">{value}</div>
    </div>
  );
}

export function FunnelBars({ results, currency, showRevenue }: { results: FunnelResult[]; currency: string; showRevenue: boolean }) {
  const max = Math.max(1, results[0]?.visitors ?? 1);
  return (
    <div className="space-y-2.5">
      {results.map((r, i) => (
        <div key={i}>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate">
              <span className="mr-1.5 text-xs text-zinc-400">{i + 1}.</span>
              {r.step.label || (r.step.type === "payment" ? "Payment" : `${r.step.type === "page" ? "Visited" : "Goal"} ${r.step.value}`)}
            </span>
            <span className="shrink-0 text-xs text-zinc-500 tabular">
              {num(r.visitors, false)} · {pct(r.conversion_rate)}
              {showRevenue && r.revenue > 0 && <span className="ml-1 text-money-600"> · {money(r.revenue, currency, { compact: true })}</span>}
            </span>
          </div>
          <div className="h-6 overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800">
            <div className="h-full rounded-md bg-gradient-to-r from-brand-500 to-brand-400" style={{ width: `${(r.visitors / max) * 100}%` }} />
          </div>
          {i > 0 && r.dropoff > 0 && <div className="mt-0.5 text-[11px] text-red-500">−{num(r.dropoff, false)} dropped ({pct(1 - r.step_conversion_rate)})</div>}
        </div>
      ))}
    </div>
  );
}

/** Without revenue the server stops a funnel before its first payment step: say so under the bars. */
export function PaymentStepsHidden({ steps }: { steps: { type: string }[] }) {
  const { canSeeRevenue } = useSite();
  if (canSeeRevenue || !steps.some((s) => s.type === "payment")) return null;
  return <p className="mt-2 text-xs text-zinc-500">Steps from the payment on aren't shown: revenue is hidden.</p>;
}

function FunnelPanel() {
  const { statsBase, meta, isPublic, canSeeRevenue } = useSite();
  const [q] = useDashQuery();
  const funnels = meta?.funnels ?? [];
  const [funnelId, setFunnelId] = useLocalStorage<string | null>(`openrev_funnel_${meta?.site.id}`, null);
  const current = funnels.find((f) => f.id === funnelId) ?? funnels[0];
  const { data, loading } = useApi<{ results: FunnelResult[] }>(current ? `${statsBase}/funnels/${current.id}?${toSearch(q)}` : null);
  return (
    <div className="card flex flex-col p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">Funnel {loading && <Spinner className="h-3.5 w-3.5" />}</h3>
        {funnels.length > 0 && (
          <select className="input !w-auto !py-1 text-xs" value={current?.id} onChange={(e) => setFunnelId(e.target.value)}>
            {funnels.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {!current ? (
        <Empty title="No funnels yet">
          {isPublic ? null : (
            <Link href="/funnels" className="font-medium text-brand-600 hover:underline">
              Create a funnel
            </Link>
          )}{" "}
          to see where visitors drop off between landing and paying.
        </Empty>
      ) : data ? (
        <>
          <FunnelBars results={data.results} currency={meta?.site.currency ?? "USD"} showRevenue={canSeeRevenue} />
          <PaymentStepsHidden steps={current.steps} />
        </>
      ) : null}
    </div>
  );
}

function NoteModal({ open, onClose, siteId, onSaved }: { open: boolean; onClose: () => void; siteId: string; onSaved: () => void }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [text, setText] = useState("");
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal open={open} onClose={onClose} title="Add a note to the chart">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api(`/api/sites/${siteId}/notes`, { body: { date, text } });
            setText("");
            onSaved();
            onClose();
          } catch (err) {
            setError(err);
          }
        }}
      >
        <Field label="Date">
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label="Note" help="e.g. “Launched on Product Hunt” or “Started Google Ads”.">
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} required autoFocus />
        </Field>
        <ErrorBox error={error} />
        <div className="flex justify-end">
          <Button variant="primary" type="submit">
            Save note
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const IMPORT_SOURCES = { plausible: "Plausible", ga4: "Google Analytics" };

/** Says when the numbers include imported history, or that filters leave it out. */
function ImportedNote({ range, filtered }: { range?: { fromDate: string; toDate: string }; filtered: boolean }) {
  const { meta } = useSite();
  const overlapping = range ? (meta?.imports ?? []).filter((i) => i.date_from <= range.toDate && range.fromDate <= i.date_to) : [];
  if (!overlapping.length) return null;
  const sources = [...new Set(overlapping.map((i) => IMPORT_SOURCES[i.source]))].join(" and ");
  const until = overlapping.map((i) => i.date_to).sort().at(-1);
  return (
    <p className="mt-1 flex items-center gap-1.5 px-2 pb-1 text-xs text-zinc-500">
      <History className="h-3.5 w-3.5 shrink-0" />
      {filtered
        ? `History imported from ${sources} isn't included while filters are on.`
        : `Includes history imported from ${sources}, up to ${until}. Imported days count visitors per day, so a visitor seen on several days counts more than once.`}
    </p>
  );
}

export function DashboardPage() {
  const { statsBase, meta, site, role, isPublic, canSeeRevenue: showRevenue } = useSite();
  const [q] = useDashQuery();
  const [metric, setMetric] = useLocalStorage<ChartMetric>("openrev_metric", "visitors");
  const [revenueBars, setRevenueBars] = useLocalStorage("openrev_revenue_bars", true);
  const [noteOpen, setNoteOpen] = useState(false);
  const search = toSearch(q);
  const overview = useApi<Overview>(`${statsBase}/overview?${search}`);
  const series = useApi<Timeseries>(`${statsBase}/timeseries?${search}`);
  const notes = useApi<{ notes: Note[] }>(`${statsBase}/notes?${search}`);
  const realtime = useApi<{ visitors: number }>(`${statsBase}/live`, { poll: 15000 });
  const currency = overview.data?.currency ?? meta?.site.currency ?? "USD";
  const effectiveMetric = !showRevenue && (metric === "conversion_rate" || metric === "revenue_per_visitor") ? "visitors" : metric === "conversions" && !overview.data?.current.kpi ? "visitors" : metric;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar />
        <div className="flex items-center gap-2">
          {!isPublic && canEdit(role) && (
            <Button size="sm" variant="ghost" onClick={() => setNoteOpen(true)} title="Add a note to the chart">
              <StickyNote className="h-4 w-4" /> Note
            </Button>
          )}
          <PeriodPicker range={overview.data?.range} storageKey={meta?.site.id ?? "site"} />
        </div>
      </div>

      <Card className="p-2 sm:p-3">
        <KpiRow
          overview={overview.data}
          metric={effectiveMetric}
          setMetric={setMetric}
          online={realtime.data?.visitors}
          showRevenue={showRevenue}
          revenueBars={revenueBars}
          toggleRevenue={() => setRevenueBars(!revenueBars)}
          realtimeHref="/realtime"
        />
        <div className="mt-2 border-t border-zinc-100 px-1 pt-3 dark:border-zinc-800">
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-xs text-zinc-500">{METRIC_LABELS[effectiveMetric]}{showRevenue && revenueBars ? " & revenue" : ""}</span>
            <IntervalPicker current={series.data?.interval} />
          </div>
          {series.error ? (
            <ErrorBox error={series.error} />
          ) : series.data ? (
            <MainChart
              points={series.data.points}
              interval={series.data.interval}
              currency={currency}
              metric={effectiveMetric}
              showRevenue={showRevenue && revenueBars}
              notes={notes.data?.notes}
            />
          ) : (
            <div className="flex h-[300px] items-center justify-center">
              <Spinner />
            </div>
          )}
          <ImportedNote range={overview.data?.range} filtered={q.filters.length > 0} />
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BreakdownPanel
          id="sources"
          title="Sources"
          tabs={[
            { key: "channel", label: "Channel", dim: "channel" },
            { key: "source", label: "Referrer", dim: "source" },
            { key: "campaign", label: "Campaign", dim: "utm_campaign" },
            { key: "utm_source", label: "UTM source", dim: "utm_source" },
            { key: "utm_medium", label: "Medium", dim: "utm_medium" },
            { key: "ref", label: "Ref", dim: "ref" },
          ]}
        />
        <BreakdownPanel
          id="pages"
          title="Pages"
          tabs={[
            { key: "page", label: "Page", dim: "page" },
            { key: "entry", label: "Entry", dim: "entry_page" },
            { key: "exit", label: "Exit", dim: "exit_page" },
            { key: "outbound", label: "Exit links", dim: "outbound" },
            { key: "hostname", label: "Hostname", dim: "hostname" },
          ]}
        />
        <SearchKeywords showRevenue={showRevenue} />
        <BreakdownPanel
          id="locations"
          title="Locations"
          tabs={[
            { key: "map", label: "Map", dim: "country", map: true },
            { key: "country", label: "Country", dim: "country" },
            { key: "region", label: "Region", dim: "region" },
            { key: "city", label: "City", dim: "city" },
          ]}
        />
        <BreakdownPanel
          id="devices"
          title="Devices"
          tabs={[
            { key: "device", label: "Device", dim: "device" },
            { key: "browser", label: "Browser", dim: "browser" },
            { key: "os", label: "OS", dim: "os" },
          ]}
        />
        <GoalsPanel />
        <FunnelPanel />
      </div>
      {site && <NoteModal open={noteOpen} onClose={() => setNoteOpen(false)} siteId={site.id} onSaved={notes.reload} />}
    </div>
  );
}

function IntervalPicker({ current }: { current?: string }) {
  const [q, setQ] = useDashQuery();
  const options = [
    { value: "hour", label: "Hourly" },
    { value: "day", label: "Daily" },
    { value: "week", label: "Weekly" },
    { value: "month", label: "Monthly" },
  ];
  return (
    <Tabs
      tabs={options}
      value={(q.interval ?? current ?? "day") as "hour"}
      onChange={(v) => setQ({ interval: v, period: q.period, from: q.from, to: q.to })}
    />
  );
}

