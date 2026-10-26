import { DollarSign, ExternalLink, Flame, MousePointerClick, Target } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";
import { Link } from "wouter";
import { MiniBars } from "../components/Chart";
import { Avatar, Badge, Card, DeviceIcon, Empty, Favicon, Flag, Spinner } from "../components/ui";
import { useApi } from "../lib/api";
import { useSite } from "../lib/context";
import { countryName, duration, money, num, pct, timeAgo, visitorName } from "../lib/format";
import type { Row } from "../lib/types";

const Globe = lazy(() => import("../components/Globe").then((m) => ({ default: m.Globe })));

interface Realtime {
  visitors: number;
  currency: string;
  sessions: Row[];
  events: Row[];
  /** Left out for viewers who can't see revenue. */
  payments?: Row[];
  minutes: { minute: number; pageviews: number; visitors: number }[];
}

// Approximate centroids (lat, lng) for when city coordinates are unavailable.
const CENTROIDS: Record<string, [number, number]> = {
  US: [39.8, -98.6], CA: [56.1, -106.3], MX: [23.6, -102.5], BR: [-14.2, -51.9], AR: [-38.4, -63.6], GB: [55.4, -3.4], IE: [53.4, -8.2],
  FR: [46.2, 2.2], DE: [51.2, 10.5], ES: [40.5, -3.7], PT: [39.4, -8.2], IT: [41.9, 12.6], NL: [52.1, 5.3], BE: [50.5, 4.5], CH: [46.8, 8.2],
  AT: [47.5, 14.6], SE: [60.1, 18.6], NO: [60.5, 8.5], DK: [56.3, 9.5], FI: [61.9, 25.7], PL: [51.9, 19.1], CZ: [49.8, 15.5], RO: [45.9, 25.0],
  GR: [39.1, 21.8], TR: [38.9, 35.2], UA: [48.4, 31.2], RU: [61.5, 105.3], IL: [31.0, 34.9], AE: [23.4, 53.8], SA: [23.9, 45.1], EG: [26.8, 30.8],
  NG: [9.1, 8.7], KE: [0.0, 37.9], ZA: [-30.6, 22.9], IN: [20.6, 79.0], PK: [30.4, 69.3], BD: [23.7, 90.4], CN: [35.9, 104.2], JP: [36.2, 138.3],
  KR: [35.9, 127.8], TW: [23.7, 121.0], HK: [22.4, 114.1], SG: [1.35, 103.8], MY: [4.2, 102.0], TH: [15.9, 101.0], VN: [14.1, 108.3],
  PH: [12.9, 121.8], ID: [-0.8, 113.9], AU: [-25.3, 133.8], NZ: [-40.9, 174.9],
};

function sessionLocation(s: Row): [number, number] | null {
  if (s.latitude !== null && s.latitude !== undefined && s.longitude !== null && s.longitude !== undefined) return [Number(s.latitude), Number(s.longitude)];
  if (s.country && CENTROIDS[s.country]) return CENTROIDS[s.country];
  return null;
}

