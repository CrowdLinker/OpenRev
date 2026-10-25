import type { Context } from "hono";
import type { Database } from "./db/types";
import type { GeoResolver } from "./lib/geo";
import type { Site } from "./services/sites";

export const VERSION = "0.1.0";

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
  /** Whether to trust X-Forwarded-For style headers for the client IP. */
  trustProxy?: boolean;
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

export function publicUrl(c: Context<AppEnv>): string {
  const configured = c.get("rt").config.publicUrl;
  if (configured) return configured.replace(/\/$/, "");
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") || url.host;
  return `${proto}://${host}`;
}
