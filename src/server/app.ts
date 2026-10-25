import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { VERSION, type AppEnv, type Runtime } from "./context";
import { ensureMigrated } from "./db/migrations";
import { authRoutes } from "./routes/auth";
import { mcpRoutes } from "./routes/mcp";
import { publicRoutes } from "./routes/public";
import { siteRoutes } from "./routes/sites";
import { v1Routes } from "./routes/v1";
import { SESSION_COOKIE, userFromSession } from "./services/auth";

/** Host of an Origin header, or null for opaque origins ("null", sandboxed frames) and junk. */
function originHost(origin: string): string | null {
  try {
    return new URL(origin).host || null;
  } catch {
    return null;
  }
}

export interface CreateAppOptions {
  /** Serves the dashboard and tracking script (Node). On Cloudflare, Workers Static Assets do this. */
  staticHandler?: MiddlewareHandler<AppEnv>;
}

const UNAUTHENTICATED_PREFIXES = ["/api/events", "/api/event", "/api/webhooks/", "/api/share/", "/api/favicon/", "/api/v1", "/api/health"];

/** Largest request body accepted anywhere (webhooks, API, dashboard). */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function createApp(resolveRuntime: (c: Context) => Runtime | Promise<Runtime>, options: CreateAppOptions = {}) {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error("[openrev]", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  // Basic hardening for every response (dashboard assets on Cloudflare get the same from _headers). Public share
  // pages may be embedded in other sites, so only they can be framed.
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    if (!c.req.path.startsWith("/share/")) c.header("X-Frame-Options", "DENY");
  });

  app.use("*", async (c, next) => {
    const rt = await resolveRuntime(c);
    c.set("rt", rt);
    c.set("user", null);
    c.set("apiKey", null);
    c.set("isPublic", false);
    const path = c.req.path;
    if (path.startsWith("/api") || path.startsWith("/mcp")) {
      await ensureMigrated(rt.db, rt.dbKey ?? rt.db);
    }
    await next();
  });

  // Cap request bodies before they're buffered (events have a tighter limit in publicRoutes).
  app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "Request body too large" }, 413) }));

  app.get("/api/health", (c) => c.json({ ok: true, version: VERSION, platform: c.get("rt").platform }));

  app.route("/", publicRoutes());
  app.route("/api/v1", v1Routes());
  app.route("/mcp", mcpRoutes());

  // Dashboard session auth + CSRF protection for cookie-authenticated requests.
  app.use("/api/*", async (c, next) => {
    const path = c.req.path;
    if (UNAUTHENTICATED_PREFIXES.some((p) => path.startsWith(p))) return next();
    const token = getCookie(c, SESSION_COOKIE);
    if (token) c.set("user", await userFromSession(c.get("rt").db, token));
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin) {
        const host = c.req.header("x-forwarded-host") ?? new URL(c.req.url).host;
        if (originHost(origin) !== host) return c.json({ error: "Cross-origin request blocked" }, 403);
      }
    }
    await next();
  });

  app.route("/api", authRoutes());
  app.route("/api", siteRoutes());
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  if (options.staticHandler) app.use("*", options.staticHandler);
  return app;
}
