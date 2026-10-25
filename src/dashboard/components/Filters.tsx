import { Calendar, ChevronDown, Filter as FilterIcon, Pin, X } from "lucide-react";
import { useState } from "react";
import { useLocalStorage } from "../lib/api";
import { DIM_LABELS, displayValue, OP_LABELS } from "../lib/dims";
import { countryName } from "../lib/format";
import { PERIODS, useDashQuery, type DashQuery } from "../lib/query";
import type { Filter, RangeInfo } from "../lib/types";
import { Button, cx, Dropdown, Field, MenuItem, Modal } from "./ui";

function periodLabel(q: DashQuery, range?: RangeInfo) {
  if (q.period === "custom" && q.from && q.to) return q.from === q.to ? q.from : `${q.from} → ${q.to}`;
  return PERIODS.find((p) => p.value === q.period)?.label ?? (range ? `${range.fromDate} → ${range.toDate}` : "Last 30 days");
}

export function PeriodPicker({ range, storageKey }: { range?: RangeInfo; storageKey: string }) {
  const [q, setQ] = useDashQuery();
  const [pinned, setPinned] = useLocalStorage<string[]>(`openrev_pins_${storageKey}`, []);
  const [custom, setCustom] = useState({ from: q.from ?? range?.fromDate ?? "", to: q.to ?? range?.toDate ?? "" });

  const togglePin = (value: string) => setPinned(pinned.includes(value) ? pinned.filter((p) => p !== value) : [...pinned, value]);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {pinned
        .map((v) => PERIODS.find((p) => p.value === v))
        .filter(Boolean)
        .map((p) => (
          <button
            key={p!.value}
            onClick={() => setQ({ period: p!.value })}
            className={cx(
              "rounded-lg px-2.5 py-1.5 text-xs font-medium transition",
              q.period === p!.value ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800",
            )}
          >
            {p!.short}
          </button>
        ))}
      <Dropdown
        align="right"
        button={() => (
          <button className="flex items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800">
            <Calendar className="h-4 w-4 text-zinc-400" />
            {periodLabel(q, range)}
            <ChevronDown className="h-4 w-4 text-zinc-400" />
          </button>
        )}
        className="w-64"
      >
        {(close) => (
          <>
            {PERIODS.map((p) => (
              <div key={p.value} className="group flex items-center">
                <MenuItem
                  active={q.period === p.value}
                  onClick={() => {
                    setQ({ period: p.value });
                    close();
                  }}
                >
                  {p.label}
                </MenuItem>
                <button
                  title={pinned.includes(p.value) ? "Unpin" : "Pin as a quick button"}
                  onClick={() => togglePin(p.value)}
                  className={cx("rounded p-1.5 transition hover:bg-zinc-100 dark:hover:bg-zinc-800", pinned.includes(p.value) ? "text-brand-600" : "text-zinc-300 opacity-0 group-hover:opacity-100")}
                >
                  <Pin className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <div className="mt-1 border-t border-zinc-100 p-2 dark:border-zinc-800">
              <div className="mb-1.5 text-xs font-medium text-zinc-500">Custom range</div>
              <div className="flex gap-1.5">
                <input type="date" className="input !px-2 !py-1 text-xs" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
                <input type="date" className="input !px-2 !py-1 text-xs" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
              </div>
              <Button
                size="sm"
                variant="primary"
                className="mt-2 w-full"
                disabled={!custom.from || !custom.to}
                onClick={() => {
                  const [from, to] = custom.from <= custom.to ? [custom.from, custom.to] : [custom.to, custom.from];
                  setQ({ period: "custom", from, to });
                  close();
                }}
              >
                Apply
              </Button>
            </div>
          </>
        )}
      </Dropdown>
    </div>
  );
}

export function filterValueLabel(f: Filter) {
  return f.values.map((v) => (f.dim === "country" ? countryName(v) : displayValue(f.dim, v))).join(" or ");
}

export function FilterBar() {
  const [q, setQ] = useDashQuery();
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {q.filters.map((f, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded-lg bg-brand-50 py-1 pr-1 pl-2.5 text-xs text-brand-800 dark:bg-brand-500/15 dark:text-brand-200">
          <span className="text-brand-500">{DIM_LABELS[f.dim] ?? f.dim}</span>
          <span className="opacity-70">{OP_LABELS[f.op]}</span>
          <b className="max-w-[200px] truncate font-medium">{filterValueLabel(f)}</b>
          <button className="rounded p-0.5 hover:bg-brand-100 dark:hover:bg-brand-500/20" onClick={() => setQ({ filters: q.filters.filter((_, j) => j !== i) })} aria-label="Remove filter">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
        <FilterIcon className="h-3.5 w-3.5" /> Filter
      </button>
      {q.filters.length > 1 && (
        <button onClick={() => setQ({ filters: [] })} className="text-xs text-zinc-400 hover:text-zinc-700 hover:underline">
          Clear all
        </button>
      )}
      <AddFilterModal open={adding} onClose={() => setAdding(false)} onAdd={(f) => setQ({ filters: [...q.filters.filter((x) => x.dim !== f.dim), f] })} />
    </div>
  );
}

function AddFilterModal({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (f: Filter) => void }) {
  const [dim, setDim] = useState("source");
  const [op, setOp] = useState<Filter["op"]>("is");
  const [value, setValue] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="Add filter">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          onAdd({ dim, op, values: value.split("|").map((v) => v.trim()) });
          setValue("");
          onClose();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Dimension">
            <select className="input" value={dim} onChange={(e) => setDim(e.target.value)}>
              {Object.entries(DIM_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Operator">
            <select className="input" value={op} onChange={(e) => setOp(e.target.value as Filter["op"])}>
              {Object.entries(OP_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Value" help={dim === "country" ? "Two-letter country code, e.g. US. Separate several values with |" : "Separate several values with |"}>
          <input className="input" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Apply filter
          </Button>
        </div>
      </form>
    </Modal>
  );
}
