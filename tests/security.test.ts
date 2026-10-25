import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { Runtime } from "../src/server/context";
import { hmacHex } from "../src/server/lib/crypto";
import { verifyStripeSignature } from "../src/server/providers/stripe";
import { deliver } from "../src/server/services/alerts";
import { recordPayment } from "../src/server/services/payments";
import { getSite } from "../src/server/services/sites";
import { testRuntime } from "./helpers";

// Regression tests for the security review: each block pins one fixed behaviour.

const BASE = "http://openrev.test";
let rt: Runtime;
let app: ReturnType<typeof createApp>;

/** A small cookie-jar client so several users can act side by side. */
function client() {
  let cookie = "";
  return async function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (cookie) headers.Cookie = cookie;
    let body = init.raw;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["Content-Type"] ??= "application/json";
    }
    const res = await app.request(BASE + path, { method: init.method ?? (body !== undefined ? "POST" : "GET"), headers, body });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie?.startsWith("openrev_auth=")) cookie = setCookie.split(";")[0];
    const text = await res.text();
    let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };
}

const tokenOf = (url: string) => new URL(url).pathname.split("/").pop()!;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const event = (siteId: string, payload: Record<string, unknown>) =>
  app.request(BASE + "/api/events", {
    method: "POST",
    headers: { "Content-Type": "text/plain", "User-Agent": UA },
    body: JSON.stringify({ websiteId: siteId, ...payload }),
  });

