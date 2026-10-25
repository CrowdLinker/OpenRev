import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getClientIp, VERSION, type AppEnv } from "../context";
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
import { fail, readJson, requireUser } from "./helpers";

// Best-effort, per-isolate login throttling.
const attempts = new Map<string, { n: number; at: number }>();
function throttle(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  if (a && now - a.at < 15 * 60 * 1000) {
    if (a.n >= 20) fail(429, "Too many attempts. Try again in a few minutes.");
    a.n++;
  } else {
    attempts.set(key, { n: 1, at: now });
  }
  if (attempts.size > 10000) attempts.clear();
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
    throttle("signup:" + (getClientIp(c) ?? "unknown"));
    if (!isEmail(body.email)) fail(400, "Please enter a valid email address");
    if (!body.password || body.password.length < 8) fail(400, "Password must be at least 8 characters");
    const first = (await userCount(rt.db)) === 0;
    let invite: { id: string; site_id: string; role: string } | null = null;
    if (body.invite) {
      invite = await rt.db.first("SELECT id, site_id, role FROM invites WHERE id = ? AND expires_at > ?", [await sha256Hex(body.invite), Date.now()]);
      if (!invite) fail(400, "This invitation is invalid or has expired");
    }
    if (!first && !invite && !(await signupEnabled(rt.db, rt.config.disableSignup))) {
      fail(403, "Sign-ups are disabled on this OpenRev instance. Ask an admin for an invitation.");
    }
    const existing = await rt.db.first("SELECT id FROM users WHERE email = ?", [body.email.toLowerCase()]);
    if (existing) fail(409, "An account with this email already exists");
    const user = await createUser(rt.db, { email: body.email, password: body.password, name: body.name, isAdmin: first });
    if (invite) {
      await rt.db.batch([
        {
          sql: "INSERT INTO site_members (site_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (site_id, user_id) DO NOTHING",
          params: [invite.site_id, user.id, invite.role, Date.now()],
        },
        { sql: "DELETE FROM invites WHERE id = ?", params: [invite.id] },
      ]);
    }
    await startSession(c, user.id);
    return c.json({ user });
  });

  app.post("/auth/login", async (c) => {
    const rt = c.get("rt");
    const body = await readJson<{ email?: string; password?: string }>(c);
    throttle("login:" + (getClientIp(c) ?? "unknown"));
    if (!body.email || !body.password) fail(400, "Email and password are required");
    const user = await authenticate(rt.db, body.email, body.password);
    if (!user) fail(401, "Invalid email or password");
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
    const body = await readJson<{ name?: string; email?: string }>(c);
    const db = c.get("rt").db;
    if (body.email !== undefined) {
      if (!isEmail(body.email)) fail(400, "Invalid email");
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
    const row = await db.first<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", [user.id]);
    if (!row || !body.current || !(await verifyPassword(body.current, row.password_hash))) fail(400, "Current password is incorrect");
    if (!body.password || body.password.length < 8) fail(400, "New password must be at least 8 characters");
    await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(body.password), user.id]);
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
      { sql: "DELETE FROM site_members WHERE user_id = ?", params: [id] },
      { sql: "DELETE FROM auth_sessions WHERE user_id = ?", params: [id] },
      { sql: "DELETE FROM api_keys WHERE user_id = ?", params: [id] },
      { sql: "DELETE FROM users WHERE id = ?", params: [id] },
    ]);
    return c.json({ ok: true });
  });

  return app;
}
