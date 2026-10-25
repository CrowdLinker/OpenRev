import type { Runtime } from "../context";
import { runScheduledAlerts } from "./alerts";
import { getRates } from "../lib/currency";

async function due(rt: Runtime, name: string, everyMs: number, now: number): Promise<boolean> {
  const row = await rt.db.first<{ last_run_at: number }>("SELECT last_run_at FROM jobs WHERE name = ?", [name]);
  if (row && now - Number(row.last_run_at) < everyMs) return false;
  await rt.db.run("INSERT INTO jobs (name, last_run_at) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET last_run_at = excluded.last_run_at", [name, now]);
  return true;
}

/**
 * Periodic work. Called by a Cloudflare Cron Trigger or an in-process timer on Node.
 * Safe to call as often as you like: every job tracks its own last run.
 */
export async function runScheduled(rt: Runtime, now = Date.now()): Promise<string[]> {
  const ran: string[] = [];
  const run = async (name: string, everyMs: number, fn: () => Promise<unknown>) => {
    if (!(await due(rt, name, everyMs, now))) return;
    try {
      await fn();
      ran.push(name);
    } catch (err) {
      console.error(`[openrev] scheduled job ${name} failed:`, err);
    }
  };

  // Alerts (traffic spikes, digests) are evaluated a few minutes after each hour.
  const minute = new Date(now).getUTCMinutes();
  if (minute >= 2) {
    await run(`alerts:${Math.floor(now / 3_600_000)}`, 2 * 3_600_000, () => runScheduledAlerts(rt, now));
  }

  await run("fx-rates", 6 * 3_600_000, () => getRates(rt.db, now));

  await run("cleanup", 24 * 3_600_000, async () => {
    await rt.db.run("DELETE FROM auth_sessions WHERE expires_at < ?", [now]);
    await rt.db.run("DELETE FROM checkout_refs WHERE created_at < ?", [now - 60 * 86_400_000]);
    await rt.db.run("DELETE FROM salts WHERE day < ?", [new Date(now - 3 * 86_400_000).toISOString().slice(0, 10)]);
    await rt.db.run("DELETE FROM alert_history WHERE ts < ?", [now - 90 * 86_400_000]);
    await rt.db.run("DELETE FROM jobs WHERE name LIKE 'alerts:%' AND last_run_at < ?", [now - 2 * 86_400_000]);
    const days = rt.config.retentionDays;
    if (days && days > 0) {
      const cutoff = now - days * 86_400_000;
      await rt.db.run("DELETE FROM events WHERE ts < ?", [cutoff]);
      await rt.db.run("DELETE FROM sessions WHERE started_at < ?", [cutoff]);
    }
  });
  return ran;
}
