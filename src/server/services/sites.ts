import type { Database } from "../db/types";

export type AttributionModel = "last_non_direct" | "last_touch" | "first_touch";

export interface SiteSettings {
  /** Extra root domains tracked as part of this website (cross-domain tracking). */
  allowedHostnames?: string[];
  excludedIps?: string[];
  excludedPaths?: string[];
  excludedCountries?: string[];
  excludedHostnames?: string[];
  /** Cookieless mode: visitors are identified by a daily-rotating hash instead of a cookie. */
  cookieless?: boolean;
  /** Accept events from localhost (useful for testing). */
  allowLocalhost?: boolean;
  /** Reject events whose hostname isn't the site's domain, a subdomain, or an allowed hostname. */
  strictHostnames?: boolean;
  /** "#1 KPI": a goal shown as the main conversion metric next to revenue. */
  kpiGoal?: string | null;
  attribution?: AttributionModel;
  /** Hide the revenue features for sites that don't sell anything. */
  hideRevenue?: boolean;
}

export interface Site {
  id: string;
  domain: string;
  name: string;
  timezone: string;
  currency: string;
  settings: SiteSettings;
  share_token: string | null;
  created_by: string | null;
  created_at: number;
}

interface SiteRow extends Omit<Site, "settings"> {
  settings: string;
}

export function parseSite(row: SiteRow): Site {
  let settings: SiteSettings = {};
  try {
    settings = JSON.parse(row.settings || "{}");
  } catch {
    settings = {};
  }
  return { ...row, created_at: Number(row.created_at), settings };
}

const cache = new Map<string, { site: Site | null; at: number }>();
const TTL = 30_000;

export async function getSite(db: Database, id: string): Promise<Site | null> {
  const row = await db.first<SiteRow>("SELECT * FROM sites WHERE id = ?", [id]);
  return row ? parseSite(row) : null;
}

/** Cached lookup used on the hot ingestion path. */
export async function getSiteCached(db: Database, id: string): Promise<Site | null> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.site;
  const site = await getSite(db, id);
  cache.set(id, { site, at: Date.now() });
  if (cache.size > 5000) cache.clear();
  return site;
}

export function invalidateSite(id: string) {
  cache.delete(id);
}

export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/^www\./, "");
  return d;
}

export function isValidDomain(d: string): boolean {
  return /^(?=.{1,253}$)(?!-)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(d) || d === "localhost";
}

/** Hostnames that belong to the website (used for self-referral detection and hostname checks). */
export function siteHosts(site: Site): string[] {
  return [site.domain, ...(site.settings.allowedHostnames ?? [])].map(normalizeDomain).filter(Boolean);
}

export function hostAllowed(site: Site, hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost")) return !!site.settings.allowLocalhost || site.domain === "localhost";
  if (site.settings.strictHostnames === false) return true;
  return siteHosts(site).some((d) => h === d || h.endsWith("." + d));
}

export type Role = "owner" | "admin" | "viewer";
const RANK: Record<Role, number> = { viewer: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: string | null | undefined, min: Role): boolean {
  if (!role) return false;
  return (RANK[role as Role] ?? 0) >= RANK[min];
}

export async function getMemberRole(db: Database, siteId: string, userId: string): Promise<Role | null> {
  const row = await db.first<{ role: Role }>("SELECT role FROM site_members WHERE site_id = ? AND user_id = ?", [siteId, userId]);
  return row?.role ?? null;
}

/**
 * Consumes an invitation if it is still valid: unexpired, and its creator still exists and can invite
 * (admin or owner of the site, or an instance admin). Removing or demoting the creator voids their links.
 * Returns the invite, or null. The delete is the claim, so a token can't be redeemed twice concurrently.
 */
export async function claimInvite(db: Database, tokenHash: string): Promise<{ site_id: string; role: Role } | null> {
  const invite = await findInvite(db, tokenHash);
  if (!invite) return null;
  const { changes } = await db.run("DELETE FROM invites WHERE id = ?", [tokenHash]);
  return changes > 0 ? { site_id: invite.site_id, role: invite.role } : null;
}

/**
 * Looks up an unexpired invite whose creator can still grant it (an instance admin, or an admin/owner of the
 * site). Invites from someone who has since lost that authority are deleted and treated as invalid.
 */
export async function findInvite(
  db: Database,
  tokenHash: string,
): Promise<{ site_id: string; role: Role; email: string | null } | null> {
  const invite = await db.first<{ site_id: string; role: Role; email: string | null; created_by: string | null }>(
    "SELECT site_id, role, email, created_by FROM invites WHERE id = ? AND expires_at > ?",
    [tokenHash, Date.now()],
  );
  if (!invite) return null;
  const creator = invite.created_by ? await db.first<{ is_admin: number }>("SELECT is_admin FROM users WHERE id = ?", [invite.created_by]) : null;
  const creatorRole = invite.created_by ? await getMemberRole(db, invite.site_id, invite.created_by) : null;
  if (!creator || (!creator.is_admin && !roleAtLeast(creatorRole, "admin"))) {
    await db.run("DELETE FROM invites WHERE id = ?", [tokenHash]);
    return null;
  }
  return { site_id: invite.site_id, role: invite.role, email: invite.email };
}