export function RealtimePage() {
  const { statsBase, meta, isPublic } = useSite();
  const { data, loading } = useApi<Realtime>(`${statsBase}/realtime`, { poll: 5000 });
  const [focus, setFocus] = useState<[number, number] | null>(null);
  const currency = data?.currency ?? meta?.site.currency ?? "USD";

  const markers = useMemo(
    () =>
      (data?.sessions ?? [])
        .map((s) => {
          const loc = sessionLocation(s);
          return loc ? { location: loc, size: Math.min(0.1, 0.03 + Number(s.pageviews) * 0.006), paying: Number(s.buyer_score) > 0.2 } : null;
        })
        .filter(Boolean) as { location: [number, number]; size: number; paying?: boolean }[],
    [data],
  );

  if (loading && !data) return <Spinner />;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.2fr_1fr]">
      <Card className="relative overflow-hidden p-5">
        <div className="relative z-10 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-500">
              <span className="live-dot relative h-2.5 w-2.5 rounded-full bg-money-500 text-money-500" />
              Visitors online now
            </div>
            <div className="mt-1 text-5xl font-semibold tracking-tight tabular">{num(data?.visitors ?? 0, false)}</div>
            <div className="mt-1 text-xs text-zinc-500">Active in the last 5 minutes</div>
          </div>
          <div className="w-44">
            <div className="mb-1 text-right text-[11px] text-zinc-400">Pageviews, last 30 min</div>
            <MiniBars values={(data?.minutes ?? []).map((m) => m.pageviews)} />
          </div>
        </div>
        <Suspense fallback={<div className="aspect-square" />}>
          <Globe markers={markers} focus={focus} className="-mt-6" />
        </Suspense>
      </Card>

      <div className="space-y-4">
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold">Live visitors</h3>
          {!data?.sessions.length ? (
            <Empty title="Nobody here right now">Visitors appear here within seconds of landing on your site.</Empty>
          ) : (
            <div className="scrollbar-thin max-h-[420px] space-y-1 overflow-y-auto">
              {data.sessions.map((s, i) => {
                const name = isPublic ? `Visitor ${i + 1}` : visitorName(String(s.visitor_id), s.name);
                const content = (
                  <div className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50" onMouseEnter={() => setFocus(sessionLocation(s))}>
                    <Avatar name={name} image={s.image} size={34} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        <span className="truncate">{name}</span>
                        {Number(s.visits) > 1 && <Badge>returning</Badge>}
                        {Number(s.buyer_score) >= 0.15 && (
                          <span title={`Buyer intent ${pct(Number(s.buyer_score), 0)}`}>
                            <Badge color="amber">
                              <Flame className="h-3 w-3" /> {pct(Number(s.buyer_score), 0)}
                            </Badge>
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs text-zinc-500">
                        on <span className="font-mono text-zinc-700 dark:text-zinc-300">{s.page}</span> · {Number(s.pageviews)} pages · {duration((Number(s.last_seen_at) - Number(s.started_at)) / 1000)}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-zinc-500">
                      <span className="flex items-center gap-1">
                        <Favicon domain={s.referrer_domain} size={12} /> {s.source || "Direct"}
                      </span>
                      <span className="flex items-center gap-1">
                        <Flag country={s.country} /> {s.city || countryName(s.country)} <DeviceIcon device={s.device} className="h-3 w-3" />
                      </span>
                    </div>
                  </div>
                );
                return isPublic ? <div key={i}>{content}</div> : <Link key={String(s.id)} href={`/visitors/${s.visitor_id}`}>{content}</Link>;
              })}
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold">Activity</h3>
          <div className="scrollbar-thin max-h-[320px] space-y-2 overflow-y-auto text-sm">
            {(data?.payments ?? []).slice(0, 5).map((p) => (
              <div key={String(p.id)} className="flex items-center gap-2 rounded-lg bg-money-50 px-2.5 py-2 dark:bg-money-500/10">
                <DollarSign className="h-4 w-4 shrink-0 text-money-600" />
                <span className="flex-1 truncate">
                  <b className="text-money-700 dark:text-money-400">{money(Math.abs(Number(p.revenue)), currency)}</b> {p.type === "refund" ? "refund" : "payment"}
                  {p.source ? ` from ${p.source}` : ""} {p.country ? <Flag country={p.country} /> : null}
                </span>
                <span className="shrink-0 text-xs text-zinc-500">{timeAgo(Number(p.ts))}</span>
              </div>
            ))}
            {(data?.events ?? []).map((e) => (
              <div key={String(e.id)} className="flex items-center gap-2 px-1">
                {e.type === "goal" ? (
                  <Target className="h-3.5 w-3.5 shrink-0 text-brand-500" />
                ) : e.type === "outbound" ? (
                  <ExternalLink className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                ) : (
                  <MousePointerClick className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                )}
                <Flag country={e.country} />
                <span className="flex-1 truncate text-zinc-600 dark:text-zinc-300">
                  {e.type === "goal" ? (
                    <>
                      completed <b>{e.name}</b>
                    </>
                  ) : e.type === "outbound" ? (
                    <>clicked {String(e.name).replace(/^https?:\/\//, "")}</>
                  ) : (
                    <>
                      viewed <span className="font-mono">{e.path}</span>
                    </>
                  )}
                </span>
                <span className="shrink-0 text-xs text-zinc-400">{timeAgo(Number(e.ts))}</span>
              </div>
            ))}
            {!data?.events.length && !data?.payments?.length && <Empty title="No activity in the last 30 minutes" />}
          </div>
        </Card>
      </div>
    </div>
  );
}
