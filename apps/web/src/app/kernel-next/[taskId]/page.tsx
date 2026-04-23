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

import { useEffect, useRef, useState, useCallback } from "react";
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
        break;
      }
      case "stage_done": {
        const d = event.data as { stage: string; attemptId?: string };
        if (d.stage === EXTERNAL_STAGE) break;
        upsertStage({ stage: d.stage, state: "done", attemptId: d.attemptId });
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
  }, [upsertStage, appendPort]);

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
                <th className="border border-gray-300 px-2 py-1 text-left">Error</th>
              </tr>
            </thead>
            <tbody>
              {stageRows.map((row) => (
                <tr key={row.stage}>
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
                  <td className="border border-gray-300 px-2 py-1 text-xs text-red-600">
                    {row.state === "error" && (
                      <ErrorReasonBadge reason={row.errorReason} />
                    )}
                    {row.errorMessage ?? ""}
                  </td>
                </tr>
              ))}
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
