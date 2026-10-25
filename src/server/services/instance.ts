import type { Database } from "../db/types";
import { randomToken } from "../lib/ids";
import type { Runtime } from "../context";

export async function getInstanceValue(db: Database, key: string): Promise<string | null> {
  const row = await db.first<{ value: string }>("SELECT value FROM instance WHERE key = ?", [key]);
  return row?.value ?? null;
}

export async function setInstanceValue(db: Database, key: string, value: string): Promise<void> {
  await db.run("INSERT INTO instance (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [
    key,
    value,
  ]);
}

let cachedSecret: string | null = null;

/** Secret used for encrypting stored credentials. Prefers OPENREV_SECRET, else a generated per-instance value. */
export async function getSecret(rt: Runtime): Promise<string> {
  if (rt.config.secret) return rt.config.secret;
  if (cachedSecret) return cachedSecret;
  let secret = await getInstanceValue(rt.db, "secret");
  if (!secret) {
    const generated = randomToken(32);
    await rt.db.run("INSERT INTO instance (key, value) VALUES ('secret', ?) ON CONFLICT (key) DO NOTHING", [generated]);
    secret = (await getInstanceValue(rt.db, "secret")) ?? generated;
  }
  cachedSecret = secret;
  return secret;
}
