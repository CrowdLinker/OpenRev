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
  {
    id: 2,
    name: "subscription billing interval",
    // How often a subscription payment recurs, when the provider says so. MRR uses it to spread a payment over
    // its period; for payments without it the interval is inferred from the gaps between renewals.
    sql: `
ALTER TABLE payments ADD COLUMN billing_interval TEXT;
ALTER TABLE payments ADD COLUMN billing_interval_count INTEGER;
CREATE INDEX IF NOT EXISTS payments_subscription ON payments (site_id, subscription_id);
`,
  },
  {
    id: 3,
    name: "imported history",
    // Daily totals imported from Plausible or Google Analytics, for the time before OpenRev. `dim` is '' for a day's
    // totals, else the dimension (source, page, country…) that `value` belongs to; `ts` is the start of that day in the
    // website's timezone. Each chunk of rows is recorded in import_chunks so a retried upload isn't counted twice.
    sql: `
CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  config TEXT,
  cursor TEXT,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_by TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS imports_site ON imports (site_id);
CREATE TABLE IF NOT EXISTS imported_stats (
  site_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  dim TEXT NOT NULL,
  value TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '',
  visitors INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  duration BIGINT NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (import_id, ts, dim, value, meta)
);
CREATE INDEX IF NOT EXISTS imported_stats_site ON imported_stats (site_id, dim, ts);
CREATE TABLE IF NOT EXISTS import_chunks (
  import_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (import_id, seq)
);
`,
  },
  {
    id: 4,
    name: "google search console",
    // A website's Search Console connection (the property and an encrypted service account key) and the clicks,
    // impressions and positions it reports per day, query and landing page. `position` is a sum weighted by
    // impressions, so averages can be taken over any range. `oldest`/`newest` are the days synced so far.
    sql: `
CREATE TABLE IF NOT EXISTS search_console (
  site_id TEXT PRIMARY KEY,
  property TEXT NOT NULL,
  config TEXT NOT NULL,
  oldest TEXT,
  newest TEXT,
  recent_synced_at BIGINT,
  last_error TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS search_stats (
  site_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  query TEXT NOT NULL,
  page TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  position DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, ts, query, page)
);
`,
  },
  {
    id: 5,
    name: "crawler hits",
    // Requests from known crawlers (AI crawlers and search engines), reported by the website's server, counted per
    // day, crawler and path. `ts` is the start of the day in the website's timezone.
    sql: `
CREATE TABLE IF NOT EXISTS crawler_stats (
  site_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  bot TEXT NOT NULL,
  path TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, ts, bot, path)
);
`,
  },
  {
    id: 6,
    name: "social",
    sql: `
-- Posts that mention or link to the website (X, Hacker News), and the account handles whose profile links to it.
CREATE TABLE IF NOT EXISTS social_config (
  site_id TEXT PRIMARY KEY,
  config TEXT,
  keywords TEXT,
  handles TEXT,
  x_since_id TEXT,
  x_checked_at BIGINT,
  x_users_checked_at BIGINT,
  x_reads_month TEXT,
  x_reads INTEGER NOT NULL DEFAULT 0,
  x_monthly_cap INTEGER NOT NULL DEFAULT 2000,
  hn INTEGER NOT NULL DEFAULT 1,
  hn_checked_at BIGINT,
  last_error TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS social_posts (
  site_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  author TEXT,
  author_name TEXT,
  author_image TEXT,
  text TEXT,
  created_at BIGINT NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  reposts INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  views INTEGER,
  links TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (site_id, platform, id)
);
CREATE INDEX IF NOT EXISTS social_posts_created ON social_posts (site_id, created_at);
-- One row per page of the website a post (or a profile, kind 'bio') links to, to match visits by landing page.
CREATE TABLE IF NOT EXISTS social_links (
  site_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  post_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (site_id, platform, post_id, path)
);
CREATE INDEX IF NOT EXISTS social_links_path ON social_links (site_id, platform, path, created_at);
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
