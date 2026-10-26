#!/usr/bin/env node
// openrev: OpenRev analytics in the terminal. No dependencies; Node.js 18 or later.
import { createReadStream, realpathSync } from "node:fs";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** From package.json, so a release bumps the version in one place. */
export const VERSION = createRequire(import.meta.url)("./package.json").version;

const HELP = `openrev ${VERSION}: OpenRev analytics in your terminal

Usage: openrev <command> [options]

Commands
  login                 Save your OpenRev address and API key
  logout                Forget them
  sites                 Websites the key can read
  stats                 Visitors, revenue and conversion, with a chart (default)
  top <report>          Top pages, referrers, channels, countries, campaigns, devices,
                        browsers, os, goals, entry-pages, exit-pages, hostnames
  live                  Visitors online now and their sessions (--watch to refresh)
  mrr                   MRR, churn and net revenue retention
  payments              Recent payments and what brought them
  keywords              Google search keywords (Search Console)
  social                Posts on X and Hacker News and what they brought
  crawlers              AI crawler and search engine requests
  crawls send <log...>  Send the crawler requests in access logs (nginx or Apache
                        "combined" format) to OpenRev

Options
  -p, --period <p>      today, yesterday, 24h, 7d (default), 30d, 90d, wtd, mtd, ytd, 12m, all
      --from <date>     Start date (YYYY-MM-DD), with --to
      --to <date>       End date (YYYY-MM-DD)
  -s, --site <site>     Website id or domain (keys for one website don't need it)
  -n, --limit <n>       Rows to show, 1 to 200 (default 10)
      --by <metric>     Sort "top" by visitors (default), revenue or conversion
      --watch           Keep "live" open, refreshing every 5 seconds
      --dry-run         "crawls send": count what would be sent, send nothing
      --json            Print the API's JSON
      --url <url>       OpenRev address (or OPENREV_URL)
      --key <key>       API key (or OPENREV_API_KEY)
      --no-color        Plain output (or NO_COLOR=1)
  -h, --help            This help
  -v, --version         The version

Create an API key in OpenRev: Settings → API & MCP.
Docs: https://github.com/CrowdLinker/OpenRev/blob/main/docs/guides/cli.md
`;

const OPTIONS = {
  period: { type: "string", short: "p" },
  from: { type: "string" },
  to: { type: "string" },
  site: { type: "string", short: "s" },
  limit: { type: "string", short: "n" },
  by: { type: "string" },
  watch: { type: "boolean" },
  "dry-run": { type: "boolean" },
  json: { type: "boolean" },
  url: { type: "string" },
  key: { type: "string" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};

const REPORTS = {
  pages: "Page",
  referrers: "Referrer",
  sources: "Referrer",
  channels: "Channel",
  countries: "Country",
  regions: "Region",
  cities: "City",
  campaigns: "Campaign",
  devices: "Device",
  browsers: "Browser",
  os: "OS",
  "operating-systems": "OS",
  goals: "Goal",
  "entry-pages": "Entry page",
  "exit-pages": "Exit page",
  hostnames: "Hostname",
  "exit-clicks": "Exit link",
};

class CliError extends Error {}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function makeOutput(io, color) {
  const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  const c = { bold: paint(1), dim: paint(2), green: paint(32), red: paint(31), yellow: paint(33), cyan: paint(36), magenta: paint(35) };
  const width = () => Math.max(40, Math.min(io.stdout.columns || 100, 140));
  const print = (s = "") => io.stdout.write(s + "\n");
  return { c, width, print };
}

const visibleLength = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s, n, right) => {
  const gap = Math.max(0, n - visibleLength(s));
  return right ? " ".repeat(gap) + s : s + " ".repeat(gap);
};
const cut = (s, n) => {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
};

