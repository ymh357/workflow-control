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
  "equipped":        "border-success-border bg-success-bg text-success-fg",
  "pending-secret":  "border-warning-border bg-warning-bg text-warning-fg",
  "unhealthy":       "border-danger-border bg-danger-bg text-danger-fg",
  "not-equipped":    "border-strong bg-elevated text-secondary",
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
    <li className="rounded-lg border border-strong bg-surface p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-3">
            <h3 className="font-mono text-sm text-accent">{entry.id}</h3>
            <span className="text-xs text-secondary">{entry.name}</span>
            <span className={`rounded border px-2 py-0.5 text-xs uppercase tracking-wide ${BADGE[status]}`}>
              {status}
            </span>
          </div>
          <p className="mt-1 text-xs text-secondary">{entry.description}</p>
          <p className="mt-1 font-mono text-xs text-muted">
            {entry.command} {entry.args.join(" ")}
          </p>
          {entry.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {entry.tags.map((t) => (
                <span key={t} className="rounded bg-elevated px-1.5 py-0.5 text-xs text-secondary">{t}</span>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          {status !== "equipped" && (
            <button onClick={() => setOpen(true)}
              className="rounded border border-info-border bg-info-bg px-3 py-1 text-xs text-info-fg">
              {status === "unhealthy" ? "Re-equip" : "Equip"}
            </button>
          )}
          {status === "equipped" && (
            <>
              <button onClick={onRecheck}
                className="rounded border border-strong px-3 py-1 text-xs text-primary">Recheck</button>
              <button onClick={onUnequip}
                className="rounded border border-danger-border bg-danger-bg px-3 py-1 text-xs text-danger-fg">Unequip</button>
            </>
          )}
        </div>
      </div>

      {open && (
        <div className="mt-4 border-t border-default pt-3">
          {requiredKeys.length === 0 ? (
            <p className="text-xs text-secondary">This entry has no required envKeys — equipping runs only the package check.</p>
          ) : (
            <div className="space-y-2">
              {requiredKeys.map((k) => {
                const have = readouts.find((r) => r.envKey === k.name)?.hasValue;
                return (
                  <label key={k.name} className="block text-xs">
                    <span className="flex items-baseline justify-between">
                      <span className="font-mono text-secondary">{k.name}</span>
                      {have && <span className="rounded border border-success-border bg-success-bg px-1.5 py-0.5 text-xs text-success-fg">in inventory</span>}
                    </span>
                    {k.description && <span className="text-muted">{k.description}</span>}
                    {k.obtainUrl && (
                      <a href={k.obtainUrl} target="_blank" rel="noreferrer"
                        className="mt-1 inline-block text-xs text-accent underline">
                        Get a key ↗
                      </a>
                    )}
                    <input type="password" autoComplete="off"
                      value={values[k.name] ?? ""}
                      onChange={(e) => setValues((p) => ({ ...p, [k.name]: e.target.value }))}
                      className="mt-1 w-full rounded border border-strong bg-page px-2 py-1 font-mono text-xs"
                      placeholder={have ? "(leave empty to keep saved value)" : "(optional if set in process.env)"}
                    />
                  </label>
                );
              })}
            </div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => { setOpen(false); setValues({}); }}
              className="rounded border border-strong px-3 py-1 text-xs">Cancel</button>
            <button onClick={onEquip} disabled={submitting}
              className="rounded border border-info-border bg-info-bg px-3 py-1 text-xs text-info-fg disabled:opacity-50">
              {submitting ? "Equipping…" : "Equip"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
};
