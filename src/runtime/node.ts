/**
 * Node.js entry point (also used by the Docker image).
 *
 *   DATABASE_URL=./data/openrev.db   (SQLite file, default)  or  postgres://user:pass@host/db
 *   PORT=3000
 *
 * See docs/self-hosting/configuration.md for every option.
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createWriteStream, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../server/app";
import { VERSION, type AppEnv, type Runtime } from "../server/context";
import { migrate } from "../server/db/migrations";
import { nodeSqliteDatabase } from "../server/db/sqlite-node";
import { postgresDatabase } from "../server/db/postgres";
import type { Database } from "../server/db/types";
import type { GeoInfo } from "../server/lib/geo";
import { runScheduled } from "../server/services/scheduler";

const env = process.env;
const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(env.DATA_DIR || "./data");

function log(...args: unknown[]) {
  console.log("[openrev]", ...args);
}

async function openDatabase(): Promise<Database> {
  const url = env.DATABASE_URL || join(DATA_DIR, "openrev.db");
  if (/^postgres(ql)?:\/\//.test(url)) {
    log("Using PostgreSQL database");
    return postgresDatabase(url);
  }
  const path = url.replace(/^sqlite:(\/\/)?/, "").replace(/^file:/, "");
  log(`Using SQLite database at ${resolve(path)}`);
  return nodeSqliteDatabase(path);
}

// ---------------------------------------------------------------------------
// IP geolocation: MaxMind GeoLite2 or DB-IP Lite (.mmdb), downloaded automatically.
// ---------------------------------------------------------------------------

type Reader = { get(ip: string): Record<string, any> | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
let geoReader: Reader | null = null;

async function loadGeo(path: string) {
  try {
    const maxmind = await import("maxmind");
    const reader = new maxmind.Reader(readFileSync(path)) as unknown as Reader;
    geoReader = reader;
    log(`Geolocation database loaded (${path})`);
  } catch (err) {
    log("Could not load geolocation database:", (err as Error).message);
  }
}

async function downloadDbIp(target: string) {
  const now = new Date();
  for (let back = 0; back < 3; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const url = `https://download.db-ip.com/free/dbip-city-lite-${month}.mmdb.gz`;
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) continue;
      log(`Downloading free IP geolocation database (DB-IP Lite ${month})...`);
      await mkdir(dirname(target), { recursive: true });
      const tmp = target + ".tmp";
      await pipeline(Readable.fromWeb(res.body as never), createGunzip(), createWriteStream(tmp));
      renameSync(tmp, target);
      return true;
    } catch (err) {
      log("Geolocation download failed:", (err as Error).message);
    }
  }
  return false;
}

async function setupGeo() {
  const configured = env.GEOIP_DB;
  if (configured) {
    if (existsSync(configured)) await loadGeo(configured);
    else log(`GEOIP_DB file not found: ${configured}`);
    return;
  }
  if (env.GEOIP_AUTO_DOWNLOAD === "false") return;
  const target = join(DATA_DIR, "dbip-city-lite.mmdb");
  if (existsSync(target)) await loadGeo(target);
  const refresh = () => {
    const stale = !existsSync(target) || Date.now() - statSync(target).mtimeMs > 35 * 86_400_000;
    if (!stale) return;
    // download in the background; don't block startup or requests
    downloadDbIp(target)
      .then((ok) => (ok ? loadGeo(target) : undefined))
      .catch(() => {});
  };
  refresh();
  // DB-IP publishes a new edition every month: check once a day.
  setInterval(refresh, 86_400_000).unref();
}

function lookupGeo(ip: string | null): GeoInfo | null {
  if (!geoReader || !ip) return null;
  try {
    const r = geoReader.get(ip.replace(/^::ffff:/, ""));
    if (!r) return null;
    return {
      country: r.country?.iso_code ?? null,
      region: r.subdivisions?.[0]?.names?.en ?? null,
      city: r.city?.names?.en ?? null,
      latitude: r.location?.latitude ?? null,
      longitude: r.location?.longitude ?? null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Static files (dashboard SPA + tracking script)
// ---------------------------------------------------------------------------

function staticFiles(root: string): MiddlewareHandler<AppEnv> {
  const assets = serveStatic({
    root,
    onFound: (path, c) => {
      if (/\/assets\//.test(path)) c.header("Cache-Control", "public, max-age=31536000, immutable");
      else if (/\/js\/script/.test(path)) {
        c.header("Cache-Control", "public, max-age=3600");
        c.header("Access-Control-Allow-Origin", "*");
      }
    },
  });
  const indexPath = join(root, "index.html");
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const res = await assets(c, async () => {});
    if (res) return res;
    // SPA fallback
    if (existsSync(indexPath) && !/\.[a-z0-9]{2,5}$/i.test(c.req.path)) {
      return c.html(readFileSync(indexPath, "utf8"));
    }
    return c.text("Not found", 404);
  };
}

async function main() {
  const db = await openDatabase();
  await migrate(db);

  await setupGeo();

  const rt: Runtime = {
    platform: "node",
    db,
    config: {
      secret: env.OPENREV_SECRET || undefined,
      publicUrl: env.PUBLIC_URL || undefined,
      disableSignup: env.DISABLE_SIGNUP === "true",
      resendApiKey: env.RESEND_API_KEY || undefined,
      emailFrom: env.OPENREV_EMAIL_FROM || undefined,
      retentionDays: env.RETENTION_DAYS ? Number(env.RETENTION_DAYS) : undefined,
      trustProxy: env.TRUST_PROXY !== "false",
    },
    geo: (ip) => lookupGeo(ip),
    waitUntil: (p) => {
      p.catch((err) => console.error("[openrev] background task failed:", err));
    },
    remoteAddress: (c) => {
      const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming;
      return incoming?.socket?.remoteAddress ?? null;
    },
  };

  const publicDir = env.PUBLIC_DIR || [join(here, "../public"), resolve("dist/public")].find((p) => existsSync(join(p, "index.html"))) || resolve("dist/public");
  if (!existsSync(join(publicDir, "index.html"))) log(`Warning: dashboard not built (${publicDir}). Run "npm run build".`);

  const app = createApp(() => rt, { staticHandler: staticFiles(publicDir) });

  const port = Number(env.PORT || 3000);
  const hostname = env.HOST || "0.0.0.0";
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    log(`OpenRev ${VERSION} running on http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${info.port}`);
    if (!env.PUBLIC_URL) log("Tip: set PUBLIC_URL to your public address (used in emails, alerts and webhook URLs).");
  });

  // Scheduled jobs (alerts, digests, cleanup) every minute.
  const tick = () => runScheduled(rt).catch((err) => console.error("[openrev] scheduler:", err));
  setTimeout(tick, 15_000);
  setInterval(tick, 60_000);

  const shutdown = async () => {
    log("Shutting down...");
    await db.close?.();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