/** A table: columns are { label, value(row), right?, flex? }. The flex column takes what's left of the width. */
function table(out, rows, columns) {
  const cells = rows.map((r) => columns.map((col) => String(col.value(r) ?? "")));
  const widths = columns.map((col, i) => Math.max(visibleLength(col.label), ...cells.map((r) => visibleLength(r[i]))));
  const flex = columns.findIndex((col) => col.flex);
  if (flex >= 0) {
    const others = widths.reduce((n, w, i) => (i === flex ? n : n + w + 2), 0);
    widths[flex] = Math.max(12, Math.min(widths[flex], out.width() - others - 2));
  }
  const line = (vals) => ("  " + vals.map((v, i) => pad(i === flex ? cut(v, widths[i]) : v, widths[i], columns[i].right)).join("  ")).trimEnd();
  out.print(out.c.dim(line(columns.map((col) => col.label))));
  for (const r of cells) out.print(line(r));
}

const DIGITS = (cur) => {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: cur }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
};
/** Amounts from the API are in minor units (cents). */
function money(minor, cur = "USD", compact = false) {
  const value = Number(minor || 0) / 10 ** DIGITS(cur);
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: cur,
      notation: compact && Math.abs(value) >= 10_000 ? "compact" : "standard",
      maximumFractionDigits: compact && Math.abs(value) >= 1000 ? 0 : DIGITS(cur),
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${cur}`;
  }
}
const num = (n) => new Intl.NumberFormat("en", { notation: Math.abs(Number(n)) >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(Number(n || 0));
const pct = (r, digits = 1) => (r === null || r === undefined ? "—" : `${(Number(r) * 100).toFixed(digits)}%`);
const duration = (s) => {
  s = Math.round(Number(s || 0));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
const ago = (ts, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - Number(ts)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const SPARKS = "▁▂▃▄▅▆▇█";
function sparkline(values) {
  const max = Math.max(...values, 0);
  return values.map((v) => (max ? SPARKS[Math.min(7, Math.round((v / max) * 7))] : SPARKS[0])).join("");
}
function delta(out, current, previous, invert = false) {
  if (previous === undefined || previous === null || !Number(previous)) return "";
  const change = (Number(current) - Number(previous)) / Number(previous);
  if (!Number.isFinite(change) || Math.abs(change) < 0.0005) return out.c.dim("  0%");
  const good = invert ? change < 0 : change > 0;
  const s = `${change > 0 ? "▲" : "▼"} ${Math.abs(change * 100).toFixed(Math.abs(change) < 0.1 ? 1 : 0)}%`;
  return good ? out.c.green(s) : out.c.red(s);
}
const bar = (share, width = 12) => "█".repeat(Math.round(Math.max(0, Math.min(1, share)) * width)).padEnd(width, " ");

// ---------------------------------------------------------------------------
// Config and API
// ---------------------------------------------------------------------------

export function configPath(env, home = homedir()) {
  const base = env.XDG_CONFIG_HOME || (process.platform === "win32" && env.APPDATA) || join(home, ".config");
  return join(base, "openrev", "config.json");
}

async function readConfig(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

function makeApi(io, url, key) {
  const base = url.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return async function call(path, { query = {}, body } = {}) {
    const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ""));
    const qs = q.toString();
    const target = `${base}/api/v1${path}${qs ? `?${qs}` : ""}`;
    let res;
    try {
      res = await io.fetch(target, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${key}`, "User-Agent": `openrev-cli/${VERSION}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new CliError(`Can't reach ${base} (${err.cause?.code ?? err.message})`);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.status === "error") {
      const message = json?.error?.message ?? `${res.status} ${res.statusText}`;
      if (res.status === 401) throw new CliError(`${message}. Run "openrev login" with a key from Settings → API & MCP.`);
      throw new CliError(message);
    }
    return json;
  };
}

