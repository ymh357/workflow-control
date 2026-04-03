"use client";

import { useState, useEffect, useRef, use, useCallback } from "react";
import { useTranslations } from "next-intl";
import type { SSEMessage, TaskDetail as SharedTaskDetail } from "@workflow-control/shared";
import StageTimeline from "@/components/stage-timeline";
import type { StageCostInfo, StageTokenUsage } from "@/components/stage-timeline";
import CostSummary from "@/components/cost-summary";
import ConfirmPanel from "@/components/confirm-panel";
import MessageStream from "@/components/message-stream";
import type { DisplayMessage } from "@/components/message-stream";
import QuestionPanel from "@/components/question-panel";
import DynamicStoreViewer from "@/components/dynamic-store-viewer";
import ConfigWorkbench from "@/components/config-workbench";
import type { PipelineStageSchema, PipelineStageEntry } from "@/lib/pipeline-types";
import { flattenPipelineStages } from "@/lib/pipeline-types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type TaskDetail = Omit<SharedTaskDetail, "pipelineSchema" | "config"> & {
  pipelineSchema?: PipelineStageEntry[];
  config?: { pipeline?: { engine?: string; stages?: PipelineStageEntry[] } };
};

interface PendingQuestion {
  questionId: string;
  question: string;
  options?: string[];
}

