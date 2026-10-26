import { fromBase64, hmac, safeEqual, toBase64, toHex, type HmacAlgo } from "../lib/crypto";
import { isValidClientId } from "../lib/ids";

/** Metadata keys recognised as a visitor id (OpenRev, DataFast-compatible and generic). */
export const VISITOR_KEYS = ["openrev_visitor_id", "openrevVisitorId", "datafast_visitor_id", "visitor_id", "visitorId", "df_visitor_id"];
export const SESSION_KEYS = ["openrev_session_id", "openrevSessionId", "datafast_session_id", "session_id_openrev"];

type Bag = Record<string, unknown> | null | undefined;

function pick(bags: Bag[], keys: string[]): string | null {
  for (const bag of bags) {
    if (!bag || typeof bag !== "object") continue;
    for (const k of keys) {
      const v = (bag as Record<string, unknown>)[k];
      if (typeof v === "string" && isValidClientId(v)) return v;
    }
  }
  return null;
}

/** Finds the OpenRev visitor id in one or more metadata objects. */
export function pickVisitorId(...bags: Bag[]): string | null {
  return pick(bags, VISITOR_KEYS);
}

export function pickSessionId(...bags: Bag[]): string | null {
  return pick(bags, SESSION_KEYS);
}

/** Reads a dotted path like `data.object.metadata.visitor` (supports array indexes: `items.0.id`). */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

export function str(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "object" && v && "id" in v && typeof (v as { id: unknown }).id === "string") return (v as { id: string }).id;
  return null;
}

/** Parses a number from numbers or numeric strings ("19.99"). */
export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Converts unix seconds, unix ms or ISO strings to epoch ms. */
export function toMs(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) return toMs(Number(v));
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function parseJson<T = Record<string, unknown>>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function header(headers: Headers, name: string): string | null {
  return headers.get(name);
}

/**
 * Verifies a Standard Webhooks signature (https://www.standardwebhooks.com), used by
 * Polar, Dodo Payments, Svix-based providers and others.
 *
 * `secretEncoding`:
 * - `"auto"` (default): secrets formatted as `whsec_<base64>` are base64-decoded, and the full secret is
 *   also tried as raw UTF-8 bytes (Polar's legacy scheme signs with the UTF-8 bytes of the whole `whsec_…` string).
 * - `"base64"`: strict Standard Webhooks — strip an optional `whsec_` prefix and base64-decode the rest.
 */
