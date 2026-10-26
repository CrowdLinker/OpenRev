import { ArrowLeft, DollarSign, ExternalLink, Eye, Search, Target } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { FilterBar, PeriodPicker } from "../components/Filters";
import { Avatar, Badge, Card, DeviceIcon, Empty, ErrorBox, Favicon, Flag, Loading, Spinner, Toggle } from "../components/ui";
import { useApi } from "../lib/api";
import { useSite } from "../lib/context";
import { countryName, dateTime, duration, money, num, timeAgo, visitorName } from "../lib/format";
import { toSearch, useDashQuery } from "../lib/query";
import type { Row } from "../lib/types";

export function VisitorsPage() {
  const { statsBase, meta, canSeeRevenue } = useSite();
  const [q] = useDashQuery();
  const [search, setSearch] = useState("");
  const [onlyCustomers, setCustomers] = useState(false);
  // Listing customers is revenue data: the filter is only offered (and sent) to members who can see revenue.
  const customers = canSeeRevenue && onlyCustomers;
  const [goal, setGoal] = useState("");
  const [page, setPage] = useState(0);
  const path = `${statsBase}/visitors?${toSearch(q, { search: search || undefined, customers: customers ? "1" : undefined, goal: goal || undefined, offset: String(page * 50) })}`;
  const { data, loading, error } = useApi<{ visitors: Row[]; currency: string }>(path);
  const currency = data?.currency ?? meta?.site.currency ?? "USD";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar />
        <PeriodPicker storageKey={meta?.site.id ?? "site"} />
      </div>
      <Card className="p-4">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative min-w-[240px] flex-1">
            <Search className="absolute top-2.5 left-3 h-4 w-4 text-zinc-400" />
            <input
              className="input pl-9"
              placeholder="Search by name, email, user id or visitor id"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
          </div>
          {meta && meta.goals.length > 0 && (
            <select className="input !w-auto" value={goal} onChange={(e) => setGoal(e.target.value)}>
              <option value="">Any goal</option>
              {meta.goals.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          )}
          {canSeeRevenue && <Toggle checked={customers} onChange={setCustomers} label="Customers only" />}
          {loading && <Spinner />}
        </div>
        <ErrorBox error={error} />
        {data && data.visitors.length === 0 ? (
          <Empty title="No visitors match">Try a longer date range or remove filters.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="pb-2 font-medium">Visitor</th>
                  <th className="pb-2 font-medium">First source</th>
                  <th className="pb-2 font-medium">Location</th>
                  <th className="pb-2 text-right font-medium">Visits</th>
                  {canSeeRevenue && <th className="pb-2 text-right font-medium">Revenue</th>}
                  <th className="pb-2 text-right font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {data?.visitors.map((v) => {
                  const name = visitorName(String(v.id), v.name);
                  return (
                    <tr key={String(v.id)} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="py-2.5">
                        <Link href={`/visitors/${v.id}`} className="flex items-center gap-2.5 hover:underline">
                          <Avatar name={name} image={v.image} size={30} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{name}</span>
                            {v.email && <span className="block truncate text-xs text-zinc-500">{v.email}</span>}
                          </span>
                        </Link>
                      </td>
                      <td className="py-2.5">
                        <span className="flex items-center gap-1.5">
                          <Favicon domain={v.referrer_domain} /> {v.source || "Direct"}
                        </span>
                      </td>
                      <td className="py-2.5">
                        <span className="flex items-center gap-1.5">
                          <Flag country={v.country} /> {v.city || countryName(v.country)}
                          <DeviceIcon device={v.device} className="h-3.5 w-3.5" />
                        </span>
                      </td>
                      <td className="py-2.5 text-right tabular">{num(Number(v.sessions), false)}</td>
                      {canSeeRevenue && (
                        <td className="py-2.5 text-right font-medium tabular text-money-600 dark:text-money-400">{Number(v.revenue) ? money(Number(v.revenue), currency) : "–"}</td>
                      )}
                      <td className="py-2.5 text-right text-xs text-zinc-500">{timeAgo(Number(v.last_seen))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex justify-between">
          <button disabled={page === 0} onClick={() => setPage(page - 1)} className="text-sm text-zinc-500 hover:text-zinc-900 disabled:opacity-30">
            ← Newer
          </button>
          <button disabled={(data?.visitors.length ?? 0) < 50} onClick={() => setPage(page + 1)} className="text-sm text-zinc-500 hover:text-zinc-900 disabled:opacity-30">
            Older →
          </button>
        </div>
      </Card>
    </div>
  );
}

interface Profile {
  currency: string;
  visitor: Row;
  sessions: Row[];
  events: Row[];
  /** Left out for viewers who can't see revenue. */
  payments?: Row[];
  revenue?: number;
}

export function VisitorProfilePage({ visitorId }: { visitorId: string }) {
  const { statsBase, meta } = useSite();
  const { data, loading, error } = useApi<Profile>(`${statsBase}/visitors/${visitorId}`);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const v = data.visitor;
  const name = visitorName(String(v.id), v.name);
  const currency = data.currency;
  const first = data.sessions[data.sessions.length - 1];
  const pageviews = data.sessions.reduce((a, s) => a + Number(s.pageviews), 0);
  const payments = data.payments ?? [];
  const firstPayment = [...payments].reverse().find((p) => p.type !== "refund");
  const daysToConvert = firstPayment && first ? Math.round((Number(firstPayment.ts) - Number(first.started_at)) / 86_400_000) : null;

  // Group events and payments under sessions for the timeline
  const eventsBySession = new Map<string, Row[]>();
  for (const e of data.events) {
    const list = eventsBySession.get(String(e.session_id)) ?? [];
    list.push(e);
    eventsBySession.set(String(e.session_id), list);
  }

  return (
    <div className="space-y-4">
      <Link href="/visitors" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        <ArrowLeft className="h-4 w-4" /> Visitors
      </Link>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-center gap-3">
              <Avatar name={name} image={v.image} size={52} />
              <div className="min-w-0">
                <div className="truncate text-lg font-semibold">{name}</div>
                {v.email && <div className="truncate text-sm text-zinc-500">{v.email}</div>}
                {v.user_id && v.user_id !== v.email && <div className="truncate font-mono text-xs text-zinc-400">id: {v.user_id}</div>}
              </div>
            </div>
            {!!data.revenue && data.revenue > 0 && (
              <div className="mt-4 rounded-xl bg-money-50 p-3 dark:bg-money-500/10">
                <div className="text-xs text-money-700 dark:text-money-400">Lifetime revenue</div>
                <div className="text-2xl font-semibold text-money-700 tabular dark:text-money-400">{money(data.revenue, currency)}</div>
                {daysToConvert !== null && (
                  <div className="text-xs text-money-700/80 dark:text-money-400/80">{daysToConvert === 0 ? "Converted on the first day" : `Converted after ${daysToConvert} day${daysToConvert > 1 ? "s" : ""}`}</div>
                )}
              </div>
            )}
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <Info label="Visits" value={num(data.sessions.length, false)} />
              <Info label="Pageviews" value={num(pageviews, false)} />
              <Info label="First seen" value={dateTime(Number(v.first_seen), meta?.site.timezone)} />
              <Info label="Last seen" value={timeAgo(Number(v.last_seen))} />
            </dl>
          </Card>
          {first && (
            <Card className="p-5 text-sm">
              <h3 className="mb-3 font-semibold">First touch</h3>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Favicon domain={first.referrer_domain} /> {first.source || "Direct"} <Badge>{first.channel}</Badge>
                </div>
                {first.utm_campaign && <div className="text-zinc-500">Campaign: {first.utm_campaign}</div>}
                <div className="text-zinc-500">
                  Landed on <span className="font-mono text-zinc-700 dark:text-zinc-300">{first.entry_page}</span>
                </div>
                <div className="flex items-center gap-2 text-zinc-500">
                  <Flag country={first.country} /> {[first.city, countryName(first.country)].filter(Boolean).join(", ")}
                </div>
                <div className="flex items-center gap-2 text-zinc-500">
                  <DeviceIcon device={first.device} /> {first.browser} · {first.os}
                </div>
              </div>
            </Card>
          )}
          {v.props && Object.keys(v.props).length > 0 && (
            <Card className="p-5 text-sm">
              <h3 className="mb-3 font-semibold">Properties</h3>
              <dl className="space-y-1.5">
                {Object.entries(v.props as Record<string, string>).map(([k, val]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <dt className="font-mono text-xs text-zinc-500">{k}</dt>
                    <dd className="truncate">{val}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}
        </div>

        <Card className="p-5">
          <h3 className="mb-4 font-semibold">Journey</h3>
          <div className="space-y-6">
            {data.sessions.map((s) => {
              const events = [...(eventsBySession.get(String(s.id)) ?? [])].reverse();
              const sessionPayments = payments.filter((p) => p.last_session_id === s.id || p.touch_session_id === s.id);
              return (
                <div key={String(s.id)} className="relative border-l-2 border-zinc-200 pl-5 dark:border-zinc-800">
                  <span className="absolute top-1 -left-[7px] h-3 w-3 rounded-full border-2 border-white bg-brand-500 dark:border-zinc-900" />
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{dateTime(Number(s.started_at), meta?.site.timezone)}</span>
                    <span className="flex items-center gap-1 text-zinc-500">
                      <Favicon domain={s.referrer_domain} size={14} /> {s.source || "Direct"}
                    </span>
                    <Badge>{s.channel}</Badge>
                    {s.utm_campaign && <Badge color="brand">{s.utm_campaign}</Badge>}
                    <span className="text-xs text-zinc-400">
                      <Flag country={s.country} /> {s.city || countryName(s.country)} · {s.browser} · {duration(Number(s.duration) / 1000)}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {events.map((e) => (
                      <div key={String(e.id)} className="flex items-center gap-2 text-sm">
                        {e.type === "goal" ? (
                          <Target className="h-3.5 w-3.5 text-brand-500" />
                        ) : e.type === "outbound" ? (
                          <ExternalLink className="h-3.5 w-3.5 text-zinc-400" />
                        ) : (
                          <Eye className="h-3.5 w-3.5 text-zinc-400" />
                        )}
                        <span className="w-16 shrink-0 text-xs text-zinc-400 tabular">
                          {new Date(Number(e.ts)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        {e.type === "goal" ? (
                          <span>
                            Completed <b>{e.name}</b>
                            {e.props && <span className="ml-1 text-xs text-zinc-500">{Object.entries(e.props).map(([k, val]) => `${k}=${val}`).join(", ")}</span>}
                          </span>
                        ) : e.type === "outbound" ? (
                          <span className="truncate text-zinc-500">Left to {String(e.name)}</span>
                        ) : (
                          <span className="truncate font-mono text-xs">{e.path}</span>
                        )}
                      </div>
                    ))}
                    {sessionPayments.map((p) => (
                      <div key={String(p.id)} className="flex items-center gap-2 rounded-lg bg-money-50 px-2 py-1.5 text-sm text-money-800 dark:bg-money-500/10 dark:text-money-300">
                        <DollarSign className="h-3.5 w-3.5" />
                        <b>{money(Math.abs(Number(p.revenue)), currency)}</b> {p.type === "refund" ? "refunded" : p.type === "renewal" ? "renewal" : "payment"} via {p.provider}
                        {p.description && <span className="opacity-70">· {p.description}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            {payments
              .filter((p) => !data.sessions.some((s) => s.id === p.last_session_id || s.id === p.touch_session_id))
              .map((p) => (
                <div key={String(p.id)} className="flex items-center gap-2 rounded-lg bg-money-50 px-3 py-2 text-sm text-money-800 dark:bg-money-500/10 dark:text-money-300">
                  <DollarSign className="h-4 w-4" />
                  {dateTime(Number(p.ts), meta?.site.timezone)} · <b>{money(Math.abs(Number(p.revenue)), currency)}</b> {p.type} via {p.provider}
                </div>
              ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
