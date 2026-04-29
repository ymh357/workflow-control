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
  onStateChanged,
}: TaskActionsBarProps) => {
  const router = useRouter();
  const toast = useToast();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [acting, setActing] = useState(false);

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
    </>
  );
};
