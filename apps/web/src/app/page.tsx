"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import type { CreateTaskResponse, TaskSummary, FailedRestoreSummary } from "@workflow-control/shared";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface PipelineManifest {
  id: string;
  name: string;
  description?: string;
  engine: "claude" | "gemini" | "codex" | "mixed";
  official?: boolean;
}

type TaskGroup = "actionable" | "running" | "other";

const TERMINAL_STATUSES = new Set(["completed", "error", "cancelled", "idle"]);

const categorizeTask = (task: TaskSummary): TaskGroup => {
  const s = task.status.toLowerCase();
  if (
    s.includes("awaiting") ||
    s.includes("confirm") ||
    s === "blocked" ||
    task.pendingQuestion
  ) {
    return "actionable";
  }
  if (!TERMINAL_STATUSES.has(s)) return "running";
  return "other";
};

const formatWaitTime = (updatedAt?: string): string | null => {
  if (!updatedAt) return null;
  const ms = Date.now() - new Date(updatedAt).getTime();
  if (ms < 60_000) return "<1m";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

const HomePage = () => {
  const t = useTranslations("Tasks");
  const tc = useTranslations("Common");
  const [taskText, setTaskText] = useState("");
  const [repoName, setRepoName] = useState("");
  const [loading, setLoading] = useState(false);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [pipelines, setPipelines] = useState<PipelineManifest[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState<string>("");
  const [showAllOther, setShowAllOther] = useState(false);
  const [failedRestores, setFailedRestores] = useState<FailedRestoreSummary[]>([]);

  const fetchPipelines = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/config/pipelines`);
      if (res.ok) {
        const data = await res.json();
        setPipelines(data.pipelines ?? []);
      }
    } catch { /* ignore */ }
  }, []);

  // SSE subscription for real-time task list updates
  useEffect(() => {
    const controller = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const res = await fetch(`${API_BASE}/api/stream/tasks`, { signal: controller.signal });
        if (!res.ok || !res.body) { scheduleReconnect(); return; }
        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";
          for (const chunk of chunks) {
            const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const event = JSON.parse(dataLine.slice(6));
              if (event.type === "task_list_init") {
                setTasks(event.tasks);
                setFailedRestores(event.failedRestores ?? []);
              } else if (event.type === "task_updated") {
                setTasks((prev) => {
                  const idx = prev.findIndex((t) => t.id === event.task.id);
                  if (idx >= 0) return [...prev.slice(0, idx), event.task, ...prev.slice(idx + 1)];
                  return [event.task, ...prev];
                });
              } else if (event.type === "task_removed") {
                setTasks((prev) => prev.filter((t) => t.id !== event.taskId));
              }
            } catch { /* skip malformed events */ }
          }
        }
        try { reader?.cancel(); } catch { /* already closed */ }
        scheduleReconnect();
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        try { reader?.cancel(); } catch { /* already closed */ }
        scheduleReconnect();
      }
    };

    const scheduleReconnect = () => {
      if (controller.signal.aborted) return;
      reconnectTimer = setTimeout(connect, 2000);
    };

    connect();
    return () => { controller.abort(); clearTimeout(reconnectTimer); };
  }, []);

  useEffect(() => {
    fetchPipelines();
  }, [fetchPipelines]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskText.trim()) return;

    setLoading(true);
    try {
      const pipelineId = selectedPipeline || pipelines[0]?.id || "pipeline-generator";
      const body: Record<string, string> = { pipelineName: pipelineId, taskText };
      if (repoName.trim()) body.repoName = repoName.trim();

      const res = await fetch(`${API_BASE}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error("Failed to create task");

      const data: CreateTaskResponse = await res.json();
      setTaskText("");
      setRepoName("");
      window.location.href = `/task/${data.taskId}`;
    } catch (err) {
      alert(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const statusColor = (status: string): string => {
    switch (status) {
      case "completed":
        return "text-green-400";
      case "error":
      case "blocked":
        return "text-red-400";
      case "idle":
      case "cancelled":
        return "text-zinc-400";
      default:
        return "text-yellow-400";
    }
  };

  // Task grouping
  const grouped = useMemo(() => {
    const actionable: TaskSummary[] = [];
    const running: TaskSummary[] = [];
    const other: TaskSummary[] = [];
    for (const t of tasks) {
      const cat = categorizeTask(t);
      if (cat === "actionable") actionable.push(t);
      else if (cat === "running") running.push(t);
      else other.push(t);
    }
    return { actionable, running, other };
  }, [tasks]);

  // Summary stats
  const totalCost = useMemo(() => {
    return tasks.reduce((sum, t) => sum + (t.totalCostUsd ?? 0), 0);
  }, [tasks]);

  // Auto-select first pipeline when loaded
  useEffect(() => {
    if (pipelines.length > 0 && !selectedPipeline) {
      setSelectedPipeline(pipelines[0].id);
    }
  }, [pipelines, selectedPipeline]);

  // Group pipelines by engine for the dropdown
  const pipelinesByEngine = useMemo(() => {
    const groups: Record<string, PipelineManifest[]> = {};
    for (const p of pipelines) {
      if (!groups[p.engine]) groups[p.engine] = [];
      groups[p.engine].push(p);
    }
    return groups;
  }, [pipelines]);

  const renderTaskItem = (task: TaskSummary, accentClass?: string) => (
    <a
      key={task.id}
      href={`/task/${task.id}`}
      className={`flex items-center justify-between rounded-md border border-zinc-800 px-4 py-3 transition hover:border-zinc-600 ${
        accentClass ? `border-l-2 ${accentClass}` : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {task.displayTitle && task.displayTitle !== task.id
            ? task.displayTitle
            : task.taskText
              ? task.taskText.slice(0, 80) + (task.taskText.length > 80 ? "..." : "")
              : task.id.slice(0, 8)}
        </p>
        <p className="text-xs text-zinc-500">
          {task.id.slice(0, 8)}...
          {task.pendingQuestion && <span className="ml-2 text-cyan-400">{t("questionPending")}</span>}
        </p>
      </div>
      <div className="ml-4 flex items-center gap-2">
        {categorizeTask(task) === "actionable" && (() => {
          const wait = formatWaitTime(task.updatedAt);
          return wait ? <span className="text-[10px] text-zinc-500">{t("waiting", { time: wait })}</span> : null;
        })()}
        {task.totalCostUsd != null && task.totalCostUsd > 0 && (
          <span className="text-xs font-mono text-zinc-500">${task.totalCostUsd.toFixed(2)}</span>
        )}
        <span className={`text-xs font-medium ${statusColor(task.status)}`}>
          {task.status}
        </span>
      </div>
    </a>
  );

  return (
    <div className="space-y-8">
      <section>
        {failedRestores.length > 0 && (
          <div className="mb-4 rounded-md border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            <div className="font-medium">{t("restoreIssues")}</div>
            <div className="mt-1 space-y-1">
              {failedRestores.map((failure) => (
                <div key={failure.id} className="font-mono text-xs text-red-300">
                  {failure.id.slice(0, 8)}... {failure.reason}
                </div>
              ))}
            </div>
          </div>
        )}
        <h2 className="mb-4 text-xl font-semibold">{t("createTask")}</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-2">
            <textarea
              value={taskText}
              onChange={(e) => setTaskText(e.target.value)}
              placeholder={t("taskTextPlaceholder")}
              required
              rows={4}
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none resize-y"
            />
            <div className="flex gap-3 items-center">
              <input
                type="text"
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                placeholder={t("repoNamePlaceholder")}
                className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={loading}
                className="rounded-md bg-zinc-100 px-5 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-200 disabled:opacity-50"
              >
                {loading ? t("starting") : t("analyze")}
              </button>
            </div>
          </div>

          {/* Pipeline selector */}
          {pipelines.length > 0 && (
            <div className="flex items-center gap-3">
              <span className="text-xs text-zinc-500 shrink-0">{t("pipeline")}</span>
              <select
                value={selectedPipeline}
                onChange={(e) => setSelectedPipeline(e.target.value)}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none appearance-none cursor-pointer"
              >
                {Object.entries(pipelinesByEngine).map(([engine, items]) => (
                  <optgroup key={engine} label={engine.toUpperCase()}>
                    {items.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          )}
        </form>
      </section>

      <section>
        <h2 className="mb-4 text-xl font-semibold">{t("tasks")}</h2>

        {/* Summary bar */}
        {tasks.length > 0 && (
          <div className="flex gap-4 text-xs text-zinc-500 mb-4">
            <span>{t("running", { count: grouped.running.length })}</span>
            <span>{t("awaitingAction", { count: grouped.actionable.length })}</span>
            <span>{t("totalCost", { cost: totalCost.toFixed(2) })}</span>
          </div>
        )}

        {tasks.length === 0 ? (
          <p className="text-sm text-zinc-500">{t("noTasksYet")}</p>
        ) : (
          <div className="space-y-6">
            {/* Needs Your Action */}
            {grouped.actionable.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-blue-400 uppercase tracking-wider mb-2">
                  {t("needsAction")} ({grouped.actionable.length})
                </h3>
                <div className="space-y-2">
                  {grouped.actionable.map((t) => renderTaskItem(t, "border-l-blue-500"))}
                </div>
              </div>
            )}

            {/* Running */}
            {grouped.running.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-yellow-400 uppercase tracking-wider mb-2">
                  {t("runningGroup")} ({grouped.running.length})
                </h3>
                <div className="space-y-2">
                  {grouped.running.map((t) => renderTaskItem(t, "border-l-yellow-500"))}
                </div>
              </div>
            )}

            {/* Completed & Other */}
            {grouped.other.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
                  {t("completedOther")} ({grouped.other.length})
                </h3>
                <div className="space-y-2">
                  {(grouped.other.length > 5 && !showAllOther
                    ? grouped.other.slice(0, 5)
                    : grouped.other
                  ).map((t) => renderTaskItem(t))}
                  {grouped.other.length > 5 && !showAllOther && (
                    <button
                      onClick={() => setShowAllOther(true)}
                      className="text-xs text-zinc-500 hover:text-zinc-400"
                    >
                      {t("showMore", { count: grouped.other.length - 5 })}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};

export default HomePage;
