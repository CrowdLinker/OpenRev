import { Search } from "lucide-react";
import { useState } from "react";
import { api, ApiError, useApi } from "../lib/api";
import { useSite } from "../lib/context";
import { money, num, pct } from "../lib/format";
import { toSearch, useDashQuery } from "../lib/query";
import { Button, Card, Empty, ErrorBox, Field, Section, Spinner } from "./ui";

const DOCS = "https://github.com/CrowdLinker/OpenRev/blob/main/docs/features/search-console.md";

interface Connection {
  property: string;
  oldest: string | null;
  newest: string | null;
  backfilled: boolean;
  last_error: string | null;
}

/** Settings → General: connect a website to Google Search Console with a service account key. */
export function SearchConsoleSettings() {
  const { site, reloadMeta } = useSite();
  const status = useApi<{ connection: Connection | null }>(site ? `/api/sites/${site.id}/search-console` : null);
  const [key, setKey] = useState("");
  const [properties, setProperties] = useState<string[]>([]);
  const [property, setProperty] = useState("");
  const [busy, setBusy] = useState<"connect" | "sync" | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!site) return null;
  const base = `/api/sites/${site.id}/search-console`;
  const conn = status.data?.connection;

  const connect = async () => {
    setBusy("connect");
    setError(null);
    try {
      await api(base, { body: { key, property: property || undefined } });
      setKey("");
      setProperties([]);
      reloadMeta();
      status.reload();
      await sync();
    } catch (err) {
      // When no property matches the website, the server lists the ones the key can read.
      setProperties(((err as ApiError).data as { properties?: string[] } | undefined)?.properties ?? []);
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  /** Syncs history in rounds while the page is open (the scheduler also does it, more slowly). */
  const sync = async () => {
    setBusy("sync");
    setError(null);
    try {
      for (let i = 0; i < 100; i++) {
        const res = await api<{ backfilled: boolean; days: number }>(`${base}/sync`, { body: {} });
        status.reload();
        if (res.backfilled || !res.days) break;
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
      status.reload();
    }
  };

  return (
    <Section
      title="Google Search Console"
      description={
        <>
          See the Google searches that bring visitors, and an estimate of the revenue each keyword earns.{" "}
          <a className="text-brand-600 hover:underline" href={DOCS} target="_blank" rel="noreferrer">
            Setup guide
          </a>
        </>
      }
    >
      {conn ? (
        <div className="space-y-3 text-sm">
          <div>
            Connected to <b>{conn.property}</b>.{" "}
            {conn.oldest && conn.newest ? (
              <span className="text-zinc-500">
                Data from {conn.oldest} to {conn.newest}
                {conn.backfilled ? "." : ", older days are still syncing."}
              </span>
            ) : (
              <span className="text-zinc-500">Nothing synced yet.</span>
            )}
          </div>
          {conn.last_error && <ErrorBox error={`Last sync failed: ${conn.last_error}`} />}
          <div className="flex flex-wrap gap-2">
            {!conn.backfilled && (
              <Button loading={busy === "sync"} disabled={!!busy} onClick={sync}>
                Sync history now
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={!!busy}
              onClick={async () => {
                if (!confirm("Disconnect Search Console and delete its synced data?")) return;
                await api(base, { method: "DELETE" }).catch(setError);
                status.reload();
                reloadMeta();
              }}
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-zinc-600 dark:text-zinc-400">
            Create a Google Cloud <b>service account</b>, enable the Search Console API, download a JSON key, then add the service account's email as a user in Search
            Console (Settings → Users and permissions, Restricted is enough). The same service account can import Google Analytics.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Service account key (JSON)">
              <input
                type="file"
                accept=".json,application/json"
                className="input py-1.5"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setKey(await f.text());
                }}
              />
            </Field>
            {properties.length > 0 && (
              <Field label="Property">
                <select className="input" value={property} onChange={(e) => setProperty(e.target.value)}>
                  <option value="">Choose…</option>
                  {properties.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <Button variant="primary" loading={busy === "connect"} disabled={!key || (properties.length > 0 && !property)} onClick={connect}>
            Connect
          </Button>
        </div>
      )}
      <div className="mt-3">
        <ErrorBox error={error} />
      </div>
    </Section>
  );
}

interface KeywordRow {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  revenue: number;
  page: string;
}

/** Dashboard card: the top search keywords with their estimated revenue. */
export function SearchKeywords({ showRevenue }: { showRevenue: boolean }) {
  const { statsBase, meta } = useSite();
  const [q] = useDashQuery();
  const [sort, setSort] = useState<"clicks" | "revenue">("clicks");
  const res = useApi<{ rows: KeywordRow[]; totals: { clicks: number; revenue: number }; currency: string }>(
    meta?.searchConsole ? `${statsBase}/search-keywords?${toSearch(q, { limit: "10", sort })}` : null,
  );
  if (!meta?.searchConsole) return null;
  const cur = res.data?.currency ?? meta.site.currency;

  return (
    <Card className="p-4 lg:col-span-2">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Search keywords</h3>
          <p className="text-xs text-zinc-500">
            From Google Search Console.{showRevenue ? " Revenue is estimated from the landing pages each keyword brought clicks to." : ""}
          </p>
        </div>
        {showRevenue && (
          <div className="flex gap-1 text-xs">
            {(["clicks", "revenue"] as const).map((s) => (
              <button key={s} className={`rounded-md px-2 py-1 font-medium ${sort === s ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "text-zinc-500"}`} onClick={() => setSort(s)}>
                By {s}
              </button>
            ))}
          </div>
        )}
      </div>
      {q.filters.length > 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">Search Console data can't be filtered: clear the filters to see keywords.</p>
      ) : res.loading && !res.data ? (
        <Spinner />
      ) : res.error ? (
        <ErrorBox error={res.error} />
      ) : !res.data?.rows.length ? (
        <Empty title="No search data for this period" icon={<Search className="h-6 w-6" />}>
          Search Console reports with a delay of about two days.
        </Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm [&_td+td]:pl-4 [&_th+th]:pl-4">
            <thead className="text-xs whitespace-nowrap text-zinc-500">
              <tr>
                <th className="pb-2 text-left font-medium">Keyword</th>
                <th className="pb-2 text-right font-medium">Clicks</th>
                <th className="hidden pb-2 text-right font-medium sm:table-cell">CTR</th>
                <th className="hidden pb-2 text-right font-medium sm:table-cell">Position</th>
                {showRevenue && (
                  <th className="pb-2 text-right font-medium">
                    Revenue<span className="hidden sm:inline"> (est.)</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {res.data.rows.map((r) => (
                <tr key={r.query} className="border-t border-zinc-100 dark:border-zinc-800" title={`Top landing page: ${r.page}`}>
                  <td className="max-w-0 py-2">
                    <div className="break-words sm:truncate">{r.query}</div>
                    <div className="truncate text-xs text-zinc-500">{r.page}</div>
                  </td>
                  <td className="py-2 text-right tabular">{num(r.clicks, false)}</td>
                  <td className="hidden py-2 text-right tabular text-zinc-500 sm:table-cell">{pct(r.ctr)}</td>
                  <td className="hidden py-2 text-right tabular text-zinc-500 sm:table-cell">{r.position.toFixed(1)}</td>
                  {showRevenue && (
                    <td className={`py-2 text-right font-medium tabular ${r.revenue ? "text-money-600 dark:text-money-400" : "text-zinc-400"}`}>{r.revenue ? money(r.revenue, cur) : "—"}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
