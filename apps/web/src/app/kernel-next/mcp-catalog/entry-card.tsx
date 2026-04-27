"use client";

import { useState } from "react";
import { equip, unequip, recheck } from "../../../lib/mcp-catalog-api";
import type { CatalogEntryClient, InventoryRowClient, InventorySecretReadoutClient } from "../../../lib/mcp-catalog-api";
import { useToast } from "../../../components/toast";

interface Props {
  entry: CatalogEntryClient;
  inventory: InventoryRowClient | null;
  readouts: InventorySecretReadoutClient[];
  onChanged: () => void;
}

const BADGE: Record<string, string> = {
  "equipped":        "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  "pending-secret":  "border-amber-500/40 bg-amber-500/10 text-amber-300",
  "unhealthy":       "border-red-500/40 bg-red-500/10 text-red-300",
  "not-equipped":    "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
};

export const EntryCard = ({ entry, inventory, readouts, onChanged }: Props) => {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const status = inventory?.status ?? "not-equipped";
  const requiredKeys = entry.envKeys.filter((k) => k.required);

  const onEquip = async () => {
    setSubmitting(true);
    const r = await equip(entry.id, values);
    setSubmitting(false);
    if (!r.ok) {
      toast.error(r.diagnostics[0]?.message ?? "equip failed");
      return;
    }
    toast.success(`${entry.name}: ${r.data.status}`);
    setOpen(false);
    setValues({});
    onChanged();
  };

  const onUnequip = async () => {
    const r = await unequip(entry.id);
    if (!r.ok) toast.error(r.diagnostics[0]?.message ?? "unequip failed");
    else { toast.success(`${entry.name}: unequipped`); onChanged(); }
  };

  const onRecheck = async () => {
    const r = await recheck(entry.id);
    if (!r.ok) toast.error(r.diagnostics[0]?.message ?? "recheck failed");
    else { toast.success(`${entry.name}: ${r.data.status}`); onChanged(); }
  };

  return (
    <li className="rounded-lg border border-zinc-700 bg-zinc-900 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-3">
            <h3 className="font-mono text-sm text-sky-300">{entry.id}</h3>
            <span className="text-xs text-zinc-400">{entry.name}</span>
            <span className={`rounded border px-2 py-0.5 text-[0.65rem] uppercase tracking-wide ${BADGE[status]}`}>
              {status}
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-400">{entry.description}</p>
          <p className="mt-1 font-mono text-[0.65rem] text-zinc-500">
            {entry.command} {entry.args.join(" ")}
          </p>
          {entry.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {entry.tags.map((t) => (
                <span key={t} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[0.6rem] text-zinc-400">{t}</span>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          {status !== "equipped" && (
            <button onClick={() => setOpen(true)}
              className="rounded border border-blue-700 bg-blue-700/40 px-3 py-1 text-xs text-blue-100">
              {status === "unhealthy" ? "Re-equip" : "Equip"}
            </button>
          )}
          {status === "equipped" && (
            <>
              <button onClick={onRecheck}
                className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-200">Recheck</button>
              <button onClick={onUnequip}
                className="rounded border border-red-700/40 bg-red-700/20 px-3 py-1 text-xs text-red-200">Unequip</button>
            </>
          )}
        </div>
      </div>

      {open && (
        <div className="mt-4 border-t border-zinc-800 pt-3">
          {requiredKeys.length === 0 ? (
            <p className="text-xs text-zinc-400">This entry has no required envKeys — equipping runs only the package check.</p>
          ) : (
            <div className="space-y-2">
              {requiredKeys.map((k) => {
                const have = readouts.find((r) => r.envKey === k.name)?.hasValue;
                return (
                  <label key={k.name} className="block text-xs">
                    <span className="flex items-baseline justify-between">
                      <span className="font-mono text-zinc-300">{k.name}</span>
                      {have && <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[0.55rem] text-emerald-300">in inventory</span>}
                    </span>
                    {k.description && <span className="text-zinc-500">{k.description}</span>}
                    {k.obtainUrl && (
                      <a href={k.obtainUrl} target="_blank" rel="noreferrer"
                        className="mt-1 inline-block text-[0.6rem] text-sky-400 underline">
                        Get a key ↗
                      </a>
                    )}
                    <input type="password" autoComplete="off"
                      value={values[k.name] ?? ""}
                      onChange={(e) => setValues((p) => ({ ...p, [k.name]: e.target.value }))}
                      className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs"
                      placeholder={have ? "(leave empty to keep saved value)" : "(optional if set in process.env)"}
                    />
                  </label>
                );
              })}
            </div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => { setOpen(false); setValues({}); }}
              className="rounded border border-zinc-700 px-3 py-1 text-xs">Cancel</button>
            <button onClick={onEquip} disabled={submitting}
              className="rounded border border-blue-700 bg-blue-700/40 px-3 py-1 text-xs text-blue-100 disabled:opacity-50">
              {submitting ? "Equipping…" : "Equip"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
};
