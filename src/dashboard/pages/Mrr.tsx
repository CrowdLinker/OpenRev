import { Info, Repeat } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { RowIcon, rowLabel } from "../components/Breakdown";
import { MrrChart, type MrrChartPoint } from "../components/Chart";
import { FilterBar, PeriodPicker } from "../components/Filters";
import { Card, Empty, Spinner, Tabs } from "../components/ui";
import { useApi } from "../lib/api";
import { canEdit, useSite } from "../lib/context";
import { money, num, pct } from "../lib/format";
import { toSearch, useDashQuery } from "../lib/query";

interface MrrSummary {
  mrr: number;
  arr: number;
  subscribers: number;
  arpu: number;
  mrr_start: number;
  subscribers_start: number;
  net_change: number;
  churn_rate: number | null;
  revenue_churn_rate: number | null;
  net_revenue_retention: number | null;
  assumed_interval: number;
  new: number;
  expansion: number;
  reactivation: number;
  contraction: number;
  churn: number;
  new_subscribers: number;
  churned_subscribers: number;
}

interface MrrResponse {
  currency: string;
  interval: string;
  range: { from: number; to: number };
  summary: MrrSummary;
  timeseries: MrrChartPoint[];
}

interface MrrRow {
  value: string;
  meta: string | null;
  mrr: number;
  subscribers: number;
  new_mrr: number;
  new_subscribers: number;
  churned_mrr: number;
}

type Group = "channel" | "source" | "utm_campaign" | "country";

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "money" | "red" }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular ${tone === "money" ? "text-money-600 dark:text-money-400" : tone === "red" ? "text-red-500" : ""}`}>{value}</div>
      <div className="h-4 text-xs text-zinc-500">{sub}</div>
    </div>
  );
}

const signed = (v: number, cur: string) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${money(Math.abs(v), cur)}`;
const rate = (v: number | null) => (v === null ? "—" : pct(v, 1));