/** Asks one question. Without input (stdin closed or at its end, as in CI) the answer is empty. */
async function prompt(io, question, { hidden = false } = {}) {
  if (io.stdin.readableEnded) return "";
  const rl = createInterface({ input: io.stdin, output: io.stdout, terminal: !!io.stdin.isTTY });
  if (hidden && io.stdin.isTTY) {
    // Echo nothing while the key is typed.
    rl._writeToOutput = (s) => {
      if (s.includes(question)) io.stdout.write(s);
    };
  }
  // readline never answers a question once the input ends: its close event does.
  const answer = await new Promise((resolve) => {
    rl.once("close", () => resolve(""));
    rl.question(question, resolve);
  });
  rl.close();
  if (hidden && io.stdin.isTTY) io.stdout.write("\n");
  return answer.trim();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function rangeQuery(v) {
  if (v.from || v.to) {
    if (!v.from || !v.to) throw new CliError("Use --from and --to together (YYYY-MM-DD)");
    return { period: "custom", from: v.from, to: v.to };
  }
  return { period: v.period ?? "7d" };
}

function rangeLabel(range) {
  if (!range) return "";
  return range.fromDate === range.toDate ? range.fromDate : `${range.fromDate} → ${range.toDate}`;
}

async function resolveSite(ctx) {
  const wanted = ctx.values.site ?? ctx.env.OPENREV_SITE ?? ctx.config.site;
  const sites = (await ctx.api("/websites")).data ?? [];
  if (!sites.length) throw new CliError("This key can't read any website");
  if (wanted) {
    const w = String(wanted).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    const site = sites.find((s) => s.id.toLowerCase() === w || s.domain.toLowerCase() === w);
    if (!site) throw new CliError(`No website "${wanted}" for this key. Run "openrev sites".`);
    return site;
  }
  if (sites.length === 1) return sites[0];
  throw new CliError(`This key reads ${sites.length} websites: pick one with --site (${sites.map((s) => s.domain).join(", ")})`);
}

function header(ctx, site, range, title) {
  const { c, print } = ctx.out;
  print(`${c.bold(site.domain)}  ${c.dim(`${title}${range ? ` · ${rangeLabel(range)}` : ""}`)}`);
  print();
}

async function cmdStats(ctx) {
  const site = await resolveSite(ctx);
  const q = { websiteId: site.id, ...rangeQuery(ctx.values) };
  const [overview, series] = await Promise.all([ctx.api("/analytics/overview", { query: q }), ctx.api("/analytics/timeseries", { query: q })]);
  if (ctx.values.json) return ctx.out.print(JSON.stringify({ overview, timeseries: series }, null, 2));
  const d = overview.data;
  const p = overview.previous ?? {};
  const cur = d.currency ?? site.currency;
  const { c, print } = ctx.out;
  header(ctx, site, overview.range, "Overview");
  const rows = [
    ["Visitors", num(d.visitors), delta(ctx.out, d.visitors, p.visitors)],
    ["Pageviews", num(d.pageviews), delta(ctx.out, d.pageviews, p.pageviews)],
    ["Bounce rate", pct(d.bounce_rate, 0), delta(ctx.out, d.bounce_rate, p.bounce_rate, true)],
    ["Visit duration", duration(d.avg_session_duration), delta(ctx.out, d.avg_session_duration, p.avg_session_duration)],
    ["Revenue", c.green(money(d.revenue, cur)), delta(ctx.out, d.revenue, p.revenue)],
    ["Customers", num(d.customers), delta(ctx.out, d.customers, p.customers)],
    ["Conversion rate", pct(d.conversion_rate, 2), delta(ctx.out, d.conversion_rate, p.conversion_rate)],
    ["Revenue per visitor", money(d.revenue_per_visitor, cur), delta(ctx.out, d.revenue_per_visitor, p.revenue_per_visitor)],
  ];
  if (d.kpi) rows.push([`Goal: ${d.kpi.goal}`, `${num(d.kpi.conversions)} (${pct(d.kpi.conversion_rate)})`, ""]);
  for (const [label, value, change] of rows) print(`  ${pad(c.dim(label), 22)}${pad(value, 14, true)}  ${change}`);
  const points = series.data ?? [];
  if (points.length > 1) {
    print();
    const spark = sparkline(points.map((x) => Number(x.visitors)));
    print(`  ${c.dim("Visitors")}  ${c.cyan(spark)}`);
    if (points.some((x) => Number(x.revenue))) print(`  ${c.dim("Revenue ")}  ${c.green(sparkline(points.map((x) => Math.max(0, Number(x.revenue)))))}`);
    const first = String(points[0].date);
    const last = String(points.at(-1).date);
    const gap = points.length - first.length - last.length;
    print(`  ${c.dim(" ".repeat(10) + (gap > 0 ? first + " ".repeat(gap) + last : `${first} → ${last}`))}`);
  }
}

async function cmdTop(ctx) {
  const report = (ctx.positionals[1] ?? "").toLowerCase();
  if (!REPORTS[report]) throw new CliError(`Pick a report: ${Object.keys(REPORTS).filter((r) => !["sources", "operating-systems"].includes(r)).join(", ")}`);
  const site = await resolveSite(ctx);
  const by = { revenue: "revenue", conversion: "conversion_rate", visitors: "visitors", completions: "completions" }[ctx.values.by ?? "visitors"];
  if (!by) throw new CliError("--by is visitors, revenue or conversion");
  const res = await ctx.api(`/analytics/${report}`, { query: { websiteId: site.id, ...rangeQuery(ctx.values), limit: ctx.limit, sort: by } });
  if (ctx.values.json) return ctx.out.print(JSON.stringify(res, null, 2));
  const rows = res.data ?? [];
  const cur = res.currency ?? site.currency;
  header(ctx, site, res.range, `Top ${report}`);
  if (!rows.length) return ctx.out.print(ctx.out.c.dim("  Nothing in this period"));
  const isGoal = report === "goals";
  // The bars follow the sort, or visitors when sorting by a rate.
  const metric = isGoal ? "completions" : by === "revenue" ? "revenue" : "visitors";
  const max = Math.max(...rows.map((r) => Number(r[metric]) || 0), 1);
  const countries = report === "countries" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
  const label = (r) => {
    if (r.value === "__unattributed__") return "(not linked to a visit)";
    if (r.value === "" || r.value === null) return "(none)";
    if (countries) {
      try {
        return countries.of(r.value) ?? r.value;
      } catch {
        return r.value;
      }
    }
    return r.value;
  };
  table(ctx.out, rows, [
    { label: REPORTS[report], value: label, flex: true },
    { label: "", value: (r) => ctx.out.c.cyan(bar((Number(r[metric]) || 0) / max)) },
    isGoal ? { label: "Completions", value: (r) => num(r.completions), right: true } : { label: "Visitors", value: (r) => num(r.visitors), right: true },
    { label: "Revenue", value: (r) => (Number(r.revenue) ? money(r.revenue, cur, true) : ctx.out.c.dim("—")), right: true },
    { label: "Conv.", value: (r) => pct(r.conversion_rate), right: true },
  ]);
}

async function cmdLive(ctx) {
  const site = await resolveSite(ctx);
  const show = async () => {
    const res = await ctx.api("/analytics/realtime", { query: { websiteId: site.id } });
    if (ctx.values.json) return ctx.out.print(JSON.stringify(res, null, 2));
    const d = res.data;
    const { c, print } = ctx.out;
    if (ctx.values.watch && ctx.io.stdout.isTTY) ctx.io.stdout.write("\x1b[2J\x1b[H");
    print(`${c.bold(site.domain)}  ${c.green("●")} ${c.bold(num(d.visitors))} ${d.visitors === 1 ? "visitor" : "visitors"} online ${c.dim(new Date().toLocaleTimeString())}`);
    print();
    const sessions = (d.sessions ?? []).slice(0, ctx.limit);
    if (sessions.length) {
      table(ctx.out, sessions, [
        { label: "Visitor", value: (s) => s.name || s.email || `${s.is_new ? "New" : "Returning"} visitor` },
        { label: "Page", value: (s) => s.page, flex: true },
        { label: "Source", value: (s) => s.source ?? "Direct" },
        { label: "Where", value: (s) => [s.city, s.country].filter(Boolean).join(", ") || "—" },
        { label: "Pages", value: (s) => num(s.pageviews), right: true },
        { label: "Seen", value: (s) => ago(s.last_seen_at), right: true },
      ]);
    } else print(c.dim("  No one right now"));
    const pays = d.recent_payments ?? [];
    if (pays.length) {
      print();
      print(c.dim("  Payments in the last 24 hours"));
      for (const p of pays.slice(0, 5)) {
        print(`  ${pad(c.green(money(p.revenue, res.currency ?? site.currency)), 12, true)}  ${p.name || p.email || "Customer"}  ${c.dim(`${p.source ?? "Direct"} · ${ago(p.ts)}`)}`);
      }
    }
  };
  await show();
  if (!ctx.values.watch || ctx.values.json) return;
  // Refreshes until Ctrl+C.
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    await show();
  }
}