describe("security fixes", () => {
  const owner = client();
  let siteId = "";

  beforeAll(async () => {
    rt = await testRuntime();
    app = createApp(() => rt);
    await owner("/api/auth/signup", { body: { email: "owner@example.com", password: "supersecret", name: "Owner" } });
    siteId = (await owner("/api/sites", { body: { domain: "example.com", currency: "USD" } })).json.site.id;
  });

  afterEach(() => vi.unstubAllGlobals());

  it("only grants membership through the invite link, never from an account's email", async () => {
    const invite = await owner(`/api/sites/${siteId}/invites`, { body: { role: "viewer" } });
    const mallory = client();
    await mallory("/api/auth/signup", { body: { email: "mallory@example.com", password: "supersecret", invite: tokenOf(invite.json.url) } });
    // Changing the sign-in email needs the password...
    expect((await mallory("/api/account", { method: "PATCH", body: { email: "alice@example.com" } })).status).toBe(400);
    expect((await mallory("/api/account", { method: "PATCH", body: { email: "alice@example.com", current: "supersecret" } })).status).toBe(200);
    // ...and even then, inviting that address issues a link instead of adding the account.
    const second = (await owner("/api/sites", { body: { domain: "private.example" } })).json.site.id;
    const r = await owner(`/api/sites/${second}/invites`, { body: { email: "alice@example.com", role: "admin" } });
    expect(r.json.url).toContain("/invite/");
    expect((await mallory(`/api/sites/${second}`)).status).toBe(404);
  });

  it("revokes invites when their creator loses the right to invite", async () => {
    const adminInvite = await owner(`/api/sites/${siteId}/invites`, { body: { role: "admin" } });
    const adam = client();
    await adam("/api/auth/signup", { body: { email: "adam@example.com", password: "supersecret", invite: tokenOf(adminInvite.json.url) } });
    const adamId = (await adam("/api/auth/me")).json.user.id;
    const spare = tokenOf((await adam(`/api/sites/${siteId}/invites`, { body: { role: "admin" } })).json.url);
    expect((await adam(`/api/invites/${spare}`)).status).toBe(200);

    expect((await owner(`/api/sites/${siteId}/members/${adamId}`, { method: "DELETE" })).status).toBe(200);
    expect((await adam(`/api/invites/${spare}`)).status).toBe(404);
    expect((await adam(`/api/invites/${spare}/accept`, { body: {} })).status).toBe(404);
    expect((await adam(`/api/sites/${siteId}`)).status).toBe(404);
  });

  it("signs out other sessions when the password changes", async () => {
    const other = client();
    await other("/api/auth/login", { body: { email: "owner@example.com", password: "supersecret" } });
    expect((await other("/api/auth/me")).json.user).not.toBeNull();
    expect((await owner("/api/account/password", { body: { current: "supersecret", password: "newsecret1" } })).status).toBe(200);
    expect((await other("/api/auth/me")).json.user).toBeNull();
    expect((await owner("/api/auth/me")).json.user.email).toBe("owner@example.com");
  });

  it("rejects opaque or malformed Origin headers on cookie requests", async () => {
    for (const origin of ["null", "not a url"]) {
      expect((await owner("/api/sites", { body: { domain: "evil.example" }, headers: { Origin: origin } })).status).toBe(403);
    }
  });

  it("bounds request bodies and per-request work", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    expect((await owner("/api/webhooks/does-not-exist", { raw: big, headers: { "Content-Type": "text/plain" } })).status).toBe(413);
    expect((await event(siteId, { type: "pageview", href: "https://example.com/", pad: "x".repeat(64 * 1024) })).status).toBe(413);

    // excluded path patterns are length-limited and matched in linear time
    const long = await owner(`/api/sites/${siteId}`, { method: "PATCH", body: { settings: { excludedPaths: ["/" + "a".repeat(400)] } } });
    expect(long.status).toBe(400);

    // huge custom ranges are clamped instead of scanning millennia of timezone offsets
    const started = Date.now();
    const range = await owner(`/api/sites/${siteId}/stats/timeseries?from=2000-01-01&to=2099-12-31&interval=week`);
    expect(range.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);

    // MCP batches are capped and list limits can't go negative
    const key = (await owner("/api/account/tokens", { body: { name: "t" } })).json.key;
    const auth = { Authorization: `Bearer ${key}` };
    const batch = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "tools/list" }));
    expect((await owner("/mcp", { headers: auth, body: batch })).status).toBe(400);
    expect((await owner(`/api/v1/payments?websiteId=${siteId}&limit=-1`, { headers: auth })).status).toBe(200);
  });

  it("doesn't let an anonymous email claim take over payments", async () => {
    const site = (await getSite(rt.db, siteId))!;
    const day = 86_400_000;
    await recordPayment(rt, site, {
      provider: "stripe",
      transactionId: "in_old",
      type: "new",
      amount: 9900,
      currency: "USD",
      timestamp: Date.now() - 40 * day,
      customerId: "cus_victim",
      email: "buyer@example.com",
    });
    await event(siteId, {
      type: "identify",
      href: "https://example.com/?utm_source=attacker",
      visitorId: "attacker-visitor-01",
      sessionId: "attacker-session-01",
      email: "buyer@example.com",
    });
    const claimed = await rt.db.first<{ email: string | null }>("SELECT email FROM visitors WHERE id = 'attacker-visitor-01'");
    expect(claimed?.email).toBe("buyer@example.com");
    const old = await rt.db.first<{ visitor_id: string | null }>("SELECT visitor_id FROM payments WHERE transaction_id = 'in_old'");
    expect(old?.visitor_id).toBeNull();
    const customer = await rt.db.first<{ visitor_id: string | null }>("SELECT visitor_id FROM customers WHERE customer_id = 'cus_victim'");
    expect(customer?.visitor_id).toBeNull();

    // two visitors claiming one email: an email-only payment goes to neither
    await event(siteId, { type: "identify", href: "https://example.com/", visitorId: "second-visitor-01", sessionId: "second-session-01", email: "buyer@example.com" });
    const { payment } = await recordPayment(rt, site, { provider: "lemonsqueezy", transactionId: "ord_new", type: "new", amount: 4900, currency: "USD", email: "buyer@example.com" });
    expect(payment.visitor_id).toBeNull();

    // a success-page hint right after a fresh payment still links it
    await recordPayment(rt, site, { provider: "stripe", transactionId: "cs_fresh", type: "new", amount: 1000, currency: "USD", email: "fresh@example.com", ref: "cs_fresh_ref" });
    await event(siteId, { type: "payment", href: "https://example.com/thanks", visitorId: "fresh-visitor-01", sessionId: "fresh-session-01", ref: "cs_fresh_ref" });
    const fresh = await rt.db.first<{ visitor_id: string | null }>("SELECT visitor_id FROM payments WHERE transaction_id = 'cs_fresh'");
    expect(fresh?.visitor_id).toBe("fresh-visitor-01");
  });

  it("hides visitor and session ids on public share links but keeps goal names", async () => {
    await event(siteId, { type: "goal", name: "signup", href: "https://example.com/", visitorId: "share-visitor-01", sessionId: "share-session-01" });
    const share = await owner(`/api/sites/${siteId}/share`, { body: { enabled: true } });
    const token = share.json.token ?? tokenOf(share.json.url);
    const anon = client();
    const live = await anon(`/api/share/${token}/stats/realtime`);
    expect(live.status).toBe(200);
    const goal = live.json.events.find((e: { type: string }) => e.type === "goal");
    expect(goal).toMatchObject({ name: "signup", visitor_id: null, session_id: null });
    const payments = await anon(`/api/share/${token}/stats/payments?period=all`);
    for (const p of payments.json.payments) {
      for (const field of ["visitor_id", "touch_session_id", "first_session_id", "last_session_id", "transaction_id", "subscription_id", "ref", "email"]) {
        expect(p[field], field).toBeNull();
      }
    }
  });

  it("escapes visitor text in Slack and Discord alerts", async () => {
    const bodies: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response("ok");
    });
    const site = (await getSite(rt.db, siteId))!;
    const msg = { event: "goal", title: "Goal: signup", lines: ["From <!channel> <https://evil.example|bank> @everyone [click](https://evil.example)"] };
    await deliver(rt, "slack", { url: "https://hooks.slack.com/services/T0/B0/x" }, msg as never, site);
    await deliver(rt, "discord", { url: "https://discord.com/api/webhooks/1/x" }, msg as never, site);
    expect(bodies[0].text).not.toContain("<!channel>");
    expect(bodies[0].text).toContain("&lt;!channel&gt;");
    expect(bodies[1].allowed_mentions).toEqual({ parse: [] });
    expect(bodies[1].content).not.toContain("[click](");
  });

  it("requires a numeric Stripe signature timestamp", async () => {
    const now = Date.now();
    const t = String(Math.floor(now / 1000));
    const sig = await hmacHex("SHA-256", "whsec_test", `${t}.{}`);
    expect(await verifyStripeSignature("{}", `t=${t},v1=${sig}`, "whsec_test", now)).toBe(true);
    const odd = `${t}.0`;
    const oddSig = await hmacHex("SHA-256", "whsec_test", `${odd}.{}`);
    expect(await verifyStripeSignature("{}", `t=${odd},v1=${oddSig}`, "whsec_test", now)).toBe(false);
  });

  it("doesn't let an unsigned WooCommerce ping clear an integration error", async () => {
    const created = await owner(`/api/sites/${siteId}/integrations`, { body: { provider: "woocommerce", config: { webhookSecret: "woo-secret" } } });
    const id = created.json.integration.id;
    await rt.db.run("UPDATE integrations SET last_error = 'Invalid webhook signature' WHERE id = ?", [id]);
    const ping = await owner(`/api/webhooks/${id}`, { raw: "webhook_id=12", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(ping.status).toBe(200);
    const row = await rt.db.first<{ last_error: string | null }>("SELECT last_error FROM integrations WHERE id = ?", [id]);
    expect(row?.last_error).toBe("Invalid webhook signature");
  });
});

