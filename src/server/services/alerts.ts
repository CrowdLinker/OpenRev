import type { Runtime } from "../context";
import { fromMinor } from "../lib/currency";
import { publicHttpsUrl } from "../lib/net";
import { uuid } from "../lib/ids";
import { formatLocalDate, localParts, resolveRange } from "../lib/time";
import { emailEnabled, escapeHtml, sendEmail } from "./email";
import type { PaymentRow } from "./payments";
import { getSite, type Site } from "./sites";
import * as stats from "./stats";

export const ALERT_TYPES = ["payment", "goal", "traffic_spike", "digest"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
export const ALERT_CHANNELS = ["slack", "discord", "telegram", "webhook", "email"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export interface AlertConfig {
  /** slack / discord / webhook URL */
  url?: string;
  /** telegram */
  botToken?: string;
  chatId?: string;
  /** email recipients (comma separated) */
  email?: string;
  /** payment alerts */
  includeRefunds?: boolean;
  minAmount?: number;
  /** goal alerts */
  goal?: string;
  /** traffic spike */
  multiplier?: number;
  minVisitors?: number;
  /** digest */
  frequency?: "daily" | "weekly";
  hour?: number;
}

export interface AlertRow {
  id: string;
  site_id: string;
  type: AlertType;
  channel: AlertChannel;
  config: string;
  enabled: number;
  created_at: number;
  last_triggered_at: number | null;
}

export interface Message {
  title: string;
  lines: string[];
  url?: string;
  /** structured payload for generic webhooks */
  event: string;
  data: Record<string, unknown>;
}

export function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(fromMinor(minor, currency));
  } catch {
    return `${fromMinor(minor, currency)} ${currency}`;
  }
}

