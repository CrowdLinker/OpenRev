import type { Database } from "./types";

/**
 * Schema migrations. Every statement must be valid on both SQLite (D1 / node:sqlite)
 * and PostgreSQL. SQLite happily accepts BIGINT and DOUBLE PRECISION as type names.
 *
 * Migrations are applied automatically on startup (or on the first request on
 * Cloudflare Workers) so self-hosters never have to run a migration command.
 * Never edit a migration that has shipped: append a new one instead.
 */
export const migrations: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "initial",
    sql: `
CREATE TABLE IF NOT EXISTS instance (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions (user_id);

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  currency TEXT NOT NULL DEFAULT 'USD',
  settings TEXT NOT NULL DEFAULT '{}',
  share_token TEXT,
  created_by TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sites_domain ON sites (domain);
CREATE UNIQUE INDEX IF NOT EXISTS sites_share_token ON sites (share_token);

CREATE TABLE IF NOT EXISTS site_members (
  site_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (site_id, user_id)
);
CREATE INDEX IF NOT EXISTS site_members_user ON site_members (user_id);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL,
  created_by TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS invites_site ON invites (site_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  site_id TEXT,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT
);
CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys (user_id);
CREATE INDEX IF NOT EXISTS api_keys_site ON api_keys (site_id);

CREATE TABLE IF NOT EXISTS visitors (
  site_id TEXT NOT NULL,
  id TEXT NOT NULL,
  first_seen BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  sessions INTEGER NOT NULL DEFAULT 0,
  user_id TEXT,
  name TEXT,
  email TEXT,
  image TEXT,
  props TEXT,
  PRIMARY KEY (site_id, id)
);
CREATE INDEX IF NOT EXISTS visitors_last_seen ON visitors (site_id, last_seen);
CREATE INDEX IF NOT EXISTS visitors_user ON visitors (site_id, user_id);
CREATE INDEX IF NOT EXISTS visitors_email ON visitors (site_id, email);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  duration BIGINT NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  goals INTEGER NOT NULL DEFAULT 0,
  is_new INTEGER NOT NULL DEFAULT 0,
  entry_page TEXT,
  exit_page TEXT,
  hostname TEXT,
  referrer TEXT,
  referrer_domain TEXT,
  source TEXT,
  channel TEXT NOT NULL,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  ref TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  browser TEXT,
  browser_version TEXT,
  os TEXT,
  os_version TEXT,
  device TEXT,
  language TEXT
);
CREATE INDEX IF NOT EXISTS sessions_site_started ON sessions (site_id, started_at);
CREATE INDEX IF NOT EXISTS sessions_site_last_seen ON sessions (site_id, last_seen_at);
CREATE INDEX IF NOT EXISTS sessions_visitor ON sessions (site_id, visitor_id, started_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  type TEXT NOT NULL,
  name TEXT,
  path TEXT,
  hostname TEXT,
  props TEXT
);
CREATE INDEX IF NOT EXISTS events_site_ts ON events (site_id, ts);
CREATE INDEX IF NOT EXISTS events_site_type_ts ON events (site_id, type, ts);
CREATE INDEX IF NOT EXISTS events_session ON events (session_id);
CREATE INDEX IF NOT EXISTS events_visitor ON events (site_id, visitor_id, ts);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount BIGINT NOT NULL,
  currency TEXT NOT NULL,
  revenue BIGINT NOT NULL,
  revenue_currency TEXT NOT NULL,
  ts BIGINT NOT NULL,
  visitor_id TEXT,
  first_session_id TEXT,
  last_session_id TEXT,
  touch_session_id TEXT,
  customer_id TEXT,
  email TEXT,
  name TEXT,
  ref TEXT,
  subscription_id TEXT,
  description TEXT,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_unique_tx ON payments (site_id, provider, transaction_id);
CREATE INDEX IF NOT EXISTS payments_site_ts ON payments (site_id, ts);
CREATE INDEX IF NOT EXISTS payments_visitor ON payments (site_id, visitor_id);
CREATE INDEX IF NOT EXISTS payments_ref ON payments (site_id, ref);
CREATE INDEX IF NOT EXISTS payments_customer ON payments (site_id, customer_id);

CREATE TABLE IF NOT EXISTS customers (
  site_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  visitor_id TEXT,
  email TEXT,
  name TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (site_id, provider, customer_id)
);

CREATE TABLE IF NOT EXISTS checkout_refs (
  site_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  session_id TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (site_id, ref)
);

CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  name TEXT,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  last_event_at BIGINT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS integrations_site ON integrations (site_id);

CREATE TABLE IF NOT EXISTS funnels (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  steps TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS funnels_site ON funnels (site_id);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  text TEXT NOT NULL,
  url TEXT,
  created_by TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_site_ts ON notes (site_id, ts);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  type TEXT NOT NULL,
  channel TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  last_triggered_at BIGINT
);
CREATE INDEX IF NOT EXISTS alerts_site ON alerts (site_id);

CREATE TABLE IF NOT EXISTS alert_history (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  status TEXT NOT NULL,
  message TEXT
);
CREATE INDEX IF NOT EXISTS alert_history_site ON alert_history (site_id, ts);

CREATE TABLE IF NOT EXISTS fx_rates (
  day TEXT PRIMARY KEY,
  base TEXT NOT NULL,
  rates TEXT NOT NULL,
  fetched_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  name TEXT PRIMARY KEY,
  last_run_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS salts (
  day TEXT PRIMARY KEY,
  salt TEXT NOT NULL
);
`,
  },
];

export const LATEST_MIGRATION = migrations[migrations.length - 1].id;

const migrated = new WeakMap<object, Promise<void>>();

/**
 * Applies pending migrations once per process / isolate. Safe to call on every request.
 * `key` identifies the underlying connection (e.g. the D1 binding) so the check is cached.
 */
export function ensureMigrated(db: Database, key: object = db): Promise<void> {
  let p = migrated.get(key);
  if (!p) {
    p = migrate(db).catch((err) => {
      migrated.delete(key);
      throw err;
    });
    migrated.set(key, p);
  }
  return p;
}

export async function migrate(db: Database): Promise<void> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)",
  );
  const rows = await db.all<{ id: number }>("SELECT id FROM _migrations");
  const applied = new Set(rows.map((r) => Number(r.id)));
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    await db.exec(m.sql);
    await db.run("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING", [
      m.id,
      m.name,
      Date.now(),
    ]);
  }
}
