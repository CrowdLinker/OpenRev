import { FileArchive, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { api, useApi } from "../lib/api";
import { useSite } from "../lib/context";
import { parseCsv } from "../lib/csv";
import { num } from "../lib/format";
import { readZip } from "../lib/zip";
import { Badge, Button, ErrorBox, Field, Section } from "./ui";

interface ImportInfo {
  id: string;
  source: "plausible" | "ga4";
  status: "running" | "done" | "failed";
  date_from: string;
  date_to: string;
  imported_rows: number;
  error: string | null;
}

const DOCS = "https://github.com/CrowdLinker/OpenRev/blob/main/docs/guides/import-history.md";
const SOURCE_LABEL = { plausible: "Plausible", ga4: "Google Analytics" };

/** Plausible's export tables, in upload order (custom properties have no OpenRev equivalent). */
const TABLES = ["visitors", "sources", "pages", "entry_pages", "exit_pages", "custom_events", "locations", "devices", "browsers", "operating_systems"];
const TABLE_RE = new RegExp(`(?:^|/)imported_(${TABLES.join("|")})(?:_\\d{8}_\\d{8})?\\.csv$`);

type Tables = Record<string, Record<string, string>[]>;

/** Reads a Plausible export: the ZIP, or the CSV files from it. */
async function readPlausible(files: File[]): Promise<Tables> {
  const out: Tables = {};
  const add = (name: string, text: string) => {
    const table = TABLE_RE.exec(name)?.[1];
    if (table) out[table] = [...(out[table] ?? []), ...parseCsv(text)];
  };
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) for (const e of await readZip(f)) TABLE_RE.test(e.name) && add(e.name, await e.read());
    else add(f.name, await f.text());
  }
  if (!out.visitors?.length) throw new Error("No imported_visitors CSV found. Choose the ZIP from Plausible's Export data, or the CSV files inside it.");
  return out;
}

const dayBefore = (date: string) => new Date(Date.parse(date) - 86_400_000).toISOString().slice(0, 10);

/** Rows per chunk for the tables whose rows add to several reports (the server's maxChunkRows: a source row adds up to
 * eight cells, a location row three). Other tables use the default. */
const CHUNK_ROWS: Partial<Record<string, number>> = { sources: 750, locations: 2000 };

