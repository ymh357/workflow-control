"use client";

// /kernel-next — task list. Reads GET /api/kernel/tasks and renders
// the one-row-per-task overview. Dark-themed to match the app shell
// (layout.tsx body is bg-zinc-950 text-zinc-100). Read-only: writes
// (launch / answer gate / cancel) go through MCP tools or per-task
// detail pages.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiFetch, API_BASE } from "../../lib/api-client";
import { useToast } from "../../components/toast";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { CopyButton } from "../../components/copy-button";

type TaskStatus = "running" | "gated" | "completed" | "failed" | "cancelled" | "orphaned";

interface TaskRow {
  taskId: string;
  pipelineName: string | null;
  versionHash: string;
  status: TaskStatus;
  currentStage: string | null;
  gateId: string | null;
  gateStage: string | null;
  startedAt: number;
  endedAt: number | null;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  attemptCount: number;
}

type StatusFilter = "" | TaskStatus;

const REFRESH_MS = 5_000;

function formatTimestamp(ms: number | null): string {
  if (!ms || ms <= 0) return "—";
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleString(undefined, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// Duration display. startedAt comes from stage_attempts.started_at; for
// tasks whose stage rows predate a clock correction we saw values that
// produce absurd deltas ("493122h") — cap the visible output.
function formatDuration(startedAt: number, endedAt: number | null): string {
  if (!startedAt || startedAt <= 0) return "—";
  const end = endedAt ?? Date.now();
  const s = Math.max(0, Math.floor((end - startedAt) / 1000));
  if (s > 60 * 60 * 24 * 365) return "> 1y";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function statusBadge(status: TaskStatus) {
  const base = "inline-flex items-center rounded border px-1.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-wide";
  switch (status) {
    case "running":
      return `${base} border-blue-500/40 bg-blue-500/15 text-blue-300`;
    case "gated":
      return `${base} border-amber-500/40 bg-amber-500/15 text-amber-300`;
    case "completed":
      return `${base} border-emerald-500/40 bg-emerald-500/15 text-emerald-300`;
    case "failed":
      return `${base} border-red-500/40 bg-red-500/15 text-red-300`;
    case "cancelled":
      return `${base} border-zinc-500/40 bg-zinc-500/15 text-zinc-300`;
    case "orphaned":
      return `${base} border-purple-500/40 bg-purple-500/15 text-purple-300`;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export default function TaskListPage() {
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("");
  const [live, setLive] = useState<boolean>(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const liveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 2026-04-27 B3 — inline cancel confirmation.
  const [cancelTarget, setCancelTarget] = useState<TaskRow | null>(null);
  const [actingTaskId, setActingTaskId] = useState<string | null>(null);
  const toast = useToast();

  const refetch = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const qs = filter ? `?status=${filter}` : "";
      const res = await fetch(`${API_BASE}/api/kernel/tasks${qs}`, { signal });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        setTasks([]);
        return;
      }
      const body = await res.json() as { ok: boolean; tasks: TaskRow[] };
      setTasks(body.ok ? body.tasks : []);
      setLastFetchedAt(Date.now());
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
      setTasks([]);
    }
  }, [filter]);

  useEffect(() => {
    const controller = new AbortController();
    void refetch(controller.signal);
    return () => controller.abort();
  }, [refetch]);

  useEffect(() => {
    if (!live) {
      if (liveTimerRef.current) {
        clearInterval(liveTimerRef.current);
        liveTimerRef.current = null;
      }
      return;
    }
    liveTimerRef.current = setInterval(() => void refetch(), REFRESH_MS);
    return () => {
      if (liveTimerRef.current) {
        clearInterval(liveTimerRef.current);
        liveTimerRef.current = null;
      }
    };
  }, [live, refetch]);

  const statusCounts = useMemo(() => {
    const counts: Record<TaskStatus, number> & { total: number } = {
      running: 0, gated: 0, completed: 0, failed: 0, cancelled: 0, orphaned: 0, total: 0,
    };
    for (const t of tasks ?? []) {
      counts[t.status] += 1;
      counts.total += 1;
    }
    return counts;
  }, [tasks]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
          {tasks !== null && (
            <span className="text-sm text-zinc-500">
              {statusCounts.total} total
              {statusCounts.running > 0 && ` · ${statusCounts.running} running`}
              {statusCounts.gated > 0 && ` · ${statusCounts.gated} gated`}
              {statusCounts.failed > 0 && ` · ${statusCounts.failed} failed`}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-sm">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as StatusFilter)}
            aria-label="Filter by status"
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 focus:border-zinc-500 focus:outline-none"
          >
            <option value="">all statuses</option>
            <option value="running">running</option>
            <option value="gated">gated</option>
            <option value="completed">completed</option>
            <option value="failed">failed</option>
            <option value="cancelled">cancelled</option>
            <option value="orphaned">orphaned</option>
          </select>
          <label className="flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 cursor-pointer hover:border-zinc-600">
            <input
              type="checkbox"
              checked={live}
              onChange={(e) => setLive(e.target.checked)}
              className="accent-blue-500"
            />
            <span>live</span>
            <span className="text-zinc-500 text-xs">5s</span>
          </label>
          <button
            type="button"
            onClick={() => void refetch()}
            className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1 hover:border-zinc-600 hover:bg-zinc-800"
          >
            refresh
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {tasks === null && (
        <div className="text-sm text-zinc-500">Loading…</div>
      )}

      {tasks !== null && tasks.length === 0 && (
        <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-900/30 p-10 text-center">
          <p className="text-zinc-400">No tasks yet.</p>
          <p className="mt-2 text-xs text-zinc-500">
            Launch via MCP: <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono">run_pipeline</code>
            {" "}or HTTP: <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono">POST /api/kernel/tasks/run</code>.
          </p>
        </div>
      )}

      {tasks !== null && tasks.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-zinc-900/70 text-xs uppercase tracking-wide text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Task</th>
                <th className="px-3 py-2 text-left font-semibold">Pipeline</th>
                <th className="px-3 py-2 text-left font-semibold">Status</th>
                <th className="px-3 py-2 text-left font-semibold">Current stage</th>
                <th className="px-3 py-2 text-right font-semibold">Cost</th>
                <th className="px-3 py-2 text-right font-semibold">Tokens <span className="text-zinc-600">in/out</span></th>
                <th className="px-3 py-2 text-right font-semibold">Att</th>
                <th className="px-3 py-2 text-left font-semibold">Started</th>
                <th className="px-3 py-2 text-right font-semibold">Duration</th>
                <th className="px-3 py-2 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr
                  key={t.taskId}
                  className="border-t border-zinc-800 hover:bg-zinc-900/40 transition-colors"
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/kernel-next/${encodeURIComponent(t.taskId)}`}
                      className="font-mono text-[0.82rem] text-sky-400 hover:text-sky-300 hover:underline"
                      title={t.taskId}
                    >
                      {truncate(t.taskId, 34)}
                    </Link>
                    <CopyButton value={t.taskId} label="copy id" />
                  </td>
                  <td className="px-3 py-2">
                    {t.pipelineName ? (
                      <Link
                        href={`/kernel-next/pipelines/${encodeURIComponent(t.pipelineName)}`}
                        className="text-zinc-200 hover:text-white hover:underline"
                        title={t.pipelineName}
                      >
                        {truncate(t.pipelineName, 28)}
                      </Link>
                    ) : (
                      <span className="font-mono text-xs text-zinc-500" title={t.versionHash}>
                        {t.versionHash.slice(0, 8)}…
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={statusBadge(t.status)}>{t.status}</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-300">
                    {t.currentStage ?? <span className="text-zinc-600">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-mono text-xs">
                    {t.totalCostUsd > 0 ? (
                      <span className="text-zinc-200">${t.totalCostUsd.toFixed(4)}</span>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-mono text-xs text-zinc-400">
                    {t.totalInputTokens + t.totalOutputTokens > 0
                      ? `${t.totalInputTokens.toLocaleString()}/${t.totalOutputTokens.toLocaleString()}`
                      : <span className="text-zinc-600">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-mono text-xs text-zinc-300">
                    {t.attemptCount}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-zinc-400">
                    {formatTimestamp(t.startedAt)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs text-zinc-400">
                    {formatDuration(t.startedAt, t.endedAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {(t.status === "running" || t.status === "gated" || t.status === "orphaned") && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setCancelTarget(t);
                        }}
                        disabled={actingTaskId === t.taskId}
                        className="rounded border border-red-700/60 bg-red-900/30 px-2 py-1 text-[0.7rem] font-semibold text-red-200 hover:border-red-600 hover:bg-red-800/50 disabled:opacity-50"
                        title="Cancel this task"
                      >
                        Cancel
                      </button>
                    )}
                    {t.status === "failed" && (
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (actingTaskId) return;
                          setActingTaskId(t.taskId);
                          const res = await apiFetch(`/api/kernel/tasks/${encodeURIComponent(t.taskId)}/retry`, {
                            method: "POST",
                            body: {},
                          });
                          setActingTaskId(null);
                          if (!res.ok) {
                            toast.error(`Retry failed: ${res.diagnostics[0]?.message ?? "unknown"}`);
                            return;
                          }
                          toast.success("Retry queued");
                          void refetch();
                        }}
                        disabled={actingTaskId === t.taskId}
                        className="rounded border border-blue-700/60 bg-blue-900/30 px-2 py-1 text-[0.7rem] font-semibold text-blue-200 hover:border-blue-600 hover:bg-blue-800/50 disabled:opacity-50"
                        title="Retry from the earliest failed stage"
                      >
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lastFetchedAt && (
        <p className="text-right text-[0.68rem] text-zinc-600">
          last updated {new Date(lastFetchedAt).toLocaleTimeString()}
        </p>
      )}

      <ConfirmDialog
        open={cancelTarget !== null}
        title="Cancel this task?"
        message={
          cancelTarget
            ? `Task ${cancelTarget.taskId.slice(0, 24)}… (${cancelTarget.pipelineName ?? "unknown pipeline"}) will be marked as cancelled and any live SDK subprocess will be killed. This is not reversible.`
            : ""
        }
        confirmLabel="Cancel task"
        cancelLabel="Keep running"
        destructive
        onCancel={() => setCancelTarget(null)}
        onConfirm={async () => {
          if (!cancelTarget) return;
          const target = cancelTarget;
          setCancelTarget(null);
          setActingTaskId(target.taskId);
          const res = await apiFetch(`/api/kernel/tasks/${encodeURIComponent(target.taskId)}/cancel`, {
            method: "POST",
            body: { reason: "cancelled from web UI" },
          });
          setActingTaskId(null);
          if (!res.ok) {
            toast.error(`Cancel failed: ${res.diagnostics[0]?.message ?? "unknown"}`);
            return;
          }
          toast.success("Task cancelled");
          void refetch();
        }}
      />
    </div>
  );
}
