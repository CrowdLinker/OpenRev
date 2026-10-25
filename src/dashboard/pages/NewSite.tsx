import { ArrowRight, Check } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { InstallGuide, VerifyInstall } from "../components/InstallGuide";
import { Button, Card, ErrorBox, Field } from "../components/ui";
import { api } from "../lib/api";
import type { Site } from "../lib/types";

export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "JPY", "CNY", "HKD", "SGD", "INR", "IDR", "BRL", "MXN", "ARS", "ZAR", "NGN", "KES", "AED", "SAR", "TRY", "ILS", "KRW", "THB", "MYR", "PHP", "VND", "UAH"];

export function timezones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

export function NewSitePage() {
  const [, navigate] = useLocation();
  const tzList = useMemo(timezones, []);
  const [domain, setDomain] = useState("");
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [currency, setCurrency] = useState("USD");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [site, setSite] = useState<Site | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ site: Site }>("/api/sites", { body: { domain, name: name || undefined, timezone, currency } });
      setSite(r.site);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Add a website</h1>
      <p className="mb-6 text-sm text-zinc-500">Takes about a minute. You can change everything later in settings.</p>

      <Card className="p-6">
        <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
          <StepBadge n={1} done={!!site} /> Website details
        </div>
        {site ? (
          <div className="text-sm text-zinc-600 dark:text-zinc-400">
            <b className="text-zinc-900 dark:text-zinc-100">{site.domain}</b> · {site.timezone} · {site.currency}
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
            <Field label="Domain" help="Your root domain without https://. Subdomains are included automatically.">
              <input className="input" placeholder="example.com" required value={domain} onChange={(e) => setDomain(e.target.value)} autoFocus />
            </Field>
            <Field label="Name (optional)">
              <input className="input" placeholder="My SaaS" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Timezone" help="Used for daily reports and charts.">
              <select className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {tzList.map((tz) => (
                  <option key={tz}>{tz}</option>
                ))}
              </select>
            </Field>
            <Field label="Currency" help="Revenue in other currencies is converted automatically.">
              <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <div className="sm:col-span-2">
              <ErrorBox error={error} />
              <Button variant="primary" type="submit" loading={busy} className="mt-2">
                Add website <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </form>
        )}
      </Card>

      {site && (
        <>
          <Card className="mt-4 p-6">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
              <StepBadge n={2} /> Install the tracking script
            </div>
            <InstallGuide site={site} />
            <div className="mt-5">
              <VerifyInstall siteId={site.id} />
            </div>
          </Card>
          <Card className="mt-4 p-6">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <StepBadge n={3} /> Connect revenue (optional)
            </div>
            <p className="mb-4 text-sm text-zinc-500">
              Connect Stripe, Lemon Squeezy, Polar, Paddle, Shopify and more — or send payments with the API — to see which channels make you money.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="money" onClick={() => navigate(`/sites/${site.id}/settings/revenue`)}>
                Connect a payment provider
              </Button>
              <Button onClick={() => navigate(`/sites/${site.id}`)}>Go to dashboard</Button>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function StepBadge({ n, done }: { n: number; done?: boolean }) {
  return (
    <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${done ? "bg-money-500 text-white" : "bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300"}`}>
      {done ? <Check className="h-3.5 w-3.5" /> : n}
    </span>
  );
}
