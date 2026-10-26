import { Hono, type Context } from "hono";
import type { AppEnv } from "../context";
import { decryptString, encryptString } from "../lib/crypto";
import { GoogleError } from "../lib/google";
import { checkGa4Access, ga4Step, type Ga4Config } from "../services/ga4";
import {
  addImportChunk,
  createImport,
  deleteImportStatements,
  finishImport,
  firstNativeDate,
  getImport,
  IMPORT_SOURCES,
  IMPORT_TABLES,
  ImportError,
  listImports,
  publicImport,
  type ImportRow,
  type ImportSource,
  type ImportTable,
} from "../services/imports";
import { getSecret } from "../services/instance";
import { fail, readJson, requireUser, siteForUser } from "./helpers";

const MAX_ROWS_PER_CHUNK = 3000;

/** Importing history from Plausible (CSV export, parsed in the browser) and Google Analytics 4 (Data API). */
export function importRoutes() {
  const app = new Hono<AppEnv>();

  const loadImport = async (c: Context<AppEnv>, status?: "running") => {
    const { site } = await siteForUser(c, c.req.param("siteId")!, "admin");
    const imp = await getImport(c.get("rt").db, site.id, c.req.param("importId")!);
    if (!imp) fail(404, "Import not found");
    if (status && imp.status !== status) fail(409, imp.status === "done" ? "This import is already complete" : "This import has stopped");
    return { site, imp };
  };

  app.get("/", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId")!, "admin");
    const db = c.get("rt").db;
    const [imports, native] = await Promise.all([listImports(db, site.id), firstNativeDate(db, site)]);
    return c.json({ imports: imports.map(publicImport), first_native_date: native });
  });

  app.post("/", async (c) => {
    const { site } = await siteForUser(c, c.req.param("siteId")!, "admin");
    const user = requireUser(c);
    const rt = c.get("rt");
    const body = await readJson<{ source?: string; date_from?: string; date_to?: string; property_id?: unknown; key?: unknown }>(c);
    const source = body.source as ImportSource;
    if (!(IMPORT_SOURCES as readonly string[]).includes(source)) fail(400, "Unknown import source");
    try {
      let config: string | null = null;
      if (source === "ga4") {
        const cfg = await checkGa4Access({ propertyId: body.property_id, key: body.key }, String(body.date_from), String(body.date_to));
        config = await encryptString(await getSecret(rt), JSON.stringify(cfg));
      }
      const imp = await createImport(rt.db, site, { source, dateFrom: String(body.date_from), dateTo: String(body.date_to), config, userId: user.id });
      return c.json({ import: publicImport(imp) });
    } catch (err) {
      if (err instanceof ImportError || err instanceof GoogleError) fail(400, err.message);
      throw err;
    }
  });

  /** One chunk of a Plausible export table. The dashboard numbers chunks from 0 so a retried upload isn't counted twice. */
  app.post("/:importId/rows", async (c) => {
    const { site, imp } = await loadImport(c, "running");
    if (imp.source !== "plausible") fail(400, "Rows can only be uploaded to a Plausible import");
    const body = await readJson<{ seq?: number; table?: string; rows?: unknown }>(c);
    if (!(IMPORT_TABLES as readonly string[]).includes(String(body.table))) fail(400, "Unknown table");
    if (!Array.isArray(body.rows) || body.rows.length > MAX_ROWS_PER_CHUNK) fail(400, `Send between 0 and ${MAX_ROWS_PER_CHUNK} rows at a time`);
    const rows = body.rows.filter((r): r is ImportRow => !!r && typeof r === "object" && !Array.isArray(r));
    try {
      const res = await addImportChunk(c.get("rt").db, site, imp, Number(body.seq), body.table as ImportTable, rows);
      return c.json({ ok: true, ...res });
    } catch (err) {
      if (err instanceof ImportError) fail(400, err.message);
      throw err;
    }
  });

  /** Marks a Plausible import complete, or failed with the error the dashboard ran into. */
  app.post("/:importId/finish", async (c) => {
    const { imp } = await loadImport(c, "running");
    const body = await readJson<{ error?: string }>(c);
    await finishImport(c.get("rt").db, imp, body.error ? String(body.error).slice(0, 500) : null);
    return c.json({ import: publicImport((await getImport(c.get("rt").db, imp.site_id, imp.id))!) });
  });

  /** Imports the next page of a Google Analytics import. The dashboard calls it until `done` is true. */
  app.post("/:importId/step", async (c) => {
    const { site, imp } = await loadImport(c, "running");
    if (imp.source !== "ga4") fail(400, "Only Google Analytics imports run in steps");
    const rt = c.get("rt");
    let cfg: Ga4Config;
    try {
      cfg = JSON.parse(await decryptString(await getSecret(rt), imp.config ?? ""));
    } catch {
      await finishImport(rt.db, imp, "The saved key can't be read (OPENREV_SECRET changed). Start the import again.");
      fail(409, "The saved key can't be read (OPENREV_SECRET changed). Start the import again.");
    }
    try {
      const step = await ga4Step(rt.db, site, imp, cfg);
      const updated = (await getImport(rt.db, site.id, imp.id))!;
      return c.json({ done: !step, report: step?.report ?? null, progress: step ? step.reportIndex / step.reports : 1, import: publicImport(updated) });
    } catch (err) {
      // Quota and server errors are worth retrying; anything else stops the import with its message.
      if (err instanceof GoogleError && (err.status === 429 || err.status >= 500)) fail(429, `Google Analytics is busy (${err.message}). Try again in a minute.`);
      const message = err instanceof Error ? err.message : String(err);
      await finishImport(rt.db, imp, message);
      fail(400, message);
    }
  });

  app.delete("/:importId", async (c) => {
    const { imp } = await loadImport(c);
    await c.get("rt").db.batch(deleteImportStatements(imp.id));
    return c.json({ ok: true });
  });

  return app;
}

