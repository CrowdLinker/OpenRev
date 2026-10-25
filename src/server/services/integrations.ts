import type { Runtime } from "../context";
import { decryptString, encryptString } from "../lib/crypto";
import { getProvider } from "../providers";
import type { ProviderConfig, WebhookRequest } from "../providers/types";
import { recordServerGoal } from "./ingest";
import { recordPayment, type NormalizedGoal, type PaymentRow } from "./payments";
import { getSecret } from "./instance";
import { getSite, type Site } from "./sites";
import { notifyPayment } from "./notify";

export interface IntegrationRow {
  id: string;
  site_id: string;
  provider: string;
  name: string | null;
  config: string;
  enabled: number;
  created_at: number;
  last_event_at: number | null;
  last_error: string | null;
}

export async function encryptConfig(rt: Runtime, config: ProviderConfig): Promise<string> {
  return encryptString(await getSecret(rt), JSON.stringify(config));
}

export async function decryptConfig(rt: Runtime, stored: string): Promise<ProviderConfig> {
  try {
    const plain = await decryptString(await getSecret(rt), stored);
    return JSON.parse(plain) as ProviderConfig;
  } catch {
    return {};
  }
}

/** Integration as returned to the dashboard: secret values are masked. */
export async function publicIntegration(rt: Runtime, row: IntegrationRow, baseUrl: string) {
  const provider = getProvider(row.provider);
  const config = await decryptConfig(rt, row.config);
  const masked: Record<string, string | null> = {};
  for (const field of provider?.fields ?? []) {
    const v = config[field.key];
    masked[field.key] = v ? (field.secret ? "••••" + v.slice(-4) : v) : null;
  }
  const missing = (provider?.fields ?? []).filter((f) => f.required && !config[f.key]).map((f) => f.label);
  const tokenQuery = config.token ? `?token=${encodeURIComponent(config.token)}` : "";
  return {
    id: row.id,
    provider: row.provider,
    name: row.name ?? provider?.name ?? row.provider,
    missing,
    enabled: !!row.enabled,
    created_at: Number(row.created_at),
    last_event_at: row.last_event_at ? Number(row.last_event_at) : null,
    last_error: row.last_error,
    config: masked,
    webhook_url: `${baseUrl}/api/webhooks/${row.id}${tokenQuery}`,
  };
}

async function resolveGoalVisitor(rt: Runtime, site: Site, provider: string, g: NormalizedGoal): Promise<string | null> {
  if (g.visitorId) return g.visitorId;
  const db = rt.db;
  if (g.customerId) {
    const c = await db.first<{ visitor_id: string | null }>(
      "SELECT visitor_id FROM customers WHERE site_id = ? AND provider = ? AND customer_id = ?",
      [site.id, provider, g.customerId],
    );
    if (c?.visitor_id) return c.visitor_id;
  }
  if (g.ref) {
    const r = await db.first<{ visitor_id: string }>("SELECT visitor_id FROM checkout_refs WHERE site_id = ? AND ref = ?", [site.id, g.ref]);
    if (r) return r.visitor_id;
  }
  if (g.email) {
    const v = await db.first<{ id: string }>("SELECT id FROM visitors WHERE site_id = ? AND LOWER(email) = ? ORDER BY last_seen DESC LIMIT 1", [
      site.id,
      g.email.toLowerCase(),
    ]);
    if (v) return v.id;
  }
  return null;
}

export interface WebhookOutcome {
  status: number;
  body: Record<string, unknown>;
}

export async function handleWebhook(rt: Runtime, integrationId: string, req: WebhookRequest): Promise<WebhookOutcome> {
  const db = rt.db;
  const row = await db.first<IntegrationRow>("SELECT * FROM integrations WHERE id = ?", [integrationId]);
  if (!row) return { status: 404, body: { error: "Unknown integration" } };
  if (!row.enabled) return { status: 200, body: { received: true, ignored: "integration disabled" } };
  const provider = getProvider(row.provider);
  if (!provider) return { status: 400, body: { error: `Unknown provider ${row.provider}` } };
  const site = await getSite(db, row.site_id);
  if (!site) return { status: 404, body: { error: "Unknown website" } };
  const config = await decryptConfig(rt, row.config);

  const setStatus = (error: string | null) =>
    db.run("UPDATE integrations SET last_event_at = ?, last_error = ? WHERE id = ?", [Date.now(), error, row.id]).catch(() => {});

  const missing = provider.fields.filter((f) => f.required && !config[f.key]);
  if (missing.length) {
    await setStatus(`Missing ${missing.map((f) => f.label).join(", ")} — add it in Settings → Revenue.`);
    return { status: 401, body: { error: "Integration is not fully configured" } };
  }

  let valid = false;
  try {
    valid = await provider.verify(req, config);
  } catch {
    valid = false;
  }
  if (!valid) {
    await setStatus("Invalid webhook signature — check the signing secret.");
    return { status: 401, body: { error: "Invalid signature" } };
  }

  try {
    const result = await provider.parse(req, config);
    const recorded: PaymentRow[] = [];
    for (const p of result.payments) {
      const { payment, created } = await recordPayment(rt, site, { ...p, provider: provider.id });
      recorded.push(payment);
      if (created) rt.waitUntil(notifyPayment(rt, site, payment).catch(() => {}));
    }
    for (const g of result.goals ?? []) {
      const visitorId = await resolveGoalVisitor(rt, site, provider.id, g);
      if (visitorId) await recordServerGoal(rt, site, { name: g.name, visitorId, props: g.props, timestamp: g.timestamp });
    }
    if (!result.unsigned) await setStatus(null);
    return {
      status: 200,
      body: { received: true, payments: recorded.length, goals: result.goals?.length ?? 0, ...(result.ignored ? { ignored: result.ignored } : {}) },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setStatus(message.slice(0, 500));
    return { status: 500, body: { error: message } };
  }
}

/** Imports one page of historical payments; returns the next cursor (null when done). */
export async function importPage(rt: Runtime, row: IntegrationRow, cursor: string | null) {
  const provider = getProvider(row.provider);
  if (!provider?.importHistory) throw new Error("This provider does not support importing past payments.");
  const site = await getSite(rt.db, row.site_id);
  if (!site) throw new Error("Unknown website");
  const config = await decryptConfig(rt, row.config);
  const page = await provider.importHistory(config, cursor);
  let imported = 0;
  for (const p of page.payments) {
    await recordPayment(rt, site, { ...p, provider: provider.id });
    imported++;
  }
  return { imported, nextCursor: page.nextCursor };
}