const TaskPage = ({ params }: { params: Promise<{ id: string }> }) => {
  const t = useTranslations("Tasks");
  const tc = useTranslations("Common");
  const { id: taskId } = use(params);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);

  // Restore messages from sessionStorage after hydration
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(`messages:${taskId}`);
      if (saved) {
        const parsed = JSON.parse(saved) as DisplayMessage[];
        if (parsed.length > 0) setMessages(parsed);
      }
    } catch { /* ignore */ }
  }, [taskId]);
  const [status, setStatus] = useState<string>("connecting");
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [question, setQuestion] = useState<PendingQuestion | null>(null);
  const [answer, setAnswer] = useState("");
  const [repoNameOverride, setRepoNameOverride] = useState("");
  const [interruptMessage, setInterruptMessage] = useState("");
  const [feedbackText, setFeedbackText] = useState("");
  const [sseKey, setSseKey] = useState(0);

  // Cost tracking
  const [stageCosts, setStageCosts] = useState<Record<string, StageCostInfo>>({});
  const [totalCostUsd, setTotalCostUsd] = useState(0);
  const [currentStage, setCurrentStage] = useState<string>("");
  const currentStageRef = useRef(currentStage);

  const [activeView, setActiveView] = useState<"workflow" | "summary" | "config">("workflow");
  const [scrollToStage, setScrollToStage] = useState<string>("");
  const [availableMcps, setAvailableMcps] = useState<Array<{ name: string; description: string; available: boolean }>>([]);

  // Elapsed time tracking for "agent is working" indicator
  const [stageStartTime, setStageStartTime] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Agent progress tracking (#1)
  const [agentProgress, setAgentProgress] = useState<{ toolCallCount: number; phase: string; thinkingSnippet: string }>({
    toolCallCount: 0, phase: "", thinkingSnippet: ""
  });

  // Refs for values needed in fetchTask to avoid dependency churn
  const questionRef = useRef(question);
  questionRef.current = question;
  const taskRef = useRef(task);
  taskRef.current = task;

  // Fetch task details periodically (stable callback — only depends on taskId)
  const fetchTask = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/tasks/${taskId}`);
      if (res.ok) {
        const data = await res.json();
        setTask(data);
        setStatus(data.status);
        if (data.totalCostUsd) {
          setTotalCostUsd((prev) => Math.max(prev, data.totalCostUsd));
        }
        // Restore per-stage token usage from persisted context
        if (data.stageTokenUsages) {
          setStageCosts((prev) => {
            const updated = { ...prev };
            for (const [stage, tu] of Object.entries(data.stageTokenUsages as Record<string, StageTokenUsage>)) {
              updated[stage] = { ...updated[stage], costUsd: updated[stage]?.costUsd ?? 0, durationMs: updated[stage]?.durationMs ?? 0, tokenUsage: tu };
            }
            return updated;
          });
        }
        if (data.pendingQuestion && !questionRef.current) {
          setQuestion(data.pendingQuestion);
        } else if (!data.pendingQuestion && questionRef.current) {
          setQuestion(null);
          setAnswer("");
        }
      }
    } catch { /* ignore */ }
  }, [taskId]);

  useEffect(() => {
    fetchTask();
  }, [fetchTask]);

  // Fetch available MCPs for config editor
  useEffect(() => {
    fetch(`${API_BASE}/api/config/system`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data?.capabilities?.mcps) setAvailableMcps(data.capabilities.mcps); })
      .catch(() => {});
  }, []);

  // Persist messages to sessionStorage
  useEffect(() => {
    if (messages.length === 0) return;
    try {
      const toCache = messages.map((m) =>
        m.type === "agent_thinking" && m.content.length > 500
          ? { ...m, content: m.content.slice(0, 500) }
          : m
      );
      sessionStorage.setItem(`messages:${taskId}`, JSON.stringify(toCache));
    } catch { /* quota exceeded */ }
  }, [messages, taskId]);

  // Elapsed timer for active stages
  useEffect(() => {
    if (!stageStartTime) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - stageStartTime) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [stageStartTime]);

  // Request browser notification permission
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // SSE connection with auto-reconnect
  useEffect(() => {
    const controller = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const res = await fetch(`${API_BASE}/api/stream/${taskId}`, {
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          scheduleReconnect();
          return;
        }

        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const msg: SSEMessage = JSON.parse(line.slice(6));
              handleMessage(msg);
            } catch { /* skip malformed */ }
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
  }, [taskId, sseKey]);

  const handleMessage = (msg: SSEMessage) => {
    const data = msg.data as Record<string, unknown>;

    switch (msg.type) {
      case "status": {
        const newStatus = String(data.status ?? "unknown");
        setStatus(newStatus);
        setCurrentStage(newStatus);
        currentStageRef.current = newStatus;
        // Only add a visible message for terminal/gate/blocked states.
        // Running agent stages get their message from "stage_change" to avoid duplicates.
        const terminalStates = ["completed", "error", "cancelled", "blocked"];
        const flatStages = taskRef.current?.pipelineSchema ? flattenPipelineStages(taskRef.current.pipelineSchema) : [];
        const isGate = flatStages.some(
          (s) => s.name === newStatus && s.type === "human_confirm",
        );
        const hasCustomMessage = typeof data.message === "string" && data.message.length > 0;
        if (terminalStates.includes(newStatus) || isGate || hasCustomMessage) {
          addMessage(msg, data.message ? String(data.message) : `Status: ${data.status}`);
        }

        // Refresh full task data on terminal/gate states (no polling to fall back on)
        if (newStatus === "completed" || newStatus === "error" || newStatus === "cancelled" || newStatus === "blocked" || isHumanGate(newStatus, taskRef.current?.pipelineSchema)) {
          fetchTask();
        }

        if (document.hidden && "Notification" in window && Notification.permission === "granted") {
          const shouldNotify = isHumanGate(newStatus, taskRef.current?.pipelineSchema) || newStatus === "blocked" || newStatus === "completed" || newStatus === "cancelled";
          if (shouldNotify) {
            new Notification("workflow-control", {
              body: `Task ${taskId.slice(0, 8)}: ${typeof data.message === "string" ? data.message : newStatus}`,
            });
          }
        }
        break;
      }
      case "stage_change": {
        const newStage = String(data.stage ?? "");
        setCurrentStage(newStage);
        currentStageRef.current = newStage;
        setStageStartTime(Date.now());
        setAgentProgress({ toolCallCount: 0, phase: "", thinkingSnippet: "" });
        addMessage(msg, `Stage: ${data.stage}`);
        fetchTask();
        break;
      }
      case "agent_text":
        addMessage(msg, String(data.text ?? ""));
        break;
      case "agent_tool_use":
        addMessage(msg, `Tool: ${data.toolName}`, { toolName: data.toolName, input: data.input } as Record<string, unknown>);
        break;
      case "agent_thinking":
        setAgentProgress((prev) => ({ ...prev, thinkingSnippet: String(data.text ?? "") }));
        addMessage(msg, String(data.text ?? ""));
        break;
      case "agent_tool_result":
        addMessage(msg, String(data.text ?? ""));
        break;
      case "agent_progress": {
        const tcc = typeof data.toolCallCount === "number" ? data.toolCallCount : 0;
        const phase = String(data.phase ?? "");
        setAgentProgress((prev) => ({
          ...prev,
          toolCallCount: tcc > 0 ? tcc : prev.toolCallCount,
          phase,
        }));
        break;
      }
      case "result": {
        if (data.sessionId) {
          setTask((prev) => prev ? { ...prev, sessionId: data.sessionId as string } : prev);
        }
        // Track cost per stage
        const costUsd = typeof data.costUsd === "number" ? data.costUsd : 0;
        const durationMs = typeof data.durationMs === "number" ? data.durationMs : 0;
        const resultTokenUsage = data.tokenUsage as StageTokenUsage | undefined;
        if (currentStageRef.current && costUsd > 0) {
          setStageCosts((prev) => ({ ...prev, [currentStageRef.current]: { costUsd, durationMs, tokenUsage: resultTokenUsage } }));
        }
        if (typeof data.totalCostUsd === "number") {
          setTotalCostUsd(data.totalCostUsd);
        }
        addMessage(msg, `Stage completed ($${costUsd.toFixed(3)}, ${Math.round(durationMs / 1000)}s)`);
        break;
      }
      case "question":
        setQuestion({
          questionId: data.questionId as string,
          question: data.question as string,
          options: data.options as string[] | undefined,
        });
        addMessage(msg, `Question: ${data.question}`);
        if (document.hidden && "Notification" in window && Notification.permission === "granted") {
          new Notification("workflow-control", {
            body: `Task ${taskId.slice(0, 8)}: Agent is asking a question`,
          });
        }
        break;
      case "cost_update": {
        if (typeof data.totalCostUsd === "number") {
          setTotalCostUsd(data.totalCostUsd);
        }
        if (typeof data.stageCostUsd === "number" && currentStageRef.current) {
          const stageTokenUsage = data.stageTokenUsage as StageTokenUsage | undefined;
          setStageCosts((prev) => ({
            ...prev,
            [currentStageRef.current]: {
              costUsd: data.stageCostUsd as number,
              durationMs: prev[currentStageRef.current]?.durationMs ?? 0,
              tokenUsage: stageTokenUsage ?? prev[currentStageRef.current]?.tokenUsage,
            },
          }));
        }
        break;
      }
      case "question_timeout_warning":
        addMessage(msg, `Question will time out in ${Math.round((data.remainingMs as number) / 60000)}min`);
        break;
      case "user_message":
        addMessage(msg, String(data.text ?? ""));
        break;
      case "error":
        addMessage(msg, `Error: ${data.error}`);
        break;
    }
  };

  const addMessage = (msg: SSEMessage, content: string, detail?: Record<string, unknown>) => {
    setMessages((prev) => {
      // Merge adjacent agent_text messages
      if (msg.type === "agent_text" && prev.length > 0) {
        const last = prev[prev.length - 1];
        if (last.type === "agent_text") {
          const merged = [...prev];
          merged[merged.length - 1] = { ...last, content: last.content + content };
          return merged;
        }
      }
      const stage = msg.type === "stage_change"
        ? String((msg.data as Record<string, unknown>).stage ?? "")
        : currentStageRef.current;
      const next = [
        ...prev,
        {
          id: `${msg.timestamp}-${msg.type}-${crypto.randomUUID().slice(0, 8)}`,
          type: msg.type,
          timestamp: msg.timestamp,
          content,
          detail,
          stage,
        },
      ];
      return next.length > 2000 ? next.slice(-2000) : next;
    });
  };

  const handleConfirm = async () => {
    try {
      const body: Record<string, string> = {};
      if (repoNameOverride.trim()) body.repoName = repoNameOverride.trim();
      const res = await fetch(`${API_BASE}/api/tasks/${taskId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) console.error("Confirm failed:", await res.text().catch(() => res.status));
      setFeedbackText("");
      fetchTask();
    } catch (err) {
      console.error("Confirm error:", err);
    }
  };

  const handleReject = async (targetStage?: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/tasks/${taskId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Rejected by user", ...(targetStage ? { targetStage } : {}) }),
      });
      if (!res.ok) console.error("Reject failed:", await res.text().catch(() => res.status));
      setFeedbackText("");
      fetchTask();
    } catch (err) {
      console.error("Reject error:", err);
    }
  };

  const handleRetry = async (sync?: boolean) => {
    try {
      const res = await fetch(`${API_BASE}/api/tasks/${taskId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sync ? { sync: true } : {}),
      });
      if (!res.ok) console.error("Retry failed:", await res.text().catch(() => res.status));
      setMessages([]);
      try { sessionStorage.removeItem(`messages:${taskId}`); } catch {}
      setSseKey((k) => k + 1);
      fetchTask();
    } catch (err) {
      console.error("Retry error:", err);
    }
  };

  const handleAnswer = async () => {
    if (!question || !answer.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/api/tasks/${taskId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: question.questionId, answer: answer.trim() }),
      });
      if (!res.ok) console.error("Answer failed:", await res.text().catch(() => res.status));
      setQuestion(null);
      setAnswer("");
    } catch (err) {
      console.error("Answer error:", err);
    }
  };

  const [interruptError, setInterruptError] = useState("");

  const handleSendMessage = async () => {
    const msg = interruptMessage.trim();
    if (!msg) return;
    setInterruptError("");
    try {
      const res = await fetch(`${API_BASE}/api/tasks/${taskId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      if (res.ok) {
        setInterruptMessage("");
        setInterruptError(t("interruptRequested"));
      } else {
        const data = await res.json().catch(() => ({}));
        setInterruptError(data.error ?? `Failed (${res.status})`);
      }
    } catch {
      setInterruptError(t("networkError"));
    }
  };

  const handleRejectWithFeedback = async (targetStage?: string) => {
    const fb = feedbackText.trim();
    if (!fb) return;
    try {
      const res = await fetch(`${API_BASE}/api/tasks/${taskId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: fb, ...(targetStage ? { targetStage } : {}) }),
      });
      if (!res.ok) console.error("Feedback failed:", await res.text().catch(() => res.status));
      setFeedbackText("");
      fetchTask();
    } catch (err) {
      console.error("Feedback error:", err);
    }
  };

  const handleCancel = async () => {
    try {
      await fetch(`${API_BASE}/api/tasks/${taskId}/cancel`, { method: "POST" });
      fetchTask();
    } catch (err) {
      console.error("Cancel error:", err);
    }
  };

  const handleDelete = async () => {
    try {
      await fetch(`${API_BASE}/api/tasks/${taskId}`, { method: "DELETE" });
      window.location.href = "/";
    } catch (err) {
      console.error("Delete error:", err);
    }
  };

  const handleResume = async () => {
    try {
      await fetch(`${API_BASE}/api/tasks/${taskId}/resume`, { method: "POST" });
      fetchTask();
    } catch (err) {
      console.error("Resume error:", err);
    }
  };

  const handleLaunch = async () => {
    try {
      await fetch(`${API_BASE}/api/tasks/${taskId}/launch`, { method: "POST" });
      setActiveView("workflow");
      fetchTask();
    } catch (err) {
      console.error("Launch error:", err);
    }
  };

  const handleUpdateConfig = async (newConfig: any) => {
    const res = await fetch(`${API_BASE}/api/tasks/${taskId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: newConfig }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.config) {
        setTask((prev) => prev ? { ...prev, config: data.config } : prev);
      }
    }
  };

  const handleStageClick = (stageName: string) => {
    setActiveView("workflow");
    // Toggle to force re-trigger if same stage
    setScrollToStage("");
    requestAnimationFrame(() => setScrollToStage(stageName));
  };

  const taskEngine: string = task?.config?.pipeline?.engine || "claude";

  // Resolve engine and cwd for the current/last stage (for resume command)
  const lastStageName = task?.currentStage || status;
  const currentStageEngine: string = (() => {
    const flatSchema = task?.pipelineSchema ? flattenPipelineStages(task.pipelineSchema) : [];
    const stage = flatSchema.find((s) => s.name === lastStageName);
    return stage?.engine || taskEngine;
  })();
  const resumeCwd: string | undefined =
    task?.stageCwds?.[lastStageName] || task?.worktreePath || undefined;

  const isHumanGate = (s: string, schema?: PipelineStageEntry[]) =>
    schema ? flattenPipelineStages(schema).some(stage => stage.name === s && stage.type === "human_confirm") : false;
  const isAwaiting = isHumanGate(status, task?.pipelineSchema);
  const isTerminal = ["completed", "error", "cancelled", "idle", "connecting"].includes(status);
  const isRunning = !isAwaiting && !isTerminal && status !== "blocked";
  const isCancellable = !isTerminal && status !== "blocked";
  const isStale = isRunning && messages.length === 0 && task !== null && (task.retryCount ?? 0) === 0;

  const statusBadgeColor = (s: string): string => {
    if (isHumanGate(s, task?.pipelineSchema)) return "bg-blue-900/50 text-blue-300";
    if (isRunning) return "bg-yellow-900/50 text-yellow-300";
    switch (s) {
      case "completed": return "bg-green-900/50 text-green-300";
      case "blocked": return "bg-orange-900/50 text-orange-300";
      case "error": return "bg-red-900/50 text-red-300";
      case "cancelled": return "bg-zinc-700/50 text-zinc-300";
      case "idle": return "bg-purple-900/50 text-purple-300";
      default: return "bg-zinc-800 text-zinc-400";
    }
  };

  const isConfirmStage = isAwaiting;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <a href="/" className="text-sm text-zinc-500 hover:text-zinc-300">&larr; {tc("back")}</a>
          <h2 className="mt-1 text-xl font-semibold">
            {task?.displayTitle && task.displayTitle !== taskId ? task.displayTitle : (status === "idle" ? t("draftTitle", { id: taskId.slice(0, 8) + "..." }) : t("taskTitle", { id: taskId.slice(0, 8) + "..." }))}
          </h2>
        </div>
        <div className="relative flex items-center gap-2">
          {totalCostUsd > 0 && (
            <CostSummary totalCostUsd={totalCostUsd} stageCosts={stageCosts} />
          )}
          {isCancellable && (
            <button onClick={handleCancel} className="rounded bg-red-800 px-3 py-1 text-xs text-red-100 hover:bg-red-700">
              {tc("cancel")}
            </button>
          )}
          {["cancelled", "error", "blocked", "idle"].includes(status) && (
            <button onClick={handleDelete} className="rounded bg-red-950 px-3 py-1 text-xs text-red-300 hover:bg-red-900">
              {tc("delete")}
            </button>
          )}
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusBadgeColor(status)}`}>
            {status}
          </span>
        </div>
      </div>

      {/* Tab Switcher */}
      <div className="flex border-b border-zinc-800">
        <button
          onClick={() => setActiveView("workflow")}
          className={`px-6 py-2 text-sm font-medium transition-all ${
            activeView === "workflow"
              ? "border-b-2 border-blue-500 text-blue-100"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {t("workflow")}
        </button>
        {task?.store && Object.keys(task.store).length > 0 && (
          <button
            onClick={() => setActiveView("summary")}
            className={`px-6 py-2 text-sm font-medium transition-all ${
              activeView === "summary"
                ? "border-b-2 border-green-500 text-green-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t("summary")}
          </button>
        )}
        <button
          onClick={() => setActiveView("config")}
          className={`flex items-center gap-2 px-6 py-2 text-sm font-medium transition-all ${
            activeView === "config"
              ? "border-b-2 border-purple-500 text-purple-100"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {t("agentConfig")}
          {status === "idle" && (
            <span className="h-1.5 w-1.5 rounded-full bg-purple-500 animate-pulse" />
          )}
        </button>
      </div>

      {activeView === "config" && task?.config ? (
        <ConfigWorkbench
          taskId={taskId}
          config={task.config as any}
          status={status}
          onLaunch={handleLaunch}
          onUpdateConfig={handleUpdateConfig}
          availableMcps={availableMcps}
        />
      ) : activeView === "summary" ? (
        <div>
          {task ? (
            <DynamicStoreViewer
              store={task.store}
              pipelineStages={task.pipelineSchema}
              branch={task.branch}
              error={task.error}
            />
          ) : (
            <p className="text-sm text-zinc-500">{t("loadingTaskData")}</p>
          )}
        </div>
      ) : (
        <>
          {/* Stage Timeline */}
          {task && status !== "connecting" && status !== "idle" && (
            <StageTimeline
              currentStatus={status}
              stageCosts={stageCosts}
              stageSessionIds={task.stageSessionIds}
              pipelineStages={task.pipelineSchema}
              onStageClick={handleStageClick}
            />
          )}

          {/* Draft Initial State Message */}
          {status === "idle" && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 py-16 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-purple-900/30 text-purple-400">
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-zinc-200">{t("taskDraftCreated")}</h3>
              <p className="mt-2 max-w-sm text-sm text-zinc-500">
                {t.rich("draftDescription", {
                  configTab: (chunks) => <button onClick={() => setActiveView("config")} className="text-purple-400 underline hover:text-purple-300">{chunks}</button>
                })}
              </p>
              <button
                onClick={handleLaunch}
                className="mt-8 rounded bg-blue-600 px-8 py-2 text-sm font-bold text-white hover:bg-blue-500 transition-colors"
              >
                {t("launchNow")}
              </button>
            </div>
          )}

          {/* Session ID + Worktree */}
          {task?.sessionId && (
            <div className={`rounded-md border px-4 py-2 text-xs font-mono space-y-1 ${
              status === "blocked"
                ? "border-orange-700 bg-orange-900/20 text-orange-300"
                : "border-zinc-800 bg-zinc-900/50 text-zinc-500"
            }`}>
              <div>
                <span className="text-zinc-400">{t("sessionId")}{task.currentStage ? ` (${task.currentStage})` : ""}: </span>
                <span className="select-all">{task.sessionId}</span>
                {isRunning && (
                  <span className="ml-2 text-yellow-600">
                    — {t("runningWarning")}
                  </span>
                )}
              </div>
              {task.worktreePath && (
                <div>
                  <span className="text-zinc-400">{t("worktree")}: </span>
                  <span className="select-all text-zinc-300">{task.worktreePath}</span>
                </div>
              )}
              {status === "blocked" && (
                <div className="text-orange-400">
                  {tc("resume")}: <span className="select-all">{`${resumeCwd ? `cd ${resumeCwd} && ` : ""}${currentStageEngine === "gemini" ? "gemini" : "claude"} --resume ${task.sessionId}`}</span>
                </div>
              )}
            </div>
          )}

          {/* Confirmation panels */}
          {isConfirmStage && (
            <ConfirmPanel
              stageName={status}
              store={task?.store}
              pipelineStages={task?.pipelineSchema}
              worktreePath={task?.worktreePath}
              repoNameOverride={repoNameOverride}
              onRepoNameChange={setRepoNameOverride}
              feedbackText={feedbackText}
              onFeedbackChange={setFeedbackText}
              onConfirm={handleConfirm}
              onReject={handleReject}
              onRejectWithFeedback={handleRejectWithFeedback}
            />
          )}

          {/* Blocked: error recovery panel */}
          {status === "blocked" && (
            <div className="rounded-md border border-orange-800 bg-orange-900/20 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-orange-300">{t("agentStopped")}</h3>
              {task?.error && (
                <p className="text-sm text-orange-200 bg-orange-950/50 rounded px-3 py-2 font-mono whitespace-pre-wrap">{task.error}</p>
              )}
              <p className="text-xs text-zinc-400">{t("agentStoppedDesc")}</p>
              <div className="flex gap-2">
                <button onClick={() => handleRetry()} className="rounded bg-orange-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-600">
                  {t("retryStage")}
                </button>
                {task?.sessionId && (
                  <button onClick={() => handleRetry(true)} className="rounded bg-blue-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-600">
                    {t("readCliChanges")}
                  </button>
                )}
                <button onClick={handleCancel} className="rounded bg-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-600">
                  {tc("cancel")}
                </button>
              </div>
              {task?.sessionId && (
                <details className="text-xs">
                  <summary className="text-zinc-500 cursor-pointer hover:text-zinc-400">{t("debugCli")}</summary>
                  <div className="mt-2 space-y-1">
                    <div className="flex items-center gap-2 rounded border border-orange-800/50 bg-zinc-900 px-3 py-1.5 font-mono text-xs text-orange-300">
                      <span className="select-all flex-1">{`${resumeCwd ? `cd ${resumeCwd} && ` : ""}${currentStageEngine === "gemini" ? "gemini" : "claude"} --resume ${task.sessionId}`}</span>
                      <button
                        onClick={() => navigator.clipboard.writeText(`${resumeCwd ? `cd ${resumeCwd} && ` : ""}${currentStageEngine === "gemini" ? "gemini" : "claude"} --resume ${task.sessionId}`)}
                        className="shrink-0 rounded bg-orange-800/50 px-2 py-0.5 text-[10px] text-orange-200 hover:bg-orange-700/50"
                      >
                        {tc("copy")}
                      </button>
                    </div>
                    <p className="text-[10px] text-zinc-500">{t("debugCliDesc")}</p>
                  </div>
                </details>
              )}
            </div>
          )}

          {/* Stale: simple retry panel */}
          {isStale && status !== "blocked" && (
            <div className="rounded-md border border-yellow-800 bg-yellow-900/20 p-4 space-y-2">
              <h3 className="text-sm font-semibold text-yellow-300">{t("taskStuck", { status })}</h3>
              <p className="text-xs text-zinc-400">{t("taskStuckDesc")}</p>
              <div className="flex gap-2">
                <button onClick={() => handleRetry()} className="rounded bg-orange-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-600">
                  {tc("retry")}
                </button>
                <button onClick={handleCancel} className="rounded bg-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-600">
                  {tc("cancel")}
                </button>
              </div>
            </div>
          )}

          {/* Auto-retrying */}
          {isRunning && (task?.retryCount ?? 0) > 0 && (
            <div className="rounded-md border border-yellow-800 bg-yellow-900/20 p-4 space-y-2">
              <h3 className="text-sm font-semibold text-yellow-300">
                {t("autoRetrying", { status, count: task?.retryCount ?? 0 })}
              </h3>
              <p className="text-xs text-zinc-400">{t("autoRetryDesc")}</p>
              <div className="flex gap-2">
                <button onClick={() => handleRetry()} className="rounded bg-orange-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-600">
                  {tc("retry")}
                </button>
                <button onClick={handleCancel} className="rounded bg-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-600">
                  {tc("cancel")}
                </button>
              </div>
            </div>
          )}

          {/* Cancelled: resume button */}
          {status === "cancelled" && (
            <div className="rounded-md border border-zinc-700 bg-zinc-800/20 p-4 space-y-2">
              <h3 className="text-sm font-semibold text-zinc-300">{t("taskCancelled")}</h3>
              <button onClick={handleResume} className="rounded bg-zinc-600 px-3 py-1 text-xs text-zinc-100 hover:bg-zinc-500">
                {tc("resume")}
              </button>
            </div>
          )}

          {/* Question panel */}
          {question && (
            <QuestionPanel
              question={question}
              answer={answer}
              onAnswerChange={setAnswer}
              onSubmit={handleAnswer}
            />
          )}

          {/* Message stream */}
          {(messages.length > 0 || isRunning || status === "connecting") && (
            <MessageStream
              messages={messages}
              isConnecting={status === "connecting"}
              scrollToStage={scrollToStage}
              isRunning={isRunning}
              elapsed={elapsed}
              agentProgress={agentProgress}
              engine={taskEngine}
              currentStage={currentStage}
              worktreePath={task?.worktreePath}
            />
          )}

          {/* Message input bar */}
          {isRunning && !isStale && (
            <div className="space-y-1">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={interruptMessage}
                  onChange={(e) => { setInterruptMessage(e.target.value); setInterruptError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }}
                  placeholder={t("interruptPlaceholder")}
                  className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none"
                />
                <button
                  onClick={handleSendMessage}
                  disabled={!interruptMessage.trim()}
                  className="rounded bg-emerald-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                >
                  {t("sendRestart")}
                </button>
              </div>
              <p className="text-[10px] text-zinc-600">{t("interruptDesc")}</p>
              {interruptError && (
                <p className={`text-xs ${interruptError === t("interruptRequested") ? "text-yellow-500" : "text-red-400"}`}>{interruptError}</p>
              )}
            </div>
          )}

          {/* Completed */}
          {status === "completed" && (
            <div className="rounded-md border border-green-800 bg-green-900/20 p-6">
              <h3 className="mb-2 text-lg font-semibold text-green-400">{t("completed")}</h3>
              {task?.completionSummary && (
                <p className="text-sm text-zinc-300">
                  {task.completionSummary.startsWith("http") ? (
                    <>{t("deliverable")}: <a href={task.completionSummary} className="text-blue-400 underline">{task.completionSummary}</a></>
                  ) : (
                    <>{t("deliverable")}: {task.completionSummary}</>
                  )}
                </p>
              )}
              {totalCostUsd > 0 && <p className="mt-1 text-sm text-zinc-400">{t("totalCostLabel", { cost: totalCostUsd.toFixed(2) })}</p>}
              {(() => {
                const pr = (task?.store as Record<string, unknown>)?.persistResult as { mcpSetupNeeded?: Array<{ name: string; envVars: string[] }> } | undefined;
                if (!pr?.mcpSetupNeeded?.length) return null;
                return (
                  <div className="mt-4 pt-3 border-t border-green-700/30">
                    <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest mb-2">{t("mcpKeysNeeded")}</p>
                    <div className="space-y-1">
                      {pr.mcpSetupNeeded.map((m) => (
                        <div key={m.name} className="text-xs text-amber-400">
                          <span className="font-mono">{m.name}</span>
                          <span className="text-zinc-500 ml-1">— set {m.envVars.join(", ")}</span>
                        </div>
                      ))}
                    </div>
                    <p className="text-[10px] text-zinc-500 mt-2">{t("mcpKeysHint")}</p>
                  </div>
                );
              })()}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default TaskPage;