export async function verifyStandardWebhook(
  req: { headers: Headers; rawBody: string },
  secret: string | undefined,
  toleranceSec = 600,
  secretEncoding: "auto" | "base64" = "auto",
): Promise<boolean> {
  if (!secret) return false;
  const id = req.headers.get("webhook-id") ?? req.headers.get("svix-id");
  const ts = req.headers.get("webhook-timestamp") ?? req.headers.get("svix-timestamp");
  const sigHeader = req.headers.get("webhook-signature") ?? req.headers.get("svix-signature");
  if (!id || !ts || !sigHeader) return false;
  if (!/^\d+$/.test(ts.trim()) || Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSec) return false;
  const content = `${id}.${ts}.${req.rawBody}`;
  const keys: Uint8Array[] = [];
  const s = secret.trim();
  if (secretEncoding === "base64" || s.startsWith("whsec_")) {
    try {
      const decoded = fromBase64(s.startsWith("whsec_") ? s.slice(6) : s);
      if (decoded.length) keys.push(decoded);
    } catch {
      /* ignore */
    }
  }
  if (secretEncoding === "auto") keys.push(new TextEncoder().encode(s));
  const provided = sigHeader
    .split(" ")
    .map((part) => part.split(",")[1] ?? part)
    .filter(Boolean);
  for (const key of keys) {
    const expected = toBase64(await hmac("SHA-256", key, content));
    if (provided.some((p) => safeEqual(p, expected))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers shared by provider adapters
// ---------------------------------------------------------------------------

export type SignatureAlgorithm = "sha1" | "sha256" | "sha512";

const HMAC_ALGOS: Record<SignatureAlgorithm, HmacAlgo> = { sha1: "SHA-1", sha256: "SHA-256", sha512: "SHA-512" };

/**
 * Verifies an HMAC signature of `data` against one or more provided signatures (constant-time).
 * Hex signatures are compared case-insensitively; an optional `prefix` (e.g. `sha256=`) is stripped.
 */
export async function verifyHmacSignature(opts: {
  algorithm: SignatureAlgorithm;
  secret: string | Uint8Array | undefined | null;
  data: string;
  signature: string | string[] | null | undefined;
  encoding: "hex" | "base64";
  prefix?: string;
}): Promise<boolean> {
  const { algorithm, secret, data, encoding } = opts;
  if (!secret || (typeof secret === "string" && !secret.trim())) return false;
  const provided = (Array.isArray(opts.signature) ? opts.signature : [opts.signature])
    .filter((s): s is string => typeof s === "string" && s.trim() !== "")
    .map((s) => {
      let v = s.trim();
      if (opts.prefix && v.toLowerCase().startsWith(opts.prefix.toLowerCase())) v = v.slice(opts.prefix.length);
      return encoding === "hex" ? v.toLowerCase() : v;
    });
  if (!provided.length) return false;
  const key = typeof secret === "string" ? secret.trim() : secret;
  const mac = await hmac(HMAC_ALGOS[algorithm], key, data);
  const expected = encoding === "hex" ? toHex(mac) : toBase64(mac);
  let ok = false;
  for (const p of provided) if (safeEqual(p, expected)) ok = true;
  return ok;
}

/** Constant-time check that the webhook URL carries `?token=<expected>` (for providers without signatures). */
export function urlTokenMatches(url: URL, expected: string | undefined | null, param = "token"): boolean {
  if (!expected || !expected.trim()) return false;
  const got = url.searchParams.get(param);
  if (!got) return false;
  return safeEqual(got, expected.trim());
}

/**
 * Parses an `application/x-www-form-urlencoded` body into an object, expanding Rails/PHP-style
 * brackets: `url_params[visitor]=x&items[]=a` → `{ url_params: { visitor: "x" }, items: ["a"] }`.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseForm(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const params = new URLSearchParams(raw);
  for (const [fullKey, value] of params) {
    const m = fullKey.match(/^([^[\]]+)((?:\[[^\]]*\])*)$/);
    if (!m) {
      if (!UNSAFE_KEYS.has(fullKey)) out[fullKey] = value;
      continue;
    }
    const parts = [m[1], ...Array.from(m[2].matchAll(/\[([^\]]*)\]/g), (x) => x[1])];
    if (parts.some((p) => UNSAFE_KEYS.has(p))) continue;
    let cur: Record<string, unknown> | unknown[] = out;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const last = i === parts.length - 1;
      if (Array.isArray(cur)) {
        if (last) cur.push(value);
        else {
          const next: Record<string, unknown> = {};
          cur.push(next);
          cur = next;
        }
        continue;
      }
      const bag = cur as Record<string, unknown>;
      if (last) {
        bag[part] = value;
      } else {
        const wantsArray = parts[i + 1] === "";
        const existing = bag[part];
        if (wantsArray ? !Array.isArray(existing) : !existing || typeof existing !== "object" || Array.isArray(existing)) {
          bag[part] = wantsArray ? [] : {};
        }
        cur = bag[part] as Record<string, unknown> | unknown[];
      }
    }
  }
  return out;
}

/** Converts `[{ name, value }]` / `[{ key, value }]` style arrays (Shopify note_attributes, WooCommerce meta_data…) into an object. */
export function pairsToObject(list: unknown, keyField = "name", valueField = "value"): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const k = (item as Record<string, unknown>)[keyField];
    if (typeof k === "string" && k && !UNSAFE_KEYS.has(k)) out[k] = (item as Record<string, unknown>)[valueField];
  }
  return out;
}

/** Returns `v` when it is a plain object, parses it when it is a JSON object string, otherwise null. */
export function asObject(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string" && v.trim().startsWith("{")) {
    const parsed = parseJson<unknown>(v);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }
  return null;
}

/** Like `toMs`, but ISO strings without a timezone (e.g. WooCommerce `*_gmt` fields) are read as UTC. */
export function utcMs(v: unknown): number | null {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v.trim())) {
    return toMs(v.trim().replace(" ", "T") + "Z");
  }
  return toMs(v);
}

/** Interprets provider booleans that may arrive as booleans, numbers or strings ("true", "1"). */
export function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return ["true", "1", "yes"].includes(v.trim().toLowerCase());
  return false;
}

/** Upper-cased ISO currency code, or null when the value is not a 3-letter code. */
export function currencyCode(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : null;
}

/** GETs a provider API with a bearer key, for history imports. Errors carry the provider's name and status. */
export async function apiGet<T = Record<string, unknown>>(provider: string, url: string, key: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text();
    const hint = res.status === 401 || res.status === 403 ? " Check the API key and its permissions." : "";
    throw new Error(`${provider} API error ${res.status}: ${body.slice(0, 300)}${hint}`);
  }
  return res.json() as Promise<T>;
}