async function cmdMrr(ctx) {
  const site = await resolveSite(ctx);
  const res = await ctx.api("/analytics/mrr", { query: { websiteId: site.id, ...rangeQuery(ctx.values) } });
  if (ctx.values.json) return ctx.out.print(JSON.stringify(res, null, 2));
  const s = res.data.summary;
  const cur = res.currency ?? site.currency;
  const { c, print } = ctx.out;
  header(ctx, site, res.range, "MRR");
  const signed = (v) => (Number(v) > 0 ? c.green(`+${money(v, cur)}`) : Number(v) < 0 ? c.red(`−${money(-v, cur)}`) : c.dim(money(0, cur)));
  const rows = [
    ["MRR", c.bold(c.green(money(s.mrr, cur))), `${signed(s.net_change)} in this period`],
    ["ARR", money(s.arr, cur), ""],
    ["Subscribers", num(s.subscribers), c.dim(`${s.new_subscribers} new · ${s.churned_subscribers} churned`)],
    ["Revenue per subscriber", money(s.arpu, cur), c.dim("per month")],
    ["Subscriber churn", pct(s.churn_rate), ""],
    ["Revenue churn", pct(s.revenue_churn_rate), ""],
    ["Net revenue retention", pct(s.net_revenue_retention), ""],
  ];
  for (const [label, value, note] of rows) print(`  ${pad(c.dim(label), 24)}${pad(value, 14, true)}  ${note}`);
  print();
  print(`  ${c.dim("Movements")}  new ${signed(s.new)}  expansion ${signed(s.expansion)}  reactivation ${signed(s.reactivation)}  contraction ${signed(s.contraction)}  churn ${signed(s.churn)}`);
  const points = res.data.timeseries ?? [];
  if (points.length > 1) print(`  ${c.dim("MRR      ")}  ${c.green(sparkline(points.map((x) => Number(x.mrr))))}`);
}

