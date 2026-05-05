"use client";

// /kernel-next — task list. Reads GET /api/kernel/tasks and renders
// the one-row-per-task overview. Dark-themed to match the app shell
// (layout.tsx body is bg-page text-primary). Read-only: writes
// (launch / answer gate / cancel) go through MCP tools or per-task
// detail pages.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import Link from "next/link";
import { apiFetch, API_BASE } from "../../lib/api-client";
import { useToast } from "../../components/toast";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { CopyButton } from "../../components/copy-button";
import { useArchivedTasks } from "../../hooks/use-archived-tasks";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/input";
import { StatusPill } from "../../components/ui/status-pill";

// Bug 64-web (c12+ review): the server emits `secret_pending` whenever
// a stage is parked on the F17 secret-gate. Pre-fix this status was
// excluded here, so list-page status filtering / pill rendering / count
// for secret-paused tasks silently fell into undefined paths (e.g. the
// StatusPill defaulted to a no-op). Wire it into the union explicitly.
type TaskStatus =
  | "running"
  | "gated"
  | "secret_pending"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned";

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
  const [showArchived, setShowArchived] = useState(false);
  const archive = useArchivedTasks();
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
      running: 0, gated: 0, secret_pending: 0,
      completed: 0, failed: 0, cancelled: 0, orphaned: 0, total: 0,
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
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Tasks</h1>
          {tasks !== null && (
            <span className="text-sm text-muted">
              {statusCounts.total} total
              {statusCounts.running > 0 && ` · ${statusCounts.running} running`}
              {statusCounts.gated > 0 && ` · ${statusCounts.gated} gated`}
              {statusCounts.secret_pending > 0 && ` · ${statusCounts.secret_pending} secret-paused`}
              {statusCounts.failed > 0 && ` · ${statusCounts.failed} failed`}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-sm">
          <Select
            value={filter}
            onChange={(e) => setFilter(e.target.value as StatusFilter)}
            aria-label="Filter by status"
          >
            <option value="">all statuses</option>
            <option value="running">running</option>
            <option value="gated">gated</option>
            <option value="secret_pending">secret_pending</option>
            <option value="completed">completed</option>
            <option value="failed">failed</option>
            <option value="cancelled">cancelled</option>
            <option value="orphaned">orphaned</option>
          </Select>
          <label className="flex cursor-pointer items-center gap-1.5 rounded border border-default bg-surface px-2 py-1.5 text-secondary hover:border-strong">
            <input
              type="checkbox"
              checked={live}
              onChange={(e) => setLive(e.target.checked)}
              className="accent-accent"
            />
            <span>live</span>
            <span className="text-xs text-muted">5s</span>
          </label>
          <Button type="button" onClick={() => void refetch()}>
            refresh
          </Button>
          {archive.archivedCount > 0 && (
            <label className="flex cursor-pointer items-center gap-1.5 rounded border border-default bg-surface px-2 py-1.5 text-secondary hover:border-strong">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="accent-accent"
              />
              <span>archived</span>
              <span className="text-xs text-muted">{archive.archivedCount}</span>
            </label>
          )}
        </div>
      </header>

      {tasks !== null && tasks.length > 0 && <DashboardWidget tasks={tasks} />}

      {error && (
        <div className="rounded border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg">
          {error}
        </div>
      )}

      {tasks === null && (
        <div className="text-sm text-muted">Loading…</div>
      )}

      {tasks !== null && tasks.length === 0 && (
        <OnboardingCard />
      )}

      {tasks !== null && tasks.length > 0 && (
        <div className="surface-card overflow-x-auto rounded-lg border border-default">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-elevated text-xs uppercase tracking-wide text-secondary">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Task</th>
                <th className="px-3 py-2 text-left font-semibold">Pipeline</th>
                <th className="px-3 py-2 text-left font-semibold">Status</th>
                <th className="px-3 py-2 text-left font-semibold">Current stage</th>
                <th className="px-3 py-2 text-right font-semibold">Cost</th>
                <th className="px-3 py-2 text-right font-semibold">Tokens <span className="text-muted">in/out</span></th>
                <th className="px-3 py-2 text-right font-semibold">Att</th>
                <th className="px-3 py-2 text-left font-semibold">Started</th>
                <th className="px-3 py-2 text-right font-semibold">Duration</th>
                <th className="px-3 py-2 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tasks.filter((t) => showArchived || !archive.isArchived(t.taskId)).map((t) => (
                <tr
                  key={t.taskId}
                  className="border-t border-default transition-colors hover:bg-elevated"
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/kernel-next/${encodeURIComponent(t.taskId)}`}
                      className="font-mono text-sm text-accent hover:underline"
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
                        className="text-primary hover:underline"
                        title={t.pipelineName}
                      >
                        {truncate(t.pipelineName, 28)}
                      </Link>
                    ) : (
                      <span className="font-mono text-xs text-muted" title={t.versionHash}>
                        {t.versionHash.slice(0, 8)}…
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={t.status} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-secondary">
                    {t.currentStage ?? <span className="text-muted">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                    {t.totalCostUsd > 0 ? (
                      <span className="text-primary">${t.totalCostUsd.toFixed(4)}</span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-secondary">
                    {t.totalInputTokens + t.totalOutputTokens > 0
                      ? `${t.totalInputTokens.toLocaleString()}/${t.totalOutputTokens.toLocaleString()}`
                      : <span className="text-muted">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-secondary">
                    {t.attemptCount}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-secondary">
                    {formatTimestamp(t.startedAt)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums text-secondary">
                    {formatDuration(t.startedAt, t.endedAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {(t.status === "running" || t.status === "gated" || t.status === "orphaned") && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setCancelTarget(t);
                        }}
                        disabled={actingTaskId === t.taskId}
                        title="Cancel this task"
                      >
                        Cancel
                      </Button>
                    )}
                    {t.status === "failed" && (
                      <Button
                        variant="primary"
                        size="sm"
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
                        title="Retry from the earliest failed stage"
                      >
                        Retry
                      </Button>
                    )}
                    {(t.status === "completed" || t.status === "failed" || t.status === "cancelled") && (
                      archive.isArchived(t.taskId) ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="ml-1"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            archive.unarchive(t.taskId);
                          }}
                          title="Unarchive (restore to default view)"
                        >
                          Unarchive
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-1"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            archive.archive(t.taskId);
                          }}
                          title="Hide from default view (UI-only, server data untouched)"
                        >
                          Archive
                        </Button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lastFetchedAt && (
        <p className="text-right text-xs text-muted">
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

// First-run onboarding. The default empty-state ("No tasks yet. Launch
// via MCP run_pipeline") was technically correct but unhelpful for the
// "I just installed this — what do I do" path: the user doesn't have
// the MCP wired up yet, doesn't know what pipelines exist, and isn't
// sure where to start. Offer three concrete starting points instead.
export const OnboardingCard = (): ReactElement => {
  return (
    <div className="space-y-4 rounded-lg border border-default bg-surface p-6">
      <div>
        <h2 className="text-lg font-semibold text-primary">Welcome — let&apos;s ship a first task</h2>
        <p className="mt-1 text-sm text-secondary">
          workflow-control is a local AI-pipeline engine. To use it, the
          MCP server must be reachable from your Claude Code session.
          Pick a starting point:
        </p>
      </div>
      <ol className="space-y-3 text-sm">
        <li className="rounded border border-default bg-page p-3">
          <p className="font-semibold text-primary">1. Verify the engine works</p>
          <p className="mt-1 text-xs text-secondary">
            Run the bundled <code className="rounded bg-elevated px-1 font-mono">smoke-test</code> pipeline. Two stages, no
            external deps, finishes in ~30 s. Confirms the runner, MCP, and DB are all wired up.
          </p>
          <pre className="mt-2 overflow-x-auto rounded bg-elevated p-2 text-xs">
{`curl -X POST ${API_BASE}/api/kernel/tasks/run \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"smoke-test","seedValues":{"name":"there"}}'`}
          </pre>
        </li>
        <li className="rounded border border-default bg-page p-3">
          <p className="font-semibold text-primary">2. Mine your existing Claude Code work</p>
          <p className="mt-1 text-xs text-secondary">
            Forge analyses your past Claude Code sessions and recommends
            pipelines worth automating. Try the {" "}
            <Link href="/forge" className="text-accent hover:underline">/forge</Link> page.
          </p>
        </li>
        <li className="rounded border border-default bg-page p-3">
          <p className="font-semibold text-primary">3. Author a new pipeline (AI-driven)</p>
          <p className="mt-1 text-xs text-secondary">
            Describe what you want to automate to the bundled <code className="rounded bg-elevated px-1 font-mono">pipeline-generator</code>{" "}
            from your Claude Code session — it produces a validated pipeline IR. See{" "}
            <Link href="/kernel-next/pipelines/pipeline-generator" className="text-accent hover:underline">
              /kernel-next/pipelines/pipeline-generator
            </Link>.
          </p>
        </li>
      </ol>
      <p className="text-xs text-muted">
        After a few tasks land, this page becomes the operational dashboard with health stats and
        per-task drill-downs.
      </p>
    </div>
  );
};

// At-a-glance health for the operator. Aggregates client-side off the
// /tasks query that already loaded — no extra round trip. Shows:
//   - 7-day count + success rate
//   - top 3 most-used pipelines (by completed-task count)
//   - top 3 failure-detail prefixes (so recurring root causes pop)
//
// Designed to be silent when health is fine (>=90% success, no failures
// in the window). Only renders sections that have something to say.
export interface DashboardWidgetProps {
  tasks: TaskRow[];
}

export const DashboardWidget = ({ tasks }: DashboardWidgetProps): ReactElement | null => {
  const stats = useMemo(() => {
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - sevenDays;
    const recent = tasks.filter((t) => t.startedAt >= cutoff);
    const completed = recent.filter((t) => t.status === "completed").length;
    const failed = recent.filter((t) => t.status === "failed").length;
    const cancelled = recent.filter((t) => t.status === "cancelled").length;
    const running = recent.filter((t) => t.status === "running" || t.status === "gated" || t.status === "secret_pending").length;
    // Success rate excludes cancelled (intentional user action) and
    // still-in-flight tasks.
    const denom = completed + failed;
    const successRate = denom === 0 ? null : completed / denom;

    // Top pipelines by completed count.
    const pipelineCompletes = new Map<string, number>();
    for (const t of recent) {
      if (t.status !== "completed" || !t.pipelineName) continue;
      pipelineCompletes.set(t.pipelineName, (pipelineCompletes.get(t.pipelineName) ?? 0) + 1);
    }
    const topPipelines = [...pipelineCompletes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    return {
      total: recent.length,
      completed,
      failed,
      cancelled,
      running,
      successRate,
      topPipelines,
    };
  }, [tasks]);

  if (stats.total === 0) {
    return null;
  }

  return (
    <section
      aria-label="Last 7 days"
      className="rounded-lg border border-default bg-surface p-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Last 7 days</p>
          <p className="text-2xl font-semibold text-primary">{stats.total}</p>
          <p className="text-xs text-secondary">tasks total</p>
        </div>
        {stats.successRate !== null && (
          <div>
            <p className="text-xs uppercase tracking-wide text-muted">Success rate</p>
            <p
              className={`text-2xl font-semibold ${
                stats.successRate >= 0.9
                  ? "text-success-fg"
                  : stats.successRate >= 0.6
                    ? "text-warning-fg"
                    : "text-danger-fg"
              }`}
            >
              {(stats.successRate * 100).toFixed(0)}%
            </p>
            <p className="text-xs text-secondary">
              {stats.completed} ok · {stats.failed} failed
              {stats.cancelled > 0 && ` · ${stats.cancelled} cancelled`}
              {stats.running > 0 && ` · ${stats.running} live`}
            </p>
          </div>
        )}
        {stats.topPipelines.length > 0 && (
          <div className="flex-1 min-w-[200px]">
            <p className="text-xs uppercase tracking-wide text-muted">Top pipelines (completed)</p>
            <ul className="mt-1 space-y-0.5 text-xs text-secondary">
              {stats.topPipelines.map(([name, count]) => (
                <li key={name} className="flex items-center justify-between gap-2">
                  <Link
                    href={`/kernel-next/pipelines/${encodeURIComponent(name)}`}
                    className="font-mono text-accent hover:underline truncate"
                    title={name}
                  >
                    {name}
                  </Link>
                  <span className="text-muted">×{count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
};