describe("account password checks", () => {
  it("limits wrong current-password attempts", async () => {
    rt = await testRuntime();
    app = createApp(() => rt);
    const user = client();
    await user("/api/auth/signup", { body: { email: "limit@example.com", password: "supersecret" } });
    for (let i = 0; i < 10; i++) {
      expect((await user("/api/account/password", { body: { current: "wrong-guess", password: "newsecret1" } })).status).toBe(400);
    }
    expect((await user("/api/account/password", { body: { current: "supersecret", password: "newsecret1" } })).status).toBe(429);
  });

  it("counts concurrent guesses toward the limits", async () => {
    rt = await testRuntime();
    app = createApp(() => rt);
    const user = client();
    await user("/api/auth/signup", { body: { email: "burst@example.com", password: "supersecret" } });
    const guesses = await Promise.all(
      Array.from({ length: 25 }, () => user("/api/account/password", { body: { current: "wrong-guess", password: "newsecret1" } })),
    );
    expect(guesses.filter((r) => r.status === 400)).toHaveLength(10);
    expect(guesses.filter((r) => r.status === 429)).toHaveLength(15);

    const anon = client();
    const logins = await Promise.all(
      Array.from({ length: 25 }, () => anon("/api/auth/login", { body: { email: "burst@example.com", password: "wrong-password" } })),
    );
    expect(logins.filter((r) => r.status === 401)).toHaveLength(10);
    expect(logins.filter((r) => r.status === 429)).toHaveLength(15);
  });

  it("doesn't count successful logins toward the limits", async () => {
    rt = await testRuntime();
    app = createApp(() => rt);
    const anon = client();
    await anon("/api/auth/signup", { body: { email: "often@example.com", password: "supersecret" } });
    for (let i = 0; i < 25; i++) {
      expect((await anon("/api/auth/login", { body: { email: "often@example.com", password: "supersecret" } })).status).toBe(200);
    }
  });
});
