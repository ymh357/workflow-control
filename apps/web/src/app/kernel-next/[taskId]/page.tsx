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

import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { GateCard, type GateContextResponse } from "../../../components/gate-card";
import { DiagnosticsPanel, type Diagnostic } from "../../../components/diagnostics-panel";
import { AuditTimeline, type AuditEntry } from "../../../components/audit-timeline";
import { DiffViewer } from "../../../components/diff-viewer";
import { PipelineGraph } from "../../../components/pipeline-graph";
import { TaskActionsBar } from "../../../components/task-actions-bar";
import { SecretGatePanel } from "../../../components/secret-gate-panel";
import { CopyButton } from "../../../components/copy-button";
import type { PipelineIRLike, StageState } from "../../../lib/ir-to-flow";

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

// P7.4 follow-up: upper bound on a live-output buffer per stage. Long
// runs (large code edits, multi-minute reasoning) can emit hundreds of
// KB of text. Once exceeded we truncate from the head and prepend an
// elision marker — the user still sees the latest output, DOM + React
// state stay bounded.
const LIVE_OUTPUT_CHAR_CAP = 50_000;

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
  // P7.4 / D29 — live accumulated text-delta output keyed by stage name.
  // Entries accumulate as agent_message_delta events arrive and are
  // cleared on stage_done / stage_error so a stage re-entering
  // `executing` (retry) starts with a fresh buffer. Server-side
  // throttling caps publish rate at 10 Hz per attempt; client just
  // appends.
  const [liveOutputs, setLiveOutputs] = useState<Map<string, string>>(new Map());
  // P6.4 / D27 — per-attempt worktree diffs. Keyed by attempt_id.
  // absent key = not yet requested; null value = loading; object = loaded.
  const [attemptDiffs, setAttemptDiffs] = useState<
    Record<string, { diff: string; beforeSha: string | null; afterSha: string | null; status?: string } | null>
  >({});
  // P6.3 / D26 — hot-update audit trail. Fetched on mount and when the
  // task reaches a terminal state (task_state / run_final). There is no
  // dedicated hot_update SSE event today, so mid-run migrations only
  // surface in the timeline after the task finishes (or a manual reload).
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  // P7.1 / D21 — PipelineIR for the DAG graph. Fetched once on mount
  // from /api/kernel/tasks/:taskId/ir. The live DAG overlays stage
  // states derived from the `stages` map on top of this static layout.
  const [ir, setIr] = useState<PipelineIRLike | null>(null);

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

  // Hydrate historical port writes + seed inputs. SSE only ships events
  // produced after the client connects; re-opening a completed task
  // leaves the "Recent port writes" and "Seed Inputs" blocks empty
  // despite the data sitting in port_values. Called once on mount.
  const hydrateHistoricalPorts = useCallback(async (): Promise<void> => {
    if (!taskId) return;
    try {
      const r = await fetch(`${API_BASE}/api/kernel/tasks/${encodeURIComponent(taskId)}/ports`);
      if (!r.ok) return;
      const body = await r.json() as {
        ok: boolean;
        ports: Array<{
          stage: string;
          port: string;
          direction: "in" | "out";
          valuePreview: string;
          truncated: boolean;
          writtenAt: number;
        }>;
      };
      if (!body.ok) return;
      const recent: PortWriteRow[] = [];
      const seeds: Map<string, SeedPortEntry> = new Map();
      for (const p of body.ports) {
        if (p.direction !== "out") continue;
        if (p.stage === EXTERNAL_STAGE) {
          seeds.set(p.port, {
            value: p.valuePreview,
            timestamp: new Date(p.writtenAt).toISOString(),
          });
        } else {
          recent.push({
            stage: p.stage,
            port: p.port,
            preview: p.valuePreview,
            at: new Date(p.writtenAt).toISOString(),
          });
        }
      }
      // Keep the same "last 20" semantics as appendPort so the UI's
      // rolling feed doesn't suddenly show 500 rows for long tasks.
      setPorts(recent.slice(-20));
      setSeedPorts(seeds);
    } catch {
      /* ignore — user can reload to retry */
    }
  }, [taskId]);

  // P6.3 / D26 — fetch hot-update audit trail. Called on mount and on
  // the task's terminal SSE frames (task_state completed/failed or
  // run_final). No dedicated hot_update SSE event today — see the
  // auditEntries declaration comment for context.
  const refreshAudit = useCallback(async (): Promise<void> => {
    if (!taskId) return;
    try {
      const r = await fetch(`${API_BASE}/api/kernel/tasks/${encodeURIComponent(taskId)}/audit`);
      if (!r.ok) return;
      const body = await r.json() as { ok: boolean; events: AuditEntry[] };
      if (body.ok) setAuditEntries(body.events);
    } catch {
      /* ignore — next event or manual reload retries */
    }
  }, [taskId]);

  // P6.4 / D27 — lazy-load a single attempt's worktree diff. Sets null
  // (loading) synchronously, then resolves to the diff object or removes
  // the key on failure so a retry can be triggered.
  const loadDiff = useCallback(async (attemptId: string): Promise<void> => {
    setAttemptDiffs((prev) => ({ ...prev, [attemptId]: null }));
    try {
      const r = await fetch(
        `${API_BASE}/api/kernel/attempts/${encodeURIComponent(attemptId)}/diff`,
      );
      if (r.ok) {
        const body = await r.json() as {
          ok: boolean;
          diff: string;
          before_sha: string | null;
          after_sha: string | null;
          status?: string;
        };
        if (body.ok) {
          setAttemptDiffs((prev) => ({
            ...prev,
            [attemptId]: {
              diff: body.diff,
              beforeSha: body.before_sha,
              afterSha: body.after_sha,
              status: body.status,
            },
          }));
          return;
        }
      }
    } catch {
      /* network error — remove key so button re-appears for retry */
    }
    setAttemptDiffs((prev) => {
      const next = { ...prev };
      delete next[attemptId];
      return next;
    });
  }, []);

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
        // Refresh audit when the task reaches a terminal state — a
        // migrate or rollback may have just completed.
        if (d.state === "completed" || d.state === "failed") {
          void refreshAudit();
        }
        break;
      }
      case "stage_executing": {
        const d = event.data as { stage: string; attemptId?: string };
        // Defensive: runner should never emit stage lifecycle events for
        // the __external__ sentinel, but drop them if it ever does.
        if (d.stage === EXTERNAL_STAGE) break;
        upsertStage({ stage: d.stage, state: "executing", attemptId: d.attemptId });
        // P7.4 / D29 — clear any stale live-output text when a stage
        // re-enters executing (retry). This prevents the previous
        // attempt's transcript from bleeding into the new one.
        setLiveOutputs((prev) => {
          if (!prev.has(d.stage)) return prev;
          const next = new Map(prev);
          next.delete(d.stage);
          return next;
        });
        void refreshAttempts();
        break;
      }
      case "stage_done": {
        const d = event.data as { stage: string; attemptId?: string };
        if (d.stage === EXTERNAL_STAGE) break;
        upsertStage({ stage: d.stage, state: "done", attemptId: d.attemptId });
        setLiveOutputs((prev) => {
          if (!prev.has(d.stage)) return prev;
          const next = new Map(prev);
          next.delete(d.stage);
          return next;
        });
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
        setLiveOutputs((prev) => {
          if (!prev.has(d.stage)) return prev;
          const next = new Map(prev);
          next.delete(d.stage);
          return next;
        });
        void refreshAttempts();
        break;
      }
      case "agent_message_delta": {
        const d = event.data as {
          attemptId: string;
          stage: string;
          textDelta: string;
          role: "assistant" | "other";
        };
        if (d.stage === EXTERNAL_STAGE) break;
        setLiveOutputs((prev) => {
          const next = new Map(prev);
          const existing = next.get(d.stage) ?? "";
          const joined = existing + d.textDelta;
          // P7.4 follow-up: tail-biased buffer cap. Long-running stages
          // can emit megabytes of text; keep only the most recent
          // LIVE_OUTPUT_CHAR_CAP chars so the DOM <pre> node and the
          // React state both stay bounded. When we drop the head, prefix
          // the visible tail with an elision marker so the user knows
          // earlier content existed.
          const capped = joined.length > LIVE_OUTPUT_CHAR_CAP
            ? `… [earlier output truncated] …\n${joined.slice(-LIVE_OUTPUT_CHAR_CAP)}`
            : joined;
          next.set(d.stage, capped);
          return next;
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
        // Refresh audit on run completion — hot-update events may have
        // been written during the run (migrate/rollback).
        void refreshAudit();
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
  }, [upsertStage, appendPort, refreshAttempts, refreshAudit]);

  // Fetch attempts once on mount (and on taskId change) so the Duration
  // column is populated for tasks that are already finished when the
  // page opens. Live updates come via the SSE lifecycle events above.
  useEffect(() => { void refreshAttempts(); }, [refreshAttempts]);

  // Fetch audit once on mount so historical migrate/rollback events are
  // visible even when the task has already finished.
  useEffect(() => { void refreshAudit(); }, [refreshAudit]);

  // Hydrate port writes once on mount so historical tasks aren't blank.
  useEffect(() => { void hydrateHistoricalPorts(); }, [hydrateHistoricalPorts]);

  // Derive stage rows from historical attempts for tasks that are not
  // streaming lifecycle events (completed / failed tasks opened after
  // the fact). The live SSE path still calls upsertStage directly and
  // wins over this mirror for in-flight state because the stages state
  // already carries the latest-per-stage value after the loop below.
  useEffect(() => {
    if (attempts.length === 0) return;
    const latest = new Map<string, AttemptRow>();
    for (const a of attempts) {
      if (a.stage_name === EXTERNAL_STAGE) continue;
      const cur = latest.get(a.stage_name);
      if (!cur || a.started_at > cur.started_at) latest.set(a.stage_name, a);
    }
    for (const [stageName, a] of latest) {
      const state: StageRow["state"] =
        a.status === "success" ? "done"
        : a.status === "error" ? "error"
        : "executing";
      upsertStage({ stage: stageName, state, attemptId: a.attempt_id });
    }
  }, [attempts, upsertStage]);

  // P7.1 / D21 — fetch the task's PipelineIR once on mount. Silent on
  // failure (404 for legacy tasks with no stage_attempts, 5xx for
  // transient) — the graph simply stays hidden.
  useEffect(() => {
    if (!taskId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const r = await fetch(
          `${API_BASE}/api/kernel/tasks/${encodeURIComponent(taskId)}/ir`,
          { signal: controller.signal },
        );
        if (!r.ok) return;
        const body = await r.json() as { ok: boolean; ir?: PipelineIRLike };
        if (body.ok && body.ir) setIr(body.ir);
      } catch {
        /* ignore — graph stays hidden */
      }
    })();
    return () => controller.abort();
  }, [taskId]);

  // P7.1 / D21 — project per-stage row state into a map the PipelineGraph
  // understands. Absent stages fall back to "idle" in the renderer.
  const stageStates = useMemo<Record<string, StageState>>(() => {
    const out: Record<string, StageState> = {};
    for (const row of stages.values()) {
      out[row.stage] = row.state;
    }
    return out;
  }, [stages]);

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

  const answerGate = useCallback(async (gateId: string, answer: string, comment: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const body = comment.length > 0 ? { answer, comment } : { answer };
      const res = await fetch(
        `${API_BASE}/api/kernel/gates/${encodeURIComponent(gateId)}/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const respBody = await res.json() as {
        ok: boolean;
        diagnostics?: Array<{ message: string; code: string }>;
      };
      if (!res.ok || !respBody.ok) {
        return { ok: false, error: respBody.diagnostics?.[0]?.message ?? `HTTP ${res.status}` };
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
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Task</h1>
            <code className="rounded bg-zinc-900 px-2 py-1 font-mono text-sm text-sky-300">
              {taskId ?? "—"}
            </code>
            {taskId && <CopyButton value={taskId} label="copy" />}
          </div>
          {taskId && (
            <TaskActionsBar
              taskId={taskId}
              topState={topState}
              hasFailedStage={stageRows.some((s) => s.state === "error")}
              onStateChanged={() => { /* SSE auto-refreshes */ }}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500 animate-pulse" : "bg-zinc-600"}`}
            />
            stream {connected ? "open" : "closed"}
          </span>
          <span>·</span>
          <span>{eventCountRef.current} events</span>
          <span>·</span>
          <span>
            state:{" "}
            <span className={
              topState === "failed" ? "text-red-400"
              : topState === "completed" ? "text-emerald-400"
              : topState === "running" ? "text-blue-400"
              : "text-zinc-400"
            }>
              {topState}
            </span>
          </span>
          {cost && (
            <>
              <span>·</span>
              <span className="font-mono tabular-nums">${cost.cumulativeUsd.toFixed(4)}</span>
              <span>·</span>
              <span className="font-mono tabular-nums text-zinc-500">
                {cost.inputTokens.toLocaleString()} in / {cost.outputTokens.toLocaleString()} out
              </span>
            </>
          )}
        </div>
      </header>

      {taskId && <SecretGatePanel taskId={taskId} />}

      {seedRows.length > 0 && (
        <section className="mb-6">
          <h2 className="text-base font-semibold mb-2">
            Seed Inputs ({seedRows.length})
          </h2>
          <table className="w-full border-collapse border border-zinc-800">
            <thead className="bg-zinc-900/70">
              <tr>
                <th className="border border-zinc-800 px-2 py-1 text-left w-48">Port</th>
                <th className="border border-zinc-800 px-2 py-1 text-left">Value</th>
                <th className="border border-zinc-800 px-2 py-1 text-left w-28">Written at</th>
              </tr>
            </thead>
            <tbody>
              {seedRows.map(([port, { value, timestamp }]) => (
                <tr key={port} className="align-top">
                  <td className="border border-zinc-800 px-2 py-1 font-mono text-sm text-zinc-200">{port}</td>
                  <td className="border border-zinc-800 px-2 py-1">
                    <SeedValueCell value={value} />
                  </td>
                  <td className="border border-zinc-800 px-2 py-1 text-xs text-zinc-500 whitespace-nowrap">
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
                <section key={gid} className="mb-2 rounded border border-amber-500/50 bg-amber-500/10 p-3">
                  <p className="text-sm text-amber-200">
                    Gate <code>{gid}</code> pending — loading context…
                  </p>
                </section>
              );
            }
            return (
              <GateCard
                key={gid}
                context={ctx}
                onAnswer={(ans, comment) => answerGate(gid, ans, comment)}
              />
            );
          })}
        </div>
      )}

      <DiagnosticsPanel diagnostics={diagnostics} />

      <AuditTimeline entries={auditEntries} />

      {ir && (
        <section className="mb-6">
          <h2 className="text-base font-semibold mb-2">Pipeline DAG</h2>
          <div className="rounded-lg border border-zinc-800 overflow-hidden">
            <PipelineGraph ir={ir} stageStates={stageStates} height={560} />
          </div>
        </section>
      )}

      {liveOutputs.size > 0 && (
        <section className="mb-6">
          <h2 className="text-base font-semibold mb-2">Live output</h2>
          {Array.from(liveOutputs.entries()).map(([stage, text]) => (
            <details
              key={stage}
              open
              className="mb-2 rounded border border-sky-500/40 bg-sky-500/10 p-2"
            >
              <summary className="cursor-pointer text-xs font-semibold text-sky-200">
                {stage}
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-zinc-200">
                {text}
              </pre>
            </details>
          ))}
        </section>
      )}

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">Stages</h2>
        {stageRows.length === 0 ? (
          <p className="text-zinc-500">no stages yet</p>
        ) : (
          <table className="w-full border-collapse border border-zinc-800">
            <thead className="bg-zinc-900/70">
              <tr>
                <th className="border border-zinc-800 px-2 py-1 text-left">Stage</th>
                <th className="border border-zinc-800 px-2 py-1 text-left">State</th>
                <th className="border border-zinc-800 px-2 py-1 text-left">Attempt</th>
                <th className="border border-zinc-800 px-2 py-1 text-left">Duration</th>
                <th className="border border-zinc-800 px-2 py-1 text-left">History</th>
                <th className="border border-zinc-800 px-2 py-1 text-left">Error</th>
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
                      <td className="border border-zinc-800 px-2 py-1">{row.stage}</td>
                      <td
                        className={`border border-zinc-800 px-2 py-1 ${
                          row.state === "error" ? "text-red-600" :
                          row.state === "done" ? "text-green-600" : "text-blue-600"
                        }`}
                      >
                        {row.state}
                      </td>
                      <td className="border border-zinc-800 px-2 py-1 text-xs text-zinc-400">
                        {row.attemptId ?? "—"}
                      </td>
                      <td className="border border-zinc-800 px-2 py-1 text-xs text-zinc-300">
                        {formatDuration(latest?.duration_ms ?? null)}
                      </td>
                      <td className="border border-zinc-800 px-2 py-1 text-xs">
                        {canExpand ? (
                          <button
                            type="button"
                            onClick={() => setExpandedStage(isExpanded ? null : row.stage)}
                            className="text-sky-400 hover:text-sky-300 hover:underline"
                            aria-expanded={isExpanded}
                          >
                            {isExpanded ? "hide" : "show"} ({stageAttempts.length})
                          </button>
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </td>
                      <td className="border border-zinc-800 px-2 py-1 text-xs text-red-400">
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
                          className="border border-zinc-800 bg-zinc-900/50 px-2 py-2"
                        >
                          <table className="w-full border-collapse text-xs">
                            <thead className="text-left text-zinc-400">
                              <tr>
                                <th className="px-2 py-1">#</th>
                                <th className="px-2 py-1">attempt_id</th>
                                <th className="px-2 py-1">status</th>
                                <th className="px-2 py-1">started_at</th>
                                <th className="px-2 py-1">ended_at</th>
                                <th className="px-2 py-1">duration</th>
                                <th className="px-2 py-1">diff</th>
                              </tr>
                            </thead>
                            <tbody>
                              {stageAttempts.map((a) => (
                                <React.Fragment key={a.attempt_id}>
                                  <tr>
                                    <td className="px-2 py-1 text-zinc-400">{a.attempt_idx}</td>
                                    <td className="px-2 py-1 font-mono text-zinc-300">
                                      <Link
                                        href={`/kernel-next/attempts/${encodeURIComponent(a.attempt_id)}`}
                                        className="text-sky-400 hover:text-sky-300 hover:underline"
                                        title={a.attempt_id}
                                      >
                                        {a.attempt_id.slice(0, 8)}
                                      </Link>
                                    </td>
                                    <td
                                      className={`px-2 py-1 ${
                                        a.status === "error" ? "text-red-400" :
                                        a.status === "success" ? "text-emerald-400" :
                                        a.status === "running" ? "text-sky-400" : "text-zinc-500"
                                      }`}
                                    >
                                      {a.status}
                                    </td>
                                    <td className="px-2 py-1 text-zinc-400">
                                      {new Date(a.started_at).toLocaleTimeString()}
                                    </td>
                                    <td className="px-2 py-1 text-zinc-400">
                                      {a.ended_at !== null ? new Date(a.ended_at).toLocaleTimeString() : "—"}
                                    </td>
                                    <td className="px-2 py-1 text-zinc-300">
                                      {formatDuration(a.duration_ms)}
                                    </td>
                                    <td className="px-2 py-1">
                                      {a.attempt_id in attemptDiffs ? (
                                        attemptDiffs[a.attempt_id] === null ? (
                                          <span className="text-zinc-500">Loading…</span>
                                        ) : (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              setAttemptDiffs((prev) => {
                                                const next = { ...prev };
                                                delete next[a.attempt_id];
                                                return next;
                                              })
                                            }
                                            className="text-blue-600 hover:underline"
                                          >
                                            hide
                                          </button>
                                        )
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() => void loadDiff(a.attempt_id)}
                                          className="text-blue-600 hover:underline"
                                        >
                                          View diff
                                        </button>
                                      )}
                                    </td>
                                  </tr>
                                  {a.attempt_id in attemptDiffs && attemptDiffs[a.attempt_id] !== null && (
                                    <tr>
                                      <td colSpan={7} className="px-2 py-2">
                                        <DiffViewer
                                          diff={attemptDiffs[a.attempt_id]!.diff}
                                          beforeSha={attemptDiffs[a.attempt_id]!.beforeSha}
                                          afterSha={attemptDiffs[a.attempt_id]!.afterSha}
                                          status={attemptDiffs[a.attempt_id]!.status}
                                        />
                                      </td>
                                    </tr>
                                  )}
                                </React.Fragment>
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
        <h2 className="text-base font-semibold mb-2">
          Recent port writes
          <span className="ml-2 text-xs font-normal text-zinc-500">
            last {ports.length === 0 ? 20 : ports.length}
          </span>
        </h2>
        {ports.length === 0 ? (
          <p className="text-sm text-zinc-500">no port writes yet</p>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {ports.map((p, idx) => {
              const compact = p.preview.length > 120
                ? `${p.preview.slice(0, 120).replace(/\s+/g, " ")}…`
                : p.preview.replace(/\s+/g, " ");
              return (
                <li key={`${p.at}-${idx}`} className="px-3 py-1.5 text-xs">
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 tabular-nums text-zinc-600">
                      {new Date(p.at).toLocaleTimeString()}
                    </span>
                    <span className="shrink-0 font-mono text-zinc-300">
                      {p.stage}.<span className="text-zinc-100">{p.port}</span>
                    </span>
                    <span className="truncate font-mono text-zinc-500">
                      = {compact}
                    </span>
                    {p.preview.length > 120 && (
                      <details className="ml-auto shrink-0 text-zinc-400">
                        <summary className="cursor-pointer select-none text-zinc-500 hover:text-zinc-300">
                          full
                        </summary>
                        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200">
                          {p.preview}
                        </pre>
                      </details>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {finalResult && (
        <section className="mb-6 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="text-base font-semibold mb-2">Run final</h2>
          <p className="text-sm">
            finalState:{" "}
            <span className={finalResult.finalState === "failed" ? "text-red-400 font-semibold" : "text-emerald-400 font-semibold"}>
              {finalResult.finalState}
            </span>
          </p>
          {finalResult.stageErrors.length > 0 && (
            <>
              <p className="mt-2 font-semibold">Stage errors:</p>
              <ul className="list-disc pl-5 text-red-300">
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

// Renders a seed-input value with a 400-char preview cap. Long values
// (task descriptions, multi-line JSON) collapse behind a "show full"
// toggle so one big seed input doesn't push the rest of the page off
// the viewport.
const SEED_PREVIEW_LIMIT = 400;

function SeedValueCell({ value }: { value: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const isLong = value.length > SEED_PREVIEW_LIMIT;
  const shown = expanded || !isLong ? value : value.slice(0, SEED_PREVIEW_LIMIT) + " …";
  return (
    <div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-zinc-300">
        {shown}
      </pre>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs text-sky-400 hover:text-sky-300 hover:underline"
        >
          {expanded ? "show less" : `show full (${value.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

