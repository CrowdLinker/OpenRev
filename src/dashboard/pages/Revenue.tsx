import { DollarSign } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { BreakdownPanel, RowIcon, rowLabel } from "../components/Breakdown";
import { FilterBar, PeriodPicker } from "../components/Filters";
import { Badge, Card, Delta, Empty, Favicon, Flag, Spinner, Tabs } from "../components/ui";
import { useApi } from "../lib/api";
import { canEdit, useSite } from "../lib/context";
import { change, dateTime, money, num, pct, visitorName } from "../lib/format";
import { toSearch, useDashQuery } from "../lib/query";
import type { Overview, Row } from "../lib/types";

function Tile({ label, value, delta, invert, tone }: { label: string; value: string; delta?: number | null; invert?: boolean; tone?: "money" | "red" }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular ${tone === "money" ? "text-money-600 dark:text-money-400" : tone === "red" ? "text-red-500" : ""}`}>{value}</div>
      <div className="h-4">{delta !== undefined && <Delta value={delta ?? null} invert={invert} />}</div>
    </div>
  );
}

export function RevenuePage() {
  const { statsBase, meta, site, role, isPublic } = useSite();
  const [q] = useDashQuery();
  const [group, setGroup] = useState<"source" | "channel" | "country" | "utm_campaign">("source");
  const [page, setPage] = useState(0);
  const search = toSearch(q);
  const overview = useApi<Overview>(`${statsBase}/overview?${search}`);
  const ltv = useApi<{ rows: Row[]; currency: string }>(`${statsBase}/ltv?${toSearch(q, { group })}`);
  const payments = useApi<{ payments: Row[]; currency: string }>(`${statsBase}/payments?${toSearch(q, { offset: String(page * 50) })}`);
  const c = overview.data?.current;
  const p = overview.data?.previous;
  const cur = overview.data?.currency ?? meta?.site.currency ?? "USD";
  const d = (a?: number, b?: number) => (a !== undefined && b !== undefined ? change(a, b) : null);
  const aov = c && c.payments ? (c.revenue + c.refunds) / c.payments : 0;
  const prevAov = p && p.payments ? (p.revenue + p.refunds) / p.payments : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar />
        <PeriodPicker range={overview.data?.range} storageKey={meta?.site.id ?? "site"} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Tile label="Net revenue" value={money(c?.revenue ?? 0, cur)} delta={d(c?.revenue, p?.revenue)} tone="money" />
        <Tile label="New revenue" value={money(c?.new_revenue ?? 0, cur)} delta={d(c?.new_revenue, p?.new_revenue)} />
        <Tile label="Renewals" value={money(c?.renewal_revenue ?? 0, cur)} delta={d(c?.renewal_revenue, p?.renewal_revenue)} />
        <Tile label="Refunds" value={money(c?.refunds ?? 0, cur)} delta={d(c?.refunds, p?.refunds)} invert tone={c?.refunds ? "red" : undefined} />
        <Tile label="Payments" value={num(c?.payments ?? 0, false)} delta={d(c?.payments, p?.payments)} />
        <Tile label="Avg. order value" value={money(aov, cur)} delta={d(aov, prevAov)} />
        <Tile label="Customers" value={num(c?.customers ?? 0, false)} delta={d(c?.customers, p?.customers)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BreakdownPanel
          id="revenue-sources"
          title="Revenue by source"
          tabs={[
            { key: "channel", label: "Channel", dim: "channel" },
            { key: "source", label: "Referrer", dim: "source" },
            { key: "campaign", label: "Campaign", dim: "utm_campaign" },
            { key: "country", label: "Country", dim: "country" },
            { key: "entry", label: "Landing page", dim: "entry_page" },
          ]}
        />
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">Customer lifetime value</h3>
              <p className="text-xs text-zinc-500">Customers acquired in this period, by first touch</p>
            </div>
            <Tabs
              tabs={[
                { value: "source", label: "Referrer" },
                { value: "channel", label: "Channel" },
                { value: "country", label: "Country" },
                { value: "utm_campaign", label: "Campaign" },
              ]}
              value={group}
              onChange={setGroup}
            />
          </div>
          {ltv.loading && !ltv.data ? (
            <Spinner />
          ) : !ltv.data?.rows.length ? (
            <Empty title="No customers in this period" />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-zinc-500">
                <tr>
                  <th className="pb-2 text-left font-medium">First touch</th>
                  <th className="pb-2 text-right font-medium">Customers</th>
                  <th className="pb-2 text-right font-medium">LTV</th>
                  <th className="pb-2 text-right font-medium">Avg LTV</th>
                  <th className="pb-2 text-right font-medium">Repeat</th>
                </tr>
              </thead>
              <tbody>
                {ltv.data.rows.map((r) => {
                  const dim = group === "utm_campaign" ? "utm_campaign" : group;
                  const row = { ...r, visitors: 0, payments: 0, conversion_rate: 0, revenue_per_visitor: 0 } as never;
                  return (
                    <tr key={String(r.value)} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="py-2">
                        <span className="flex items-center gap-2">
                          <RowIcon dim={dim} row={row} /> <span className="truncate">{rowLabel(dim, row)}</span>
                        </span>
                      </td>
                      <td className="py-2 text-right tabular">{num(r.customers, false)}</td>
                      <td className="py-2 text-right font-medium tabular text-money-600 dark:text-money-400">{money(r.revenue, cur)}</td>
                      <td className="py-2 text-right tabular">{money(r.avg_ltv, cur)}</td>
                      <td className="py-2 text-right tabular">{pct(r.repeat_rate, 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Payments</h3>
          {!isPublic && canEdit(role) && site && (
            <Link href="/settings/revenue" className="text-xs font-medium text-brand-600 hover:underline">
              Manage payment providers →
            </Link>
          )}
        </div>
        {payments.loading && !payments.data ? (
          <Spinner />
        ) : !payments.data?.payments.length ? (
          <Empty title="No payments in this period" icon={<DollarSign className="h-6 w-6" />}>
            {!isPublic && "Connect a payment provider in Settings → Revenue, or send payments with the API."}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="pb-2 font-medium">Date</th>
                  <th className="pb-2 font-medium">Customer</th>
                  <th className="pb-2 font-medium">Source</th>
                  <th className="pb-2 font-medium">Type</th>
                  <th className="pb-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.data.payments.map((pay) => {
                  const who = pay.visitor_id ? visitorName(String(pay.visitor_id), pay.visitor_name ?? pay.name) : pay.name || pay.email || "Unknown";
                  return (
                    <tr key={String(pay.id)} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="py-2 text-zinc-500">{dateTime(Number(pay.ts), meta?.site.timezone)}</td>
                      <td className="py-2">
                        {pay.visitor_id && !isPublic ? (
                          <Link href={`/visitors/${pay.visitor_id}`} className="hover:underline">
                            {who}
                          </Link>
                        ) : (
                          who
                        )}
                        {pay.email && !isPublic && <div className="text-xs text-zinc-500">{pay.email}</div>}
                      </td>
                      <td className="py-2">
                        {pay.source ? (
                          <span className="flex items-center gap-1.5">
                            <Favicon domain={pay.referrer_domain} /> {pay.source} <span className="text-xs text-zinc-400">{pay.channel}</span>
                            {pay.country && <Flag country={pay.country} />}
                          </span>
                        ) : (
                          <span className="text-zinc-400">Unattributed</span>
                        )}
                      </td>
                      <td className="py-2">
                        <Badge color={pay.type === "refund" ? "red" : pay.type === "renewal" ? "brand" : "green"}>{pay.type}</Badge>
                        <span className="ml-1.5 text-xs text-zinc-400">{pay.provider}</span>
                      </td>
                      <td className={`py-2 text-right font-medium tabular ${Number(pay.revenue) < 0 ? "text-red-500" : "text-money-600 dark:text-money-400"}`}>
                        {money(Number(pay.revenue), cur)}
                        {pay.currency !== cur && <div className="text-xs font-normal text-zinc-400">{money(Number(pay.amount), String(pay.currency))}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="mt-3 flex justify-between">
              <button disabled={page === 0} onClick={() => setPage(page - 1)} className="text-sm text-zinc-500 disabled:opacity-30">
                ← Newer
              </button>
              <button disabled={payments.data.payments.length < 50} onClick={() => setPage(page + 1)} className="text-sm text-zinc-500 disabled:opacity-30">
                Older →
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
