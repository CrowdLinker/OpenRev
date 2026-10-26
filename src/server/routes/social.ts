import { Hono } from "hono";
import type { AppEnv } from "../context";
import { disconnectSocialStatements, getSocialConfig, publicSocialConfig, saveSocialConfig, SocialError, syncSocial } from "../services/social";
import { fail, readJson, siteForUser } from "./helpers";

/** Social monitoring settings: the 𝕏 bearer token, keywords, profile handles and Hacker News. */
export function socialRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId")!, "admin");
    return c.json({ config: publicSocialConfig(await getSocialConfig(c.get("rt").db, site.id)) });
  });

  app.patch("/", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId")!, "admin");
    const body = await readJson<{ x_token?: unknown; keywords?: unknown; handles?: unknown; x_monthly_cap?: unknown; hn?: unknown }>(c);
    try {
      const row = await saveSocialConfig(c.get("rt"), site, {
        xToken: body.x_token,
        keywords: body.keywords,
        handles: body.handles,
        xMonthlyCap: body.x_monthly_cap,
        hn: body.hn,
      });
      return c.json({ config: publicSocialConfig(row) });
    } catch (err) {
      if (err instanceof SocialError) fail(400, err.message);
      throw err;
    }
  });

  /** Looks for new posts now. 𝕏 is checked at most every 5 minutes, since each post read is billed. */
  app.post("/sync", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId")!, "admin");
    const rt = c.get("rt");
    const row = await getSocialConfig(rt.db, site.id);
    if (!row) fail(404, "Social monitoring isn't set up");
    const result = await syncSocial(rt, site, row, { force: true });
    return c.json({ ...result, config: publicSocialConfig(await getSocialConfig(rt.db, site.id)) });
  });

  app.delete("/", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId")!, "admin");
    await c.get("rt").db.batch(disconnectSocialStatements(site.id));
    return c.json({ ok: true });
  });

  return app;
}
