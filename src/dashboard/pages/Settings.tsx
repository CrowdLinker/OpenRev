import { AlertTriangle, Bell, CheckCircle2, Download, ExternalLink, KeyRound, Plus, Trash2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ImportHistory } from "../components/ImportHistory";
import { SearchConsoleSettings } from "../components/SearchConsole";
import { InstallGuide, QUEUE_SNIPPET, scriptUrl, snippet, VerifyInstall } from "../components/InstallGuide";
import { LiveBadge } from "../components/LiveBadge";
import { Badge, Button, Card, CodeBlock, CopyButton, cx, Empty, ErrorBox, Field, Loading, Modal, Section, Toggle } from "../components/ui";
import { api, useApi } from "../lib/api";
import { useAuth, useSite } from "../lib/context";
import { dateTime, timeAgo } from "../lib/format";
import type { Row, Site, SiteSettings } from "../lib/types";
import { CURRENCIES, timezones } from "./NewSite";

const TABS = [
  { value: "general", label: "General" },
  { value: "tracking", label: "Tracking code" },
  { value: "revenue", label: "Revenue" },
  { value: "exclusions", label: "Exclusions" },
  { value: "team", label: "Team" },
  { value: "api", label: "API & MCP" },
  { value: "alerts", label: "Alerts" },
  { value: "data", label: "Data" },
];

