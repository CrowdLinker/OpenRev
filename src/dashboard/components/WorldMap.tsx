import { geoEqualEarth, geoPath } from "d3-geo";
import { useEffect, useMemo, useState } from "react";
import { feature } from "topojson-client";
import { countryName, num } from "../lib/format";

// ISO 3166-1 numeric -> alpha-2 (world-atlas uses numeric ids)
const ISO = "004AF,008AL,010AQ,012DZ,016AS,020AD,024AO,028AG,031AZ,032AR,036AU,040AT,044BS,048BH,050BD,051AM,052BB,056BE,060BM,064BT,068BO,070BA,072BW,074BV,076BR,084BZ,086IO,090SB,092VG,096BN,100BG,104MM,108BI,112BY,116KH,120CM,124CA,132CV,136KY,140CF,144LK,148TD,152CL,156CN,158TW,162CX,166CC,170CO,174KM,175YT,178CG,180CD,184CK,188CR,191HR,192CU,196CY,203CZ,204BJ,208DK,212DM,214DO,218EC,222SV,226GQ,231ET,232ER,233EE,234FO,238FK,239GS,242FJ,246FI,248AX,250FR,254GF,258PF,260TF,262DJ,266GA,268GE,270GM,275PS,276DE,288GH,292GI,296KI,300GR,304GL,308GD,312GP,316GU,320GT,324GN,328GY,332HT,334HM,336VA,340HN,344HK,348HU,352IS,356IN,360ID,364IR,368IQ,372IE,376IL,380IT,384CI,388JM,392JP,398KZ,400JO,404KE,408KP,410KR,414KW,417KG,418LA,422LB,426LS,428LV,430LR,434LY,438LI,440LT,442LU,446MO,450MG,454MW,458MY,462MV,466ML,470MT,474MQ,478MR,480MU,484MX,492MC,496MN,498MD,499ME,500MS,504MA,508MZ,512OM,516NA,520NR,524NP,528NL,531CW,533AW,534SX,535BQ,540NC,548VU,554NZ,558NI,562NE,566NG,570NU,574NF,578NO,580MP,581UM,583FM,584MH,585PW,586PK,591PA,598PG,600PY,604PE,608PH,612PN,616PL,620PT,624GW,626TL,630PR,634QA,638RE,642RO,643RU,646RW,652BL,654SH,659KN,660AI,662LC,663MF,666PM,670VC,674SM,678ST,682SA,686SN,688RS,690SC,694SL,702SG,703SK,704VN,705SI,706SO,710ZA,716ZW,724ES,728SS,729SD,732EH,740SR,744SJ,748SZ,752SE,756CH,760SY,762TJ,764TH,768TG,772TK,776TO,780TT,784AE,788TN,792TR,795TM,796TC,798TV,800UG,804UA,807MK,818EG,826GB,831GG,832JE,833IM,834TZ,840US,850VI,854BF,858UY,860UZ,862VE,876WF,882WS,887YE,894ZM";
const NUMERIC_TO_ALPHA2 = new Map(ISO.split(",").map((e) => [e.slice(0, 3), e.slice(3)]));

type Geo = { type: string; id?: string; properties: { name: string }; geometry: unknown };

let cached: Promise<Geo[]> | null = null;
function loadWorld(): Promise<Geo[]> {
  cached ??= import("world-atlas/countries-110m.json").then((mod) => {
    const topo = (mod as { default?: unknown }).default ?? mod;
    const fc = feature(topo as never, (topo as { objects: { countries: unknown } }).objects.countries as never) as unknown as { features: Geo[] };
    return fc.features.filter((f) => f.properties.name !== "Antarctica");
  });
  return cached;
}

export function WorldMap({ data, onSelect }: { data: { country: string; visitors: number; revenue?: number }[]; onSelect?: (country: string) => void }) {
  const [features, setFeatures] = useState<Geo[] | null>(null);
  const [hover, setHover] = useState<{ code: string; x: number; y: number } | null>(null);
  useEffect(() => {
    loadWorld().then(setFeatures).catch(() => setFeatures([]));
  }, []);

  const byCountry = useMemo(() => new Map(data.filter((d) => d.country).map((d) => [d.country, d])), [data]);
  const max = Math.max(1, ...data.map((d) => d.visitors));
  const width = 800;
  const height = 400;
  const path = useMemo(() => {
    const projection = geoEqualEarth().fitSize([width, height], { type: "Sphere" } as never);
    return geoPath(projection);
  }, []);

  if (!features) return <div className="h-[260px] animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800/50" />;
  const hovered = hover ? byCountry.get(hover.code) : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full">
        {features.map((f, i) => {
          const code = NUMERIC_TO_ALPHA2.get(String(f.id ?? "").padStart(3, "0")) ?? "";
          const d = code ? byCountry.get(code) : undefined;
          const intensity = d ? 0.15 + 0.85 * Math.sqrt(d.visitors / max) : 0;
          return (
            <path
              key={i}
              d={path(f as never) ?? ""}
              className={d ? "cursor-pointer stroke-white dark:stroke-zinc-900" : "fill-zinc-200 stroke-white dark:fill-zinc-800 dark:stroke-zinc-900"}
              style={d ? { fill: "var(--color-brand-500)", fillOpacity: intensity } : undefined}
              strokeWidth={0.5}
              onMouseMove={(e) => {
                const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                setHover({ code, x: e.clientX - rect.left, y: e.clientY - rect.top });
              }}
              onMouseLeave={() => setHover(null)}
              onClick={() => d && onSelect?.(code)}
            />
          );
        })}
      </svg>
      {hover && (
        <div className="card pointer-events-none absolute z-10 px-2.5 py-1.5 text-xs shadow-md" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          <div className="font-medium">{countryName(hover.code)}</div>
          <div className="text-zinc-500">{num(hovered?.visitors ?? 0, false)} visitors</div>
        </div>
      )}
    </div>
  );
}
