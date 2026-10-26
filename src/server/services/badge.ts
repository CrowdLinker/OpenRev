import type { Database } from "../db/types";
import { startOfLocalDay } from "../lib/time";
import { REALTIME_WINDOW } from "./stats";

/**
 * The live badge ("● 3 online · 1,297 visitors today · stats →") that sites embed to link to their public
 * dashboard. It only exists for sites with a share link, and only shows two numbers that dashboard already
 * shows, so it reveals nothing the link doesn't.
 */
export interface BadgeData {
  online: number;
  today: number;
}

export const BADGE_TTL_MS = 30_000;
const MAX_CACHED = 1000;
const cache = new Map<string, { at: number; data: BadgeData | null }>();

export const isShareToken = (token: string) => /^[a-z0-9]{10,40}$/.test(token);

/** Counts for a share token, or null when no site has that token. Cached briefly per process. */
export async function badgeData(db: Database, token: string, now = Date.now()): Promise<BadgeData | null> {
  const hit = cache.get(token);
  if (hit && now - hit.at < BADGE_TTL_MS) return hit.data;

  const site = await db.first<{ id: string; timezone: string }>("SELECT id, timezone FROM sites WHERE share_token = ?", [token]);
  let data: BadgeData | null = null;
  if (site) {
    // Same definitions as the dashboard: visitors whose session started today (site time zone), and
    // visitors seen within the realtime window.
    const row = await db.first<{ today: number; online: number }>(
      `SELECT (SELECT COUNT(DISTINCT visitor_id) FROM sessions WHERE site_id = ? AND started_at >= ?) AS today,
              (SELECT COUNT(DISTINCT visitor_id) FROM sessions WHERE site_id = ? AND last_seen_at > ?) AS online`,
      [site.id, startOfLocalDay(site.timezone, now), site.id, now - REALTIME_WINDOW],
    );
    data = { online: Number(row?.online ?? 0), today: Number(row?.today ?? 0) };
  }

  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(token, { at: now, data });
  return data;
}

/** Forgets cached counts, e.g. when a share link is turned off. */
export function clearBadgeCache(token?: string | null) {
  if (token) cache.delete(token);
  else cache.clear();
}

// ---- SVG version, for READMEs and pages that can't run scripts --------------------------------------

const THEMES = {
  light: { bg: "#ffffff", border: "#e4e4e7", text: "#3f3f46", strong: "#16a34a", dot: "#22c55e" },
  dark: { bg: "#18181b", border: "#3f3f46", text: "#d4d4d8", strong: "#4ade80", dot: "#22c55e" },
} as const;

// Approximate advance widths for 12px system sans-serif, enough to size the pill without a font engine.
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (/[0-9]/.test(ch)) w += 6.8;
    else if (/[iljtf.,·'|!:]/.test(ch)) w += 3.4;
    else if (ch === " ") w += 3.4;
    else if (/[mw]/.test(ch)) w += 9.6;
    else if (/[A-Z]/.test(ch)) w += 8;
    else w += 6.6;
  }
  return w;
}

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function badgeSvg(data: BadgeData, theme: "light" | "dark" = "light"): string {
  const t = THEMES[theme];
  const fmt = new Intl.NumberFormat("en-US");
  const online = `${fmt.format(data.online)} online`;
  const rest = ` · ${fmt.format(data.today)} ${data.today === 1 ? "visitor" : "visitors"} today`;
  // One <text> with inline runs, so the browser does the spacing; the estimate only sizes the pill.
  const width = Math.ceil(26 + textWidth(online + rest) + 14);
  const height = 26;
  const label = `${online}${rest}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(label)}">
<title>${escapeXml(label)}</title>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${(height - 1) / 2}" fill="${t.bg}" stroke="${t.border}"/>
<circle cx="15" cy="13" r="6" fill="${t.dot}" opacity="0.25"><animate attributeName="r" values="4;7;4" dur="2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.35;0;0.35" dur="2s" repeatCount="indefinite"/></circle>
<circle cx="15" cy="13" r="4" fill="${t.dot}"/>
<text x="26" y="17" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="12" xml:space="preserve"><tspan fill="${t.strong}" font-weight="600">${escapeXml(online)}</tspan><tspan fill="${t.text}">${escapeXml(rest)}</tspan></text>
</svg>`;
}
