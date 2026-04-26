"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api-client";
import type { ApiDiagnostic } from "../lib/api-client";
import { useToast } from "./toast";
import { ErrorBanner } from "./error-banner";

interface RunningTaskRow {
  taskId: string;
  pipelineName: string | null;
  status: string;
  currentStage: string | null;
  startedAt: number;
}

interface MigrateProposalDialogProps {
  open: boolean;
  proposalId: string;
  pipelineName: string;
  /**
   * The proposal's migrateRunning policy from the kernel.
   *   "all"    → migrate any currently-running task on this pipeline
   *   "none"   → no targets (button should be disabled — but we render
   *              this dialog with an explanatory empty state if reached)
   *   string[] → explicit list of taskIds the proposal opted in
   */
  migrateRunning: "all" | "none" | string[];
  onClose: () => void;
  onSuccess?: () => void;
}

/**
 * Replaces the previous window.prompt-based migrate flow with a real
 * dropdown sourced from the proposal's migrateRunning policy. When the
 * policy is "all", the dialog fetches /api/kernel/tasks?status=running
 * and uses that as the target list.
 *
 * 2026-04-27 B-secondary.
 */
export const MigrateProposalDialog = ({
  open,
  proposalId,
  pipelineName,
  migrateRunning,
  onClose,
  onSuccess,
}: MigrateProposalDialogProps) => {
  const toast = useToast();
  const [candidates, setCandidates] = useState<RunningTaskRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [diagnostics, setDiagnostics] = useState<ApiDiagnostic[]>([]);

  useEffect(() => {
    if (!open) {
      setCandidates(null);
      setSelectedTaskId("");
      setDiagnostics([]);
      return;
    }
    setLoading(true);
    void (async () => {
      // Always fetch live running/gated tasks; we filter against the
      // policy list below so "explicit list" tasks that are no longer
      // running get marked as unavailable rather than silently selectable.
      const res = await apiFetch<{ tasks: RunningTaskRow[] }>(
        "/api/kernel/tasks",
      );
      setLoading(false);
      if (!res.ok) {
        setDiagnostics(res.diagnostics);
        setCandidates([]);
        return;
      }
      // Only running/gated/orphaned are meaningful migrate targets — a
      // completed/failed/cancelled task has no live runner to receive
      // the migration's INTERRUPT.
      const live = res.data.tasks.filter((t) =>
        t.status === "running" || t.status === "gated" || t.status === "orphaned",
      );
      setCandidates(live);
    })();
  }, [open, pipelineName]);

  const filtered = useMemo(() => {
    if (candidates === null) return null;
    if (migrateRunning === "all") {
      // For "all" we still scope by pipelineName since migration only
      // makes sense within a single pipeline's lineage.
      return candidates.filter((t) => t.pipelineName === pipelineName);
    }
    if (migrateRunning === "none") return [];
    // Explicit list — intersect with live tasks.
    const allowed = new Set(migrateRunning);
    return candidates.filter((t) => allowed.has(t.taskId));
  }, [candidates, migrateRunning, pipelineName]);

  useEffect(() => {
    // Pre-select the first candidate so a single-click migrate works.
    if (filtered && filtered.length > 0 && !selectedTaskId) {
      setSelectedTaskId(filtered[0]!.taskId);
    }
  }, [filtered, selectedTaskId]);

  if (!open) return null;

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!selectedTaskId || submitting) return;
    setSubmitting(true);
    setDiagnostics([]);
    const res = await apiFetch(
      `/api/kernel/tasks/${encodeURIComponent(selectedTaskId)}/migrate`,
      { method: "POST", body: { proposalId } },
    );
    setSubmitting(false);
    if (!res.ok) {
      setDiagnostics(res.diagnostics);
      return;
    }
    toast.success(`Migrated proposal into ${selectedTaskId.slice(0, 24)}…`);
    onSuccess?.();
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="migrate-dialog-title"
      className="fixed inset-0 z-[10000] flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-12"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="w-full max-w-xl rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-baseline justify-between border-b border-zinc-800 px-5 py-3">
          <div>
            <h2 id="migrate-dialog-title" className="text-base font-semibold text-zinc-100">
              Migrate proposal
            </h2>
            <p className="mt-0.5 font-mono text-[0.7rem] text-zinc-500">{proposalId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="rounded text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
          >
            ✕
          </button>
        </header>

        <form onSubmit={onSubmit} className="space-y-4 p-5">
          <p className="text-xs text-zinc-500">
            Pick a live task on <code className="font-mono text-zinc-400">{pipelineName}</code> to apply this proposal to. The kernel
            will INTERRUPT the runner, swap in the new IR, and resume from the proposal&rsquo;s rerun-from stage.
          </p>

          {migrateRunning === "none" && (
            <div className="rounded border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-200">
              This proposal&rsquo;s <code className="font-mono">migrateRunningTasks</code> is set to <code className="font-mono">&quot;none&quot;</code> — it&rsquo;s for new tasks only. Use the launcher to start a fresh task on the new version.
            </div>
          )}

          {loading && <p className="text-sm text-zinc-500">Loading candidate tasks…</p>}

          {!loading && filtered !== null && filtered.length === 0 && migrateRunning !== "none" && (
            <div className="rounded border border-zinc-700/60 bg-zinc-900/40 p-3 text-xs text-zinc-400">
              No live tasks to migrate.
              {Array.isArray(migrateRunning)
                ? ` This proposal opted in ${migrateRunning.length} task(s) but none are currently running.`
                : ` All tasks on '${pipelineName}' have completed or been cancelled.`}
            </div>
          )}

          {filtered && filtered.length > 0 && (
            <label className="block text-sm">
              <span className="text-xs text-zinc-400">Target task</span>
              <select
                value={selectedTaskId}
                onChange={(e) => setSelectedTaskId(e.target.value)}
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 font-mono text-xs text-zinc-100 focus:border-zinc-500 focus:outline-none"
                disabled={submitting}
              >
                {filtered.map((t) => (
                  <option key={t.taskId} value={t.taskId}>
                    {t.taskId.slice(0, 24)}… · {t.status}
                    {t.currentStage ? ` @ ${t.currentStage}` : ""}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[0.65rem] text-zinc-600">
                {filtered.length} candidate{filtered.length === 1 ? "" : "s"} ·
                policy: <code className="font-mono">{Array.isArray(migrateRunning) ? "explicit list" : `"${migrateRunning}"`}</code>
              </p>
            </label>
          )}

          {diagnostics.length > 0 && <ErrorBanner diagnostics={diagnostics} />}

          <div className="flex justify-end gap-2 border-t border-zinc-800 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-600 hover:bg-zinc-700 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !selectedTaskId || !filtered || filtered.length === 0}
              className="rounded border border-blue-600 bg-blue-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-50"
            >
              {submitting ? "Migrating…" : "Migrate →"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
