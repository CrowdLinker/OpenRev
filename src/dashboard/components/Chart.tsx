import { StickyNote } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { bucketLabel, duration, money, num, pct } from "../lib/format";
import type { Note, Point } from "../lib/types";

export type ChartMetric = "visitors" | "pageviews" | "sessions" | "bounce_rate" | "avg_session_duration" | "conversion_rate" | "revenue_per_visitor" | "conversions";

export const METRIC_LABELS: Record<ChartMetric, string> = {
  visitors: "Visitors",
  pageviews: "Pageviews",
  sessions: "Sessions",
  bounce_rate: "Bounce rate",
  avg_session_duration: "Session time",
  conversion_rate: "Conversion rate",
  revenue_per_visitor: "Revenue/visitor",
  conversions: "Goal conversions",
};

function metricValue(p: Point, m: ChartMetric): number {
  switch (m) {
    case "conversion_rate":
      return p.visitors ? Math.min(1, p.customers / p.visitors) : 0;
    case "revenue_per_visitor":
      return p.visitors ? p.revenue / p.visitors : 0;
    default:
      return Number(p[m] ?? 0);
  }
}

export function formatMetric(m: ChartMetric, v: number, currency: string) {
  if (m === "bounce_rate" || m === "conversion_rate") return pct(v);
  if (m === "avg_session_duration") return duration(v);
  if (m === "revenue_per_visitor") return money(v, currency, { cents: true });
  return num(v, false);
}

/** Rounds `v` up so that it splits into 4 "nice" ticks (integers when `integer` is set). */
function niceMax(v: number, integer = false) {
  if (v <= 0) return integer ? 4 : 1;
  const raw = v / 4;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / exp;
  let step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
  if (integer) step = Math.max(1, Math.ceil(step));
  return step * 4;
}

const COUNT_METRICS = new Set<ChartMetric>(["visitors", "pageviews", "sessions", "conversions"]);

