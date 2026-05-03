"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "../lib/api-client";
import { useToast } from "./toast";
import { ConfirmDialog } from "./confirm-dialog";
import { CopyButton } from "./copy-button";

interface TaskActionsBarProps {
  taskId: string;
  // Mirrors the union in [taskId]/page.tsx — see the comment there. Extended
  // 2026-04-28 to include the gate/secret-gate states the canonical /status
  // endpoint emits but the SSE task_state event doesn't. Cancel/retry only
  // act on "running"/"failed", so the new states are safe no-ops here.
  topState:
    | "idle"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "orphaned"
    | "gated"
    | "secret_pending"
    | "unknown";
  hasFailedStage: boolean;
  /** The pipeline this task is currently running on. When set, surfaces a
   * "Modify pipeline" button that launches a pipeline-modifier task pre-
   * populated with this name. Omit on tasks whose pipeline name isn't yet
   * known (e.g. before the IR /api round-trip lands). */
  pipelineName?: string | null;
  /** Called after a state-changing action so the page can refetch fresh data. */
  onStateChanged?: () => void;
}

/**
 * Lifecycle controls for the task detail page header. Surfaces the four
 * operations a single user actually wants to do in-flight or post-mortem:
 *
 *  - Cancel       : during `running`, kills SDK + writes task_finals(cancelled)
 *  - Retry        : when a stage has errored, retry from the earliest failure
 *  - Open MCP cmd : copies a ready-to-paste MCP run_pipeline command
 *  - Copy task ID : already covered by <CopyButton/> above the bar; included
 *                   here in toolbar form so the user finds everything in one place
 *
 * 2026-04-27 B4.
 */
