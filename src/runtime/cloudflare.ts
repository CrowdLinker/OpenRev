/**
 * Cloudflare Workers entry point (Workers + D1 + Static Assets + Cron Triggers).
 * Deploy with `npm run deploy` or the "Deploy to Cloudflare" button.
 */
import { createApp } from "../server/app";
import type { Runtime } from "../server/context";
import { d1Database, type D1DatabaseBinding } from "../server/db/d1";
import { ensureMigrated } from "../server/db/migrations";
import { runScheduled } from "../server/services/scheduler";

export interface Env {
  DB: D1DatabaseBinding;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  OPENREV_SECRET?: string;
  PUBLIC_URL?: string;
  DISABLE_SIGNUP?: string;
  RESEND_API_KEY?: string;
  OPENREV_EMAIL_FROM?: string;
  RETENTION_DAYS?: string;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

type CfRequest = Request & { cf?: Record<string, unknown> };

function buildRuntime(env: Env, ctx: ExecutionContextLike): Runtime {
  return {
    platform: "cloudflare",
    db: d1Database(env.DB),
    dbKey: env.DB as object,
    config: {
      secret: env.OPENREV_SECRET || undefined,
      publicUrl: env.PUBLIC_URL || undefined,
      disableSignup: env.DISABLE_SIGNUP === "true",
      resendApiKey: env.RESEND_API_KEY || undefined,
      emailFrom: env.OPENREV_EMAIL_FROM || undefined,
      retentionDays: env.RETENTION_DAYS ? Number(env.RETENTION_DAYS) : undefined,
      trustProxy: true,
    },
    geo: (_ip, request, proxied) => {
      const cf = (request as CfRequest).cf;
      // For proxied events request.cf locates the proxy, not the visitor.
      if (!cf || proxied) return null;
      return {
        country: (cf.country as string) ?? null,
        region: (cf.region as string) ?? null,
        city: (cf.city as string) ?? null,
        latitude: cf.latitude ? Number(cf.latitude) : null,
        longitude: cf.longitude ? Number(cf.longitude) : null,
      };
    },
    waitUntil: (p) => ctx.waitUntil(p),
  };
}

const app = createApp((c) => buildRuntime(c.env as Env, c.executionCtx));

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike) {
    return app.fetch(request, env, ctx as never);
  },
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContextLike) {
    const rt = buildRuntime(env, ctx);
    ctx.waitUntil(
      ensureMigrated(rt.db, env.DB as object).then(() => runScheduled(rt)),
    );
  },
};