async function cmdPayments(ctx) {
  const site = await resolveSite(ctx);
  const res = await ctx.api("/payments", { query: { websiteId: site.id, ...rangeQuery(ctx.values), limit: ctx.limit } });
  if (ctx.values.json) return ctx.out.print(JSON.stringify(res, null, 2));
  const cur = res.currency ?? site.currency;
  header(ctx, site, res.range, "Payments");
  const rows = res.data ?? [];
  if (!rows.length) return ctx.out.print(ctx.out.c.dim("  No payments in this period"));
  table(ctx.out, rows, [
    { label: "When", value: (p) => new Date(Number(p.ts)).toISOString().slice(0, 16).replace("T", " ") },
    { label: "Amount", value: (p) => (Number(p.revenue) < 0 ? ctx.out.c.red(money(p.revenue, cur)) : ctx.out.c.green(money(p.revenue, cur))), right: true },
    { label: "Type", value: (p) => p.type },
    { label: "Customer", value: (p) => p.name || p.visitor_name || p.email || "—", flex: true },
    { label: "Source", value: (p) => p.source ?? (p.visitor_id ? "Direct" : "(not linked)") },
    { label: "Campaign", value: (p) => p.utm_campaign ?? "" },
    { label: "Country", value: (p) => p.country ?? "" },
  ]);
}

