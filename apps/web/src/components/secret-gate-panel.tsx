"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api-client";
import type { ApiDiagnostic } from "../lib/api-client";
import { useToast } from "./toast";
import { ErrorBanner } from "./error-banner";

interface PendingSecretGate {
  secretGateId: string;
  stageName: string;
  attemptId: string;
  requiredKeys: string[];
  stillMissing: string[];
  createdAt: number;
}

interface SecretGatePanelProps {
  taskId: string;
  /** Called after secrets are accepted so the parent can refetch. */
  onResolved?: () => void;
}

/**
 * UI for the F17 secret-gate state. Polls /api/kernel/tasks/:id/secrets
 * (read-only) to enumerate pending gates, then renders one password input
 * per stillMissing key. Submit posts to the same path (POST) and on
 * success the kernel auto-resumes the task via retryTaskFromStage.
 *
 * 2026-04-27 B4.
 */
export const SecretGatePanel = ({ taskId, onResolved }: SecretGatePanelProps) => {
  const toast = useToast();
  const [pending, setPending] = useState<PendingSecretGate[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [diagnostics, setDiagnostics] = useState<ApiDiagnostic[]>([]);
  const [inventoryMap, setInventoryMap] = useState<Record<string, string | null>>({});
  const [persistChecked, setPersistChecked] = useState<Record<string, boolean>>({});

  const refresh = async (): Promise<void> => {
    const res = await apiFetch<{ pending: PendingSecretGate[] }>(
      `/api/kernel/tasks/${encodeURIComponent(taskId)}/secrets`,
    );
    if (!res.ok) {
      setPending([]);
      return;
    }
    setPending(res.data.pending);
  };

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    if (!pending || pending.length === 0) return;
    const allKeys = new Set<string>();
    for (const p of pending) for (const k of p.stillMissing) allKeys.add(k);
    if (allKeys.size === 0) return;
    void apiFetch<{ mapping: Record<string, string | null> }>(
      `/api/kernel/mcp-catalog/lookup-by-envkey?names=${[...allKeys].map(encodeURIComponent).join(",")}`,
    ).then((r) => { if (r.ok) setInventoryMap(r.data.mapping); });
  }, [pending]);

  if (pending === null || pending.length === 0) return null;

  // Aggregate every still-missing key across pending rows for the form.
  const allMissing = new Set<string>();
  for (const p of pending) {
    for (const k of p.stillMissing) allMissing.add(k);
  }
  const missingArr = Array.from(allMissing).sort();
  if (missingArr.length === 0) return null;

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    const secrets: Record<string, string> = {};
    for (const k of missingArr) {
      const v = values[k];
      if (v && v.length > 0) secrets[k] = v;
    }
    if (Object.keys(secrets).length === 0) {
      toast.info("Provide at least one secret value");
      return;
    }
    setSubmitting(true);
    setDiagnostics([]);
    const persistAs: Record<string, { entryId: string }> = {};
    for (const k of Object.keys(secrets)) {
      const eid = inventoryMap[k];
      if (typeof eid === "string" && persistChecked[k]) persistAs[k] = { entryId: eid };
    }
    const res = await apiFetch(`/api/kernel/tasks/${encodeURIComponent(taskId)}/secrets`, {
      method: "POST",
      body: Object.keys(persistAs).length > 0 ? { secrets, persistAs } : { secrets },
    });
    setSubmitting(false);
    if (!res.ok) {
      setDiagnostics(res.diagnostics);
      return;
    }
    toast.success("Secrets accepted — task resuming");
    setValues({});
    void refresh();
    onResolved?.();
  };

  return (
    <section className="rounded-lg border border-warning-border bg-warning-bg p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-warning-fg">
            Waiting for secrets
          </h2>
          <p className="mt-1 text-xs text-warning-fg">
            This task is paused on a secret-gate. Provide values for the
            missing envKeys below and the runner will resume automatically.
            Values are stored in <code className="font-mono">task_env_values</code> and
            never enter the agent prompt context.
          </p>
        </div>
        <span className="rounded border border-warning-border bg-warning-bg px-2 py-1 text-xs font-semibold uppercase tracking-wide text-warning-fg">
          {missingArr.length} missing
        </span>
      </div>

      <ul className="mt-3 space-y-1 text-xs text-warning-fg">
        {pending.map((p) => (
          <li key={p.secretGateId}>
            stage <code className="font-mono">{p.stageName}</code> requires{" "}
            <code className="font-mono">[{p.requiredKeys.join(", ")}]</code>
          </li>
        ))}
      </ul>

      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        {missingArr.map((k) => {
          const eid = inventoryMap[k];
          return (
            <div key={k} className="block text-sm">
              <label className="block">
                <span className="font-mono text-xs text-warning-fg">{k}</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={values[k] ?? ""}
                  onChange={(e) => setValues((prev) => ({ ...prev, [k]: e.target.value }))}
                  className="mt-1 w-full rounded border border-warning-border bg-page px-2 py-1.5 font-mono text-xs text-primary focus:border-warning-border focus:outline-none"
                />
              </label>
              {typeof eid === "string" && (
                <label className="mt-1 flex items-center gap-2 text-xs text-warning-fg">
                  <input type="checkbox" checked={persistChecked[k] === true}
                    onChange={(e) => setPersistChecked((p) => ({ ...p, [k]: e.target.checked }))} />
                  Save to MCP inventory as <code className="font-mono">{eid}</code> for reuse on later runs
                </label>
              )}
            </div>
          );
        })}

        {diagnostics.length > 0 && <ErrorBanner diagnostics={diagnostics} />}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submitting}
            className="rounded border border-warning-border bg-warning-bg px-4 py-1.5 text-xs font-semibold text-warning-fg hover:border-warning-border hover:bg-warning-fg/30 disabled:opacity-50"
          >
            {submitting ? "Submitting…" : "Provide secrets & resume"}
          </button>
        </div>
      </form>
    </section>
  );
};