export const TaskActionsBar = ({
  taskId,
  topState,
  hasFailedStage,
  pipelineName,
  onStateChanged,
}: TaskActionsBarProps) => {
  const router = useRouter();
  const toast = useToast();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [acting, setActing] = useState(false);
  const [modifyOpen, setModifyOpen] = useState(false);
  const [modifyGoal, setModifyGoal] = useState("");
  const [modifying, setModifying] = useState(false);

  const onCancel = async (): Promise<void> => {
    setConfirmCancel(false);
    setActing(true);
    const res = await apiFetch(`/api/kernel/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
      body: { reason: "cancelled from web UI" },
    });
    setActing(false);
    if (!res.ok) {
      toast.error(`Cancel failed: ${res.diagnostics[0]?.message ?? "unknown"}`);
      return;
    }
    toast.success("Task cancelled");
    onStateChanged?.();
    router.refresh();
  };

  const onRetry = async (): Promise<void> => {
    setActing(true);
    const res = await apiFetch(`/api/kernel/tasks/${encodeURIComponent(taskId)}/retry`, {
      method: "POST",
      body: {},
    });
    setActing(false);
    if (!res.ok) {
      toast.error(`Retry failed: ${res.diagnostics[0]?.message ?? "unknown"}`);
      return;
    }
    toast.success("Retry queued");
    onStateChanged?.();
    router.refresh();
  };

  const isRunning = topState === "running";
  const isFailed = topState === "failed";

  // 2026-05-03: launch the pipeline-modifier builtin pre-filled with this
  // task's pipeline. The modifier emits a hot-update proposal (review
  // surface lives at /kernel-next/proposals); we redirect to the new task
  // page so the user sees the modifier run live.
  const onModify = async (): Promise<void> => {
    if (!pipelineName) {
      toast.error("Cannot modify: pipeline name not yet known");
      return;
    }
    if (modifyGoal.trim().length === 0) {
      toast.error("Modification goal is required");
      return;
    }
    setModifying(true);
    const res = await apiFetch<{ taskId: string }>("/api/kernel/tasks/run", {
      method: "POST",
      body: {
        name: "pipeline-modifier",
        seedValues: {
          targetPipelineName: pipelineName,
          modificationGoal: modifyGoal.trim(),
          failureContext:
            topState === "failed" || hasFailedStage
              ? { taskId }
              : null,
        },
      },
    });
    setModifying(false);
    if (!res.ok) {
      toast.error(`Modify failed: ${res.diagnostics[0]?.message ?? "unknown"}`);
      return;
    }
    toast.success("pipeline-modifier task launched");
    setModifyOpen(false);
    setModifyGoal("");
    router.push(`/kernel-next/${encodeURIComponent(res.data.taskId)}`);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {isRunning && (
          <button
            type="button"
            onClick={() => setConfirmCancel(true)}
            disabled={acting}
            className="rounded border border-danger-border bg-danger-bg px-3 py-1 text-xs font-semibold text-danger-fg hover:border-danger-border hover:bg-danger-bg disabled:opacity-50"
          >
            {acting ? "Cancelling…" : "Cancel"}
          </button>
        )}
        {(isFailed || hasFailedStage) && (
          <button
            type="button"
            onClick={onRetry}
            disabled={acting}
            className="rounded border border-info-border bg-info-bg px-3 py-1 text-xs font-semibold text-info-fg hover:border-info-border hover:bg-info-bg disabled:opacity-50"
            title="Retry from the earliest failed stage"
          >
            {acting ? "Retrying…" : "Retry from failed stage"}
          </button>
        )}
        {pipelineName && (
          <button
            type="button"
            onClick={() => setModifyOpen(true)}
            disabled={acting || modifying}
            className="rounded border border-strong bg-surface px-3 py-1 text-xs font-semibold text-primary hover:bg-elevated disabled:opacity-50"
            title="Launch pipeline-modifier to propose an IR change for this pipeline"
          >
            Modify pipeline
          </button>
        )}
        <CopyButton value={taskId} label="copy task id" />
        <CopyButton
          value={`run_pipeline taskId=${taskId}`}
          label="MCP cmd"
        />
      </div>

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this task?"
        message="The runner will receive INTERRUPT and the SDK subprocess will be killed. The task will be marked cancelled. This is not reversible."
        confirmLabel="Cancel task"
        cancelLabel="Keep running"
        destructive
        onCancel={() => setConfirmCancel(false)}
        onConfirm={onCancel}
      />

      {modifyOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModifyOpen(false);
          }}
        >
          <div className="w-full max-w-lg rounded-lg border border-default bg-page p-5 shadow-xl">
            <h2 className="mb-3 text-lg font-semibold text-primary">
              Modify pipeline
            </h2>
            <p className="mb-3 text-xs text-secondary">
              This launches the <code className="rounded bg-elevated px-1 font-mono">pipeline-modifier</code> builtin
              targeting <code className="rounded bg-elevated px-1 font-mono">{pipelineName}</code>. The modifier
              produces a hot-update proposal you review at{" "}
              <code className="rounded bg-elevated px-1 font-mono">/kernel-next/proposals</code>.
              {topState === "failed" || hasFailedStage ? (
                <>
                  {" "}This task's failure context will be passed in so the modifier can target the
                  failure root cause.
                </>
              ) : null}
            </p>
            <label htmlFor="modify-goal" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-secondary">
              Modification goal
            </label>
            <textarea
              id="modify-goal"
              value={modifyGoal}
              onChange={(e) => setModifyGoal(e.target.value)}
              placeholder="e.g. Add a verification stage between draft and publish that checks each citation against the original source."
              rows={5}
              className="w-full rounded border border-strong bg-surface px-2 py-1 text-sm text-primary placeholder:text-muted focus:border-strong focus:outline-none"
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setModifyOpen(false)}
                disabled={modifying}
                className="rounded border border-strong bg-surface px-3 py-1 text-xs font-semibold text-primary hover:bg-elevated disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void onModify()}
                disabled={modifying || modifyGoal.trim().length === 0}
                className="rounded border border-info-border bg-info-bg px-3 py-1 text-xs font-semibold text-info-fg hover:bg-info-bg disabled:opacity-50"
              >
                {modifying ? "Launching…" : "Launch modifier"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