async function cmdKeywords(ctx) {
  const site = await resolveSite(ctx);
  const by = ctx.values.by === "revenue" ? "revenue" : ctx.values.by === "impressions" ? "impressions" : "clicks";
  const res = await ctx.api("/analytics/search-keywords", { query: { websiteId: site.id, ...rangeQuery(ctx.values), sort: by, limit: ctx.limit } });
  if (ctx.values.json) return ctx.out.print(JSON.stringify(res, null, 2));
  const cur = res.currency ?? site.currency;
  header(ctx, site, res.range, "Google search keywords");
  const rows = res.data ?? [];
  if (!rows.length) return ctx.out.print(ctx.out.c.dim("  No keywords. Connect Search Console in Settings → General."));
  table(ctx.out, rows, [
    { label: "Keyword", value: (r) => r.query, flex: true },
    { label: "Clicks", value: (r) => num(r.clicks), right: true },
    { label: "Impr.", value: (r) => num(r.impressions), right: true },
    { label: "CTR", value: (r) => pct(r.ctr), right: true },
    { label: "Pos.", value: (r) => Number(r.position).toFixed(1), right: true },
    { label: "Revenue", value: (r) => (Number(r.revenue) ? money(r.revenue, cur, true) : ctx.out.c.dim("—")), right: true },
  ]);
}

async function cmdSocial(ctx) {
  const site = await resolveSite(ctx);
  const res = await ctx.api("/analytics/social", { query: { websiteId: site.id, ...rangeQuery(ctx.values), limit: ctx.limit } });
  if (ctx.values.json) return ctx.out.print(JSON.stringify(res, null, 2));
  const d = res.data;
  const cur = res.currency ?? site.currency;
  const { c, print } = ctx.out;
  header(ctx, site, res.range, "Social");
  for (const [key, name] of [
    ["x", "X"],
    ["hn", "Hacker News"],
  ]) {
    const s = d.summary[key];
    if (s) print(`  ${pad(c.dim(name), 14)}${pad(num(s.mentions), 5, true)} posts  ${pad(num(s.visits), 6, true)} visits (${num(s.credited_visits)} matched)  ${c.green(money(s.credited_revenue, cur))}`);
  }
  print();
  if (!d.posts.length && !d.profiles.length) return print(c.dim("  No posts. Watch X and Hacker News in Settings → General."));
  table(ctx.out, [...d.posts, ...d.profiles], [
    { label: "", value: (p) => (p.platform === "hn" ? c.yellow("Y") : "𝕏") },
    { label: "Author", value: (p) => (p.author ? (p.platform === "x" ? `@${p.author}` : p.author) : "—") },
    { label: "Post", value: (p) => (p.id.startsWith("bio:") ? `Link in bio: ${p.links.join(" ")}` : (p.text ?? "").replace(/\s+/g, " ")), flex: true },
    { label: "When", value: (p) => (p.created_at ? ago(p.created_at) : ""), right: true },
    { label: "Visitors", value: (p) => num(p.visitors), right: true },
    { label: "Revenue", value: (p) => (Number(p.revenue) ? c.green(money(p.revenue, cur, true)) : c.dim("—")), right: true },
  ]);
}

async function cmdCrawlers(ctx) {
  const site = await resolveSite(ctx);
  const res = await ctx.api("/analytics/crawlers", { query: { websiteId: site.id, ...rangeQuery(ctx.values) } });
  if (ctx.values.json) return ctx.out.print(JSON.stringify(res, null, 2));
  const d = res.data;
  const { c, print } = ctx.out;
  header(ctx, site, res.range, "Crawlers");
  const s = d.summary;
  print(`  ${c.dim("AI training")} ${num(s.ai_training)}   ${c.dim("AI search")} ${num(s.ai_search)}   ${c.dim("AI assistants")} ${num(s.ai_user)}   ${c.dim("Search engines")} ${num(s.search)}`);
  print(`  ${c.dim("Visitors from AI")} ${num(s.ai_visitors)}   ${c.dim("Revenue from AI")} ${c.green(money(s.ai_revenue, res.currency ?? site.currency))}`);
  print();
  if (!d.crawlers.length) return print(c.dim('  No crawler requests. Your server can report them (see the Crawlers page), or send access logs with "openrev crawls send".'));
  const labels = { ai_training: "AI training", ai_search: "AI search", ai_user: "AI assistant", search: "Search" };
  table(ctx.out, d.crawlers.slice(0, ctx.limit), [
    { label: "Crawler", value: (r) => r.name },
    { label: "Operator", value: (r) => r.operator ?? "" },
    { label: "Category", value: (r) => labels[r.category] ?? r.category },
    { label: "Requests", value: (r) => num(r.hits), right: true },
    { label: "Pages", value: (r) => num(r.pages), right: true },
  ]);
}