export function MrrPage() {
  const { statsBase, meta, role, isPublic } = useSite();
  const [q] = useDashQuery();
  const [group, setGroup] = useState<Group>("channel");
  const report = useApi<MrrResponse>(`${statsBase}/mrr?${toSearch(q)}`);
  const breakdown = useApi<{ rows: MrrRow[]; currency: string }>(`${statsBase}/mrr/breakdown?${toSearch(q, { group })}`);
  const s = report.data?.summary;
  const cur = report.data?.currency ?? meta?.site.currency ?? "USD";
  const empty = s && !s.mrr && !s.mrr_start && !s.new && !s.churn && !s.reactivation;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar />
        <PeriodPicker range={report.data?.range as never} storageKey={meta?.site.id ?? "site"} />
      </div>

      {report.loading && !report.data ? (
        <Spinner />
      ) : empty ? (
        <Card className="p-6">
          <Empty title="No subscriptions yet" icon={<Repeat className="h-6 w-6" />}>
            MRR is built from subscription payments: first payments and renewals that carry a subscription id. Connect Stripe, Paddle, Polar,
            Lemon Squeezy or another provider{!isPublic && canEdit(role) ? " in Settings → Revenue" : ""}, or send `subscription_id` and
            `interval` with the Payments API.
          </Empty>
        </Card>
      ) : s ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="MRR" value={money(s.mrr, cur)} sub={`${signed(s.net_change, cur)} in this period`} tone="money" />
            <Tile label="ARR" value={money(s.arr, cur)} sub="MRR × 12" />
            <Tile label="Subscribers" value={num(s.subscribers, false)} sub={`${s.new_subscribers} new · ${s.churned_subscribers} churned`} />
            <Tile label="Revenue per subscriber" value={money(s.arpu, cur)} sub="per month" />
            <Tile label="Subscriber churn" value={rate(s.churn_rate)} sub={`of ${num(s.subscribers_start, false)} at the start`} tone={s.churn_rate ? "red" : undefined} />
            <Tile label="Revenue churn" value={rate(s.revenue_churn_rate)} sub="churned + contracted MRR" tone={s.revenue_churn_rate ? "red" : undefined} />
            <Tile label="Net revenue retention" value={rate(s.net_revenue_retention)} sub="from subscribers at the start" />
            <Tile label="New MRR" value={money(s.new, cur)} sub={`+${money(s.expansion, cur)} expansion`} tone="money" />
          </div>

          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">MRR and its movements</h3>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
                <Legend dot="bg-money-500" label={`New ${signed(s.new, cur)}`} />
                <Legend dot="bg-money-300" label={`Expansion ${signed(s.expansion, cur)}`} />
                <Legend dot="bg-sky-400" label={`Reactivation ${signed(s.reactivation, cur)}`} />
                <Legend dot="bg-amber-400" label={`Contraction ${signed(s.contraction, cur)}`} />
                <Legend dot="bg-red-400" label={`Churn ${signed(s.churn, cur)}`} />
              </div>
            </div>
            <MrrChart points={report.data!.timeseries} interval={report.data!.interval} currency={cur} />
            {s.assumed_interval > 0 && (
              <p className="mt-3 flex items-start gap-1.5 text-xs text-zinc-500">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {s.assumed_interval} {s.assumed_interval === 1 ? "subscription has" : "subscriptions have"} only one payment and no billing interval from the provider, so
                monthly billing is assumed until a renewal shows the real interval.
              </p>
            )}
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">MRR by acquisition</h3>
                <p className="text-xs text-zinc-500">What brought each subscriber in: current MRR, MRR won and MRR lost in this period</p>
              </div>
              <Tabs
                tabs={[
                  { value: "channel", label: "Channel" },
                  { value: "source", label: "Referrer" },
                  { value: "utm_campaign", label: "Campaign" },
                  { value: "country", label: "Country" },
                ]}
                value={group}
                onChange={(v) => setGroup(v as Group)}
              />
            </div>
            {breakdown.loading && !breakdown.data ? (
              <Spinner />
            ) : !breakdown.data?.rows.length ? (
              <Empty title="No subscriptions in this period" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm [&_td+td]:pl-4 [&_th+th]:pl-4">
                  <thead className="text-xs whitespace-nowrap text-zinc-500">
                    <tr>
                      <th className="pb-2 text-left font-medium">Acquired via</th>
                      <th className="pb-2 text-right font-medium">MRR</th>
                      <th className="pb-2 text-right font-medium">Subscribers</th>
                      <th className="pb-2 text-right font-medium">New MRR</th>
                      <th className="pb-2 text-right font-medium">Churned MRR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.data.rows.map((r) => {
                      const row = { ...r, visitors: 0, revenue: r.mrr, payments: 0, customers: r.subscribers, conversion_rate: 0, revenue_per_visitor: 0 } as never;
                      return (
                        <tr key={r.value} className="border-t border-zinc-100 dark:border-zinc-800">
                          <td className="py-2">
                            <span className="flex items-center gap-2">
                              <RowIcon dim={group} row={row} /> <span className="truncate">{rowLabel(group, row)}</span>
                            </span>
                          </td>
                          <td className="py-2 text-right font-medium tabular text-money-600 dark:text-money-400">{money(r.mrr, cur)}</td>
                          <td className="py-2 text-right tabular">{num(r.subscribers, false)}</td>
                          <td className={`py-2 text-right tabular ${r.new_mrr ? "" : "text-zinc-400"}`}>{r.new_mrr ? `+${money(r.new_mrr, cur)}` : "—"}</td>
                          <td className={`py-2 text-right tabular ${r.churned_mrr ? "text-red-500" : "text-zinc-400"}`}>{r.churned_mrr ? `−${money(r.churned_mrr, cur)}` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {!isPublic && (
            <p className="text-xs text-zinc-500">
              MRR spreads each subscription payment over its billing period and counts a subscription as churned when a renewal is more than 7 days late.{" "}
              <Link href="/revenue" className="font-medium text-brand-600 hover:underline">
                Revenue
              </Link>{" "}
              shows every payment, one-off sales and refunds included.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}

function Legend({ dot, label }: { dot: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
