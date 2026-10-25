const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

export type HmacAlgo = "SHA-1" | "SHA-256" | "SHA-512";

export async function hmac(algo: HmacAlgo, key: string | Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const keyBytes = typeof key === "string" ? enc.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "HMAC", hash: algo }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, (typeof data === "string" ? enc.encode(data) : data) as BufferSource);
  return new Uint8Array(sig);
}

export async function hmacHex(algo: HmacAlgo, key: string | Uint8Array, data: string | Uint8Array) {
  return toHex(await hmac(algo, key, data));
}

export async function hmacBase64(algo: HmacAlgo, key: string | Uint8Array, data: string | Uint8Array) {
  return toBase64(await hmac(algo, key, data));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Password hashing (PBKDF2-SHA256). Workers cap PBKDF2 at 100k iterations.
// Format: pbkdf2$<iterations>$<saltHex>$<hashHex>
// ---------------------------------------------------------------------------

const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, saltHex, hashHex] = stored.split("$");
  if (scheme !== "pbkdf2" || !iter || !saltHex || !hashHex) return false;
  const hash = await pbkdf2(password, fromHex(saltHex), Number(iter));
  return safeEqual(toHex(hash), hashHex);
}

// ---------------------------------------------------------------------------
// Symmetric encryption for provider secrets stored in the database (AES-GCM).
// Format: enc:v1:<ivBase64>:<cipherBase64>
// ---------------------------------------------------------------------------

const keyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle
      .digest("SHA-256", enc.encode("openrev-encryption:" + secret))
      .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
    keyCache.set(secret, k);
  }
  return k;
}

export async function encryptString(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(plaintext));
  return `enc:v1:${toBase64(iv)}:${toBase64(cipher)}`;
}

export async function decryptString(secret: string, value: string): Promise<string> {
  if (!value.startsWith("enc:v1:")) return value;
  const [, , ivB64, dataB64] = value.split(":");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(ivB64) as BufferSource },
    await aesKey(secret),
    fromBase64(dataB64) as BufferSource,
  );
  return new TextDecoder().decode(plain);
}
