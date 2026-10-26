import { useEffect, useState } from "react";
import { api, useApi } from "../lib/api";
import { useSite } from "../lib/context";
import { num, timeAgo } from "../lib/format";
import { Badge, Button, ErrorBox, Field, Section, Toggle } from "./ui";

const DOCS = "https://github.com/CrowdLinker/OpenRev/blob/main/docs/features/social.md";

export interface SocialConfig {
  set_up: boolean;
  x_connected: boolean;
  keywords: string[];
  handles: string[];
  x_checked_at: number | null;
  hn_checked_at: number | null;
  x_reads: number;
  x_monthly_cap: number;
  hn: boolean;
  last_error: string | null;
}

export function XLogo({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-label="𝕏">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function HnLogo({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center justify-center rounded-[3px] bg-[#ff6600] text-[0.6rem] leading-none font-bold text-white ${className}`} aria-label="Hacker News">
      Y
    </span>
  );
}

/** Settings → General: watch 𝕏 (with the website's own API token) and Hacker News for posts about the website. */
export function SocialSettings() {
  const { site, reloadMeta } = useSite();
  const status = useApi<{ config: SocialConfig }>(site ? `/api/sites/${site.id}/social` : null);
  const cfg = status.data?.config;
  const [token, setToken] = useState("");
  const [keywords, setKeywords] = useState("");
  const [handles, setHandles] = useState("");
  const [cap, setCap] = useState("2000");
  const [hn, setHn] = useState(true);
  const [busy, setBusy] = useState<"save" | "check" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!cfg) return;
    setKeywords(cfg.keywords.join(", "));
    setHandles(cfg.handles.map((h) => `@${h}`).join(", "));
    setCap(String(cfg.x_monthly_cap));
    setHn(cfg.set_up ? cfg.hn : true);
  }, [cfg]);

  if (!site) return null;
  const base = `/api/sites/${site.id}/social`;
  const setUp = !!cfg?.set_up;

  const check = async () => {
    setBusy("check");
    setError(null);
    try {
      const res = await api<{ x: number | null; hn: number | null; error: string | null }>(`${base}/sync`, { body: {} });
      const found = [res.x !== null && `${res.x} on 𝕏`, res.hn !== null && `${res.hn} on Hacker News`].filter(Boolean).join(" and ");
      setNote(found ? `Found ${found}.` : "Checked recently; nothing new to look at yet.");
      reloadMeta();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
      status.reload();
    }
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    setNote(null);
    try {
      await api(base, { method: "PATCH", body: { keywords, handles, x_monthly_cap: Number(cap), hn, ...(token ? { x_token: token } : {}) } });
      setToken("");
      status.reload();
      setBusy(null);
      await check();
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  };

  return (
    <Section
      title="Social: 𝕏 and Hacker News"
      description={
        <>
          Find posts that mention or link to your website, and see the visitors and revenue each one brings.{" "}
          <a className="text-brand-600 hover:underline" href={DOCS} target="_blank" rel="noreferrer">
            How it works
          </a>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <Toggle checked={hn} onChange={setHn} label="Watch Hacker News" help="Stories and comments that link to your website or use your keywords. Free, no account needed." />

        <div className="space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            𝕏 API {cfg?.x_connected ? <Badge color="green">Connected</Badge> : <Badge>Not connected</Badge>}
          </div>
          <p className="text-zinc-600 dark:text-zinc-400">
            Uses your own 𝕏 API app. 𝕏 bills about $0.005 per post read, from credits you add in the{" "}
            <a className="text-brand-600 hover:underline" href="https://console.x.com" target="_blank" rel="noreferrer">
              Developer Console
            </a>
            . OpenRev searches every 6 hours, reads each post once, and stops at your monthly limit.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={cfg?.x_connected ? "Replace the bearer token" : "Bearer token"} help="Developer Console → your app → Keys and tokens. Stored encrypted.">
              <input type="password" className="input font-mono" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="AAAAAAAAAAAAAAAAAAAAA…" />
            </Field>
            <Field label="Monthly limit (posts read)" help={`About $${((Number(cap) || 0) * 0.005).toFixed(2)} at most. ${cfg ? `${num(cfg.x_reads, false)} read this month.` : ""}`}>
              <input type="number" min={0} step={100} className="input" value={cap} onChange={(e) => setCap(e.target.value)} />
            </Field>
            <Field label="Link-in-bio handles" help="𝕏 accounts whose profile links to your website, yours or a partner's. Visits from 𝕏 to that page count for the profile.">
              <input className="input" value={handles} onChange={(e) => setHandles(e.target.value)} placeholder="@yourbrand, @founder" />
            </Field>
            <Field label="Keywords" help="Brand or product names, @handles or #hashtags, comma separated. Links to your domain are found without them.">
              <input className="input" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="YourBrand, @yourbrand" />
            </Field>
          </div>
        </div>

        {(error || cfg?.last_error) && <ErrorBox error={error ?? `Last check: ${cfg?.last_error}`} />}
        {note && !error && <p className="text-money-600 dark:text-money-400">{note}</p>}
        {cfg && setUp && (
          <p className="text-xs text-zinc-500">
            {cfg.hn_checked_at ? `Hacker News checked ${timeAgo(cfg.hn_checked_at)}. ` : ""}
            {cfg.x_connected ? (cfg.x_checked_at ? `𝕏 checked ${timeAgo(cfg.x_checked_at)}.` : "𝕏 not checked yet.") : ""}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy === "save"} disabled={!!busy} onClick={save}>
            {setUp ? "Save" : "Start watching"}
          </Button>
          {setUp && (
            <Button variant="secondary" loading={busy === "check"} disabled={!!busy} onClick={check}>
              Check now
            </Button>
          )}
          {cfg?.x_connected && (
            <Button
              variant="ghost"
              disabled={!!busy}
              onClick={async () => {
                if (!confirm("Remove the 𝕏 token? Posts already found stay.")) return;
                await api(base, { method: "PATCH", body: { x_token: null } }).catch(setError);
                status.reload();
              }}
            >
              Remove 𝕏 token
            </Button>
          )}
          {setUp && (
            <Button
              variant="ghost"
              disabled={!!busy}
              onClick={async () => {
                if (!confirm("Stop watching and delete the posts found?")) return;
                await api(base, { method: "DELETE" }).catch(setError);
                status.reload();
                reloadMeta();
              }}
            >
              Stop and delete posts
            </Button>
          )}
        </div>
      </div>
    </Section>
  );
}