export function flag(country: string | null | undefined): string {
  if (!country || country.length !== 2) return "🌐";
  return String.fromCodePoint(...[...country.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function countryName(code: string | null | undefined): string {
  if (!code) return "Unknown";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

function markdown(msg: Message, bold: (s: string) => string): string {
  return [bold(msg.title), ...msg.lines, msg.url ? msg.url : ""].filter(Boolean).join("\n");
}

export const TELEGRAM_TOKEN = /^\d{3,15}:[A-Za-z0-9_-]{20,64}$/;

// Services whose error responses are safe and useful to show (e.g. "chat not found").
const KNOWN_HOSTS = new Set(["hooks.slack.com", "discord.com", "discordapp.com", "api.telegram.org"]);

async function post(rt: Runtime, rawUrl: string, body: unknown) {
  const url = publicHttpsUrl(rawUrl);
  if (!url) throw new Error("The destination must be a public https:// URL");
  if (rt.isPublicHost && !(await rt.isPublicHost(url.hostname))) throw new Error("The destination resolves to a private or internal address");
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (res.status >= 300 && res.status < 400) throw new Error(`HTTP ${res.status}: redirects are not followed`);
  if (!res.ok) {
    const detail = KNOWN_HOSTS.has(url.hostname) ? `: ${(await res.text()).slice(0, 200)}` : "";
    throw new Error(`HTTP ${res.status}${detail}`);
  }
}

export async function deliver(rt: Runtime, channel: AlertChannel, config: AlertConfig, msg: Message, site: Site) {
  switch (channel) {
    case "slack":
      if (!config.url) throw new Error("Missing Slack webhook URL");
      return post(rt, config.url, { text: markdown(msg, (s) => `*${s}*`) });
    case "discord":
      if (!config.url) throw new Error("Missing Discord webhook URL");
      return post(rt, config.url, { content: markdown(msg, (s) => `**${s}**`).slice(0, 1900), username: "OpenRev" });
    case "telegram": {
      if (!config.botToken || !config.chatId) throw new Error("Missing Telegram bot token or chat id");
      if (!TELEGRAM_TOKEN.test(config.botToken)) throw new Error("Invalid Telegram bot token");
      const html = [`<b>${escapeHtml(msg.title)}</b>`, ...msg.lines.map(escapeHtml), msg.url ? escapeHtml(msg.url) : ""].filter(Boolean).join("\n");
      return post(rt, `https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        chat_id: config.chatId,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    }
    case "webhook":
      if (!config.url) throw new Error("Missing webhook URL");
      return post(rt, config.url, { event: msg.event, website: { id: site.id, domain: site.domain, name: site.name }, title: msg.title, text: msg.lines.join("\n"), url: msg.url ?? null, data: msg.data });
    case "email": {
      if (!emailEnabled(rt)) throw new Error("Email is not configured on this instance (RESEND_API_KEY)");
      const to = (config.email ?? "").split(",").map((e) => e.trim()).filter(Boolean);
      if (!to.length) throw new Error("Missing recipient email");
      const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;color:#111">
        <h2 style="margin:0 0 12px">${escapeHtml(msg.title)}</h2>
        ${msg.lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}
        ${msg.url ? `<p><a href="${escapeHtml(msg.url)}">Open in OpenRev →</a></p>` : ""}
        <p style="color:#888;font-size:12px;margin-top:24px">Sent by OpenRev for ${escapeHtml(site.domain)}</p></div>`;
      return sendEmail(rt, { to, subject: `[${site.domain}] ${msg.title}`, html, text: [msg.title, ...msg.lines, msg.url ?? ""].join("\n") });
    }
  }
}

async function trigger(rt: Runtime, alert: AlertRow, site: Site, msg: Message) {
  const config = JSON.parse(alert.config || "{}") as AlertConfig;
  let status = "sent";
  let error: string | null = null;
  try {
    await deliver(rt, alert.channel, config, msg, site);
  } catch (err) {
    status = "failed";
    error = err instanceof Error ? err.message : String(err);
  }
  await rt.db.batch([
    { sql: "UPDATE alerts SET last_triggered_at = ? WHERE id = ?", params: [Date.now(), alert.id] },
    {
      sql: "INSERT INTO alert_history (id, alert_id, site_id, ts, status, message) VALUES (?, ?, ?, ?, ?, ?)",
      params: [uuid(), alert.id, site.id, Date.now(), status, (error ? `${msg.title} — ${error}` : msg.title).slice(0, 500)],
    },
  ]);
  if (error) throw new Error(error);
}

const alertCache = new Map<string, { rows: AlertRow[]; at: number }>();
async function siteAlerts(rt: Runtime, siteId: string): Promise<AlertRow[]> {
  const hit = alertCache.get(siteId);
  if (hit && Date.now() - hit.at < 60_000) return hit.rows;
  const rows = await rt.db.all<AlertRow>("SELECT * FROM alerts WHERE site_id = ? AND enabled = 1", [siteId]);
  alertCache.set(siteId, { rows, at: Date.now() });
  return rows;
}
export function invalidateAlerts(siteId: string) {
  alertCache.delete(siteId);
}

function dashboardUrl(rt: Runtime, site: Site, path = "") {
  const base = rt.config.publicUrl?.replace(/\/$/, "");
  return base ? `${base}/sites/${site.id}${path}` : undefined;
}

// ---------------------------------------------------------------------------
// Payment alerts
// ---------------------------------------------------------------------------

export async function paymentMessage(rt: Runtime, site: Site, p: PaymentRow): Promise<Message> {
  const isRefund = p.type === "refund";
  const session = p.touch_session_id
    ? await rt.db.first<Record<string, string | number | null>>("SELECT * FROM sessions WHERE id = ?", [p.touch_session_id])
    : null;
  const lines: string[] = [];
  const amount = money(Math.abs(Number(p.revenue)), site.currency);
  const original = p.currency !== site.currency ? ` (${money(Math.abs(Number(p.amount)), p.currency)})` : "";
  if (p.description) lines.push(`🧾 ${p.description}`);
  if (session) {
    const campaign = session.utm_campaign ? ` · campaign "${session.utm_campaign}"` : "";
    lines.push(`📣 Source: ${session.source ?? "Direct"} (${session.channel})${campaign}`);
    lines.push(`${flag(session.country as string)} ${[session.city, countryName(session.country as string)].filter(Boolean).join(", ")} · ${session.device ?? ""} · ${session.browser ?? ""}`);
    if (session.entry_page) lines.push(`🛬 Landing page: ${session.entry_page}`);
  } else {
    lines.push("📣 Source: unattributed (no visitor id found)");
  }
  if (p.visitor_id) {
    const j = await rt.db.first<{ sessions: number; first: number; pages: number }>(
      `SELECT COUNT(*) AS sessions, MIN(started_at) AS first, SUM(pageviews) AS pages FROM sessions WHERE site_id = ? AND visitor_id = ?`,
      [site.id, p.visitor_id],
    );
    if (j && Number(j.sessions) > 0) {
      const days = Math.max(0, Math.round((Number(p.ts) - Number(j.first)) / 86_400_000));
      lines.push(`🧭 Journey: ${j.sessions} visit${Number(j.sessions) > 1 ? "s" : ""}, ${j.pages} pageviews, ${days === 0 ? "converted the same day" : `${days} day${days > 1 ? "s" : ""} to convert`}`);
    }
  }
  if (p.email || p.name) lines.push(`👤 ${[p.name, p.email].filter(Boolean).join(" · ")}`);
  lines.push(`💳 ${p.provider}${p.type === "renewal" ? " · renewal" : ""}`);
  return {
    title: isRefund ? `↩️ Refund: -${amount}${original}` : `💰 New ${p.type === "renewal" ? "renewal" : "sale"}: ${amount}${original}`,
    lines,
    url: p.visitor_id ? dashboardUrl(rt, site, `/visitors/${p.visitor_id}`) : dashboardUrl(rt, site, "/revenue"),
    event: isRefund ? "payment.refunded" : "payment.created",
    data: {
      id: p.id,
      provider: p.provider,
      transaction_id: p.transaction_id,
      type: p.type,
      amount: fromMinor(Number(p.amount), p.currency),
      currency: p.currency,
      revenue: fromMinor(Number(p.revenue), site.currency),
      revenue_currency: site.currency,
      visitor_id: p.visitor_id,
      email: p.email,
      source: session?.source ?? null,
      channel: session?.channel ?? null,
      country: session?.country ?? null,
      utm_campaign: session?.utm_campaign ?? null,
    },
  };
}

export async function notifyPayment(rt: Runtime, site: Site, p: PaymentRow): Promise<void> {
  const alerts = (await siteAlerts(rt, site.id)).filter((a) => a.type === "payment");
  if (!alerts.length) return;
  const msg = await paymentMessage(rt, site, p);
  await Promise.allSettled(
    alerts.map(async (a) => {
      const cfg = JSON.parse(a.config || "{}") as AlertConfig;
      if (p.type === "refund" && cfg.includeRefunds === false) return;
      if (cfg.minAmount && Math.abs(fromMinor(Number(p.revenue), site.currency)) < cfg.minAmount) return;
      await trigger(rt, a, site, msg);
    }),
  );
}

// ---------------------------------------------------------------------------
// Goal alerts
// ---------------------------------------------------------------------------

export async function notifyGoal(rt: Runtime, site: Site, goal: string, visitorId: string, sessionId: string) {
  const alerts = (await siteAlerts(rt, site.id)).filter((a) => a.type === "goal" && (JSON.parse(a.config || "{}") as AlertConfig).goal === goal);
  if (!alerts.length) return;
  const s = await rt.db.first<Record<string, string | null>>("SELECT source, channel, country, city, entry_page FROM sessions WHERE id = ?", [sessionId]);
  const v = await rt.db.first<{ name: string | null; email: string | null }>("SELECT name, email FROM visitors WHERE site_id = ? AND id = ?", [site.id, visitorId]);
  const msg: Message = {
    title: `🎯 Goal completed: ${goal}`,
    lines: [
      `📣 Source: ${s?.source ?? "Direct"} (${s?.channel ?? "Direct"})`,
      `${flag(s?.country)} ${[s?.city, countryName(s?.country)].filter(Boolean).join(", ")}`,
      ...(v?.name || v?.email ? [`👤 ${[v.name, v.email].filter(Boolean).join(" · ")}`] : []),
    ],
    url: dashboardUrl(rt, site, `/visitors/${visitorId}`),
    event: "goal.completed",
    data: { goal, visitor_id: visitorId, source: s?.source ?? null, channel: s?.channel ?? null, country: s?.country ?? null },
  };
  await Promise.allSettled(alerts.map((a) => trigger(rt, a, site, msg)));
}

// ---------------------------------------------------------------------------
// Scheduled: traffic spikes & digests
// ---------------------------------------------------------------------------

async function checkTrafficSpike(rt: Runtime, alert: AlertRow, site: Site, now: number) {
  const cfg = JSON.parse(alert.config || "{}") as AlertConfig;
  const multiplier = cfg.multiplier && cfg.multiplier > 1 ? cfg.multiplier : 4;
  const minVisitors = cfg.minVisitors && cfg.minVisitors > 0 ? cfg.minVisitors : 20;
  const hourEnd = Math.floor(now / 3_600_000) * 3_600_000;
  const hourStart = hourEnd - 3_600_000;
  if (alert.last_triggered_at && Number(alert.last_triggered_at) >= hourEnd - 60_000) return;
  const weekStart = hourStart - 7 * 24 * 3_600_000;
  const rows = await rt.db.all<{ source: string; recent: number; baseline: number; landing: string | null }>(
    `SELECT COALESCE(source, 'Direct') AS source,
            COUNT(DISTINCT CASE WHEN started_at >= ? THEN visitor_id END) AS recent,
            COUNT(DISTINCT CASE WHEN started_at < ? THEN visitor_id END) AS baseline,
            MAX(CASE WHEN started_at >= ? THEN entry_page END) AS landing
     FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at < ?
     GROUP BY COALESCE(source, 'Direct')`,
    [hourStart, hourStart, hourStart, site.id, weekStart, hourEnd],
  );
  for (const r of rows) {
    const recent = Number(r.recent);
    const avgHourly = Number(r.baseline) / (7 * 24);
    if (recent >= minVisitors && recent >= Math.max(1, avgHourly) * multiplier) {
      await trigger(rt, alert, site, {
        title: `🚀 Traffic spike from ${r.source}`,
        lines: [
          `${recent} visitors in the last hour (usually ~${avgHourly < 1 ? "<1" : Math.round(avgHourly)}/hour, ${(recent / Math.max(avgHourly, 1)).toFixed(1)}×)`,
          ...(r.landing ? [`🛬 Landing page: ${r.landing}`] : []),
        ],
        url: dashboardUrl(rt, site, `?filters=${encodeURIComponent(JSON.stringify([{ dim: "source", op: "is", values: [r.source] }]))}`),
        event: "traffic.spike",
        data: { source: r.source, visitors_last_hour: recent, average_hourly: avgHourly, landing_page: r.landing },
      });
      return;
    }
  }
}

export async function digestMessage(rt: Runtime, site: Site, frequency: "daily" | "weekly", now: number): Promise<Message> {
  const lp = localParts(site.timezone, now);
  const day = (offset: number) => new Date(Date.UTC(lp.year, lp.month - 1, lp.day + offset)).toISOString().slice(0, 10);
  const range =
    frequency === "daily"
      ? resolveRange(site.timezone, { period: "yesterday" }, now)
      : resolveRange(site.timezone, { from: day(-7), to: day(-1) }, now);
  const q = { site, range, filters: [] };
  const { current, previous } = await stats.overview(rt.db, q);
  const sources = await stats.breakdown(rt.db, q, "source", { limit: 5, sort: "revenue" });
  const pct = (a: number, b: number) => (b ? `${a >= b ? "▲" : "▼"} ${Math.abs(Math.round(((a - b) / b) * 100))}%` : "");
  const label = frequency === "daily" ? `Yesterday (${formatLocalDate(site.timezone, range.from)})` : `Last 7 days`;
  const lines = [
    `👀 Visitors: ${current.visitors} ${pct(current.visitors, previous?.visitors ?? 0)}`,
    `💰 Revenue: ${money(current.revenue, site.currency)} ${pct(current.revenue, previous?.revenue ?? 0)} · ${current.payments} payments`,
    `📈 Conversion rate: ${(current.conversion_rate * 100).toFixed(2)}% · Revenue/visitor: ${money(Math.round(current.revenue_per_visitor), site.currency)}`,
    "Top sources:",
    ...sources.filter((s) => s.visitors || s.revenue).map((s) => `  • ${s.value === stats.UNATTRIBUTED ? "Unattributed" : s.value || "Direct"}: ${s.visitors} visitors, ${money(s.revenue, site.currency)}`),
  ];
  return {
    title: `📊 ${site.name} — ${label}`,
    lines,
    url: dashboardUrl(rt, site),
    event: "digest",
    data: { frequency, from: range.from, to: range.to, ...current, top_sources: sources },
  };
}

async function checkDigest(rt: Runtime, alert: AlertRow, site: Site, now: number) {
  const cfg = JSON.parse(alert.config || "{}") as AlertConfig;
  const hour = Number.isFinite(cfg.hour) ? Number(cfg.hour) : 8;
  const local = localParts(site.timezone, now);
  if (local.hour !== hour) return;
  const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  if (cfg.frequency === "weekly" && weekday !== 1) return; // Mondays
  if (alert.last_triggered_at && now - Number(alert.last_triggered_at) < 20 * 3_600_000) return;
  await trigger(rt, alert, site, await digestMessage(rt, site, cfg.frequency === "weekly" ? "weekly" : "daily", now));
}

export async function runScheduledAlerts(rt: Runtime, now = Date.now()) {
  const alerts = await rt.db.all<AlertRow>("SELECT * FROM alerts WHERE enabled = 1 AND type IN ('traffic_spike', 'digest')");
  const sites = new Map<string, Site | null>();
  for (const alert of alerts) {
    if (!sites.has(alert.site_id)) sites.set(alert.site_id, await getSite(rt.db, alert.site_id));
    const site = sites.get(alert.site_id);
    if (!site) continue;
    try {
      if (alert.type === "traffic_spike") await checkTrafficSpike(rt, alert, site, now);
      else await checkDigest(rt, alert, site, now);
    } catch {
      /* recorded in alert_history by trigger() */
    }
  }
}

/** Sends a sample message so users can check their configuration. */
export async function sendTestAlert(rt: Runtime, alert: AlertRow, site: Site) {
  let msg: Message;
  if (alert.type === "digest") {
    const cfg = JSON.parse(alert.config || "{}") as AlertConfig;
    msg = await digestMessage(rt, site, cfg.frequency === "weekly" ? "weekly" : "daily", Date.now());
  } else {
    msg = {
      title: "✅ OpenRev test alert",
      lines: [`Your ${alert.type.replace("_", " ")} alert for ${site.domain} is set up correctly.`],
      url: dashboardUrl(rt, site),
      event: "test",
      data: { alert_id: alert.id, type: alert.type },
    };
  }
  await trigger(rt, alert, site, msg);
}