/** Splits rows into chunks under the server's size limits. */
function chunks(rows: Record<string, string>[], maxRows = 2000, maxBytes = 700_000) {
  const out: Record<string, string>[][] = [];
  let cur: Record<string, string>[] = [];
  let bytes = 0;
  for (const r of rows) {
    const size = JSON.stringify(r).length + 1;
    if (cur.length && (cur.length >= maxRows || bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(r);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function ImportHistory() {
  const { site, reloadMeta } = useSite();
  const list = useApi<{ imports: ImportInfo[]; first_native_date: string | null }>(site ? `/api/sites/${site.id}/imports` : null);
  const [tab, setTab] = useState<"plausible" | "ga4">("plausible");
  const [progress, setProgress] = useState<{ label: string; value: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!site) return null;
  const base = `/api/sites/${site.id}/imports`;
  const native = list.data?.first_native_date ?? null;
  const done = () => {
    setProgress(null);
    list.reload();
    reloadMeta();
  };

  return (
    <Section
      title="Import history"
      description={
        <>
          Bring your traffic history from Plausible or Google Analytics 4. Imported days are added to the dashboard's totals, chart and top lists, but not to
          filtered views, funnels or journeys.{" "}
          <a className="text-brand-600 hover:underline" href={DOCS} target="_blank" rel="noreferrer">
            How imports work
          </a>
        </>
      }
    >
      <div className="mb-4 flex gap-1 rounded-lg bg-zinc-100 p-1 text-sm dark:bg-zinc-800/60">
        {(["plausible", "ga4"] as const).map((t) => (
          <button
            key={t}
            className={`flex-1 rounded-md px-3 py-1.5 font-medium ${tab === t ? "bg-white shadow-sm dark:bg-zinc-900" : "text-zinc-500"}`}
            onClick={() => setTab(t)}
            disabled={!!progress}
          >
            {SOURCE_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === "plausible" ? (
        <PlausibleImport base={base} native={native} busy={!!progress} setProgress={setProgress} setError={setError} onDone={done} />
      ) : (
        <Ga4Import base={base} native={native} busy={!!progress} setProgress={setProgress} setError={setError} onDone={done} />
      )}

      {progress && (
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-xs text-zinc-500">
            <span>{progress.label}</span>
            <span>{Math.round(progress.value * 100)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div className="h-full bg-brand-500 transition-all" style={{ width: `${Math.max(2, progress.value * 100)}%` }} />
          </div>
        </div>
      )}
      <div className="mt-3">
        <ErrorBox error={error} />
      </div>

      {!!list.data?.imports.length && (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="text-left text-xs text-zinc-500">
              <tr>
                <th className="pb-2 font-medium">Source</th>
                <th className="pb-2 font-medium">Dates</th>
                <th className="pb-2 text-right font-medium">Rows</th>
                <th className="pb-2 pl-4 font-medium">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.imports.map((imp) => (
                <tr key={imp.id} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                  <td className="py-2">{SOURCE_LABEL[imp.source]}</td>
                  <td className="py-2 whitespace-nowrap tabular">
                    {imp.date_from} → {imp.date_to}
                  </td>
                  <td className="py-2 text-right tabular">{num(imp.imported_rows, false)}</td>
                  <td className="py-2 pl-4">
                    {imp.status === "done" ? <Badge color="green">Imported</Badge> : imp.status === "failed" ? <Badge color="red">Failed</Badge> : <Badge color="amber">Incomplete</Badge>}
                    {imp.error && <div className="mt-1 max-w-xs text-xs text-red-600">{imp.error}</div>}
                    {imp.status === "running" && !progress && (
                      <div className="mt-1 max-w-xs text-xs text-zinc-500">
                        {imp.source === "ga4" ? (
                          <button className="text-brand-600 hover:underline" onClick={() => runGa4(base, imp.id, setProgress, setError).then(done, done)}>
                            Continue the import
                          </button>
                        ) : (
                          "The upload stopped. Delete this import and upload the export again."
                        )}
                      </div>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      size="sm"
                      disabled={!!progress}
                      onClick={async () => {
                        if (!confirm(`Delete the ${SOURCE_LABEL[imp.source]} import from ${imp.date_from} to ${imp.date_to}?`)) return;
                        await api(`${base}/${imp.id}`, { method: "DELETE" }).catch(setError);
                        done();
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

interface FormProps {
  base: string;
  native: string | null;
  busy: boolean;
  setProgress: (p: { label: string; value: number } | null) => void;
  setError: (e: unknown) => void;
  onDone: () => void;
}

function PlausibleImport({ base, native, busy, setProgress, setError, onDone }: FormProps) {
  const input = useRef<HTMLInputElement>(null);
  const [tables, setTables] = useState<Tables | null>(null);
  const [reading, setReading] = useState(false);
  const dates = tables ? tables.visitors.map((r) => r.date).filter(Boolean).sort() : [];
  const from = dates[0];
  const last = dates[dates.length - 1];
  const to = native && last >= native ? dayBefore(native) : last;
  const rows = tables ? Object.values(tables).reduce((n, t) => n + t.length, 0) : 0;

  const start = async () => {
    if (!tables) return;
    setError(null);
    let id: string | null = null;
    try {
      id = (await api<{ import: { id: string } }>(base, { body: { source: "plausible", date_from: from, date_to: to } })).import.id;
      const work = TABLES.filter((t) => tables[t]?.length).flatMap((table) => chunks(tables[table], CHUNK_ROWS[table]).map((part) => ({ table, part })));
      for (let seq = 0; seq < work.length; seq++) {
        const { table, part } = work[seq];
        setProgress({ label: `Uploading ${table.replace(/_/g, " ")}…`, value: seq / work.length });
        await api(`${base}/${id}/rows`, { body: { seq, table, rows: part } });
      }
      await api(`${base}/${id}/finish`, { body: {} });
      setTables(null);
      if (input.current) input.current.value = "";
    } catch (err) {
      setError(err);
    } finally {
      onDone();
    }
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-600 dark:text-zinc-400">
        In Plausible, open <b>Site settings → Imports &amp; exports → Export data</b> and download the ZIP. Then choose it here (or the CSV files inside it). It's read in your
        browser; only the daily totals are sent to OpenRev.
      </p>
      <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-zinc-300 px-4 py-3 hover:border-brand-400 dark:border-zinc-700">
        <FileArchive className="h-5 w-5 text-zinc-400" />
        <span className="text-zinc-600 dark:text-zinc-400">{reading ? "Reading…" : tables ? "Choose another export" : "Choose the Plausible export (.zip or .csv files)"}</span>
        <input
          ref={input}
          type="file"
          accept=".zip,.csv"
          multiple
          className="sr-only"
          disabled={busy}
          onChange={async (e) => {
            const files = [...(e.target.files ?? [])];
            if (!files.length) return;
            setError(null);
            setReading(true);
            try {
              setTables(await readPlausible(files));
            } catch (err) {
              setTables(null);
              setError(err);
            } finally {
              setReading(false);
            }
          }}
        />
      </label>
      {tables && from && (
        <div className="rounded-lg bg-zinc-50 px-4 py-3 dark:bg-zinc-800/50">
          <div>
            {num(rows, false)} rows in {Object.keys(tables).length} tables, from <b>{from}</b> to <b>{last}</b>.
          </div>
          {to !== last && (
            <div className="mt-1 text-zinc-500">
              OpenRev has its own data from {native}, so the import stops on {to}.
            </div>
          )}
          <Button className="mt-3" variant="primary" loading={busy} disabled={!to || to < from} onClick={start}>
            <Upload className="h-4 w-4" /> Import {from} to {to}
          </Button>
          {(!to || to < from) && <div className="mt-2 text-zinc-500">OpenRev already has data for every day in this export.</div>}
        </div>
      )}
    </div>
  );
}

async function runGa4(base: string, id: string, setProgress: FormProps["setProgress"], setError: FormProps["setError"]) {
  setProgress({ label: "Reading Google Analytics…", value: 0 });
  for (let attempt = 0; ; ) {
    try {
      const step = await api<{ done: boolean; report: string | null; progress: number }>(`${base}/${id}/step`, { body: {} });
      if (step.done) return;
      setProgress({ label: `Importing ${step.report?.toLowerCase()}…`, value: step.progress });
      attempt = 0;
    } catch (err) {
      // Google's per-hour quotas: wait and retry a few times before giving up.
      if ((err as { status?: number }).status === 429 && attempt++ < 5) {
        setProgress({ label: "Google Analytics is busy, retrying…", value: 0 });
        await new Promise((r) => setTimeout(r, 15_000 * attempt));
        continue;
      }
      setError(err);
      return;
    }
  }
}

function Ga4Import({ base, native, busy, setProgress, setError, onDone }: FormProps) {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const [propertyId, setPropertyId] = useState("");
  const [key, setKey] = useState("");
  const [from, setFrom] = useState(`${new Date().getUTCFullYear() - 2}-01-01`);
  const [to, setTo] = useState(native ? dayBefore(native) : yesterday);

  const start = async () => {
    setError(null);
    setProgress({ label: "Checking access…", value: 0 });
    try {
      const { import: imp } = await api<{ import: { id: string } }>(base, { body: { source: "ga4", property_id: propertyId, key, date_from: from, date_to: to } });
      setKey("");
      await runGa4(base, imp.id, setProgress, setError);
    } catch (err) {
      setError(err);
    } finally {
      onDone();
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-zinc-600 dark:text-zinc-400">
        OpenRev reads your GA4 reports with a Google Cloud <b>service account</b>: create one, enable the Google Analytics Data API, download a JSON key, and add the
        service account's email as a <b>Viewer</b> in GA4 (Admin → Property access management).{" "}
        <a className="text-brand-600 hover:underline" href={`${DOCS}#google-analytics-4`} target="_blank" rel="noreferrer">
          Step-by-step guide
        </a>
        . The key is only kept while the import runs.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Property ID" help="Admin → Property settings → Property details">
          <input className="input" inputMode="numeric" placeholder="123456789" value={propertyId} onChange={(e) => setPropertyId(e.target.value)} />
        </Field>
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
        <Field label="From">
          <input type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" help={native ? `OpenRev has its own data from ${native}` : undefined}>
          <input type="date" className="input" value={to} min={from} max={native ? dayBefore(native) : yesterday} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <Button variant="primary" loading={busy} disabled={!propertyId || !key || !from || !to} onClick={start}>
        <Upload className="h-4 w-4" /> Check access and import
      </Button>
    </div>
  );
}
