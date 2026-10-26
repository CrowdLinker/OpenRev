/**
 * Google APIs with a service account: the user creates one in Google Cloud, gives it read access (a Viewer on a GA4
 * property, a user in Search Console) and pastes its JSON key into OpenRev. OpenRev signs a JWT with the key and trades
 * it for an access token, so no OAuth app or Google review is needed. Works on Workers and Node (Web Crypto only).
 */

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id?: string;
}

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** Parses a pasted JSON key file, or throws a message the user can act on. */
export function parseServiceAccountKey(input: unknown): ServiceAccountKey {
  let key: Record<string, unknown>;
  try {
    key = typeof input === "string" ? JSON.parse(input) : (input as Record<string, unknown>);
  } catch {
    throw new GoogleError("That isn't a JSON key file. In Google Cloud, open the service account → Keys → Add key → JSON, and paste the whole file.");
  }
  if (!key || key.type !== "service_account" || typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    throw new GoogleError("That JSON isn't a service account key: it needs \"type\": \"service_account\", a client_email and a private_key.");
  }
  if (!key.private_key.includes("BEGIN PRIVATE KEY")) throw new GoogleError("The key's private_key isn't a PEM private key.");
  const tokenUri = typeof key.token_uri === "string" && /^https:\/\/oauth2\.googleapis\.com\/token$/.test(key.token_uri) ? key.token_uri : "https://oauth2.googleapis.com/token";
  return {
    client_email: key.client_email,
    private_key: key.private_key,
    token_uri: tokenUri,
    project_id: typeof key.project_id === "string" ? key.project_id : undefined,
  };
}

const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

async function importKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  let der: Uint8Array<ArrayBuffer>;
  try {
    der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  } catch {
    throw new GoogleError("The key's private_key isn't valid base64.");
  }
  try {
    return await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new GoogleError("The key's private_key can't be read as an RSA key.");
  }
}

/** A signed JWT asking for `scope`, valid for an hour. */
export async function signAssertion(key: ServiceAccountKey, scope: string, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  const unsigned = `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson({ iss: key.client_email, scope, aud: key.token_uri, iat, exp: iat + 3600 })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importKey(key.private_key), new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(signature)}`;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
const tokens = new Map<string, { token: string; expires: number }>();

/** An access token for the service account, cached until a minute before it expires. */
export async function accessToken(key: ServiceAccountKey, scope: string, fetchFn: FetchFn = fetch, now = Date.now()): Promise<string> {
  const cacheKey = `${key.client_email}\u0000${scope}`;
  const cached = tokens.get(cacheKey);
  if (cached && cached.expires > now + 60_000) return cached.token;
  const res = await fetchFn(key.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await signAssertion(key, scope, now) }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new GoogleError(
      body.error === "invalid_grant"
        ? "Google rejected the key: it may have been deleted or disabled. Create a new JSON key for the service account."
        : `Google sign-in failed: ${body.error_description || body.error || res.status}`,
      res.status,
    );
  }
  tokens.set(cacheKey, { token: body.access_token, expires: now + (body.expires_in ?? 3600) * 1000 });
  if (tokens.size > 100) tokens.delete(tokens.keys().next().value!);
  return body.access_token;
}

/** Calls a Google JSON API and turns its errors into messages that say what to fix. */
export async function googleJson<T>(url: string, token: string, body: unknown, fetchFn: FetchFn = fetch): Promise<T> {
  const res = await fetchFn(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string; details?: { reason?: string; metadata?: Record<string, string> }[] } };
  if (!res.ok) {
    const err = data.error ?? {};
    const reason = err.details?.find((d) => d.reason)?.reason;
    const activation = err.details?.find((d) => d.metadata?.activationUrl)?.metadata?.activationUrl;
    let message = err.message || `Google returned HTTP ${res.status}`;
    if (reason === "SERVICE_DISABLED" || /has not been used in project|is disabled/i.test(message)) {
      message = `The API isn't enabled for the service account's Google Cloud project. Enable it${activation ? ` at ${activation}` : " in Google Cloud → APIs & Services"}, wait a minute, then try again.`;
    }
    throw new GoogleError(message, res.status);
  }
  return data;
}

export function clearGoogleTokens() {
  tokens.clear();
}
