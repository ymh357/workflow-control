"use client";

// kernel-next live observability demo page.
//
// Subscribes to GET /api/kernel-next/tasks/:taskId/stream over
// fetch-streaming (same pattern as the legacy task page so we stay
// consistent and benefit from auto-reconnect). Renders:
//   - top-level TaskMachine state
//   - seed inputs written by the runner under the __external__ sentinel
//   - per-stage table (executing/done/error + attemptId if known)
//   - recent port writes (last 20, excluding __external__ seeds)
//   - final run diagnostics (run_final payload)
//
// Deliberately minimal. The goal is end-to-end verification that
// runner → broadcaster → HTTP route → dashboard works; polished UX
// is a later concern.

import React, { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { GateCard, type GateContextResponse } from "../../../components/gate-card";
import { DiagnosticsPanel, type Diagnostic } from "../../../components/diagnostics-panel";

// Payload shape for the `diagnostics_emitted` SSE event. Kept local
// (rather than imported from server) so the web app does not reach
// across the workspace boundary for a types-only dependency; the
// contract is duplicated deliberately.
interface DiagnosticsEmittedPayload {
  source: "submit" | "migrate" | "runtime" | "validator";
  diagnostics: Diagnostic[];
}

// P6.1 / D23 — cumulative cost + token totals for the task, emitted
// by the server after each stage_done and after run_final. Shape
// mirrors apps/server TaskCostUpdateData; duplicated locally (same
// reasoning as DiagnosticsEmittedPayload above — no cross-workspace
// types-only dependency). cacheReadTokens is present for forward-
// compat but the server writes 0 today.
interface TaskCostUpdatePayload {
  cumulativeUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type TopLevelState = "idle" | "running" | "completed" | "failed" | "unknown";

type StageErrorReason = "no_active_wire" | "executor_failed";

interface StageRow {
  stage: string;
  state: "executing" | "done" | "error";
  attemptId?: string;
  errorMessage?: string;
  // Classifies an `error` state so the UI can render a reason badge
  // without regex-matching the message. Absence on older emitters is
  // treated as no_active_wire by the renderer (runner invariant).
  errorReason?: StageErrorReason;
}

// P6.2 / D24 — mirror of server's AttemptRow shape from
// routes/kernel-attempts.ts. Duplicated locally so the web app does not
// take a cross-workspace types-only import.
interface AttemptRow {
  attempt_id: string;
  stage_name: string;
  attempt_idx: number;
  status: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
}

// Formats a duration in ms into a compact, human-readable string.
// Returns an em dash for null (in-flight attempts). Matches the
// existing dashboard typography (lowercase units, no spaces).
const formatDuration = (ms: number | null): string => {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
};

interface PortWriteRow {
  stage: string;
  port: string;
  preview: string;
  at: string;
}

interface SeedPortEntry {
  value: string;
  timestamp: string;
}

// Sentinel stage name emitted by the runner when it seeds external
// inputs into the task store before any real stage runs. It is not a
// real pipeline stage — surface it separately so the stages table stays
// clean.
const EXTERNAL_STAGE = "__external__";

// Compact visual classifier for a stage_error cause. Runner currently
// emits two reasons: no_active_wire (topology — every inbound wire
// resolved false or a producer never ran) and executor_failed (the
// agent / script returned status=error or threw). Older emitters that
// pre-date the SSE reason field render as "wire" under the runner's
// backwards-compat convention.
const ErrorReasonBadge = ({ reason }: { reason?: StageErrorReason }) => {
  const isExec = reason === "executor_failed";
  const label = isExec ? "exec" : "wire";
  const title = isExec
    ? "executor_failed — stage agent/script returned error or threw"
    : "no_active_wire — every inbound wire resolved false";
  const className = isExec
    ? "mr-1 inline-block rounded bg-red-100 px-1 text-[10px] font-semibold uppercase text-red-800"
    : "mr-1 inline-block rounded bg-amber-100 px-1 text-[10px] font-semibold uppercase text-amber-800";
  return (
    <span className={className} title={title}>
      {label}
    </span>
  );
};

interface RunFinalPayload {
  finalState: "completed" | "failed";
  stageErrors: Array<{ stage: string; message: string }>;
}

interface KernelEventEnvelope {
  type: string;
  taskId: string;
  timestamp: string;
  data: unknown;
}

export default function KernelNextTaskPage() {
  const params = useParams();
  const taskIdRaw = params?.taskId;
  const taskId = Array.isArray(taskIdRaw) ? taskIdRaw[0] : taskIdRaw;

  const [topState, setTopState] = useState<TopLevelState>("unknown");
  const [stages, setStages] = useState<Map<string, StageRow>>(new Map());
  const [ports, setPorts] = useState<PortWriteRow[]>([]);
  const [seedPorts, setSeedPorts] = useState<Map<string, SeedPortEntry>>(new Map());
  const [finalResult, setFinalResult] = useState<RunFinalPayload | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [connected, setConnected] = useState(false);
  const eventCountRef = useRef(0);
  const [pendingGateIds, setPendingGateIds] = useState<string[]>([]);
  const [gateContexts, setGateContexts] = useState<Map<string, GateContextResponse>>(new Map());
  const [cost, setCost] = useState<TaskCostUpdatePayload | null>(null);
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [expandedStage, setExpandedStage] = useState<string | null>(null);

  // P6.2 / D24 — fetch per-task stage_attempts history. Called on mount
  // and whenever a stage lifecycle event fires so the Duration column
  // and the expandable Attempts sub-table stay roughly live. Errors are
  // swallowed — next lifecycle event (or page reload) will retry.
  const refreshAttempts = useCallback(async (): Promise<void> => {
    if (!taskId) return;
    try {
      const r = await fetch(`${API_BASE}/api/kernel/tasks/${encodeURIComponent(taskId)}/attempts`);
      if (!r.ok) return;
      const body = await r.json() as { ok: boolean; attempts: AttemptRow[] };
      if (body.ok) setAttempts(body.attempts);
    } catch {
      /* ignore — next event or manual reload retries */
    }
  }, [taskId]);

  const upsertStage = useCallback((row: StageRow) => {
    setStages((prev) => {
      const next = new Map(prev);
      const existing = next.get(row.stage);
      next.set(row.stage, { ...(existing ?? { stage: row.stage, state: row.state }), ...row });
      return next;
    });
  }, []);

  const appendPort = useCallback((row: PortWriteRow) => {
    setPorts((prev) => [...prev, row].slice(-20));
  }, []);

  const handleEvent = useCallback((event: KernelEventEnvelope) => {
    eventCountRef.current += 1;
    switch (event.type) {
      case "task_state": {
        const d = event.data as { state: TopLevelState };
        setTopState(d.state);
        break;
      }
      case "stage_executing": {
        const d = event.data as { stage: string; attemptId?: string };
        // Defensive: runner should never emit stage lifecycle events for
        // the __external__ sentinel, but drop them if it ever does.
        if (d.stage === EXTERNAL_STAGE) break;
        upsertStage({ stage: d.stage, state: "executing", attemptId: d.attemptId });
        void refreshAttempts();
        break;
      }
      case "stage_done": {
        const d = event.data as { stage: string; attemptId?: string };
        if (d.stage === EXTERNAL_STAGE) break;
        upsertStage({ stage: d.stage, state: "done", attemptId: d.attemptId });
        void refreshAttempts();
        break;
      }
      case "stage_error": {
        const d = event.data as {
          stage: string;
          attemptId?: string;
          message: string;
          reason?: StageErrorReason;
        };
        if (d.stage === EXTERNAL_STAGE) break;
        upsertStage({
          stage: d.stage,
          state: "error",
          attemptId: d.attemptId,
          errorMessage: d.message,
          errorReason: d.reason,
        });
        void refreshAttempts();
        break;
      }
      case "port_written": {
        const d = event.data as { stage: string; port: string; valuePreview: string };
        if (d.stage === EXTERNAL_STAGE) {
          // Seed inputs are write-once values set by the runner before
          // any stage runs. Render them in the dedicated Seed block
          // instead of the rolling ports feed / stages table.
          setSeedPorts((prev) => {
            const next = new Map(prev);
            next.set(d.port, { value: d.valuePreview, timestamp: event.timestamp });
            return next;
          });
          break;
        }
        appendPort({
          stage: d.stage,
          port: d.port,
          preview: d.valuePreview,
          at: event.timestamp,
        });
        break;
      }
      case "run_final": {
        setFinalResult(event.data as RunFinalPayload);
        break;
      }
      case "diagnostics_emitted": {
        const d = event.data as DiagnosticsEmittedPayload;
        // Accumulate across events — a single run can emit multiple
        // batches (e.g. runtime stageErrors + later submit/migrate
        // failures). Order is preserved for the Copy JSON output.
        setDiagnostics((prev) => [...prev, ...d.diagnostics]);
        break;
      }
      case "task_cost_update": {
        // P6.1 / D23 — latest cumulative totals overwrite; server
        // computes the sum so no client-side reconciliation needed.
        setCost(event.data as TaskCostUpdatePayload);
        break;
      }
      default:
        // Unknown event type — ignore gracefully so future types don't
        // break old clients.
        break;
    }
  }, [upsertStage, appendPort, refreshAttempts]);

  // Fetch attempts once on mount (and on taskId change) so the Duration
  // column is populated for tasks that are already finished when the
  // page opens. Live updates come via the SSE lifecycle events above.
  useEffect(() => { void refreshAttempts(); }, [refreshAttempts]);

  useEffect(() => {
    if (!taskId) return;
    const controller = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async (): Promise<void> => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const res = await fetch(
          `${API_BASE}/api/kernel-next/tasks/${taskId}/stream`,
          { signal: controller.signal },
        );
        if (!res.ok || !res.body) {
          scheduleReconnect();
          return;
        }
        setConnected(true);
        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            // Each frame: "event: <type>\ndata: <json>"
            // We only need the data line; the event field is
            // redundant with envelope.type. Skip heartbeats (": ...").
            const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const ev = JSON.parse(dataLine.slice(6)) as KernelEventEnvelope;
              handleEvent(ev);
            } catch {
              /* malformed frame — skip */
            }
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

    const scheduleReconnect = (): void => {
      setConnected(false);
      if (controller.signal.aborted) return;
      reconnectTimer = setTimeout(() => void connect(), 2000);
    };

    void connect();
    return () => {
      controller.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [taskId, handleEvent]);

  // B5: poll /status every 2s to discover pending gate IDs. Polling is
  // cheap at per-task granularity (one open page = one poller) and
  // avoids introducing a new SSE event type. The poll runs for the
  // lifetime of the page — aborted via the controller.
  useEffect(() => {
    if (!taskId) return;
    const controller = new AbortController();

    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(
          `${API_BASE}/api/kernel/tasks/${encodeURIComponent(taskId)}/status`,
          { signal: controller.signal },
        );
        if (!res.ok) {
          setPendingGateIds([]);
          return;
        }
        const body = await res.json() as {
          status: string;
          pending?: Array<{ gateId: string }>;
        };
        if (body.status === "gated" && Array.isArray(body.pending)) {
          setPendingGateIds(body.pending.map((g) => g.gateId));
        } else {
          setPendingGateIds([]);
        }
      } catch {
        // network error — leave last known state and retry next tick
      }
    };

    void tick();
    const interval = setInterval(() => void tick(), 2000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [taskId]);

  // B5: for every pending gateId we don't already have a context for,
  // fetch it once. Evict contexts whose gateId left pendingGateIds to
  // prevent unbounded growth on long-running tasks with many gates.
  useEffect(() => {
    if (pendingGateIds.length === 0) {
      setGateContexts((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    const controller = new AbortController();

    // Evict stale entries.
    setGateContexts((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const key of next.keys()) {
        if (!pendingGateIds.includes(key)) { next.delete(key); changed = true; }
      }
      return changed ? next : prev;
    });

    // Fetch missing entries.
    for (const id of pendingGateIds) {
      if (gateContexts.has(id)) continue;
      void (async () => {
        try {
          const res = await fetch(
            `${API_BASE}/api/kernel/gates/${encodeURIComponent(id)}/context`,
            { signal: controller.signal },
          );
          if (!res.ok) return;
          const body = await res.json() as { ok: boolean } & GateContextResponse;
          if (!body.ok) return;
          setGateContexts((prev) => {
            if (prev.has(id)) return prev;
            const next = new Map(prev);
            next.set(id, body);
            return next;
          });
        } catch {
          // network error — next poll tick can retry
        }
      })();
    }
    return () => controller.abort();
  }, [pendingGateIds, gateContexts]);

  const answerGate = useCallback(async (gateId: string, answer: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const res = await fetch(
        `${API_BASE}/api/kernel/gates/${encodeURIComponent(gateId)}/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer }),
        },
      );
      const body = await res.json() as {
        ok: boolean;
        diagnostics?: Array<{ message: string; code: string }>;
      };
      if (!res.ok || !body.ok) {
        return { ok: false, error: body.diagnostics?.[0]?.message ?? `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, []);

  const stageRows = Array.from(stages.values()).sort((a, b) => a.stage.localeCompare(b.stage));
  const seedRows = Array.from(seedPorts.entries()).sort(([a], [b]) => a.localeCompare(b));

  // P6.2 / D24 — group attempts by stage_name for the expandable row +
  // pick the "latest" attempt (highest started_at) per stage for the
  // Duration column. attempts[] is already started_at-ASC from the
  // server so the last entry per stage wins.
  const attemptsByStage = new Map<string, AttemptRow[]>();
  for (const a of attempts) {
    const list = attemptsByStage.get(a.stage_name);
    if (list) list.push(a);
    else attemptsByStage.set(a.stage_name, [a]);
  }
  const latestAttemptByStage = new Map<string, AttemptRow>();
  for (const [stage, list] of attemptsByStage) {
    latestAttemptByStage.set(stage, list[list.length - 1]!);
  }

  return (
    <div className="mx-auto max-w-5xl p-6 font-mono text-sm">
      <h1 className="mb-4 text-xl font-bold">
        kernel-next task: <span className="text-blue-600">{taskId ?? "—"}</span>
      </h1>

      <div className="mb-4 flex items-center gap-4">
        <span>
          Connection:{" "}
          <span className={connected ? "text-green-600" : "text-red-600"}>
            {connected ? "open" : "closed"}
          </span>
        </span>
        <span>Events received: {eventCountRef.current}</span>
        <span>
          State:{" "}
          <span className={topState === "failed" ? "text-red-600" : topState === "completed" ? "text-green-600" : "text-gray-700"}>
            {topState}
          </span>
        </span>
        {cost && (
          <>
            <span>
              Cost:{" "}
              <span className="font-mono">${cost.cumulativeUsd.toFixed(4)}</span>
            </span>
            <span>
              Tokens: {cost.inputTokens.toLocaleString()}&uarr;{" "}
              / {cost.outputTokens.toLocaleString()}&darr;
            </span>
          </>
        )}
      </div>

      {seedRows.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 font-semibold">
            Seed Inputs ({seedRows.length})
          </h2>
          <table className="w-full border-collapse border border-gray-300">
            <thead className="bg-gray-100">
              <tr>
                <th className="border border-gray-300 px-2 py-1 text-left">Port</th>
                <th className="border border-gray-300 px-2 py-1 text-left">Value</th>
                <th className="border border-gray-300 px-2 py-1 text-left">Written at</th>
              </tr>
            </thead>
            <tbody>
              {seedRows.map(([port, { value, timestamp }]) => (
                <tr key={port}>
                  <td className="border border-gray-300 px-2 py-1 font-semibold">{port}</td>
                  <td className="border border-gray-300 px-2 py-1 break-all text-gray-700">
                    <code>{value}</code>
                  </td>
                  <td className="border border-gray-300 px-2 py-1 text-xs text-gray-500">
                    {new Date(timestamp).toLocaleTimeString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {pendingGateIds.length > 0 && (
        <div className="mb-6">
          {pendingGateIds.map((gid) => {
            const ctx = gateContexts.get(gid);
            if (!ctx) {
              return (
                <section key={gid} className="mb-2 rounded border border-amber-400 bg-amber-50 p-3">
                  <p className="text-sm text-amber-900">
                    Gate <code>{gid}</code> pending — loading context…
                  </p>
                </section>
              );
            }
            return (
              <GateCard
                key={gid}
                context={ctx}
                onAnswer={(ans) => answerGate(gid, ans)}
              />
            );
          })}
        </div>
      )}

      <DiagnosticsPanel diagnostics={diagnostics} />

      <section className="mb-6">
        <h2 className="mb-2 font-semibold">Stages</h2>
        {stageRows.length === 0 ? (
          <p className="text-gray-500">no stages yet</p>
        ) : (
          <table className="w-full border-collapse border border-gray-300">
            <thead className="bg-gray-100">
              <tr>
                <th className="border border-gray-300 px-2 py-1 text-left">Stage</th>
                <th className="border border-gray-300 px-2 py-1 text-left">State</th>
                <th className="border border-gray-300 px-2 py-1 text-left">Attempt</th>
                <th className="border border-gray-300 px-2 py-1 text-left">Duration</th>
                <th className="border border-gray-300 px-2 py-1 text-left">History</th>
                <th className="border border-gray-300 px-2 py-1 text-left">Error</th>
              </tr>
            </thead>
            <tbody>
              {stageRows.map((row) => {
                const stageAttempts = attemptsByStage.get(row.stage) ?? [];
                const latest = latestAttemptByStage.get(row.stage);
                const isExpanded = expandedStage === row.stage;
                const canExpand = stageAttempts.length > 0;
                return (
                  <React.Fragment key={row.stage}>
                    <tr>
                      <td className="border border-gray-300 px-2 py-1">{row.stage}</td>
                      <td
                        className={`border border-gray-300 px-2 py-1 ${
                          row.state === "error" ? "text-red-600" :
                          row.state === "done" ? "text-green-600" : "text-blue-600"
                        }`}
                      >
                        {row.state}
                      </td>
                      <td className="border border-gray-300 px-2 py-1 text-xs text-gray-600">
                        {row.attemptId ?? "—"}
                      </td>
                      <td className="border border-gray-300 px-2 py-1 text-xs text-gray-700">
                        {formatDuration(latest?.duration_ms ?? null)}
                      </td>
                      <td className="border border-gray-300 px-2 py-1 text-xs">
                        {canExpand ? (
                          <button
                            type="button"
                            onClick={() => setExpandedStage(isExpanded ? null : row.stage)}
                            className="text-blue-600 hover:underline"
                            aria-expanded={isExpanded}
                          >
                            {isExpanded ? "hide" : "show"} ({stageAttempts.length})
                          </button>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="border border-gray-300 px-2 py-1 text-xs text-red-600">
                        {row.state === "error" && (
                          <ErrorReasonBadge reason={row.errorReason} />
                        )}
                        {row.errorMessage ?? ""}
                      </td>
                    </tr>
                    {isExpanded && canExpand && (
                      <tr>
                        <td
                          colSpan={6}
                          className="border border-gray-300 bg-gray-50 px-2 py-2"
                        >
                          <table className="w-full border-collapse text-xs">
                            <thead className="text-left text-gray-600">
                              <tr>
                                <th className="px-2 py-1">#</th>
                                <th className="px-2 py-1">attempt_id</th>
                                <th className="px-2 py-1">status</th>
                                <th className="px-2 py-1">started_at</th>
                                <th className="px-2 py-1">ended_at</th>
                                <th className="px-2 py-1">duration</th>
                              </tr>
                            </thead>
                            <tbody>
                              {stageAttempts.map((a) => (
                                <tr key={a.attempt_id}>
                                  <td className="px-2 py-1 text-gray-600">{a.attempt_idx}</td>
                                  <td className="px-2 py-1 font-mono text-gray-700">{a.attempt_id}</td>
                                  <td
                                    className={`px-2 py-1 ${
                                      a.status === "error" ? "text-red-600" :
                                      a.status === "success" ? "text-green-600" :
                                      a.status === "running" ? "text-blue-600" : "text-gray-500"
                                    }`}
                                  >
                                    {a.status}
                                  </td>
                                  <td className="px-2 py-1 text-gray-600">
                                    {new Date(a.started_at).toLocaleTimeString()}
                                  </td>
                                  <td className="px-2 py-1 text-gray-600">
                                    {a.ended_at !== null ? new Date(a.ended_at).toLocaleTimeString() : "—"}
                                  </td>
                                  <td className="px-2 py-1 text-gray-700">
                                    {formatDuration(a.duration_ms)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="mb-6">
        <h2 className="mb-2 font-semibold">Recent port writes (last 20)</h2>
        {ports.length === 0 ? (
          <p className="text-gray-500">no port writes yet</p>
        ) : (
          <ul className="divide-y divide-gray-200 border border-gray-300">
            {ports.map((p, idx) => (
              <li key={`${p.at}-${idx}`} className="px-2 py-1">
                <span className="text-gray-500">{new Date(p.at).toLocaleTimeString()}</span>{" "}
                <span className="font-semibold">{p.stage}.{p.port}</span>{" "}
                <span className="text-gray-700">= {p.preview}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {finalResult && (
        <section className="mb-6 rounded border border-gray-400 bg-gray-50 p-3">
          <h2 className="mb-2 font-semibold">Run final</h2>
          <p>
            finalState:{" "}
            <span className={finalResult.finalState === "failed" ? "text-red-600" : "text-green-600"}>
              {finalResult.finalState}
            </span>
          </p>
          {finalResult.stageErrors.length > 0 && (
            <>
              <p className="mt-2 font-semibold">Stage errors:</p>
              <ul className="list-disc pl-5 text-red-700">
                {finalResult.stageErrors.map((e, idx) => (
                  <li key={idx}>
                    <span className="font-semibold">{e.stage}</span>: {e.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}
