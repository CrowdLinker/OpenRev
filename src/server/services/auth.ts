import type { Database } from "../db/types";
import type { AuthUser } from "../context";
import { hashPassword, sha256Hex, verifyPassword } from "../lib/crypto";
import { randomToken, uuid } from "../lib/ids";
import { getInstanceValue } from "./instance";

export const SESSION_COOKIE = "openrev_auth";
export const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

export async function userCount(db: Database): Promise<number> {
  const row = await db.first<{ c: number }>("SELECT COUNT(*) AS c FROM users");
  return Number(row?.c ?? 0);
}

export async function signupEnabled(db: Database, disableSignupEnv?: boolean): Promise<boolean> {
  if ((await userCount(db)) === 0) return true;
  if (disableSignupEnv) return false;
  return (await getInstanceValue(db, "signup_enabled")) === "true";
}

export async function createUser(
  db: Database,
  input: { email: string; password: string; name?: string | null; isAdmin?: boolean },
): Promise<AuthUser> {
  const id = uuid();
  const email = input.email.trim().toLowerCase();
  const hash = await hashPassword(input.password);
  await db.run("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    email,
    input.name?.trim() || null,
    hash,
    input.isAdmin ? 1 : 0,
    Date.now(),
  ]);
  return { id, email, name: input.name?.trim() || null, is_admin: input.isAdmin ? 1 : 0 };
}

export async function authenticate(db: Database, email: string, password: string): Promise<AuthUser | null> {
  const row = await db.first<AuthUser & { password_hash: string }>(
    "SELECT id, email, name, is_admin, password_hash FROM users WHERE email = ?",
    [email.trim().toLowerCase()],
  );
  if (!row) {
    // keep timing similar for unknown emails
    await hashPassword(password);
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) return null;
  return { id: row.id, email: row.email, name: row.name, is_admin: Number(row.is_admin) };
}

export async function createSession(db: Database, userId: string): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await db.run("INSERT INTO auth_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", [
    await sha256Hex(token),
    userId,
    now + SESSION_TTL,
    now,
  ]);
  return token;
}

export async function userFromSession(db: Database, token: string): Promise<AuthUser | null> {
  if (!token || token.length > 128) return null;
  const row = await db.first<AuthUser & { expires_at: number }>(
    `SELECT u.id, u.email, u.name, u.is_admin, s.expires_at FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    [await sha256Hex(token)],
  );
  if (!row || Number(row.expires_at) < Date.now()) return null;
  return { id: row.id, email: row.email, name: row.name, is_admin: Number(row.is_admin) };
}

export async function deleteSession(db: Database, token: string) {
  await db.run("DELETE FROM auth_sessions WHERE id = ?", [await sha256Hex(token)]);
}

// ---------------------------------------------------------------------------
// API keys: `or_...` (website key) and `ort_...` (account token)
// ---------------------------------------------------------------------------

export async function createApiKey(db: Database, input: { userId: string; siteId: string | null; name: string }) {
  const prefix = input.siteId ? "or_" : "ort_";
  const key = prefix + randomToken(24);
  const id = uuid();
  await db.run(
    "INSERT INTO api_keys (id, key_hash, prefix, name, user_id, site_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, await sha256Hex(key), key.slice(0, prefix.length + 6), input.name.slice(0, 100), input.userId, input.siteId, Date.now()],
  );
  return { id, key };
}

export async function verifyApiKey(db: Database, key: string) {
  if (!/^ort?_[a-f0-9]{48}$/.test(key)) return null;
  const row = await db.first<{ id: string; user_id: string; site_id: string | null; last_used_at: number | null }>(
    "SELECT id, user_id, site_id, last_used_at FROM api_keys WHERE key_hash = ?",
    [await sha256Hex(key)],
  );
  if (!row) return null;
  const now = Date.now();
  if (!row.last_used_at || now - Number(row.last_used_at) > 60_000) {
    await db.run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", [now, row.id]).catch(() => {});
  }
  return { id: row.id, userId: row.user_id, siteId: row.site_id };
}
