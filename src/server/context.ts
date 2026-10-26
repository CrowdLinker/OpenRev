import type { Context } from "hono";
import type { Database } from "./db/types";
import type { GeoResolver } from "./lib/geo";
import { isPublicIp } from "./lib/net";
import { ipMatches } from "./lib/validate";
import type { Site } from "./services/sites";

export const VERSION = "0.2.0";

export interface AppConfig {
  /** Secret used to encrypt provider credentials. Falls back to a generated value stored in the database. */
  secret?: string;
  /** Public base URL of this OpenRev instance (e.g. https://analytics.example.com). Derived from requests when unset. */
  publicUrl?: string;
  /** Disable public sign-ups after the first (admin) account is created. Invites still work. */
  disableSignup?: boolean;
  /** Resend API key used for emails (invites, alerts, digests). */
  resendApiKey?: string;
  emailFrom?: string;
  /** Delete raw events older than this many days (0 / unset = keep forever). */
  retentionDays?: number;
  /**
   * Whether to trust X-Forwarded-For style headers. For rate limits, `true` (the default) trusts them from
   * private or loopback peers, and a list trusts them only from those proxy addresses (IPs or IPv4 CIDRs).
   */
  trustProxy?: boolean | string[];
}

export interface Runtime {
  platform: "cloudflare" | "node";
  db: Database;
  config: AppConfig;
  /** Resolves geolocation for an IP (Cloudflare `request.cf`, MaxMind/DB-IP database on Node...). */
  geo?: GeoResolver;
  /** Keeps background work alive after the response is sent. */
  waitUntil: (p: Promise<unknown>) => void;
  /** Socket-level remote address when available (Node). */
  remoteAddress?: (c: Context) => string | null;
  /** Object identifying the underlying connection, used to run migrations once per isolate. */
  dbKey?: object;
  /**
   * POSTs to a user-configured https URL, connecting only to public addresses (Node). Without it, alerts use
   * plain fetch: Workers can't reach private networks.
   */
  postPublic?: (url: URL, body: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;
}

export type AppEnv = {
  Variables: {
    rt: Runtime;
    user: AuthUser | null;
    apiKey: ApiKeyAuth | null;
    /** Website resolved for stats routes (dashboard, public share links, API). */
    site: Site;
    /** True on public share links: personal data (names, emails) is hidden. */
    isPublic: boolean;
  };
};

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  is_admin: number;
}

export interface ApiKeyAuth {
  id: string;
  userId: string;
  siteId: string | null;
}

export interface ClientIp {
  ip: string | null;
  /**
   * True when the request reached OpenRev through another proxy (e.g. the tracked website proxies
   * /api/events to avoid ad blockers): the edge's own geolocation then describes the proxy, not the visitor.
   */
  proxied: boolean;
}

export function getClientIpInfo(c: Context<AppEnv>): ClientIp {
  const h = (k: string) => c.req.header(k)?.trim() || null;
  const rt = c.get("rt");
  const trust = rt.platform === "cloudflare" || rt.config.trustProxy !== false;
  if (!trust) return { ip: rt.remoteAddress?.(c) ?? null, proxied: false };
  // The first X-Forwarded-For entry is the original client, even when a proxy (or Cloudflare) appended itself.
  const forwarded = h("x-forwarded-for")?.split(",")[0].trim() || null;
  const edge = h("cf-connecting-ip") || h("true-client-ip") || h("fly-client-ip") || h("x-real-ip");
  const ip = forwarded || edge || rt.remoteAddress?.(c) || null;
  return { ip, proxied: !!(forwarded && edge && forwarded !== edge) };
}

export function getClientIp(c: Context<AppEnv>): string | null {
  return getClientIpInfo(c).ip;
}

/**
 * The address of the nearest peer, for rate limits and other security decisions. Unlike getClientIp
 * (which honours the visitor address a website's proxy forwards, for analytics), it never uses the
 * client-supplied start of X-Forwarded-For.
 */
export function getPeerIp(c: Context<AppEnv>): string | null {
  const rt = c.get("rt");
  if (rt.platform === "cloudflare") return c.req.header("cf-connecting-ip")?.trim() || null;
  const socket = rt.remoteAddress?.(c)?.replace(/^::ffff:/, "") ?? null;
  // Forwarded headers only count when the connection comes from a trusted proxy: one of the configured
  // addresses, or by default any private-network peer (same host, Docker network, Fly/Render/Railway edge).
  // A directly exposed server uses the socket.
  const proxies = rt.config.trustProxy;
  const trusted = Array.isArray(proxies)
    ? !!socket && proxies.some((rule) => ipMatches(rule, socket))
    : proxies !== false && !(socket && isPublicIp(socket));
  if (!trusted) return socket;
  // A reverse proxy appends the address it received the request from; earlier entries come from the client.
  const chain = (c.req.header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return chain[chain.length - 1] ?? socket;
}

export function publicUrl(c: Context<AppEnv>): string {
  const configured = c.get("rt").config.publicUrl;
  if (configured) return configured.replace(/\/$/, "");
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") || url.host;
  return `${proto}://${host}`;
}