// 1.2.3.4 - - [26/Oct/2026:09:12:00 +0000] "GET /pricing HTTP/1.1" 200 5120 "-" "Mozilla/5.0 (compatible; GPTBot/1.2)"
// The path stops at a space or quote, so no two parts of the pattern can match the same characters: a crafted request
// line can't make it backtrack.
const LOG_LINE = /^\S+ \S+ \S+ \[([^\]]+)\] "(?:GET|HEAD) ([^\s"]+)(?: [^"]*)?" \d{3} \S+ "[^"]*" "([^"]*)"/;

/** Parses one access log line in the "combined" format: { path, user_agent, timestamp } or null. */
export function parseLogLine(line) {
  const m = LOG_LINE.exec(line);
  if (!m) return null;
  // "26/Oct/2026:09:12:00 +0000" → "26 Oct 2026 09:12:00 +0000"
  const timestamp = Date.parse(m[1].replace(":", " ").replaceAll("/", " "));
  return { path: m[2], user_agent: m[3], timestamp: Number.isFinite(timestamp) ? timestamp : undefined };
}

async function cmdCrawlsSend(ctx) {
  const files = ctx.positionals.slice(2);
  if (!files.length) throw new CliError("Usage: openrev crawls send <access.log> [more logs]");
  const site = await resolveSite(ctx);
  // The crawler list comes from the server, so it stays current; the server checks each user agent again.
  const pattern = new RegExp((await ctx.api("/analytics/crawlers", { query: { websiteId: site.id, period: "today" } })).data.pattern, "i");
  const { c, print } = ctx.out;
  let lines = 0;
  let matched = 0;
  let recorded = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    if (!ctx.values["dry-run"]) recorded += (await ctx.api("/crawls", { query: { websiteId: site.id }, body: { hits: batch } })).data.recorded;
    batch = [];
  };
  for (const file of files) {
    if (file !== "-") await access(file).catch((err) => Promise.reject(new CliError(`Can't read ${file}: ${err.code ?? err.message}`)));
    const stream = file === "-" ? ctx.io.stdin : createReadStream(file);
    try {
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        lines++;
        const hit = parseLogLine(line);
        if (!hit || !pattern.test(hit.user_agent)) continue;
        matched++;
        batch.push(hit);
        if (batch.length === 1000) await flush();
      }
    } catch (err) {
      throw err instanceof CliError ? err : new CliError(`Can't read ${file}: ${err.code ?? err.message}`);
    }
  }
  await flush();
  if (ctx.values.json) return print(JSON.stringify({ lines, matched, recorded, dry_run: !!ctx.values["dry-run"] }));
  print(`${c.bold(site.domain)}  ${num(lines)} lines, ${num(matched)} from crawlers`);
  print(ctx.values["dry-run"] ? c.dim("  Dry run: nothing sent") : `  ${c.green("✓")} Sent ${num(matched)}, ${num(recorded)} recorded`);
  print(c.dim("  Sending the same log again counts its requests again."));
}

async function cmdSites(ctx) {
  const res = await ctx.api("/websites");
  if (ctx.values.json) return ctx.out.print(JSON.stringify(res, null, 2));
  table(ctx.out, res.data ?? [], [
    { label: "Domain", value: (s) => s.domain },
    { label: "Name", value: (s) => s.name ?? "", flex: true },
    { label: "Id", value: (s) => s.id },
    { label: "Currency", value: (s) => s.currency },
    { label: "Time zone", value: (s) => s.timezone },
  ]);
}

async function cmdLogin(ctx) {
  const { c, print } = ctx.out;
  let url = ctx.values.url ?? ctx.env.OPENREV_URL;
  let key = ctx.values.key ?? ctx.env.OPENREV_API_KEY;
  if (!url) url = await prompt(ctx.io, "OpenRev address (https://analytics.example.com): ");
  if (!url) throw new CliError("No OpenRev address: pass --url or set OPENREV_URL");
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  if (!key) key = await prompt(ctx.io, "API key (Settings → API & MCP): ", { hidden: true });
  if (!key) throw new CliError("No API key: pass --key or set OPENREV_API_KEY");
  const api = makeApi(ctx.io, url, key);
  const sites = (await api("/websites")).data ?? [];
  const config = { url: url.replace(/\/+$/, ""), key };
  if (ctx.values.site) config.site = ctx.values.site;
  await mkdir(dirname(ctx.configFile), { recursive: true, mode: 0o700 });
  // writeFile's mode only applies to a new file: an existing one is made private before the key goes in.
  await chmod(ctx.configFile, 0o600).catch((err) => {
    if (err.code !== "ENOENT") throw err;
  });
  await writeFile(ctx.configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  print(`${c.green("✓")} Saved to ${ctx.configFile}`);
  print(`  ${sites.length === 1 ? "Website" : "Websites"}: ${sites.map((s) => s.domain).join(", ") || "none"}`);
  if (sites.length > 1 && !config.site) print(c.dim(`  Pick one with --site, or set it as the default: openrev login --site ${sites[0].domain}`));
}

async function cmdLogout(ctx) {
  await rm(ctx.configFile, { force: true });
  ctx.out.print(`Removed ${ctx.configFile}`);
}

const COMMANDS = {
  stats: cmdStats,
  top: cmdTop,
  live: cmdLive,
  realtime: cmdLive,
  mrr: cmdMrr,
  payments: cmdPayments,
  keywords: cmdKeywords,
  social: cmdSocial,
  crawlers: cmdCrawlers,
  sites: cmdSites,
  login: cmdLogin,
  logout: cmdLogout,
};

/** Runs the CLI. `io` swaps in fetch, streams and the environment for tests. Returns the exit code. */
export async function main(argv, io = {}) {
  io = { fetch: globalThis.fetch, stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env, home: homedir(), ...io };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    io.stderr.write(`${err.message}\nRun "openrev --help" for the options.\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const color = !values["no-color"] && !io.env.NO_COLOR && !!io.stdout.isTTY && !values.json;
  const out = makeOutput(io, color);
  if (values.version) {
    out.print(VERSION);
    return 0;
  }
  if (values.help || positionals[0] === "help") {
    io.stdout.write(HELP);
    return 0;
  }

  const name = positionals[0] ?? "stats";
  const configFile = configPath(io.env, io.home);
  const config = await readConfig(configFile);
  try {
    let run = COMMANDS[name];
    if (name === "crawls") {
      if (positionals[1] !== "send") throw new CliError('Usage: openrev crawls send <access.log>  (for the report: "openrev crawlers")');
      run = cmdCrawlsSend;
    }
    if (!run) throw new CliError(`Unknown command "${name}". Run "openrev --help".`);
    const limit = values.limit === undefined ? 10 : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new CliError("--limit is a whole number from 1 to 200");
    const ctx = { io, env: io.env, values, positionals, out, config, configFile, limit };
    if (run !== cmdLogin && run !== cmdLogout) {
      const url = values.url ?? io.env.OPENREV_URL ?? config.url;
      const key = values.key ?? io.env.OPENREV_API_KEY ?? config.key;
      if (!url || !key) throw new CliError('Run "openrev login" first, or set OPENREV_URL and OPENREV_API_KEY.');
      ctx.api = makeApi(io, url, key);
    }
    await run(ctx);
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr.write(`${color ? "\x1b[31m✖\x1b[0m" : "✖"} ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

// Run when executed (also through npm's bin symlink), not when imported: tests import main.
const invoked = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invoked) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
