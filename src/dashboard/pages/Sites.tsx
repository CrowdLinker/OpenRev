import { Plus } from "lucide-react";
import { Link } from "wouter";
import { Sparkline } from "../components/Chart";
import { Card, Empty, ErrorBox, Favicon, Loading } from "../components/ui";
import { useApi } from "../lib/api";
import { money, num } from "../lib/format";
import type { SiteSummary } from "../lib/types";

export function SitesPage() {
  const { data, error, loading } = useApi<{ sites: SiteSummary[] }>("/api/sites", { poll: 30000 });
  if (loading && !data) return <Loading />;
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Websites</h1>
          <p className="text-sm text-zinc-500">Last 7 days</p>
        </div>
        <Link href="/sites/new" className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700">
          <Plus className="h-4 w-4" /> Add website
        </Link>
      </div>
      <ErrorBox error={error} />
      {data && data.sites.length === 0 && (
        <Card>
          <Empty title="No websites yet" icon={<Plus className="h-8 w-8" />}>
            <Link href="/sites/new" className="font-medium text-brand-600 hover:underline">
              Add your first website
            </Link>{" "}
            to start tracking visitors and revenue.
          </Empty>
        </Card>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data?.sites.map((s) => (
          <Link key={s.id} href={`/sites/${s.id}`} className="card group block p-5 transition hover:border-brand-300 hover:shadow-md dark:hover:border-brand-700">
            <div className="flex items-center gap-2.5">
              <Favicon domain={s.domain} size={20} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{s.name}</div>
                <div className="truncate text-xs text-zinc-500">{s.domain}</div>
              </div>
              {s.online > 0 && (
                <span className="flex items-center gap-1.5 text-xs font-medium text-money-600">
                  <span className="live-dot relative h-2 w-2 rounded-full bg-money-500 text-money-500" />
                  {s.online} online
                </span>
              )}
            </div>
            <div className="mt-4 flex items-end justify-between gap-3">
              <div className="flex gap-6">
                <div>
                  <div className="text-xs text-zinc-500">Visitors</div>
                  <div className="text-lg font-semibold tabular">{num(s.visitors)}</div>
                </div>
                {s.canSeeRevenue && (
                  <div>
                    <div className="text-xs text-zinc-500">Revenue</div>
                    <div className="text-lg font-semibold text-money-600 tabular dark:text-money-400">{money(s.revenue ?? 0, s.currency, { compact: true })}</div>
                  </div>
                )}
              </div>
              <Sparkline values={s.series.map((p) => p.visitors)} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