/** Monotone cubic interpolation path (Fritsch–Carlson) for a smooth, non-overshooting line. */
function smoothPath(pts: [number, number][]) {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const n = pts.length;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    m.push((pts[i + 1][1] - pts[i][1]) / (dx[i] || 1));
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${pts[i][0] + h},${pts[i][1] + h * t[i]} ${pts[i + 1][0] - h},${pts[i + 1][1] - h * t[i + 1]} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

export function MainChart({
  points,
  interval,
  currency,
  metric = "visitors",
  showRevenue = true,
  notes = [],
  height = 300,
}: {
  points: Point[];
  interval: string;
  currency: string;
  metric?: ChartMetric;
  showRevenue?: boolean;
  notes?: Note[];
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.max(300, entries[0].contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const padL = 44;
  const padR = showRevenue ? 60 : 12;
  const padT = 12;
  const padB = 30;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const n = Math.max(points.length, 1);
  const step = innerW / n;
  const x = (i: number) => padL + step * (i + 0.5);

  const values = points.map((p) => metricValue(p, metric));
  const maxV = niceMax(Math.max(...values, 0) * 1.05, COUNT_METRICS.has(metric));
  const maxR = niceMax(Math.max(...points.map((p) => Math.max(p.revenue, 0)), 0) * 1.05);
  const yV = (v: number) => padT + innerH - (v / maxV) * innerH;
  const yR = (v: number) => padT + innerH - (Math.max(v, 0) / maxR) * innerH;
  const barW = Math.max(2, Math.min(step * 0.55, 26));

  const linePts = values.map((v, i) => [x(i), yV(v)] as [number, number]);
  const line = smoothPath(linePts);
  const area = points.length ? `${line} L${x(points.length - 1)},${padT + innerH} L${x(0)},${padT + innerH} Z` : "";

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(innerW / 80))));

  const noteBuckets = useMemo(() => {
    const map = new Map<number, Note[]>();
    notes.forEach((note) => {
      for (let i = 0; i < points.length; i++) {
        const start = points[i].start;
        const end = i + 1 < points.length ? points[i + 1].start : Infinity;
        if (note.ts >= start && note.ts < end) {
          map.set(i, [...(map.get(i) ?? []), note]);
          break;
        }
      }
    });
    return map;
  }, [notes, points]);

  const hp = hover !== null ? points[hover] : null;
  const tooltipLeft = hover !== null ? Math.min(Math.max(x(hover) - 110, 0), width - 230) : 0;

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} className="overflow-visible">
        <defs>
          <linearGradient id="visitorsFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--color-brand-500)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--color-brand-500)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={width - padR} y1={padT + innerH * (1 - t)} y2={padT + innerH * (1 - t)} className="stroke-zinc-200 dark:stroke-zinc-800" strokeDasharray={t === 0 ? undefined : "3 4"} />
            <text x={padL - 8} y={padT + innerH * (1 - t) + 4} textAnchor="end" className="fill-zinc-400 text-[10px] tabular">
              {formatMetric(metric, maxV * t, currency).replace(/\.0+%$/, "%")}
            </text>
            {showRevenue && (
              <text x={width - padR + 8} y={padT + innerH * (1 - t) + 4} textAnchor="start" className="fill-money-600/70 text-[10px] tabular dark:fill-money-400/70">
                {money(maxR * t, currency, { compact: true })}
              </text>
            )}
          </g>
        ))}

        {showRevenue &&
          points.map((p, i) =>
            p.revenue > 0 ? (
              <rect
                key={`r${i}`}
                x={x(i) - barW / 2}
                y={yR(p.revenue)}
                width={barW}
                height={padT + innerH - yR(p.revenue)}
                rx={Math.min(4, barW / 3)}
                className={hover === i ? "fill-money-500" : "fill-money-400/70 dark:fill-money-500/60"}
              />
            ) : null,
          )}

        {points.length > 0 && (
          <>
            <path d={area} fill="url(#visitorsFill)" />
            <path d={line} fill="none" stroke="var(--color-brand-500)" strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}

        {points.map((p, i) =>
          i % labelEvery === 0 ? (
            <text key={`l${i}`} x={x(i)} y={height - 8} textAnchor="middle" className="fill-zinc-400 text-[10px]">
              {bucketLabel(p.date, interval)}
            </text>
          ) : null,
        )}

        {[...noteBuckets.entries()].map(([i, ns]) => (
          <g key={`n${i}`}>
            <line x1={x(i)} x2={x(i)} y1={padT} y2={padT + innerH} className="stroke-amber-400/60" strokeDasharray="2 3" />
            <circle cx={x(i)} cy={padT + innerH} r={4.5} className="fill-amber-400 stroke-white dark:stroke-zinc-900" strokeWidth={1.5}>
              <title>{ns.map((n) => n.text).join("\n")}</title>
            </circle>
          </g>
        ))}

        {hover !== null && hp && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + innerH} className="stroke-zinc-300 dark:stroke-zinc-600" />
            <circle cx={x(hover)} cy={yV(values[hover])} r={4.5} fill="var(--color-brand-500)" className="stroke-white dark:stroke-zinc-900" strokeWidth={2} />
          </g>
        )}

        {points.map((_, i) => (
          <rect key={`h${i}`} x={padL + step * i} y={padT} width={step} height={innerH + padB} fill="transparent" onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)} />
        ))}
      </svg>

      {hp && hover !== null && (
        <div className="card pointer-events-none absolute top-2 z-10 w-[230px] p-3 text-xs shadow-lg" style={{ left: tooltipLeft }}>
          <div className="mb-2 font-medium text-zinc-500">{bucketLabel(hp.date, interval, true)}</div>
          <div className="space-y-1.5">
            <Row color="bg-brand-500" label={METRIC_LABELS[metric]} value={formatMetric(metric, values[hover], currency)} />
            {metric !== "visitors" && <Row color="bg-brand-300" label="Visitors" value={num(hp.visitors, false)} />}
            {showRevenue && <Row color="bg-money-500" label="Revenue" value={money(hp.revenue, currency)} />}
            {showRevenue && hp.payments > 0 && <Row label="Payments" value={num(hp.payments, false)} />}
            {showRevenue && metric !== "conversion_rate" && <Row label="Conversion rate" value={pct(hp.visitors ? hp.customers / hp.visitors : 0)} />}
            {hp.conversions !== undefined && metric !== "conversions" && <Row label="Goal conversions" value={num(hp.conversions, false)} />}
          </div>
          {noteBuckets.get(hover)?.map((n) => (
            <div key={n.id} className="mt-2 flex items-start gap-1.5 border-t border-zinc-100 pt-2 text-amber-700 dark:border-zinc-800 dark:text-amber-400">
              <StickyNote className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{n.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-zinc-500">
        {color && <span className={`h-2 w-2 rounded-full ${color}`} />}
        {label}
      </span>
      <span className="font-semibold tabular text-zinc-900 dark:text-zinc-100">{value}</span>
    </div>
  );
}

export function Sparkline({ values, width = 120, height = 32, color = "var(--color-brand-500)" }: { values: number[]; width?: number; height?: number; color?: string }) {
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [values.length > 1 ? (i / (values.length - 1)) * width : width / 2, height - 2 - (v / max) * (height - 4)] as [number, number]);
  const d = smoothPath(pts);
  return (
    <svg width={width} height={height} className="overflow-visible">
      <path d={`${d} L${width},${height} L0,${height} Z`} fill={color} opacity={0.12} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" />
    </svg>
  );
}

export function MiniBars({ values, height = 40, className = "fill-brand-500" }: { values: number[]; height?: number; className?: string }) {
  const max = Math.max(...values, 1);
  const w = 100 / Math.max(values.length, 1);
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="h-10 w-full">
      {values.map((v, i) => (
        <rect key={i} x={i * w + w * 0.15} width={w * 0.7} y={height - (v / max) * height} height={(v / max) * height} rx={0.6} className={className} />
      ))}
    </svg>
  );
}
