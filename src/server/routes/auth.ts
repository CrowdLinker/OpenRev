import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getPeerIp, VERSION, type AppEnv } from "../context";
import type { Database } from "../db/types";
import { hashPassword, sha256Hex, verifyPassword } from "../lib/crypto";
import { isEmail } from "../lib/validate";
import {
  authenticate,
  createApiKey,
  createSession,
  createUser,
  deleteSession,
  SESSION_COOKIE,
  SESSION_TTL,
  signupEnabled,
  userCount,
} from "../services/auth";
import { emailEnabled } from "../services/email";
import { setInstanceValue } from "../services/instance";
import { claimInvite, joinStatement } from "../services/sites";
import { fail, readJson, requireUser } from "./helpers";

// Best-effort, per-isolate throttling of login and signup attempts.
const WINDOW = 15 * 60 * 1000;
const MAX_KEYS = 50_000;
const attempts = new Map<string, { n: number; at: number }>();

function limited(key: string, max: number): boolean {
  const a = attempts.get(key);
  return !!a && Date.now() - a.at < WINDOW && a.n >= max;
}

function record(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  if (a && now - a.at < WINDOW) {
    a.n++;
    return;
  }
  attempts.delete(key);
  attempts.set(key, { n: 1, at: now });
  if (attempts.size > MAX_KEYS) {
    for (const [k, v] of attempts) if (now - v.at >= WINDOW) attempts.delete(k);
    // Still full: drop the oldest windows (Map iterates in insertion order).
    for (const k of attempts.keys()) {
      if (attempts.size <= MAX_KEYS) break;
      attempts.delete(k);
    }
  }
}

/** Gives back an attempt reserved with `record` (used when the attempt succeeds). */
function release(key: string) {
  const a = attempts.get(key);
  if (a && --a.n <= 0) attempts.delete(key);
}

function tooMany(): never {
  fail(429, "Too many attempts. Try again in a few minutes.");
}

/** Checks a signed-in user's current password, limiting failed guesses (e.g. from a stolen session). */
async function checkCurrentPassword(db: Database, userId: string, password: string | undefined): Promise<boolean> {
  const key = "account-password:" + userId;
  if (limited(key, 10)) tooMany();
  // Count the attempt before the first await so concurrent guesses can't all pass the check; give it back on success.
  record(key);
  const row = await db.first<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", [userId]);
  const ok = !!row && !!password && (await verifyPassword(password, row.password_hash));
  if (ok) release(key);
  return ok;
}

