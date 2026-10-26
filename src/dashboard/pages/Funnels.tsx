import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { FilterBar, PeriodPicker } from "../components/Filters";
import { Button, Card, Empty, ErrorBox, Field, Modal, Spinner } from "../components/ui";
import { api, useApi } from "../lib/api";
import { canEdit, useSite } from "../lib/context";
import { toSearch, useDashQuery } from "../lib/query";
import type { Funnel, FunnelResult, FunnelStep } from "../lib/types";
import { FunnelBars, PaymentStepsHidden } from "./Dashboard";

function FunnelCard({ funnel, onEdit, onDelete }: { funnel: Funnel; onEdit?: () => void; onDelete?: () => void }) {
  const { statsBase, meta, canSeeRevenue } = useSite();
  const [q] = useDashQuery();
  const { data, loading, error } = useApi<{ results: FunnelResult[] }>(`${statsBase}/funnels/${funnel.id}?${toSearch(q)}`);
  const overall = data?.results.length ? data.results[data.results.length - 1].conversion_rate : 0;
  // Without revenue the results stop before the first payment step, so the last one isn't the funnel's conversion.
  const truncated = !canSeeRevenue && funnel.steps.some((s) => s.type === "payment");
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{funnel.name}</h3>
          <p className="text-xs text-zinc-500">
            {funnel.steps.length} steps{truncated ? "" : ` · ${(overall * 100).toFixed(1)}% overall conversion`}
          </p>
        </div>
        <div className="flex gap-1">
          {loading && <Spinner className="h-4 w-4" />}
          {onEdit && (
            <Button size="sm" variant="ghost" onClick={onEdit}>
              Edit
            </Button>
          )}
          {onDelete && (
            <Button size="sm" variant="ghost" onClick={onDelete} aria-label="Delete funnel">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
      <ErrorBox error={error} />
      {data && <FunnelBars results={data.results} currency={meta?.site.currency ?? "USD"} showRevenue={canSeeRevenue} />}
      {data && <PaymentStepsHidden steps={funnel.steps} />}
    </Card>
  );
}

function FunnelEditor({ funnel, onClose, onSaved }: { funnel: Funnel | null; onClose: () => void; onSaved: () => void }) {
  const { site, statsBase, meta, canSeeRevenue } = useSite();
  const [q] = useDashQuery();
  const [name, setName] = useState(funnel?.name ?? "");
  const [steps, setSteps] = useState<FunnelStep[]>(funnel?.steps ?? [{ type: "page", value: "/", match: "equals" }, { type: "payment" }]);
  const [preview, setPreview] = useState<FunnelResult[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      const valid = steps.every((s) => s.type === "payment" || (s.value ?? "").trim());
      if (!valid) return;
      api<{ results: FunnelResult[] }>(`${statsBase}/funnels/preview?${toSearch(q)}`, { body: { steps } })
        .then((r) => setPreview(r.results))
        .catch(() => setPreview(null));
    }, 400);
    return () => clearTimeout(t);
  }, [steps, statsBase, q]);

  const update = (i: number, patch: Partial<FunnelStep>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (funnel) await api(`/api/sites/${site!.id}/funnels/${funnel.id}`, { method: "PATCH", body: { name, steps } });
      else await api(`/api/sites/${site!.id}/funnels`, { body: { name, steps } });
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={funnel ? "Edit funnel" : "New funnel"} wide>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="space-y-4">
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Landing → Pricing → Purchase" />
          </Field>
          <div className="space-y-2">
            <div className="label">Steps</div>
            {steps.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-5 text-xs text-zinc-400">{i + 1}.</span>
                <select className="input !w-28" value={s.type} onChange={(e) => update(i, { type: e.target.value as FunnelStep["type"] })}>
                  <option value="page">Page</option>
                  <option value="goal">Goal</option>
                  <option value="payment">Payment</option>
                </select>
                {s.type === "page" && (
                  <select className="input !w-32" value={s.match ?? "equals"} onChange={(e) => update(i, { match: e.target.value as FunnelStep["match"] })}>
                    <option value="equals">equals</option>
                    <option value="starts_with">starts with</option>
                    <option value="contains">contains</option>
                  </select>
                )}
                {s.type === "page" && <input className="input" value={s.value ?? ""} placeholder="/pricing" onChange={(e) => update(i, { value: e.target.value })} />}
                {s.type === "goal" && (
                  <>
                    <input className="input" list="goal-names" value={s.value ?? ""} placeholder="signup" onChange={(e) => update(i, { value: e.target.value })} />
                  </>
                )}
                {s.type === "payment" && <span className="flex-1 text-sm text-zinc-500">Visitor paid</span>}
                <button className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-500 dark:hover:bg-zinc-800" onClick={() => setSteps(steps.filter((_, j) => j !== i))} disabled={steps.length <= 1}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <datalist id="goal-names">
              {meta?.goals.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            {steps.length < 10 && (
              <Button size="sm" variant="ghost" onClick={() => setSteps([...steps, { type: "page", value: "", match: "equals" }])}>
                <Plus className="h-3.5 w-3.5" /> Add step
              </Button>
            )}
          </div>
          <ErrorBox error={error} />
        </div>
        <div>
          <div className="label">Preview</div>
          <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
            {preview ? (
              <>
                <FunnelBars results={preview} currency={meta?.site.currency ?? "USD"} showRevenue={canSeeRevenue} />
                <PaymentStepsHidden steps={steps} />
              </>
            ) : (
              <p className="text-sm text-zinc-500">Fill in the steps to preview conversions.</p>
            )}
          </div>
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={save} disabled={!name.trim()}>
          Save funnel
        </Button>
      </div>
    </Modal>
  );
}

export function FunnelsPage() {
  const { meta, role, isPublic, site, reloadMeta } = useSite();
  const [editing, setEditing] = useState<Funnel | null | "new">(null);
  const funnels = meta?.funnels ?? [];
  const editable = !isPublic && canEdit(role);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar />
        <div className="flex items-center gap-2">
          {editable && (
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" /> New funnel
            </Button>
          )}
          <PeriodPicker storageKey={meta?.site.id ?? "site"} />
        </div>
      </div>
      {funnels.length === 0 ? (
        <Card>
          <Empty title="No funnels yet">Funnels show how many visitors go from one step to the next — e.g. landing page → pricing → signup → payment.</Empty>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {funnels.map((f) => (
            <FunnelCard
              key={f.id}
              funnel={f}
              onEdit={editable ? () => setEditing(f) : undefined}
              onDelete={
                editable
                  ? async () => {
                      if (!confirm(`Delete funnel "${f.name}"?`)) return;
                      await api(`/api/sites/${site!.id}/funnels/${f.id}`, { method: "DELETE" });
                      reloadMeta();
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}
      {editing && <FunnelEditor funnel={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={reloadMeta} />}
    </div>
  );
}
