import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { Runtime } from "../src/server/context";
import { hmacHex } from "../src/server/lib/crypto";
import { decryptConfig, UNREADABLE_CONFIG_ERROR, type IntegrationRow } from "../src/server/services/integrations";
import { testRuntime } from "./helpers";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const BASE = "http://openrev.test";

let rt: Runtime;
let app: ReturnType<typeof createApp>;
let cookie = "";

async function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { "User-Agent": UA, ...(init.headers ?? {}) };
  if (cookie) headers.Cookie = cookie;
  let body: string | undefined = init.raw;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["Content-Type"] = "application/json";
  }
  const res = await app.request(BASE + path, { method: init.method ?? (body !== undefined ? "POST" : "GET"), headers, body });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie?.startsWith("openrev_auth=")) cookie = setCookie.split(";")[0];
  return { status: res.status, json: await res.json().catch(() => null), res };
}

async function stripeWebhook(path: string, secret: string) {
  const raw = JSON.stringify({ id: "evt_ping", type: "customer.created", created: Math.floor(Date.now() / 1000), data: { object: {} } });
  const t = Math.floor(Date.now() / 1000);
  const sig = await hmacHex("SHA-256", secret, `${t}.${raw}`);
  return call(path, { raw, headers: { "Stripe-Signature": `t=${t},v1=${sig}`, "Content-Type": "application/json" } });
}

describe("integration keys when OPENREV_SECRET changes", () => {
  let siteId = "";
  let integrationId = "";
  let webhookPath = "";

  const integration = async () => {
    const list = await call(`/api/sites/${siteId}/integrations`);
    return list.json.integrations.find((i: { id: string }) => i.id === integrationId);
  };

  beforeAll(async () => {
    rt = await testRuntime();
    rt.config = { ...rt.config, secret: undefined }; // start on the generated per-instance secret
    app = createApp(() => rt);
    await call("/api/auth/signup", { body: { email: "owner@example.com", password: "supersecret" } });
    siteId = (await call("/api/sites", { body: { domain: "example.com" } })).json.site.id;
    const created = await call(`/api/sites/${siteId}/integrations`, { body: { provider: "stripe", config: { webhookSecret: "whsec_one" } } });
    integrationId = created.json.integration.id;
    webhookPath = new URL(created.json.integration.webhook_url).pathname;
  });

  it("keeps keys saved before OPENREV_SECRET was set, and re-encrypts them with it", async () => {
    const before = (await rt.db.first<{ config: string }>("SELECT config FROM integrations WHERE id = ?", [integrationId]))!.config;
    rt.config = { ...rt.config, secret: "now-set-explicitly" };

    expect((await stripeWebhook(webhookPath, "whsec_one")).status).toBe(200);
    const after = (await rt.db.first<{ config: string }>("SELECT config FROM integrations WHERE id = ?", [integrationId]))!.config;
    expect(after).not.toBe(before);
    expect(await integration()).toMatchObject({ missing: [], last_error: null });
  });

  it("reports keys that no secret can read instead of silently dropping them, and repairs them on re-entry", async () => {
    rt.config = { ...rt.config, secret: "changed-again" };

    const webhook = await stripeWebhook(webhookPath, "whsec_one");
    expect(webhook.status).toBe(401);
    const broken = await integration();
    expect(broken.last_error).toBe(UNREADABLE_CONFIG_ERROR);
    expect(broken.missing.length).toBeGreaterThan(0);

    const repaired = await call(`/api/sites/${siteId}/integrations/${integrationId}`, {
      method: "PATCH",
      body: { config: { webhookSecret: "whsec_two" } },
    });
    expect(repaired.json.integration).toMatchObject({ missing: [], last_error: null });
    expect((await stripeWebhook(webhookPath, "whsec_two")).status).toBe(200);
  });

  it("doesn't overwrite keys saved after the old settings were read", async () => {
    rt.config = { ...rt.config, secret: undefined };
    const created = await call(`/api/sites/${siteId}/integrations`, { body: { provider: "stripe", config: { webhookSecret: "whsec_old" } } });
    const id = created.json.integration.id;

    rt.config = { ...rt.config, secret: "set-later" };
    const stale = (await rt.db.first<IntegrationRow>("SELECT * FROM integrations WHERE id = ?", [id]))!; // a slow request's read
    await call(`/api/sites/${siteId}/integrations/${id}`, { method: "PATCH", body: { config: { webhookSecret: "whsec_new" } } });

    expect(await decryptConfig(rt, stale)).toMatchObject({ webhookSecret: "whsec_old" });
    const saved = (await rt.db.first<IntegrationRow>("SELECT * FROM integrations WHERE id = ?", [id]))!;
    expect(await decryptConfig(rt, saved)).toMatchObject({ webhookSecret: "whsec_new" });
  });
});

describe("security headers", () => {
  it("are set on API responses, and only share pages may be framed", async () => {
    rt = await testRuntime();
    app = createApp(() => rt);
    const api = await app.request(BASE + "/api/health");
    expect(api.headers.get("x-content-type-options")).toBe("nosniff");
    expect(api.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(api.headers.get("x-frame-options")).toBe("DENY");

    const share = await app.request(BASE + "/share/abc");
    expect(share.headers.get("x-frame-options")).toBeNull();
    expect(share.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
