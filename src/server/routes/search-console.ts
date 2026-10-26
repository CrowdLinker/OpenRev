import { Hono } from "hono";
import type { AppEnv } from "../context";
import { GoogleError } from "../lib/google";
import {
  connectSearchConsole,
  disconnectStatements,
  getSearchConsole,
  publicSearchConsole,
  SearchConsoleError,
  syncSearchConsole,
} from "../services/search-console";
import { fail, readJson, siteForUser } from "./helpers";

/** Connecting a website to Google Search Console, and syncing its history. */
export function searchConsoleRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId")!, "admin");
    return c.json({ connection: publicSearchConsole(await getSearchConsole(c.get("rt").db, site.id)) });
  });

  /** Connects with a service account key. Without `property`, the one matching the website's domain is picked. */
  app.post("/", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId")!, "admin");
    const body = await readJson<{ key?: unknown; property?: unknown }>(c);
    try {
      const row = await connectSearchConsole(c.get("rt"), site, { key: body.key, property: body.property });
      return c.json({ connection: publicSearchConsole(row) });
    } catch (err) {
      if (err instanceof SearchConsoleError) return c.json({ error: err.message, properties: err.properties }, 400);
      if (err instanceof GoogleError) fail(400, err.message);
      throw err;
    }
  });

  /** Syncs a few more days; the settings page calls it until `backfilled` is true. */
  app.post("/sync", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId")!, "admin");
    const rt = c.get("rt");
    const row = await getSearchConsole(rt.db, site.id);
    if (!row) fail(404, "Search Console isn't connected");
    try {
      const result = await syncSearchConsole(rt, site, row, { maxDays: 8 });
      return c.json({ ...result, connection: publicSearchConsole(await getSearchConsole(rt.db, site.id)) });
    } catch (err) {
      if (err instanceof GoogleError && (err.status === 429 || err.status >= 500)) fail(429, `Search Console is busy (${err.message}). Try again in a minute.`);
      if (err instanceof GoogleError || err instanceof SearchConsoleError) fail(400, err.message);
      throw err;
    }
  });

  app.delete("/", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId")!, "admin");
    await c.get("rt").db.batch(disconnectStatements(site.id));
    return c.json({ ok: true });
  });

  return app;
}
