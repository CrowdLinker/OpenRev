import type { Runtime } from "../context";
import type { Database, SqlValue, Statement } from "../db/types";
import { decryptString, encryptString } from "../lib/crypto";
import { getSecret } from "./instance";
import { getSite, siteHosts, type Site } from "./sites";
import { attributionColumn, type StatsQuery } from "./stats";

/**
 * Social posts that mention or link to the website, and the visits and revenue they bring.
 *
 * - 𝕏: posts found with the 𝕏 API's recent search (the website's own bearer token, paid per post read), and the
 *   profiles of the handles you list, for link-in-bio traffic.
 * - Hacker News: stories and comments, from the free HN Search API (Algolia). No setup.
 *
 * 𝕏 wraps links in t.co, and browsers only send "https://t.co/" as the referrer, so a visit can't name its post. A
 * visit from 𝕏 is credited to the latest post (within 7 days) that links to the page it landed on, or else to a
 * listed profile whose bio links there. Hacker News visits are matched the same way.
 */

export const SOCIAL_PLATFORMS = ["x", "hn"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
/** The source name a platform's visits get (see lib/referrers). */
export const PLATFORM_SOURCE: Record<SocialPlatform, string> = { x: "X", hn: "Hacker News" };

const DAY = 86_400_000;
/** A visit is credited to a post published up to this long before it. */
export const POST_WINDOW_MS = 7 * DAY;
const X_EVERY_MS = 6 * 3_600_000;
const X_USERS_EVERY_MS = 7 * DAY;
/** "Check now" doesn't read 𝕏 more often than this. */
const X_FORCE_MIN_MS = 5 * 60_000;
const HN_EVERY_MS = 3_600_000;
const X_PAGES_PER_RUN = 2;
const X_API = "https://api.x.com/2";
const HN_API = "https://hn.algolia.com/api/v1";
export const MAX_KEYWORDS = 10;
export const MAX_HANDLES = 10;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface SocialConfigRow {
  site_id: string;
  config: string | null;
  keywords: string | null;
  handles: string | null;
  x_since_id: string | null;
  x_checked_at: number | null;
  x_users_checked_at: number | null;
  x_reads_month: string | null;
  x_reads: number;
  x_monthly_cap: number;
  hn: number;
  hn_checked_at: number | null;
  last_error: string | null;
  created_at: number;
}

export interface SocialPost {
  platform: SocialPlatform;
  id: string;
  kind: "post" | "bio";
  url: string;
  author: string | null;
  authorName: string | null;
  authorImage: string | null;
  text: string | null;
  createdAt: number;
  likes: number;
  reposts: number;
  replies: number;
  views: number | null;
  /** Paths on the website the post links to. */
  paths: string[];
}

export class SocialError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

const list = (v: string | null): string[] => {
  try {
    const parsed = v ? JSON.parse(v) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const monthKey = (now: number) => new Date(now).toISOString().slice(0, 7);

/** Brand names, hashtags or @handles to look for, from a list or a comma or newline separated string. */
export function parseKeywords(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[\n,]/) : [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const k = v.trim().replace(/["\\]/g, "");
    if (k.length < 2 || k.length > 50) continue;
    if (!out.some((o) => o.toLowerCase() === k.toLowerCase())) out.push(k);
  }
  if (out.length > MAX_KEYWORDS) throw new SocialError(`Up to ${MAX_KEYWORDS} keywords`);
  return out;
}

/** 𝕏 usernames, with or without @, or profile URLs. */
export function parseHandles(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !v.trim()) continue;
    const h = v
      .trim()
      .replace(/^(https?:\/\/)?(www\.|mobile\.)?(x|twitter)\.com\//i, "")
      .replace(/^@/, "")
      .replace(/[/?#].*$/, "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) throw new SocialError(`"${v.trim()}" isn't an 𝕏 username`);
    if (!out.some((o) => o.toLowerCase() === h.toLowerCase())) out.push(h);
  }
  if (out.length > MAX_HANDLES) throw new SocialError(`Up to ${MAX_HANDLES} handles`);
  return out;
}

export async function getSocialConfig(db: Database, siteId: string): Promise<SocialConfigRow | null> {
  return db.first<SocialConfigRow>("SELECT * FROM social_config WHERE site_id = ?", [siteId]);
}

/** What the settings page shows. The token never leaves the server. */
export function publicSocialConfig(row: SocialConfigRow | null, now = Date.now()) {
  return {
    set_up: !!row,
    x_connected: !!row?.config,
    keywords: list(row?.keywords ?? null),
    handles: list(row?.handles ?? null),
    x_checked_at: row?.x_checked_at ? Number(row.x_checked_at) : null,
    hn_checked_at: row?.hn_checked_at ? Number(row.hn_checked_at) : null,
    /** Posts read from the 𝕏 API this calendar month (UTC), and the limit. */
    x_reads: row && row.x_reads_month === monthKey(now) ? Number(row.x_reads) : 0,
    x_monthly_cap: row ? Number(row.x_monthly_cap) : 2000,
    hn: row ? !!Number(row.hn) : false,
    last_error: row?.last_error ?? null,
  };
}

/**
 * Saves the settings. `xToken`: a new bearer token, `null` to remove it, or leave it out to keep the current one.
 * Changing the keywords restarts the 𝕏 search from 7 days back; changing the handles looks their profiles up again.
 */
export async function saveSocialConfig(
  rt: Runtime,
  site: Site,
  input: { xToken?: unknown; keywords?: unknown; handles?: unknown; xMonthlyCap?: unknown; hn?: unknown },
  now = Date.now(),
): Promise<SocialConfigRow> {
  const current = await getSocialConfig(rt.db, site.id);
  let config = current?.config ?? null;
  if (input.xToken === null) config = null;
  else if (input.xToken !== undefined) {
    // Sent as shown in the Developer Console, URL-encoded characters included.
    const token = typeof input.xToken === "string" ? input.xToken.trim().replace(/^Bearer\s+/i, "") : "";
    if (token.length < 20 || /\s/.test(token)) throw new SocialError("Paste the bearer token from your 𝕏 app (Developer Console → Apps → Keys and tokens)");
    config = await encryptString(await getSecret(rt), JSON.stringify({ xToken: token }));
  }
  const keywords = input.keywords !== undefined ? parseKeywords(input.keywords) : list(current?.keywords ?? null);
  const handles = input.handles !== undefined ? parseHandles(input.handles) : list(current?.handles ?? null);
  let cap = current ? Number(current.x_monthly_cap) : 2000;
  if (input.xMonthlyCap !== undefined) {
    cap = Number(input.xMonthlyCap);
    if (!Number.isInteger(cap) || cap < 0 || cap > 1_000_000) throw new SocialError("The monthly limit is a number of posts, 0 to 1,000,000");
  }

  const hn = input.hn !== undefined ? !!input.hn : current ? !!Number(current.hn) : true;
  const sameKeywords = JSON.stringify(keywords) === (current?.keywords ?? "[]");
  const sameHandles = JSON.stringify(handles) === (current?.handles ?? "[]");
  const sameToken = config === (current?.config ?? null);
  const statements: Statement[] = [
    {
      sql: `INSERT INTO social_config (site_id, config, keywords, handles, x_since_id, x_checked_at, x_users_checked_at, x_monthly_cap, hn, hn_checked_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (site_id) DO UPDATE SET config = excluded.config, keywords = excluded.keywords, handles = excluded.handles,
              x_since_id = excluded.x_since_id, x_checked_at = excluded.x_checked_at, x_users_checked_at = excluded.x_users_checked_at,
              x_monthly_cap = excluded.x_monthly_cap, hn = excluded.hn, hn_checked_at = excluded.hn_checked_at, last_error = NULL`,
      params: [
        site.id,
        config,
        JSON.stringify(keywords),
        JSON.stringify(handles),
        sameKeywords && sameToken ? (current?.x_since_id ?? null) : null,
        sameKeywords && sameToken ? (current?.x_checked_at ?? null) : null,
        sameHandles && sameToken ? (current?.x_users_checked_at ?? null) : null,
        cap,
        hn ? 1 : 0,
        sameKeywords ? (current?.hn_checked_at ?? null) : null,
        current?.created_at ?? now,
      ],
    },
  ];
  // Profiles that are no longer listed stop getting credit.
  const keep = handles.map((h) => `bio:${h.toLowerCase()}`);
  const ph = keep.map(() => "?").join(", ");
  statements.push(
    { sql: `DELETE FROM social_links WHERE site_id = ? AND platform = 'x' AND kind = 'bio'${keep.length ? ` AND post_id NOT IN (${ph})` : ""}`, params: [site.id, ...keep] },
    { sql: `DELETE FROM social_posts WHERE site_id = ? AND platform = 'x' AND kind = 'bio'${keep.length ? ` AND id NOT IN (${ph})` : ""}`, params: [site.id, ...keep] },
  );
  await rt.db.batch(statements);
  return (await getSocialConfig(rt.db, site.id))!;
}

export function disconnectSocialStatements(siteId: string): Statement[] {
  return ["social_links", "social_posts", "social_config"].map((t) => ({ sql: `DELETE FROM ${t} WHERE site_id = ?`, params: [siteId] }));
}

// ---------------------------------------------------------------------------
// Links to the website
// ---------------------------------------------------------------------------

/** The paths on the website that these URLs point to, stored like entry pages. */
export function sitePaths(urls: (string | null | undefined)[], hosts: string[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!hosts.some((h) => host === h || host.endsWith("." + h))) continue;
    let path = url.pathname || "/";
    try {
      path = decodeURI(path);
    } catch {
      /* keep encoded */
    }
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    out.add(path.slice(0, 500));
  }
  return [...out];
}

const POSTS_PER_INSERT = 6; // 16 parameters each: D1 allows 100 per statement
const LINKS_PER_INSERT = 16; // 6 parameters each
const IDS_PER_DELETE = 90;

const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** Saves posts and the website paths they link to, several rows per statement. */
function postStatements(siteId: string, list: SocialPost[], now: number): Statement[] {
  // One row per post: an upsert can't touch the same row twice in one statement.
  const posts = [...new Map(list.map((p) => [`${p.platform}\u0000${p.id}`, p])).values()];
  const out: Statement[] = [];
  for (const part of chunks(posts, POSTS_PER_INSERT)) {
    out.push({
      sql: `INSERT INTO social_posts (site_id, platform, id, kind, url, author, author_name, author_image, text, created_at, likes, reposts, replies, views, links, updated_at)
            VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
            ON CONFLICT (site_id, platform, id) DO UPDATE SET url = excluded.url, author = excluded.author, author_name = excluded.author_name,
              author_image = excluded.author_image, text = excluded.text, likes = excluded.likes, reposts = excluded.reposts,
              replies = excluded.replies, views = excluded.views, links = excluded.links, updated_at = excluded.updated_at`,
      params: part.flatMap((p): SqlValue[] => [
        siteId,
        p.platform,
        p.id,
        p.kind,
        p.url,
        p.author,
        p.authorName,
        p.authorImage,
        p.text,
        p.createdAt,
        p.likes,
        p.reposts,
        p.replies,
        p.views,
        JSON.stringify(p.paths),
        now,
      ]),
    });
  }
  // A post's links are replaced, so a link removed from an edited post or a bio goes away.
  for (const platform of new Set(posts.map((p) => p.platform))) {
    for (const part of chunks(posts.filter((p) => p.platform === platform), IDS_PER_DELETE)) {
      out.push({
        sql: `DELETE FROM social_links WHERE site_id = ? AND platform = ? AND post_id IN (${part.map(() => "?").join(", ")})`,
        params: [siteId, platform, ...part.map((p) => p.id)],
      });
    }
  }
  const links = posts.flatMap((p) => p.paths.map((path) => [siteId, p.platform, p.id, path, p.kind, p.kind === "bio" ? 0 : p.createdAt] as SqlValue[]));
  for (const part of chunks(links, LINKS_PER_INSERT)) {
    out.push({
      sql: `INSERT INTO social_links (site_id, platform, post_id, path, kind, created_at) VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")} ON CONFLICT DO NOTHING`,
      params: part.flat(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 𝕏
// ---------------------------------------------------------------------------

interface XPost {
  id: string;
  text?: string;
  author_id?: string;
  created_at?: string;
  public_metrics?: Record<string, number | undefined>;
  entities?: { urls?: { url?: string; expanded_url?: string; unwound_url?: string }[] };
}
interface XUser {
  id: string;
  username: string;
  name?: string;
  profile_image_url?: string;
  url?: string;
  entities?: { url?: { urls?: { expanded_url?: string }[] }; description?: { urls?: { expanded_url?: string }[] } };
}

async function xGet<T>(path: string, params: Record<string, string>, token: string, fetchFn: FetchFn): Promise<T> {
  const res = await fetchFn(`${X_API}${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => ({}))) as { title?: string; detail?: string; errors?: { message?: string; detail?: string }[] };
  if (!res.ok) {
    const detail = body.detail || body.title || body.errors?.[0]?.message || body.errors?.[0]?.detail || res.statusText;
    const message =
      res.status === 401
        ? "𝕏 didn't accept the bearer token (401). Check it in the Developer Console."
        : res.status === 402 || /credit/i.test(detail ?? "")
          ? "Your 𝕏 developer account is out of credits. Add credits in the Developer Console."
          : res.status === 429
            ? "𝕏 rate limit reached (429). OpenRev tries again later."
            : `𝕏 API error ${res.status}: ${detail}`;
    throw new SocialError(message, res.status);
  }
  return body as T;
}

/** The recent-search query: links to the website's domains, and the keywords. Reposts are left out. */
export function xQuery(site: Site, keywords: string[]): string {
  // @handles and #hashtags are operators of their own; other keywords are exact phrases.
  const parts = [...siteHosts(site).map((h) => `url:"${h}"`), ...keywords.map((k) => (/^[@#][A-Za-z0-9_]+$/.test(k) ? k : `"${k}"`))];
  return `(${parts.join(" OR ")}) -is:retweet`;
}

function xPost(p: XPost, users: Map<string, XUser>, hosts: string[]): SocialPost {
  const user = p.author_id ? users.get(p.author_id) : undefined;
  const m = p.public_metrics ?? {};
  return {
    platform: "x",
    id: p.id,
    kind: "post",
    url: `https://x.com/${user?.username ?? "i"}/status/${p.id}`,
    author: user?.username ?? null,
    authorName: user?.name ?? null,
    authorImage: user?.profile_image_url ?? null,
    text: p.text?.slice(0, 1000) ?? null,
    createdAt: p.created_at ? Date.parse(p.created_at) : Date.now(),
    likes: Number(m.like_count) || 0,
    reposts: Number(m.repost_count ?? m.retweet_count) || 0,
    replies: Number(m.reply_count) || 0,
    views: m.impression_count === undefined ? null : Number(m.impression_count),
    paths: sitePaths((p.entities?.urls ?? []).map((u) => u.unwound_url || u.expanded_url), hosts),
  };
}

/** New posts since the last check (or the last 7 days), at most `maxReads` of them. */
export async function searchX(
  site: Site,
  token: string,
  keywords: string[],
  opts: { sinceId?: string | null; now?: number; maxReads: number; fetchFn?: FetchFn },
): Promise<{ posts: SocialPost[]; newestId: string | null; reads: number }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now();
  const hosts = siteHosts(site);
  const base: Record<string, string> = {
    query: xQuery(site, keywords),
    max_results: "100",
    sort_order: "recency",
    "post.fields": "created_at,public_metrics,entities",
    expansions: "author_id",
    "user.fields": "username,name,profile_image_url",
  };
  // start_time must be within the last 7 days.
  if (opts.sinceId) base.since_id = opts.sinceId;
  else base.start_time = new Date(now - POST_WINDOW_MS + 60_000).toISOString();

  const posts: SocialPost[] = [];
  let newestId: string | null = null;
  let next: string | undefined;
  for (let page = 0; page < X_PAGES_PER_RUN && posts.length < opts.maxReads; page++) {
    const params: Record<string, string> = { ...base, max_results: String(Math.max(10, Math.min(100, opts.maxReads - posts.length))) };
    if (next) params.next_token = next;
    const res = await xGet<{ data?: XPost[]; includes?: { users?: XUser[] }; meta?: { newest_id?: string; next_token?: string } }>(
      "/tweets/search/recent",
      params,
      token,
      fetchFn,
    );
    const users = new Map((res.includes?.users ?? []).map((u) => [u.id, u]));
    for (const p of res.data ?? []) posts.push(xPost(p, users, hosts));
    if (page === 0) newestId = res.meta?.newest_id ?? null;
    next = res.meta?.next_token;
    if (!next) break;
  }
  return { posts, newestId, reads: posts.length };
}

/** The listed profiles, as "bio" posts with the website links in their bio and website field. */
export async function lookupXProfiles(site: Site, token: string, handles: string[], fetchFn: FetchFn = fetch): Promise<SocialPost[]> {
  if (!handles.length) return [];
  const res = await xGet<{ data?: XUser[] }>(
    "/users/by",
    { usernames: handles.join(","), "user.fields": "entities,url,name,profile_image_url" },
    token,
    fetchFn,
  );
  const hosts = siteHosts(site);
  return (res.data ?? []).map((u) => ({
    platform: "x" as const,
    id: `bio:${u.username.toLowerCase()}`,
    kind: "bio" as const,
    url: `https://x.com/${u.username}`,
    author: u.username,
    authorName: u.name ?? null,
    authorImage: u.profile_image_url ?? null,
    text: null,
    createdAt: 0,
    likes: 0,
    reposts: 0,
    replies: 0,
    views: null,
    paths: sitePaths([...(u.entities?.url?.urls ?? []), ...(u.entities?.description?.urls ?? [])].map((x) => x.expanded_url), hosts),
  }));
}

// ---------------------------------------------------------------------------
// Hacker News
// ---------------------------------------------------------------------------

interface HnHit {
  objectID: string;
  created_at_i: number;
  author?: string;
  title?: string | null;
  url?: string | null;
  story_text?: string | null;
  comment_text?: string | null;
  story_title?: string | null;
  points?: number | null;
  num_comments?: number | null;
}

const decodeHtml = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

function hnPost(h: HnHit, hosts: string[]): SocialPost {
  const html = h.comment_text ?? h.story_text ?? "";
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => decodeHtml(m[1]));
  const text = h.title ?? (h.comment_text ? `${decodeHtml(h.comment_text.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()}` : null);
  return {
    platform: "hn",
    id: h.objectID,
    kind: "post",
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    author: h.author ?? null,
    authorName: null,
    authorImage: null,
    text: (h.comment_text && h.story_title ? `On "${h.story_title}": ${text}` : text)?.slice(0, 1000) ?? null,
    createdAt: h.created_at_i * 1000,
    likes: Number(h.points) || 0,
    reposts: 0,
    replies: Number(h.num_comments) || 0,
    views: null,
    paths: sitePaths([h.url, ...hrefs], hosts),
  };
}

/** Stories linking to the website, comments mentioning it, and stories or comments with a keyword, since `since`. */
export async function searchHackerNews(site: Site, keywords: string[], since: number, fetchFn: FetchFn = fetch): Promise<SocialPost[]> {
  const hosts = siteHosts(site);
  const after = `created_at_i>${Math.floor(since / 1000)}`;
  const queries: Record<string, string>[] = [];
  for (const host of hosts) {
    queries.push({ query: host, restrictSearchableAttributes: "url", tags: "story" });
    queries.push({ query: host, tags: "comment" });
  }
  for (const k of keywords) queries.push({ query: k.replace(/^[@#]/, ""), tags: "(story,comment)" });
  // HN search matches words loosely, so keep only what links to the website or names it.
  const needles = [...hosts, ...keywords.map((k) => k.replace(/^[@#]/, ""))].map((n) => n.toLowerCase());
  const posts = new Map<string, SocialPost>();
  for (const q of queries) {
    const res = await fetchFn(`${HN_API}/search_by_date?${new URLSearchParams({ ...q, numericFilters: after, hitsPerPage: "100" })}`);
    if (!res.ok) throw new SocialError(`Hacker News search error ${res.status}`, res.status);
    const body = (await res.json()) as { hits?: HnHit[] };
    for (const h of body.hits ?? []) {
      const post = hnPost(h, hosts);
      const haystack = decodeHtml([h.title, h.url, h.story_text, h.comment_text].filter(Boolean).join(" ")).toLowerCase();
      if (post.paths.length || needles.some((n) => haystack.includes(n))) posts.set(h.objectID, post);
    }
  }
  return [...posts.values()];
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Statements a sync may still write. The first write against a budget goes through even when it's larger, so one big
 * check can't be held up forever. The scheduler shares one budget between all websites.
 */
export interface SyncBudget {
  left: number;
  wrote: boolean;
}

/** Statements one scheduled run spends on social posts: a Worker invocation may run 1,000 queries, and the other jobs need some. */
const RUN_BUDGET = 600;
/** Room an 𝕏 check needs before it starts: its reads cost money, so what it finds is always stored. */
const X_ROOM = 120;
/** What visiting a website costs a scheduled run besides the posts it writes. */
const VISIT_COST = 3;

const spend = (budget: SyncBudget, statements: number) => {
  budget.left -= statements;
  budget.wrote = true;
};

/**
 * Marks an 𝕏 check as started, unless another sync already did since `row` was read: two syncs at once ("Check now"
 * during a scheduled run) would otherwise both pay for the same search.
 */
async function claimXCheck(rt: Runtime, row: SocialConfigRow, now: number): Promise<boolean> {
  const res =
    row.x_checked_at === null
      ? await rt.db.run("UPDATE social_config SET x_checked_at = ? WHERE site_id = ? AND x_checked_at IS NULL", [now, row.site_id])
      : await rt.db.run("UPDATE social_config SET x_checked_at = ? WHERE site_id = ? AND x_checked_at = ?", [now, row.site_id, Number(row.x_checked_at)]);
  return res.changes > 0;
}

/** Looks for new posts: Hacker News every hour, 𝕏 every 6 hours (`force` checks now), within the monthly limit. */
export async function syncSocial(
  rt: Runtime,
  site: Site,
  row: SocialConfigRow,
  opts: { now?: number; fetchFn?: FetchFn; force?: boolean; budget?: SyncBudget } = {},
): Promise<{ x: number | null; hn: number | null; error: string | null; stopped: boolean }> {
  const now = opts.now ?? Date.now();
  const fetchFn = opts.fetchFn ?? fetch;
  const budget = opts.budget ?? { left: Infinity, wrote: false };
  const keywords = list(row.keywords);
  const handles = list(row.handles);
  const result = { x: null as number | null, hn: null as number | null, error: null as string | null, stopped: false };
  const errors: string[] = [];

  if (Number(row.hn) && (opts.force || !row.hn_checked_at || now - Number(row.hn_checked_at) >= HN_EVERY_MS)) {
    try {
      // The first look goes back 30 days; later ones re-read the last 3 days to update points and comments.
      const posts = await searchHackerNews(site, keywords, row.hn_checked_at ? now - 3 * DAY : now - 30 * DAY, fetchFn);
      const statements = [...postStatements(site.id, posts, now), { sql: "UPDATE social_config SET hn_checked_at = ? WHERE site_id = ?", params: [now, site.id] }];
      // No room left in this run: the check stays due, and runs again next time.
      if (budget.wrote && statements.length > budget.left) result.stopped = true;
      else {
        await rt.db.batch(statements);
        spend(budget, statements.length);
        result.hn = posts.length;
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  const sinceX = row.x_checked_at ? now - Number(row.x_checked_at) : Infinity;
  const xDue = sinceX >= X_EVERY_MS || (opts.force && sinceX >= X_FORCE_MIN_MS);
  if (row.config && xDue && budget.wrote && budget.left < X_ROOM) result.stopped = true;
  else if (row.config && xDue && (await claimXCheck(rt, row, now))) {
    const month = monthKey(now);
    const reads = row.x_reads_month === month ? Number(row.x_reads) : 0;
    const left = Number(row.x_monthly_cap) - reads;
    let sinceId = row.x_since_id;
    let usersCheckedAt = row.x_users_checked_at;
    let found = 0;
    let runReads = 0;
    try {
      if (left <= 0) throw new SocialError(`Paused: ${reads.toLocaleString("en-US")} 𝕏 posts read this month, the limit you set. Raise it to keep looking.`);
      const { xToken } = JSON.parse(await decryptString(await getSecret(rt), row.config)) as { xToken: string };
      if (handles.length && (opts.force || !usersCheckedAt || now - Number(usersCheckedAt) >= X_USERS_EVERY_MS)) {
        const profiles = postStatements(site.id, await lookupXProfiles(site, xToken, handles, fetchFn), now);
        await rt.db.batch(profiles);
        spend(budget, profiles.length);
        usersCheckedAt = now;
      }
      const res = await searchX(site, xToken, keywords, { sinceId, now, maxReads: Math.min(left, 100 * X_PAGES_PER_RUN), fetchFn });
      const posts = postStatements(site.id, res.posts, now);
      await rt.db.batch(posts);
      spend(budget, posts.length);
      runReads = res.reads;
      found = res.posts.length;
      sinceId = res.newestId ?? sinceId;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    // The reads are added to the stored count, which a settings change may have touched meanwhile.
    await rt.db.run(
      `UPDATE social_config SET x_since_id = ?, x_checked_at = ?, x_users_checked_at = ?,
         x_reads = CASE WHEN x_reads_month = ? THEN x_reads + ? ELSE ? END, x_reads_month = ? WHERE site_id = ?`,
      [sinceId, now, usersCheckedAt, month, runReads, runReads, month, site.id],
    );
    result.x = found;
  }

  result.error = errors.length ? errors.join(" ") : null;
  if (result.x !== null || result.hn !== null) await rt.db.run("UPDATE social_config SET last_error = ? WHERE site_id = ?", [result.error, site.id]);
  return result;
}

/** Scheduler entry: every website with social monitoring set up. */
/**
 * Called by the scheduler: the checks that are due for each website, within one statement budget for the whole run.
 * Each run starts from a different website, so on an instance with many of them none waits behind the others.
 */
export async function syncAllSocial(rt: Runtime, now = Date.now(), budget: SyncBudget = { left: RUN_BUDGET, wrote: false }) {
  const rows = await rt.db.all<SocialConfigRow>("SELECT * FROM social_config ORDER BY site_id");
  const start = rows.length ? Math.floor(now / 600_000) % rows.length : 0;
  for (let i = 0; i < rows.length && budget.left > 0; i++) {
    const row = rows[(start + i) % rows.length];
    budget.left -= VISIT_COST;
    const site = await getSite(rt.db, row.site_id);
    if (!site) continue;
    try {
      if ((await syncSocial(rt, site, row, { now, budget })).stopped) break;
    } catch (err) {
      console.error(`[openrev] social sync failed for ${site.id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface PostRow {
  platform: SocialPlatform;
  id: string;
  kind: "post" | "bio";
  url: string;
  author: string | null;
  author_name: string | null;
  author_image: string | null;
  text: string | null;
  created_at: number;
  likes: number;
  reposts: number;
  replies: number;
  views: number | null;
  links: string | null;
}

/**
 * Posts and profiles with the visits and revenue credited to them in the range, and the posts published in it.
 * Filters don't apply. Revenue is what the credited visits went on to pay, by the website's attribution model.
 */
export async function socialReport(db: Database, q: StatsQuery, opts: { platform?: string | null; limit?: number } = {}) {
  const platform = (SOCIAL_PLATFORMS as readonly string[]).includes(opts.platform ?? "") ? (opts.platform as SocialPlatform) : null;
  const platforms = platform ? [platform] : [...SOCIAL_PLATFORMS];
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const attr = attributionColumn(q.site, q.attribution);
  const sources = platforms.map((p) => PLATFORM_SOURCE[p]);
  const platformOf = `CASE s.source ${platforms.map((p) => `WHEN '${PLATFORM_SOURCE[p]}' THEN '${p}'`).join(" ")} END`;
  const range = [q.site.id, q.range.from, q.range.to];

  // Each visit from a platform, with the post (or profile) it's credited to, and what it paid.
  const credited = await db.all<{ platform: SocialPlatform; post_id: string | null; sessions: number; visitors: number; revenue: number; customers: number }>(
    `SELECT m.platform, m.post_id, COUNT(*) AS sessions, COUNT(DISTINCT m.visitor_id) AS visitors,
            COALESCE(SUM(pay.revenue), 0) AS revenue, COUNT(DISTINCT CASE WHEN pay.revenue > 0 THEN m.visitor_id END) AS customers
     FROM (
       SELECT s.id, s.visitor_id, ${platformOf} AS platform,
         (SELECT l.post_id FROM social_links l
          WHERE l.site_id = s.site_id AND l.platform = ${platformOf} AND l.path = s.entry_page
            AND (l.kind = 'bio' OR (l.created_at <= s.started_at AND l.created_at > s.started_at - ?))
          ORDER BY l.created_at DESC LIMIT 1) AS post_id
       FROM sessions s
       WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ? AND s.source IN (${sources.map(() => "?").join(", ")})
     ) m
     LEFT JOIN (
       SELECT p.${attr} AS sid, SUM(p.revenue) AS revenue FROM payments p WHERE p.site_id = ? AND p.ts >= ? AND p.${attr} IS NOT NULL GROUP BY p.${attr}
     ) pay ON pay.sid = m.id
     GROUP BY m.platform, m.post_id`,
    [POST_WINDOW_MS, ...range, ...sources, q.site.id, q.range.from],
  );

  const byPost = new Map<string, { sessions: number; visitors: number; revenue: number; customers: number }>();
  const totals = Object.fromEntries(platforms.map((p) => [p, { visits: 0, credited: 0, revenue: 0, credited_revenue: 0 }])) as Record<
    SocialPlatform,
    { visits: number; credited: number; revenue: number; credited_revenue: number }
  >;
  for (const r of credited) {
    const t = totals[r.platform];
    if (!t) continue;
    t.visits += Number(r.sessions);
    t.revenue += Number(r.revenue);
    if (r.post_id) {
      t.credited += Number(r.sessions);
      t.credited_revenue += Number(r.revenue);
      byPost.set(`${r.platform}:${r.post_id}`, { sessions: Number(r.sessions), visitors: Number(r.visitors), revenue: Number(r.revenue), customers: Number(r.customers) });
    }
  }

  // Posts published in the range, and any older post or profile that got visits in it.
  const ph = platforms.map(() => "?").join(", ");
  const published = await db.all<PostRow>(
    `SELECT * FROM social_posts WHERE site_id = ? AND kind = 'post' AND platform IN (${ph}) AND created_at >= ? AND created_at < ?
     ORDER BY created_at DESC LIMIT ?`,
    [q.site.id, ...platforms, q.range.from, q.range.to, limit],
  );
  // The list stops at `limit`; the counts don't.
  const counts = await db.all<{ platform: SocialPlatform; n: number }>(
    `SELECT platform, COUNT(*) AS n FROM social_posts WHERE site_id = ? AND kind = 'post' AND platform IN (${ph}) AND created_at >= ? AND created_at < ?
     GROUP BY platform`,
    [q.site.id, ...platforms, q.range.from, q.range.to],
  );
  const mentions = Object.fromEntries(counts.map((r) => [r.platform, Number(r.n)])) as Partial<Record<SocialPlatform, number>>;
  const have = new Set(published.map((p) => `${p.platform}:${p.id}`));
  const missing = [...byPost.keys()].filter((k) => !have.has(k));
  const extra: PostRow[] = [];
  for (let i = 0; i < missing.length; i += 40) {
    const part = missing.slice(i, i + 40);
    extra.push(
      ...(await db.all<PostRow>(
        `SELECT * FROM social_posts WHERE site_id = ? AND (${part.map(() => "(platform = ? AND id = ?)").join(" OR ")})`,
        [q.site.id, ...part.flatMap((k) => k.split(/:(.*)/s).slice(0, 2))],
      )),
    );
  }
  const shape = (p: PostRow) => {
    const stats = byPost.get(`${p.platform}:${p.id}`) ?? { sessions: 0, visitors: 0, revenue: 0, customers: 0 };
    return {
      platform: p.platform,
      id: p.id,
      url: p.url,
      author: p.author,
      author_name: p.author_name,
      author_image: p.author_image,
      text: p.text,
      created_at: Number(p.created_at),
      likes: Number(p.likes),
      reposts: Number(p.reposts),
      replies: Number(p.replies),
      views: p.views === null ? null : Number(p.views),
      links: list(p.links),
      ...stats,
    };
  };
  const all = [...published, ...extra];
  const posts = all
    .filter((p) => p.kind === "post")
    .map(shape)
    .sort((a, b) => b.revenue - a.revenue || b.visitors - a.visitors || b.created_at - a.created_at)
    .slice(0, limit);
  const profiles = all
    .filter((p) => p.kind === "bio")
    .map(shape)
    .sort((a, b) => b.revenue - a.revenue || b.visitors - a.visitors);

  return {
    summary: {
      mentions: platforms.reduce((n, p) => n + (mentions[p] ?? 0), 0),
      ...Object.fromEntries(
        platforms.map((p) => [
          p,
          {
            mentions: mentions[p] ?? 0,
            visits: totals[p].visits,
            credited_visits: totals[p].credited,
            revenue: totals[p].revenue,
            credited_revenue: totals[p].credited_revenue,
          },
        ]),
      ),
    },
    posts,
    profiles,
  };
}

/** For the dashboard's meta: whether any post was found, so shared dashboards show the Social page. */
export async function hasSocialPosts(db: Database, siteId: string): Promise<boolean> {
  return !!(await db.first("SELECT 1 AS found FROM social_posts WHERE site_id = ? LIMIT 1", [siteId]));
}