export function authRoutes() {
  const app = new Hono<AppEnv>();

  const startSession = async (c: Context<AppEnv>, userId: string) => {
    const token = await createSession(c.get("rt").db, userId);
    const secure = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(SESSION_TTL / 1000),
    });
  };

  app.get("/instance", async (c) => {
    const rt = c.get("rt");
    const users = await userCount(rt.db);
    return c.json({
      version: VERSION,
      platform: rt.platform,
      hasUsers: users > 0,
      signupEnabled: await signupEnabled(rt.db, rt.config.disableSignup),
      emailEnabled: emailEnabled(rt),
    });
  });

  app.post("/auth/signup", async (c) => {
    const rt = c.get("rt");
    const body = await readJson<{ email?: string; password?: string; name?: string; invite?: string }>(c);
    const signupKey = "signup:" + (getPeerIp(c) ?? "unknown");
    if (limited(signupKey, 20)) tooMany();
    record(signupKey);
    if (!isEmail(body.email)) fail(400, "Please enter a valid email address");
    if (!body.password || body.password.length < 8) fail(400, "Password must be at least 8 characters");
    const first = (await userCount(rt.db)) === 0;
    if (!first && !body.invite && !(await signupEnabled(rt.db, rt.config.disableSignup))) {
      fail(403, "Sign-ups are disabled on this OpenRev instance. Ask an admin for an invitation.");
    }
    const existing = await rt.db.first("SELECT id FROM users WHERE email = ?", [body.email.toLowerCase()]);
    if (existing) fail(409, "An account with this email already exists");
    const invite = body.invite ? await claimInvite(rt.db, await sha256Hex(body.invite)) : null;
    if (body.invite && !invite) fail(400, "This invitation is invalid or has expired");
    const user = await createUser(rt.db, { email: body.email, password: body.password, name: body.name, isAdmin: first });
    if (invite) {
      const join = joinStatement(invite, user.id);
      await rt.db.run(join.sql, join.params);
    }
    await startSession(c, user.id);
    return c.json({ user });
  });

  app.post("/auth/login", async (c) => {
    const rt = c.get("rt");
    const body = await readJson<{ email?: string; password?: string }>(c);
    if (!body.email || !body.password) fail(400, "Email and password are required");
    // Failed attempts are limited per network peer and per account, so rotating addresses doesn't help guessing.
    const ipKey = "login-ip:" + (getPeerIp(c) ?? "unknown");
    const emailKey = "login-email:" + String(body.email).trim().toLowerCase();
    if (limited(ipKey, 20) || limited(emailKey, 10)) tooMany();
    // Count the attempt before the first await so concurrent guesses can't all pass the check; give it back on success.
    record(ipKey);
    record(emailKey);
    const user = await authenticate(rt.db, body.email, body.password);
    if (!user) fail(401, "Invalid email or password");
    release(ipKey);
    release(emailKey);
    await startSession(c, user.id);
    return c.json({ user });
  });

  app.post("/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deleteSession(c.get("rt").db, token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/auth/me", (c) => c.json({ user: c.get("user") }));

  // ---- account ---------------------------------------------------------------

  app.patch("/account", async (c) => {
    const user = requireUser(c);
    const body = await readJson<{ name?: string; email?: string; current?: string }>(c);
    const db = c.get("rt").db;
    if (body.email !== undefined && body.email.toLowerCase() !== user.email) {
      if (!isEmail(body.email)) fail(400, "Invalid email");
      // Changing the sign-in email needs the password, so a stolen session can't take over the account.
      if (!(await checkCurrentPassword(db, user.id, body.current))) fail(400, "Enter your current password to change your email");
      const taken = await db.first<{ id: string }>("SELECT id FROM users WHERE email = ? AND id <> ?", [body.email.toLowerCase(), user.id]);
      if (taken) fail(409, "This email is already used by another account");
    }
    await db.run("UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email) WHERE id = ?", [
      body.name?.trim() ?? null,
      body.email?.toLowerCase() ?? null,
      user.id,
    ]);
    return c.json({ ok: true });
  });

  app.post("/account/password", async (c) => {
    const user = requireUser(c);
    const body = await readJson<{ current?: string; password?: string }>(c);
    const db = c.get("rt").db;
    if (!(await checkCurrentPassword(db, user.id, body.current))) fail(400, "Current password is incorrect");
    if (!body.password || body.password.length < 8) fail(400, "New password must be at least 8 characters");
    // Signs out every other session: a password change is how users cut off someone who got in.
    await db.batch([
      { sql: "UPDATE users SET password_hash = ? WHERE id = ?", params: [await hashPassword(body.password), user.id] },
      { sql: "DELETE FROM auth_sessions WHERE user_id = ?", params: [user.id] },
    ]);
    await startSession(c, user.id);
    return c.json({ ok: true });
  });

  app.get("/account/tokens", async (c) => {
    const user = requireUser(c);
    const rows = await c
      .get("rt")
      .db.all("SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? AND site_id IS NULL ORDER BY created_at DESC", [user.id]);
    return c.json({ tokens: rows });
  });

  app.post("/account/tokens", async (c) => {
    const user = requireUser(c);
    const body = await readJson<{ name?: string }>(c);
    const created = await createApiKey(c.get("rt").db, { userId: user.id, siteId: null, name: body.name?.trim() || "Account token" });
    return c.json(created);
  });

  app.delete("/account/tokens/:id", async (c) => {
    const user = requireUser(c);
    await c.get("rt").db.run("DELETE FROM api_keys WHERE id = ? AND user_id = ? AND site_id IS NULL", [c.req.param("id"), user.id]);
    return c.json({ ok: true });
  });

  // ---- instance admin ------------------------------------------------------------

  app.get("/admin/users", async (c) => {
    const user = requireUser(c);
    if (!user.is_admin) fail(403, "Admins only");
    const users = await c.get("rt").db.all("SELECT id, email, name, is_admin, created_at FROM users ORDER BY created_at ASC");
    return c.json({ users });
  });

  app.patch("/admin/settings", async (c) => {
    const user = requireUser(c);
    if (!user.is_admin) fail(403, "Admins only");
    const body = await readJson<{ signupEnabled?: boolean }>(c);
    if (typeof body.signupEnabled === "boolean") await setInstanceValue(c.get("rt").db, "signup_enabled", String(body.signupEnabled));
    return c.json({ ok: true });
  });

  app.patch("/admin/users/:id", async (c) => {
    const user = requireUser(c);
    if (!user.is_admin) fail(403, "Admins only");
    const body = await readJson<{ is_admin?: boolean }>(c);
    if (c.req.param("id") === user.id) fail(400, "You can't change your own admin status");
    if (typeof body.is_admin === "boolean") {
      await c.get("rt").db.run("UPDATE users SET is_admin = ? WHERE id = ?", [body.is_admin ? 1 : 0, c.req.param("id")]);
    }
    return c.json({ ok: true });
  });

  app.delete("/admin/users/:id", async (c) => {
    const user = requireUser(c);
    if (!user.is_admin) fail(403, "Admins only");
    const id = c.req.param("id");
    if (id === user.id) fail(400, "You can't delete your own account here");
    await c.get("rt").db.batch([
      { sql: "DELETE FROM invites WHERE created_by = ?", params: [id] },
      { sql: "DELETE FROM site_members WHERE user_id = ?", params: [id] },
      { sql: "DELETE FROM auth_sessions WHERE user_id = ?", params: [id] },
      { sql: "DELETE FROM api_keys WHERE user_id = ?", params: [id] },
      { sql: "DELETE FROM users WHERE id = ?", params: [id] },
    ]);
    return c.json({ ok: true });
  });

  return app;
}
