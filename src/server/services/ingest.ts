import type { Runtime } from "../context";
import type { Statement } from "../db/types";
import { isBot } from "../lib/bots";
import { sha256Hex } from "../lib/crypto";
import { normalizeGeo, type GeoInfo } from "../lib/geo";
import { isValidClientId, randomToken, uuid } from "../lib/ids";
import { classify, CLICK_ID_PARAMS } from "../lib/referrers";
import { parseUserAgent } from "../lib/ua";
import { clampString, ipMatches, isEmail, matchPath, sanitizeGoalName, sanitizeProps } from "../lib/validate";
import { notifyGoal } from "./notify";
import { attachVisitorToPayments } from "./payments";
import { getSiteCached, hostAllowed, siteHosts, type Site } from "./sites";

/** Avatar URLs are shown in the dashboard, so only keep plain https:// image links. */
function imageUrl(value: unknown): string | null {
  const url = clampString(value, 250);
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export const SESSION_TIMEOUT = 30 * 60 * 1000;

/** Payload sent by the tracking script (and accepted by the server-side events API). */
export interface IncomingEvent {
  type?: string;
  websiteId?: string;
  href?: string;
  referrer?: string | null;
  visitorId?: string | null;
  sessionId?: string | null;
  /** goal name (type=goal) */
  name?: string;
  props?: Record<string, unknown>;
  screenWidth?: number;
  language?: string;
  /** engaged time on the current page in ms (type=engagement) */
  engagedMs?: number;
  /** destination URL (type=outbound) */
  url?: string;
  // identify
  userId?: string;
  email?: string;
  image?: string;
  // payment hints
  provider?: string;
  ref?: string;
  /** hash-based routing: include location.hash in the path */
  hash?: boolean;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string;
  geo: GeoInfo | null;
  /** True for server-side API calls (skip bot and hostname checks). */
  trusted?: boolean;
}

export type IngestResult = { ok: true; visitorId: string; sessionId: string } | { ok: false; reason: string };

const VALID_TYPES = new Set(["pageview", "goal", "engagement", "identify", "payment", "outbound"]);

export function normalizePath(url: URL, includeHash: boolean): string {
  let path = url.pathname || "/";
  try {
    path = decodeURI(path);
  } catch {
    /* keep encoded */
  }
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (includeHash && url.hash && url.hash.length > 1) path += url.hash;
  return path.slice(0, 500);
}

/** Daily rotating salt for cookieless visitor ids. */
async function dailySalt(rt: Runtime, now: number): Promise<string> {
  const day = new Date(now).toISOString().slice(0, 10);
  const cached = saltCache.get(day);
  if (cached) return cached;
  let row = await rt.db.first<{ salt: string }>("SELECT salt FROM salts WHERE day = ?", [day]);
  if (!row) {
    await rt.db.run("INSERT INTO salts (day, salt) VALUES (?, ?) ON CONFLICT (day) DO NOTHING", [day, randomToken(16)]);
    row = await rt.db.first<{ salt: string }>("SELECT salt FROM salts WHERE day = ?", [day]);
  }
  const salt = row?.salt ?? day;
  saltCache.clear();
  saltCache.set(day, salt);
  return salt;
}
const saltCache = new Map<string, string>();

async function cookielessVisitorId(rt: Runtime, site: Site, meta: RequestMeta, now: number) {
  const salt = await dailySalt(rt, now);
  const hash = await sha256Hex(`${salt}|${site.id}|${site.domain}|${meta.ip ?? ""}|${meta.userAgent}`);
  return "h" + hash.slice(0, 31);
}

function isExcluded(site: Site, hostname: string, path: string, meta: RequestMeta, country: string | null): boolean {
  const s = site.settings;
  if (meta.ip && s.excludedIps?.some((rule) => ipMatches(rule, meta.ip!))) return true;
  if (s.excludedHostnames?.some((h) => h.toLowerCase().trim().replace(/^www\./, "") === hostname)) return true;
  if (s.excludedPaths?.some((p) => p.trim() && matchPath(p.trim(), path))) return true;
  if (country && s.excludedCountries?.some((c) => c.toUpperCase() === country)) return true;
  return false;
}

export async function ingestEvent(rt: Runtime, body: IncomingEvent, meta: RequestMeta): Promise<IngestResult> {
  const type = body.type ?? "pageview";
  if (!VALID_TYPES.has(type)) return { ok: false, reason: "invalid_type" };
  if (typeof body.websiteId !== "string" || body.websiteId.length > 64) return { ok: false, reason: "missing_website_id" };

  const site = await getSiteCached(rt.db, body.websiteId);
  if (!site) return { ok: false, reason: "unknown_website" };
  if (!meta.trusted && isBot(meta.userAgent)) return { ok: false, reason: "bot" };

  let url: URL | null = null;
  if (body.href) {
    try {
      url = new URL(body.href);
    } catch {
      url = null;
    }
  }
  if (!url && !meta.trusted) return { ok: false, reason: "invalid_url" };
  if (url && url.protocol === "file:") url = new URL("http://localhost" + url.pathname);
  const hostname = url ? url.hostname.toLowerCase().replace(/^www\./, "") : site.domain;
  if (url && !meta.trusted && !hostAllowed(site, hostname)) return { ok: false, reason: "hostname_not_allowed" };
  const path = url ? normalizePath(url, !!body.hash) : "/";

  const geo = normalizeGeo(meta.geo);
  if (isExcluded(site, hostname, path, meta, geo.country)) return { ok: false, reason: "excluded" };

  const now = Date.now();
  const db = rt.db;

  // ---- identity ----------------------------------------------------------
  let visitorId: string;
  if (!site.settings.cookieless && isValidClientId(body.visitorId)) visitorId = body.visitorId;
  else if (meta.trusted && isValidClientId(body.visitorId)) visitorId = body.visitorId;
  else visitorId = await cookielessVisitorId(rt, site, meta, now);

  let sessionId = isValidClientId(body.sessionId) ? body.sessionId : null;

  const lookup = await db.first<{ s_site: string | null; s_visitor: string | null; v_first: number | null; recent: string | null }>(
    `SELECT
      (SELECT site_id FROM sessions WHERE id = ?) AS s_site,
      (SELECT visitor_id FROM sessions WHERE id = ?) AS s_visitor,
      (SELECT first_seen FROM visitors WHERE site_id = ? AND id = ?) AS v_first,
      (SELECT id FROM sessions WHERE site_id = ? AND visitor_id = ? AND last_seen_at > ? ORDER BY last_seen_at DESC LIMIT 1) AS recent`,
    [sessionId ?? "", sessionId ?? "", site.id, visitorId, site.id, visitorId, now - SESSION_TIMEOUT],
  );

  if (sessionId && lookup?.s_site && (lookup.s_site !== site.id || lookup.s_visitor !== visitorId)) {
    // Session id belongs to someone else (forged or collided): start a fresh one.
    sessionId = null;
  }
  if (!sessionId) sessionId = lookup?.recent ?? uuid();
  const sessionExists = !!(lookup?.s_site === site.id && lookup?.s_visitor === visitorId) || sessionId === lookup?.recent;
  const isNewVisitor = lookup?.v_first === null || lookup?.v_first === undefined;

  const statements: Statement[] = [];

  // Engagement pings only extend an existing session.
  if (type === "engagement") {
    if (!sessionExists) return { ok: true, visitorId, sessionId };
    const engaged = Math.max(0, Math.min(Number(body.engagedMs) || 0, SESSION_TIMEOUT));
    statements.push({
      sql: "UPDATE sessions SET duration = duration + ?, last_seen_at = ? WHERE id = ? AND site_id = ?",
      params: [engaged, now, sessionId, site.id],
    });
    statements.push({ sql: "UPDATE visitors SET last_seen = ? WHERE site_id = ? AND id = ?", params: [now, site.id, visitorId] });
    await db.batch(statements);
    return { ok: true, visitorId, sessionId };
  }

  // ---- session ------------------------------------------------------------
  const isPageview = type === "pageview";
  const isGoal = type === "goal";
  if (!sessionExists) {
    const params = url?.searchParams;
    const ua = parseUserAgent(meta.userAgent, Number(body.screenWidth) || null);
    const utm = {
      source: clampString(params?.get("utm_source"), 200),
      medium: clampString(params?.get("utm_medium"), 200),
      campaign: clampString(params?.get("utm_campaign"), 200),
      term: clampString(params?.get("utm_term"), 200),
      content: clampString(params?.get("utm_content"), 200),
    };
    const ref = clampString(params?.get("ref") || params?.get("via") || params?.get("source"), 200);
    const clickIds = CLICK_ID_PARAMS.filter((p) => params?.has(p));
    const attr = meta.trusted && !body.referrer
      ? classify({ utm, ref })
      : classify({ referrer: body.referrer, ownHosts: siteHosts(site), utm, clickIds, inApp: ua.inApp, ref });
    statements.push({
      sql: `INSERT INTO sessions (id, site_id, visitor_id, started_at, last_seen_at, duration, pageviews, goals, is_new,
              entry_page, exit_page, hostname, referrer, referrer_domain, source, channel,
              utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref,
              country, region, city, latitude, longitude, browser, browser_version, os, os_version, device, language)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET
              last_seen_at = excluded.last_seen_at,
              pageviews = sessions.pageviews + excluded.pageviews,
              goals = sessions.goals + excluded.goals,
              exit_page = CASE WHEN excluded.pageviews > 0 THEN excluded.exit_page ELSE sessions.exit_page END
            WHERE sessions.site_id = excluded.site_id`,
      params: [
        sessionId,
        site.id,
        visitorId,
        now,
        now,
        isPageview ? 1 : 0,
        isGoal ? 1 : 0,
        isNewVisitor ? 1 : 0,
        isPageview || !meta.trusted ? path : null,
        isPageview ? path : null,
        hostname,
        attr.referrer,
        attr.referrerDomain,
        attr.source,
        attr.channel,
        utm.source,
        utm.medium,
        utm.campaign,
        utm.term,
        utm.content,
        ref,
        geo.country,
        geo.region,
        geo.city,
        geo.latitude,
        geo.longitude,
        ua.browser,
        ua.browserVersion,
        ua.os,
        ua.osVersion,
        ua.device,
        clampString(body.language, 20),
      ],
    });
    statements.push({
      sql: `INSERT INTO visitors (site_id, id, first_seen, last_seen, sessions) VALUES (?, ?, ?, ?, 1)
            ON CONFLICT (site_id, id) DO UPDATE SET last_seen = excluded.last_seen, sessions = visitors.sessions + 1`,
      params: [site.id, visitorId, now, now],
    });
  } else {
    statements.push({
      sql: `UPDATE sessions SET last_seen_at = ?, pageviews = pageviews + ?, goals = goals + ?,
              exit_page = CASE WHEN ? = 1 THEN ? ELSE exit_page END,
              entry_page = COALESCE(entry_page, ?)
            WHERE id = ? AND site_id = ?`,
      params: [now, isPageview ? 1 : 0, isGoal ? 1 : 0, isPageview ? 1 : 0, path, isPageview ? path : null, sessionId, site.id],
    });
    statements.push({ sql: "UPDATE visitors SET last_seen = ? WHERE site_id = ? AND id = ?", params: [now, site.id, visitorId] });
  }

  // ---- event ----------------------------------------------------------------
  let afterCommit: (() => Promise<unknown>) | null = null;
  switch (type) {
    case "pageview": {
      statements.push(eventInsert(site.id, sessionId, visitorId, now, "pageview", null, path, hostname, null));
      break;
    }
    case "goal": {
      const name = sanitizeGoalName(body.name);
      if (!name) return { ok: false, reason: "invalid_goal_name" };
      const props = sanitizeProps(body.props);
      statements.push(eventInsert(site.id, sessionId, visitorId, now, "goal", name, path, hostname, props));
      const sid = sessionId;
      afterCommit = async () => rt.waitUntil(notifyGoal(rt, site, name, visitorId, sid).catch(() => {}));
      break;
    }
    case "outbound": {
      const dest = clampString(body.url, 500);
      if (!dest) return { ok: false, reason: "missing_url" };
      statements.push(eventInsert(site.id, sessionId, visitorId, now, "outbound", dest, path, hostname, null));
      break;
    }
    case "identify": {
      const userId = clampString(body.userId, 200);
      if (!userId && !body.email) return { ok: false, reason: "missing_user_id" };
      const email = isEmail(body.email) ? body.email.toLowerCase() : isEmail(userId) ? userId!.toLowerCase() : null;
      const existing = await db.first<{ props: string | null }>("SELECT props FROM visitors WHERE site_id = ? AND id = ?", [
        site.id,
        visitorId,
      ]);
      let mergedProps: Record<string, string> | null = null;
      const custom = sanitizeProps(
        Object.fromEntries(
          Object.entries(body.props ?? {}).filter(([k]) => !["user_id", "name", "image", "email"].includes(k)),
        ),
      );
      if (custom || existing?.props) {
        mergedProps = { ...(existing?.props ? JSON.parse(existing.props) : {}), ...(custom ?? {}) };
      }
      statements.push({
        sql: `UPDATE visitors SET user_id = COALESCE(?, user_id), name = COALESCE(?, name), email = COALESCE(?, email),
                image = COALESCE(?, image), props = ? WHERE site_id = ? AND id = ?`,
        params: [
          userId,
          clampString(body.props?.name ?? (body as { name?: string }).name, 200),
          email,
          imageUrl(body.image ?? body.props?.image),
          mergedProps ? JSON.stringify(mergedProps) : null,
          site.id,
          visitorId,
        ],
      });
      if (email) afterCommit = () => attachVisitorToPayments(rt, site, { visitorId, sessionId, email });
      break;
    }
    case "payment": {
      // Hint from the tracker: this visitor reached a checkout success page (or called openrev("payment", {email})).
      const ref = clampString(body.ref, 200);
      const email = isEmail(body.email) ? body.email.toLowerCase() : null;
      if (!ref && !email) return { ok: false, reason: "missing_ref" };
      if (ref) {
        statements.push({
          sql: `INSERT INTO checkout_refs (site_id, ref, visitor_id, session_id, created_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (site_id, ref) DO NOTHING`,
          params: [site.id, ref, visitorId, sessionId, now],
        });
      }
      if (email) {
        statements.push({
          sql: "UPDATE visitors SET email = COALESCE(email, ?) WHERE site_id = ? AND id = ?",
          params: [email, site.id, visitorId],
        });
      }
      afterCommit = () => attachVisitorToPayments(rt, site, { visitorId, sessionId, ref, email });
      break;
    }
  }

  await db.batch(statements);
  if (afterCommit) await afterCommit();
  return { ok: true, visitorId, sessionId };
}

function eventInsert(
  siteId: string,
  sessionId: string,
  visitorId: string,
  ts: number,
  type: string,
  name: string | null,
  path: string,
  hostname: string,
  props: Record<string, string> | null,
): Statement {
  return {
    sql: "INSERT INTO events (id, site_id, session_id, visitor_id, ts, type, name, path, hostname, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    params: [uuid(), siteId, sessionId, visitorId, ts, type, name, path, hostname, props ? JSON.stringify(props) : null],
  };
}

/**
 * Attaches identity (user id, name, email, image, custom properties) to a visitor from the server.
 * Unlike tracker events it never creates a session, so it doesn't affect traffic stats.
 */
export async function identifyVisitor(
  rt: Runtime,
  site: Site,
  input: { visitorId: string; userId?: string | null; name?: string | null; email?: string | null; image?: string | null; props?: Record<string, unknown> | null },
): Promise<void> {
  const db = rt.db;
  const now = Date.now();
  const email = isEmail(input.email) ? input.email.toLowerCase() : isEmail(input.userId) ? input.userId!.toLowerCase() : null;
  const existing = await db.first<{ props: string | null }>("SELECT props FROM visitors WHERE site_id = ? AND id = ?", [site.id, input.visitorId]);
  const custom = sanitizeProps(input.props);
  const merged = custom || existing?.props ? { ...(existing?.props ? JSON.parse(existing.props) : {}), ...(custom ?? {}) } : null;
  await db.batch([
    {
      sql: `INSERT INTO visitors (site_id, id, first_seen, last_seen, sessions) VALUES (?, ?, ?, ?, 0)
            ON CONFLICT (site_id, id) DO NOTHING`,
      params: [site.id, input.visitorId, now, now],
    },
    {
      sql: `UPDATE visitors SET user_id = COALESCE(?, user_id), name = COALESCE(?, name), email = COALESCE(?, email),
              image = COALESCE(?, image), props = ? WHERE site_id = ? AND id = ?`,
      params: [
        clampString(input.userId, 200),
        clampString(input.name, 200),
        email,
        imageUrl(input.image),
        merged ? JSON.stringify(merged) : null,
        site.id,
        input.visitorId,
      ],
    },
  ]);
  if (email) await attachVisitorToPayments(rt, site, { visitorId: input.visitorId, email, trusted: true });
}

/** Records a goal on behalf of a visitor from the server (API, payment providers). */
export async function recordServerGoal(
  rt: Runtime,
  site: Site,
  goal: { name: string; visitorId?: string | null; props?: Record<string, unknown> | null; timestamp?: number | null },
): Promise<IngestResult> {
  const name = sanitizeGoalName(goal.name);
  if (!name) return { ok: false, reason: "invalid_goal_name" };
  if (!goal.visitorId) return { ok: false, reason: "missing_visitor_id" };
  const last = await rt.db.first<{ id: string; exit_page: string | null; hostname: string | null }>(
    "SELECT id, exit_page, hostname FROM sessions WHERE site_id = ? AND visitor_id = ? ORDER BY started_at DESC LIMIT 1",
    [site.id, goal.visitorId],
  );
  // Goals belong to a visit: without one we'd have to invent a "Direct" session, which would distort stats.
  if (!last) return { ok: false, reason: "unknown_visitor" };
  const ts = goal.timestamp ?? Date.now();
  await rt.db.batch([
    eventInsert(site.id, last.id, goal.visitorId, ts, "goal", name, last.exit_page ?? "/", last.hostname ?? site.domain, sanitizeProps(goal.props)),
    { sql: "UPDATE sessions SET goals = goals + 1 WHERE id = ?", params: [last.id] },
  ]);
  return { ok: true, visitorId: goal.visitorId, sessionId: last.id };
}