export function SettingsPage({ tab = "general" }: { tab?: string }) {
  const { site } = useSite();
  if (!site) return <Loading />;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[200px_1fr]">
      <nav className="flex gap-1 overflow-x-auto lg:flex-col">
        {TABS.map((t) => (
          <Link
            key={t.value}
            href={`/settings/${t.value}`}
            className={cx(
              "shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition",
              tab === t.value ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-white dark:ring-zinc-800" : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="min-w-0 space-y-6">
        {tab === "general" && <GeneralSettings site={site} />}
        {tab === "tracking" && <TrackingSettings site={site} />}
        {tab === "revenue" && <RevenueSettings site={site} />}
        {tab === "exclusions" && <ExclusionSettings site={site} />}
        {tab === "team" && <TeamSettings site={site} />}
        {tab === "api" && <ApiSettings site={site} />}
        {tab === "alerts" && <AlertSettings site={site} />}
        {tab === "data" && <DataSettings site={site} />}
      </div>
    </div>
  );
}

function useSave(site: Site) {
  const { reloadSite, reloadMeta } = useSite();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const save = async (body: Partial<Site> | { settings: Partial<SiteSettings> }) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/api/sites/${site.id}`, { method: "PATCH", body });
      reloadSite();
      reloadMeta();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, saved, save };
}

function SaveRow({ busy, saved, error, onSave }: { busy: boolean; saved: boolean; error: unknown; onSave: () => void }) {
  return (
    <div className="mt-5 flex items-center gap-3">
      <Button variant="primary" loading={busy} onClick={onSave}>
        Save changes
      </Button>
      {saved && <span className="text-sm text-money-600">Saved ✓</span>}
      <div className="flex-1">
        <ErrorBox error={error} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function GeneralSettings({ site }: { site: Site }) {
  const { meta, reloadSite } = useSite();
  const tzList = useMemo(timezones, []);
  const [form, setForm] = useState({
    name: site.name,
    domain: site.domain,
    timezone: site.timezone,
    currency: site.currency,
    allowedHostnames: (site.settings.allowedHostnames ?? []).join("\n"),
    attribution: site.settings.attribution ?? "last_non_direct",
    kpiGoal: site.settings.kpiGoal ?? "",
    cookieless: !!site.settings.cookieless,
    allowLocalhost: !!site.settings.allowLocalhost,
    strictHostnames: site.settings.strictHostnames !== false,
    hideRevenue: !!site.settings.hideRevenue,
  });
  const { busy, error, saved, save } = useSave(site);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const [shareBusy, setShareBusy] = useState(false);

  return (
    <>
      <Section title="Website">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Domain" help="Root domain. Subdomains are tracked automatically.">
            <input className="input" value={form.domain} onChange={(e) => set({ domain: e.target.value })} />
          </Field>
          <Field label="Timezone">
            <select className="input" value={form.timezone} onChange={(e) => set({ timezone: e.target.value })}>
              {tzList.map((tz) => (
                <option key={tz}>{tz}</option>
              ))}
            </select>
          </Field>
          <Field label="Currency" help="All revenue is converted to this currency.">
            <select className="input" value={form.currency} onChange={(e) => set({ currency: e.target.value })}>
              {[...new Set([form.currency, ...CURRENCIES])].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Additional domains" help="Other root domains that share visitors with this site (cross-domain tracking). One per line.">
            <textarea className="input min-h-[80px] font-mono text-xs" value={form.allowedHostnames} onChange={(e) => set({ allowedHostnames: e.target.value })} placeholder="app.example.io" />
          </Field>
          <div className="space-y-4">
            <Field label="Revenue attribution model" help="Which visit gets credit for a payment.">
              <select className="input" value={form.attribution} onChange={(e) => set({ attribution: e.target.value as typeof form.attribution })}>
                <option value="last_non_direct">Last non-direct touch (recommended)</option>
                <option value="last_touch">Last touch</option>
                <option value="first_touch">First touch</option>
              </select>
            </Field>
            <Field label="#1 KPI" help="A goal shown as a headline metric next to revenue.">
              <input className="input" list="kpi-goals" value={form.kpiGoal} onChange={(e) => set({ kpiGoal: e.target.value })} placeholder="e.g. signup" />
              <datalist id="kpi-goals">
                {meta?.goals.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </Field>
          </div>
        </div>
        <div className="mt-6 space-y-4">
          <Toggle checked={form.cookieless} onChange={(v) => set({ cookieless: v })} label="Cookieless mode" help="No cookies: visitors are identified by a daily-rotating anonymous hash. Better for GDPR, less accurate for multi-day attribution." />
          <Toggle checked={form.strictHostnames} onChange={(v) => set({ strictHostnames: v })} label="Only accept events from my domains" help="Ignore events from hostnames that aren't your domain, its subdomains or additional domains." />
          <Toggle checked={form.allowLocalhost} onChange={(v) => set({ allowLocalhost: v })} label="Accept events from localhost" help="Useful while developing. Also add data-allow-localhost=&quot;true&quot; to the script tag." />
          <Toggle checked={form.hideRevenue} onChange={(v) => set({ hideRevenue: v })} label="Hide revenue features" help="For sites that don't sell anything." />
        </div>
        <SaveRow
          busy={busy}
          saved={saved}
          error={error}
          onSave={() =>
            save({
              name: form.name,
              domain: form.domain,
              timezone: form.timezone,
              currency: form.currency,
              settings: {
                allowedHostnames: form.allowedHostnames.split(/\s+/).filter(Boolean),
                attribution: form.attribution,
                kpiGoal: form.kpiGoal || null,
                cookieless: form.cookieless,
                allowLocalhost: form.allowLocalhost,
                strictHostnames: form.strictHostnames,
                hideRevenue: form.hideRevenue,
              },
            } as Partial<Site>)
          }
        />
      </Section>

      <Section title="Public dashboard" description="Share a read-only dashboard with anyone (investors, “open startup” pages…). Visitor names and emails are never shown.">
        {site.share_token ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <code className="code flex-1 truncate">{`${window.location.origin}/share/${site.share_token}`}</code>
              <CopyButton text={`${window.location.origin}/share/${site.share_token}`} />
              <a href={`/share/${site.share_token}`} target="_blank" rel="noreferrer">
                <Button size="sm">
                  <ExternalLink className="h-3.5 w-3.5" /> Open
                </Button>
              </a>
            </div>
            <Button
              size="sm"
              variant="ghost"
              loading={shareBusy}
              onClick={async () => {
                setShareBusy(true);
                await api(`/api/sites/${site.id}/share`, { body: { enabled: false } });
                reloadSite();
                setShareBusy(false);
              }}
            >
              Disable public link
            </Button>
            <LiveBadge token={site.share_token} />
          </div>
        ) : (
          <Button
            loading={shareBusy}
            onClick={async () => {
              setShareBusy(true);
              await api(`/api/sites/${site.id}/share`, { body: { enabled: true } });
              reloadSite();
              setShareBusy(false);
            }}
          >
            Create public link
          </Button>
        )}
      </Section>
      <SearchConsoleSettings />
      <NotesSection site={site} />
    </>
  );
}

function NotesSection({ site }: { site: Site }) {
  const { data, reload } = useApi<{ notes: Row[] }>(`/api/sites/${site.id}/notes`);
  return (
    <Section title="Chart notes" description="Annotations shown on the main chart. Add them from the dashboard with the “Note” button.">
      {!data?.notes.length ? (
        <p className="text-sm text-zinc-500">No notes yet.</p>
      ) : (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {data.notes.map((n) => (
            <div key={String(n.id)} className="flex items-center gap-3 py-2 text-sm">
              <span className="w-28 shrink-0 text-zinc-500">{dateTime(Number(n.ts), site.timezone)}</span>
              <span className="flex-1">{n.text}</span>
              <button
                className="text-zinc-400 hover:text-red-500"
                onClick={async () => {
                  await api(`/api/sites/${site.id}/notes/${n.id}`, { method: "DELETE" });
                  reload();
                }}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------

function TrackingSettings({ site }: { site: Site }) {
  return (
    <>
      <Section title="Install the tracking script" description="Add this snippet to every page of your website. It's ~4 kB, loads asynchronously and never slows your site down.">
        <InstallGuide site={site} cookieless={site.settings.cookieless} />
        <div className="mt-5">
          <VerifyInstall siteId={site.id} />
        </div>
      </Section>
      <Section title="Track goals" description="Measure signups, clicks, downloads… and see which channels drive them.">
        <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">With JavaScript (add the queue snippet to your &lt;head&gt; so early calls aren't lost):</p>
        <CodeBlock code={`${QUEUE_SNIPPET}\n\n<script>\n  openrev("signup", { plan: "pro" });\n</script>`} />
        <p className="mt-4 mb-2 text-sm text-zinc-600 dark:text-zinc-400">Or without code, with HTML attributes:</p>
        <CodeBlock
          code={`<button data-openrev-goal="start_trial" data-openrev-goal-plan="pro">Start trial</button>\n\n<!-- fires when the element is scrolled into view -->\n<section data-openrev-scroll="pricing_seen">...</section>`}
        />
        <p className="mt-4 mb-2 text-sm text-zinc-600 dark:text-zinc-400">Identify logged-in users (shows names in journeys & realtime):</p>
        <CodeBlock code={`openrev("identify", { user_id: "usr_123", name: "Jane Doe", email: "jane@example.com", plan: "pro" });`} />
      </Section>
      {!site.settings.cookieless && (
        <Section
          title="Cookie consent"
          description="Showing a cookie banner? Use the consent build instead: it tracks without cookies until the visitor accepts, then switches to cookies and keeps the same visit."
        >
          <CodeBlock code={snippet(site, "consent")} />
          <p className="mt-4 mb-2 text-sm text-zinc-600 dark:text-zinc-400">Then tell OpenRev what the visitor chose, from your banner's buttons (with the queue snippet above):</p>
          <CodeBlock
            code={`// When the visitor accepts analytics cookies:
openrev("consent", true);

// When they reject them, or withdraw consent later:
openrev("consent", false);`}
          />
          <p className="mt-4 text-sm text-zinc-500">
            Using Google Consent Mode? Add <code className="code">data-consent="google"</code> and OpenRev follows <code className="code">analytics_storage</code>{" "}
            instead.{" "}
            <a
              className="text-brand-600 hover:underline"
              href="https://github.com/CrowdLinker/OpenRev/blob/main/docs/tracking/privacy-and-cookies.md#cookieless-until-consent"
              target="_blank"
              rel="noreferrer"
            >
              Consent guide
            </a>
          </p>
        </Section>
      )}
      <Section title="Script options">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {[
                ["data-website-id", "Required. Your website id: " + site.id],
                ["data-domain", "Your root domain, used for cookies across subdomains."],
                ["data-allowed-hostnames", "Comma-separated extra domains for cross-domain tracking."],
                ["data-api-url", "Custom events endpoint, for proxies (default: the script's origin + /api/events). Alias: data-api."],
                ["data-allow-localhost", "Set to true to track localhost."],
                ["data-allow-file-protocol", "Set to true to track pages opened from file://."],
                ["data-hash", "Set to true for hash-based routing (or use script.hash.js)."],
                ["data-cookieless", "Set to true for cookieless tracking (or use script.cookieless.js)."],
                ["data-consent", 'With script.consent.js: set to "google" to follow Google Consent Mode instead of openrev("consent", …).'],
                ["data-disable-payments", "Disable automatic payment link tagging & checkout detection."],
                ["data-disable-outbound", "Disable outbound link tracking."],
                ["data-disable-console", "Silence console messages."],
                ["data-debug", "Allow tracking inside iframes."],
              ].map(([k, v]) => (
                <tr key={k}>
                  <td className="py-2 pr-4 align-top">
                    <code className="code">{k}</code>
                  </td>
                  <td className="py-2 text-zinc-600 dark:text-zinc-400">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-zinc-500">
          Ad blockers? Serve the script from your own domain with a proxy —{" "}
          <a className="text-brand-600 hover:underline" href="https://github.com/CrowdLinker/OpenRev/blob/main/docs/tracking/proxy.md" target="_blank" rel="noreferrer">
            proxy guides
          </a>
          . Script URL: <code className="code">{scriptUrl()}</code>
        </p>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------

interface ProviderInfo {
  id: string;
  name: string;
  website: string;
  description: string;
  fields: { key: string; label: string; type: string; required?: boolean; placeholder?: string; help?: string; options?: { value: string; label: string }[]; secret?: boolean }[];
  events: string[];
  metadataHint: string | null;
  supportsImport: boolean;
}

interface Integration {
  id: string;
  provider: string;
  name: string;
  enabled: boolean;
  last_event_at: number | null;
  last_error: string | null;
  missing: string[];
  config: Record<string, string | null>;
  webhook_url: string;
  created_at: number;
}

function RevenueSettings({ site }: { site: Site }) {
  const { data, reload, loading } = useApi<{ integrations: Integration[]; providers: ProviderInfo[] }>(`/api/sites/${site.id}/integrations`);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Integration | null>(null);
  const [created, setCreated] = useState<Integration | null>(null);
  const providers = data?.providers ?? [];
  const byId = (id: string) => providers.find((p) => p.id === id);

  return (
    <>
      <Section
        title="Payment providers"
        description="Connect where you get paid. OpenRev attributes every payment, renewal and refund to the visitor's traffic source."
        actions={
          <Button variant="money" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> Connect
          </Button>
        }
      >
        {loading && !data ? (
          <Loading />
        ) : !data?.integrations.length ? (
          <Empty title="No payment provider connected">Stripe, Lemon Squeezy, Polar, Paddle, Shopify, Gumroad, Dodo, Creem, Paystack, Razorpay, WooCommerce or any custom webhook.</Empty>
        ) : (
          <div className="space-y-3">
            {data.integrations.map((i) => (
              <IntegrationRow key={i.id} site={site} integration={i} provider={byId(i.provider)} onChange={reload} onEdit={() => setEditing(i)} />
            ))}
          </div>
        )}
      </Section>
      <Section title="Any other payment system: Payments API" description="Send payments from your backend after a successful charge.">
        <CodeBlock
          code={`curl -X POST ${window.location.origin}/api/v1/payments \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount": 29.99,
    "currency": "USD",
    "transaction_id": "txn_123",
    "openrev_visitor_id": "<value of the openrev_visitor_id cookie>",
    "email": "jane@example.com"
  }'`}
        />
        <p className="mt-3 text-sm text-zinc-500">
          Create an API key in{" "}
          <Link href="/settings/api" className="text-brand-600 hover:underline">
            API & MCP
          </Link>
          . Set <code className="code">"renewal": true</code> for recurring charges and <code className="code">"refunded": true</code> for refunds.
        </p>
      </Section>
      {adding && (
        <ConnectModal
          site={site}
          providers={providers}
          onClose={() => setAdding(false)}
          onCreated={(i) => {
            setAdding(false);
            setCreated(i);
            reload();
          }}
        />
      )}
      {editing && (
        <ConnectModal
          site={site}
          providers={providers}
          integration={editing}
          onClose={() => setEditing(null)}
          onCreated={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {created && <SetupInstructions integration={created} provider={byId(created.provider)} onClose={() => setCreated(null)} />}
    </>
  );
}

function IntegrationRow({ site, integration: i, provider, onChange, onEdit }: { site: Site; integration: Integration; provider?: ProviderInfo; onChange: () => void; onEdit: () => void }) {
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState<unknown>(null);
  const [showSetup, setShowSetup] = useState(false);

  const runImport = async () => {
    setImportError(null);
    let cursor: string | null = null;
    let total = 0;
    try {
      do {
        setImporting(`Importing… ${total} payments`);
        const r: { imported: number; nextCursor: string | null } = await api(`/api/sites/${site.id}/integrations/${i.id}/import`, { body: { cursor } });
        total += r.imported;
        cursor = r.nextCursor;
      } while (cursor);
      setImporting(`Imported ${total} payments ✓`);
      onChange();
    } catch (err) {
      setImportError(err);
      setImporting(null);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-medium">
            {i.name}
            {!i.enabled ? <Badge>Paused</Badge> : i.missing.length ? <Badge color="amber">Add {i.missing.join(", ").toLowerCase()}</Badge> : i.last_error ? <Badge color="red">Error</Badge> : i.last_event_at ? <Badge color="green">Receiving events</Badge> : <Badge color="amber">Waiting for first event</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-zinc-500">
            {provider?.name ?? i.provider} · {i.last_event_at ? `last event ${timeAgo(i.last_event_at)}` : "no events yet"}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => setShowSetup(true)}>
            Setup
          </Button>
          {provider?.supportsImport && (
            <Button size="sm" onClick={runImport} loading={!!importing && importing.startsWith("Importing")}>
              <Download className="h-3.5 w-3.5" /> Import history
            </Button>
          )}
          <Button size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await api(`/api/sites/${site.id}/integrations/${i.id}`, { method: "PATCH", body: { enabled: !i.enabled } });
              onChange();
            }}
          >
            {i.enabled ? "Pause" : "Resume"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              if (!confirm(`Disconnect ${i.name}? Recorded payments are kept.`)) return;
              await api(`/api/sites/${site.id}/integrations/${i.id}`, { method: "DELETE" });
              onChange();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <code className="code flex-1 truncate">{i.webhook_url}</code>
        <CopyButton text={i.webhook_url} label="Copy webhook URL" />
      </div>
      {i.last_error && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-red-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {i.last_error}
        </div>
      )}
      {importing && <div className="mt-2 text-xs text-zinc-500">{importing}</div>}
      <ErrorBox error={importError} />
      {showSetup && <SetupInstructions integration={i} provider={provider} onClose={() => setShowSetup(false)} />}
    </div>
  );
}

function ConnectModal({ site, providers, integration, onClose, onCreated }: { site: Site; providers: ProviderInfo[]; integration?: Integration; onClose: () => void; onCreated: (i: Integration) => void }) {
  const [providerId, setProviderId] = useState(integration?.provider ?? "");
  const provider = providers.find((p) => p.id === providerId);
  const [config, setConfig] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(integration?.config ?? {}).map(([k, v]) => [k, v ?? ""])));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = integration
        ? await api<{ integration: Integration }>(`/api/sites/${site.id}/integrations/${integration.id}`, { method: "PATCH", body: { config } })
        : await api<{ integration: Integration }>(`/api/sites/${site.id}/integrations`, { body: { provider: providerId, config } });
      onCreated(r.integration);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={integration ? `Edit ${integration.name}` : "Connect a payment provider"} wide={!provider}>
      {!provider ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {providers.map((p) => (
            <button key={p.id} onClick={() => setProviderId(p.id)} className="rounded-xl border border-zinc-200 p-4 text-left transition hover:border-brand-400 hover:bg-brand-50/40 dark:border-zinc-800 dark:hover:border-brand-600 dark:hover:bg-brand-500/5">
              <div className="flex items-center gap-2 font-medium">
                <img src={`/api/favicon/${new URL(p.website).hostname}`} alt="" className="h-4 w-4 rounded-sm" />
                {p.name}
              </div>
              <p className="mt-1 line-clamp-3 text-xs text-zinc-500">{p.description}</p>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{provider.description}</p>
          {provider.fields.map((f) => (
            <Field
              key={f.key}
              label={f.label + (f.required ? "" : /optional/i.test(f.label) ? "" : " (optional)")}
              help={
                <>
                  {f.help}
                  {f.secret && f.required && !integration && f.key !== "token" && <span className="block text-amber-600">You can leave this empty for now and add it after registering the webhook URL.</span>}
                  {f.key === "token" && !integration && <span className="block">Leave empty to generate one automatically — it's included in the webhook URL.</span>}
                </>
              }
            >
              {f.type === "select" ? (
                <select className="input" value={config[f.key] ?? ""} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}>
                  <option value="">—</option>
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.type === "textarea" ? (
                <textarea className="input min-h-[80px] font-mono text-xs" value={config[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
              ) : (
                <input className="input font-mono text-xs" type={f.type === "password" ? "password" : "text"} autoComplete="off" value={config[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
              )}
            </Field>
          ))}
          <ErrorBox error={error} />
          <div className="flex justify-between gap-2">
            {!integration ? (
              <Button variant="ghost" onClick={() => setProviderId("")}>
                ← All providers
              </Button>
            ) : (
              <span />
            )}
            <Button variant="money" loading={busy} onClick={submit}>
              {integration ? "Save" : `Connect ${provider.name}`}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function SetupInstructions({ integration, provider, onClose }: { integration: Integration; provider?: ProviderInfo; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={`Finish setting up ${integration.name}`} wide>
      <ol className="space-y-5 text-sm">
        <li>
          <div className="mb-1.5 font-medium">1. Add this webhook endpoint in your {provider?.name ?? "provider"} dashboard</div>
          <div className="flex items-center gap-2">
            <code className="code flex-1 truncate">{integration.webhook_url}</code>
            <CopyButton text={integration.webhook_url} />
          </div>
        </li>
        {provider && provider.events.length > 0 && (
          <li>
            <div className="mb-1.5 font-medium">2. Subscribe to these events</div>
            <div className="flex flex-wrap gap-1.5">
              {provider.events.map((e) => (
                <code key={e} className="code">
                  {e}
                </code>
              ))}
            </div>
          </li>
        )}
        <li>
          <div className="mb-1.5 font-medium">3. Pass the visitor id at checkout</div>
          <p className="mb-2 text-zinc-600 dark:text-zinc-400">
            Read the <code className="code">openrev_visitor_id</code> cookie on your server (or <code className="code">window.openrev.visitorId()</code> in the browser) and attach it to the checkout
            {provider?.metadataHint ? (
              <>
                {" "}
                as <code className="code">{provider.metadataHint}</code>
              </>
            ) : null}
            . Payment links and checkout success pages are detected automatically by the tracker for Stripe, Lemon Squeezy, Polar, Dodo, Creem and Gumroad.
          </p>
          <a className="text-brand-600 hover:underline" href={`https://github.com/CrowdLinker/OpenRev/blob/main/docs/revenue/${integration.provider}.md`} target="_blank" rel="noreferrer">
            Read the {provider?.name ?? integration.provider} guide →
          </a>
        </li>
      </ol>
      <div className="mt-6 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function ExclusionSettings({ site }: { site: Site }) {
  const [form, setForm] = useState({
    excludedIps: (site.settings.excludedIps ?? []).join("\n"),
    excludedPaths: (site.settings.excludedPaths ?? []).join("\n"),
    excludedCountries: (site.settings.excludedCountries ?? []).join("\n"),
    excludedHostnames: (site.settings.excludedHostnames ?? []).join("\n"),
  });
  const { busy, error, saved, save } = useSave(site);
  const lines = (s: string) => s.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
  const areas: { key: keyof typeof form; label: string; help: string; placeholder: string }[] = [
    { key: "excludedIps", label: "IP addresses", help: "One per line. Supports wildcards (192.168.*) and CIDR (10.0.0.0/8).", placeholder: "203.0.113.4" },
    { key: "excludedPaths", label: "Paths", help: "One per line. /admin/* excludes every page under /admin.", placeholder: "/admin/*" },
    { key: "excludedCountries", label: "Countries", help: "Two-letter country codes, one per line.", placeholder: "RU" },
    { key: "excludedHostnames", label: "Hostnames", help: "Exact hostnames, e.g. staging.example.com.", placeholder: "staging.example.com" },
  ];
  return (
    <>
      <Section title="Exclude visits" description="Excluded visits are dropped before they're stored.">
        <div className="grid gap-4 sm:grid-cols-2">
          {areas.map((a) => (
            <Field key={a.key} label={a.label} help={a.help}>
              <textarea className="input min-h-[100px] font-mono text-xs" value={form[a.key]} placeholder={a.placeholder} onChange={(e) => setForm({ ...form, [a.key]: e.target.value })} />
            </Field>
          ))}
        </div>
        <SaveRow
          busy={busy}
          saved={saved}
          error={error}
          onSave={() =>
            save({
              settings: {
                excludedIps: lines(form.excludedIps),
                excludedPaths: lines(form.excludedPaths),
                excludedCountries: lines(form.excludedCountries),
                excludedHostnames: lines(form.excludedHostnames),
              },
            })
          }
        />
      </Section>
      <Section title="Exclude your own visits" description="Run this once in the browser console on your website (each browser and domain).">
        <CodeBlock code={`localStorage.setItem("openrev_ignore", "true")`} />
        <p className="mt-2 text-xs text-zinc-500">
          To track yourself again: <code className="code">localStorage.removeItem("openrev_ignore")</code>
        </p>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------

function TeamSettings({ site }: { site: Site }) {
  const { user, instance } = useAuth();
  const { role } = useSite();
  const { data, reload } = useApi<{ members: Row[]; invites: Row[] }>(`/api/sites/${site.id}/members`);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Section title="Members" description="Owners manage everything, admins manage settings, viewers can only see the dashboard.">
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {data?.members.map((m) => (
            <div key={String(m.id)} className="flex items-center gap-3 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{m.name || m.email}</div>
                <div className="text-xs text-zinc-500">{m.email}</div>
              </div>
              <select
                className="input !w-auto !py-1 text-xs"
                value={m.role}
                disabled={m.id === user?.id}
                onChange={async (e) => {
                  try {
                    await api(`/api/sites/${site.id}/members/${m.id}`, { method: "PATCH", body: { role: e.target.value } });
                  } catch (err) {
                    alert((err as Error).message);
                  }
                  reload();
                }}
              >
                <option value="owner" disabled={role !== "owner"}>
                  Owner
                </option>
                <option value="admin">Admin</option>
                <option value="viewer">Viewer</option>
              </select>
              <button
                className="text-zinc-400 hover:text-red-500"
                title={m.id === user?.id ? "Leave website" : "Remove member"}
                onClick={async () => {
                  if (!confirm(m.id === user?.id ? "Leave this website?" : `Remove ${m.email}?`)) return;
                  try {
                    await api(`/api/sites/${site.id}/members/${m.id}`, { method: "DELETE" });
                    reload();
                  } catch (err) {
                    alert((err as Error).message);
                  }
                }}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Invite someone" description={instance?.emailEnabled ? "They'll receive an email with a link." : "Share the generated link with them (email isn't configured on this instance)."}>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            setLink(null);
            try {
              const r = await api<{ url?: string; added?: boolean; emailed?: boolean }>(`/api/sites/${site.id}/invites`, { body: { email: email || undefined, role: inviteRole } });
              if (r.url) setLink(r.url);
              setEmail("");
              reload();
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="min-w-[220px] flex-1">
            <Field label="Email (optional)">
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" />
            </Field>
          </div>
          <Field label="Role">
            <select className="input" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
              <option value="viewer">Viewer</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <Button variant="primary" type="submit" loading={busy}>
            Create invite
          </Button>
        </form>
        <ErrorBox error={error} />
        {link && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-zinc-50 p-2 dark:bg-zinc-800/50">
            <code className="code flex-1 truncate">{link}</code>
            <CopyButton text={link} />
          </div>
        )}
        {!!data?.invites.length && (
          <div className="mt-4">
            <div className="mb-1 text-xs font-medium text-zinc-500">Pending invitations</div>
            {data.invites.map((i) => (
              <div key={String(i.id)} className="flex items-center gap-2 py-1 text-sm">
                <span className="flex-1">{i.email || "Invite link"} · {i.role}</span>
                <span className="text-xs text-zinc-400">expires {dateTime(Number(i.expires_at))}</span>
                <button
                  className="text-zinc-400 hover:text-red-500"
                  onClick={async () => {
                    await api(`/api/sites/${site.id}/invites/${i.id}`, { method: "DELETE" });
                    reload();
                  }}
                >
                  <XCircle className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------

export function KeysList({ listPath, createPath, deletePath, label }: { listPath: string; createPath: string; deletePath: (id: string) => string; label: string }) {
  const { data, reload } = useApi<{ keys?: Row[]; tokens?: Row[] }>(listPath);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const keys = data?.keys ?? data?.tokens ?? [];
  return (
    <div>
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await api<{ key: string }>(createPath, { body: { name: name || label } });
          setCreated(r.key);
          setName("");
          reload();
        }}
      >
        <input className="input" placeholder={`${label} name, e.g. "Backend"`} value={name} onChange={(e) => setName(e.target.value)} />
        <Button variant="primary" type="submit">
          <KeyRound className="h-4 w-4" /> Create
        </Button>
      </form>
      {created && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-500/10">
          <div className="mb-1.5 text-xs font-medium text-amber-800 dark:text-amber-300">Copy it now — it won't be shown again.</div>
          <div className="flex items-center gap-2">
            <code className="code flex-1 truncate">{created}</code>
            <CopyButton text={created} />
          </div>
        </div>
      )}
      <div className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
        {keys.map((k) => (
          <div key={String(k.id)} className="flex items-center gap-3 py-2 text-sm">
            <KeyRound className="h-4 w-4 text-zinc-400" />
            <span className="flex-1">
              {k.name} <code className="code ml-1">{k.prefix}…</code>
            </span>
            <span className="text-xs text-zinc-400">{k.last_used_at ? `used ${timeAgo(Number(k.last_used_at))}` : "never used"}</span>
            <button
              className="text-zinc-400 hover:text-red-500"
              onClick={async () => {
                if (!confirm(`Revoke "${k.name}"?`)) return;
                await api(deletePath(String(k.id)), { method: "DELETE" });
                reload();
              }}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ApiSettings({ site }: { site: Site }) {
  const origin = window.location.origin;
  return (
    <>
      <Section title="API keys" description="Website keys (or_…) can read this website's analytics and send payments, goals and identities.">
        <KeysList label="API key" listPath={`/api/sites/${site.id}/keys`} createPath={`/api/sites/${site.id}/keys`} deletePath={(id) => `/api/sites/${site.id}/keys/${id}`} />
      </Section>
      <Section title="REST API" description={<>OpenAPI spec: <a className="text-brand-600 hover:underline" href="/api/v1/openapi.json" target="_blank">/api/v1/openapi.json</a></>}>
        <CodeBlock code={`curl "${origin}/api/v1/analytics/overview?period=30d" \\\n  -H "Authorization: Bearer YOUR_API_KEY"\n\ncurl "${origin}/api/v1/analytics/breakdowns/source?period=30d&sort=revenue" \\\n  -H "Authorization: Bearer YOUR_API_KEY"`} />
      </Section>
      <Section title="MCP server (AI agents)" description="Ask Claude, Cursor or any MCP client about your traffic and revenue.">
        <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">Claude Code:</p>
        <CodeBlock code={`claude mcp add --transport http openrev ${origin}/mcp --header "Authorization: Bearer YOUR_API_KEY"`} />
        <p className="mt-4 mb-2 text-sm text-zinc-600 dark:text-zinc-400">Cursor / other clients (mcp.json):</p>
        <CodeBlock code={JSON.stringify({ mcpServers: { openrev: { url: `${origin}/mcp`, headers: { Authorization: "Bearer YOUR_API_KEY" } } } }, null, 2)} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------

const ALERT_TYPE_LABELS: Record<string, string> = {
  payment: "New sale / refund",
  goal: "Goal completed",
  traffic_spike: "Traffic spike",
  digest: "Daily / weekly digest",
};
const CHANNEL_LABELS: Record<string, string> = { slack: "Slack", discord: "Discord", telegram: "Telegram", email: "Email", webhook: "Webhook" };

function AlertSettings({ site }: { site: Site }) {
  const { data, reload } = useApi<{ alerts: Row[]; history: Row[]; emailEnabled: boolean }>(`/api/sites/${site.id}/alerts`);
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; message?: string } | null>(null);
  return (
    <>
      <Section
        title="Alerts"
        description="Get notified about sales (with source, country and journey), goals, traffic spikes and daily digests."
        actions={
          <Button variant="primary" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> New alert
          </Button>
        }
      >
        {!data?.alerts.length ? (
          <Empty title="No alerts yet" icon={<Bell className="h-6 w-6" />}>
            Get a ping on Slack, Discord, Telegram or email every time you make a sale.
          </Empty>
        ) : (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {data.alerts.map((a) => (
              <div key={String(a.id)} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {ALERT_TYPE_LABELS[a.type]} {a.type === "goal" && <code className="code">{a.config.goal}</code>} → {CHANNEL_LABELS[a.channel]}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {a.enabled ? "Active" : "Paused"} · {a.last_triggered_at ? `last sent ${timeAgo(Number(a.last_triggered_at))}` : "never sent"}
                  </div>
                  {testResult && testResult.id === a.id && (
                    <div className={cx("mt-1 flex items-center gap-1 text-xs", testResult.ok ? "text-money-600" : "text-red-600")}>
                      {testResult.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />} {testResult.ok ? "Test sent" : testResult.message}
                    </div>
                  )}
                </div>
                <Button
                  size="sm"
                  loading={testing === a.id}
                  onClick={async () => {
                    setTesting(String(a.id));
                    try {
                      await api(`/api/sites/${site.id}/alerts/${a.id}/test`, { body: {} });
                      setTestResult({ id: String(a.id), ok: true });
                    } catch (err) {
                      setTestResult({ id: String(a.id), ok: false, message: (err as Error).message });
                    } finally {
                      setTesting(null);
                      reload();
                    }
                  }}
                >
                  Send test
                </Button>
                <Button size="sm" onClick={() => setEditing(a)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api(`/api/sites/${site.id}/alerts/${a.id}`, { method: "PATCH", body: { enabled: !a.enabled } });
                    reload();
                  }}
                >
                  {a.enabled ? "Pause" : "Resume"}
                </Button>
                <button
                  className="text-zinc-400 hover:text-red-500"
                  onClick={async () => {
                    if (!confirm("Delete this alert?")) return;
                    await api(`/api/sites/${site.id}/alerts/${a.id}`, { method: "DELETE" });
                    reload();
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>
      {!!data?.history.length && (
        <Section title="Recent deliveries">
          <div className="space-y-1 text-sm">
            {data.history.map((h) => (
              <div key={String(h.id)} className="flex items-center gap-2">
                {h.status === "sent" ? <CheckCircle2 className="h-4 w-4 text-money-500" /> : <XCircle className="h-4 w-4 text-red-500" />}
                <span className="flex-1 truncate">{h.message}</span>
                <span className="text-xs text-zinc-400">{timeAgo(Number(h.ts))}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
      {editing && <AlertEditor site={site} alert={editing === "new" ? null : editing} emailEnabled={!!data?.emailEnabled} onClose={() => setEditing(null)} onSaved={reload} />}
    </>
  );
}

function AlertEditor({ site, alert, emailEnabled, onClose, onSaved }: { site: Site; alert: Row | null; emailEnabled: boolean; onClose: () => void; onSaved: () => void }) {
  const { meta } = useSite();
  const [type, setType] = useState<string>(alert?.type ?? "payment");
  const [channel, setChannel] = useState<string>(alert?.channel ?? "slack");
  const [config, setConfig] = useState<Record<string, unknown>>(alert?.config ?? { includeRefunds: true, frequency: "daily", hour: 8, multiplier: 4, minVisitors: 20 });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setConfig({ ...config, [k]: v });
  useEffect(() => setError(null), [type, channel]);

  const channelFields: Record<string, ReactNode> = {
    slack: (
      <Field label="Slack incoming webhook URL" help="Slack → Apps → Incoming Webhooks → Add to channel.">
        <input className="input font-mono text-xs" value={String(config.url ?? "")} onChange={(e) => set("url", e.target.value)} placeholder="https://hooks.slack.com/services/..." />
      </Field>
    ),
    discord: (
      <Field label="Discord webhook URL" help="Channel settings → Integrations → Webhooks → New webhook → Copy URL.">
        <input className="input font-mono text-xs" value={String(config.url ?? "")} onChange={(e) => set("url", e.target.value)} placeholder="https://discord.com/api/webhooks/..." />
      </Field>
    ),
    telegram: (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Bot token" help="Create a bot with @BotFather.">
          <input className="input font-mono text-xs" value={String(config.botToken ?? "")} onChange={(e) => set("botToken", e.target.value)} placeholder="123456:ABC..." />
        </Field>
        <Field label="Chat id" help="Message your bot, then open api.telegram.org/bot<token>/getUpdates to find it.">
          <input className="input font-mono text-xs" value={String(config.chatId ?? "")} onChange={(e) => set("chatId", e.target.value)} placeholder="123456789" />
        </Field>
      </div>
    ),
    email: (
      <Field label="Recipients" help={emailEnabled ? "Comma-separated." : "⚠️ Email isn't configured on this instance (set RESEND_API_KEY)."}>
        <input className="input" value={String(config.email ?? "")} onChange={(e) => set("email", e.target.value)} placeholder="you@example.com" />
      </Field>
    ),
    webhook: (
      <Field label="Webhook URL" help="We'll POST a JSON payload with the event and its data.">
        <input className="input font-mono text-xs" value={String(config.url ?? "")} onChange={(e) => set("url", e.target.value)} placeholder="https://example.com/hooks/openrev" />
      </Field>
    ),
  };

  return (
    <Modal open onClose={onClose} title={alert ? "Edit alert" : "New alert"}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="When">
            <select className="input" value={type} onChange={(e) => setType(e.target.value)} disabled={!!alert}>
              {Object.entries(ALERT_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Send to">
            <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
              {Object.entries(CHANNEL_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {type === "payment" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`Minimum amount (${site.currency})`}>
              <input className="input" type="number" min={0} value={Number(config.minAmount ?? 0)} onChange={(e) => set("minAmount", Number(e.target.value))} />
            </Field>
            <div className="pt-6">
              <Toggle checked={config.includeRefunds !== false} onChange={(v) => set("includeRefunds", v)} label="Include refunds" />
            </div>
          </div>
        )}
        {type === "goal" && (
          <Field label="Goal">
            <input className="input" list="alert-goals" value={String(config.goal ?? "")} onChange={(e) => set("goal", e.target.value)} placeholder="signup" />
            <datalist id="alert-goals">
              {meta?.goals.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
        )}
        {type === "traffic_spike" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Multiplier" help="Alert when a source sends this many times its usual hourly traffic.">
              <input className="input" type="number" min={2} value={Number(config.multiplier ?? 4)} onChange={(e) => set("multiplier", Number(e.target.value))} />
            </Field>
            <Field label="Minimum visitors / hour">
              <input className="input" type="number" min={1} value={Number(config.minVisitors ?? 20)} onChange={(e) => set("minVisitors", Number(e.target.value))} />
            </Field>
          </div>
        )}
        {type === "digest" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Frequency">
              <select className="input" value={String(config.frequency ?? "daily")} onChange={(e) => set("frequency", e.target.value)}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly (Mondays)</option>
              </select>
            </Field>
            <Field label={`Hour (${site.timezone})`}>
              <select className="input" value={Number(config.hour ?? 8)} onChange={(e) => set("hour", Number(e.target.value))}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
        {channelFields[channel]}
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                if (alert) await api(`/api/sites/${site.id}/alerts/${alert.id}`, { method: "PATCH", body: { type, channel, config } });
                else await api(`/api/sites/${site.id}/alerts`, { body: { type, channel, config } });
                onSaved();
                onClose();
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save alert
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function DataSettings({ site }: { site: Site }) {
  const { role } = useSite();
  const [, navigate] = useLocation();
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState(false);
  return (
    <>
      {(role === "owner" || role === "admin") && <ImportHistory />}
      <Section title="Export your data" description="Download raw data as CSV. It's your data — take it anywhere.">
        <div className="flex flex-wrap gap-2">
          {["sessions", "events", "payments", "visitors"].map((k) => (
            <a key={k} href={`/api/sites/${site.id}/export/${k}`} download>
              <Button>
                <Download className="h-4 w-4" /> {k}.csv
              </Button>
            </a>
          ))}
        </div>
      </Section>
      {role === "owner" && (
        <Card className="border-red-200 p-6 dark:border-red-900/60">
          <h3 className="text-base font-semibold text-red-600">Danger zone</h3>
          <p className="mt-1 text-sm text-zinc-500">
            Type <b>{site.domain}</b> to confirm.
          </p>
          <input className="input mt-3 max-w-sm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={site.domain} />
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={confirmText !== site.domain}
              loading={busy === "reset"}
              onClick={async () => {
                setBusy("reset");
                await api(`/api/sites/${site.id}/reset`, { body: {} });
                setBusy(null);
                setResetDone(true);
              }}
            >
              Reset all stats
            </Button>
            <Button
              variant="danger"
              disabled={confirmText !== site.domain}
              loading={busy === "delete"}
              onClick={async () => {
                setBusy("delete");
                await api(`/api/sites/${site.id}`, { method: "DELETE" });
                navigate("~/");
              }}
            >
              Delete website
            </Button>
          </div>
          {resetDone && <p className="mt-2 text-sm text-money-600">All analytics data was deleted.</p>}
        </Card>
      )}
    </>
  );
}
