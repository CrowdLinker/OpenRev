import type { Runtime } from "../context";

export function emailEnabled(rt: Runtime): boolean {
  return !!rt.config.resendApiKey;
}

/** Sends an email through Resend (https://resend.com). Works on every runtime (plain fetch). */
export async function sendEmail(rt: Runtime, msg: { to: string | string[]; subject: string; html: string; text?: string }) {
  if (!rt.config.resendApiKey) throw new Error("Email is not configured. Set RESEND_API_KEY and OPENREV_EMAIL_FROM.");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${rt.config.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: rt.config.emailFrom || "OpenRev <onboarding@resend.dev>",
      to: Array.isArray(msg.to) ? msg.to : [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    }),
  });
  if (!res.ok) throw new Error(`Email failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
