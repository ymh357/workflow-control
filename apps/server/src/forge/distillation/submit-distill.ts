// Inline distillation: take a session's events, run forge-distill,
// poll until completion, return the parsed Episode[]. Designed for
// the user-triggered analyze flow — caller awaits the full result.

import type { DatabaseSync } from "node:sqlite";
import { startPipelineRun } from "../../kernel-next/runtime/start-pipeline-run.js";
import { kernelNextBroadcaster } from "../../kernel-next/sse/singleton.js";
import { readLatestPort } from "../../kernel-next/runtime/port-runtime.js";
import { KernelService } from "../../kernel-next/mcp/kernel.js";
import { listEventsBySession, setSessionStatus } from "../db/sessions.js";
import { insertEpisode } from "../db/episodes.js";
import { extractEpisodes } from "./extract.js";
import type { SessionEpisode, SessionEvent } from "../types.js";

const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
// Truncation limit on event count when building the payload — protects
// against huge sessions blowing distillation context.
const MAX_PAYLOAD_EVENTS = 800;

export type DistillResult =
  | {
      ok: true;
      episodes: SessionEpisode[];
      taskId: string;
      truncated: boolean;
      reasonNoEpisodes?: string;
    }
  | {
      ok: false;
      code: "DISTILL_SUBMIT_FAILED" | "DISTILL_TASK_FAILED" | "DISTILL_TIMEOUT" | "DISTILL_NO_OUTPUT" | "DISTILL_PARSE_FAILED";
      message: string;
      taskId?: string;
    };

export interface DistillOpts {
  forgeDb: DatabaseSync;
  kernelDb: DatabaseSync;
  sessionId: string;
  timeoutMs?: number;
  /** Allow tests to inject a fast poll loop. */
  pollIntervalMs?: number;
}

export async function distillSession(opts: DistillOpts): Promise<DistillResult> {
  const { forgeDb, kernelDb, sessionId } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;

  const events = listEventsBySession(forgeDb, sessionId);
  if (events.length < 3) {
    setSessionStatus(forgeDb, sessionId, "skipped", "too few events");
    return {
      ok: true,
      episodes: [],
      taskId: "",
      truncated: false,
      reasonNoEpisodes: `session has only ${events.length} events; minimum 3 required`,
    };
  }

  const truncated = events.length > MAX_PAYLOAD_EVENTS;
  const trimmed = truncated ? events.slice(-MAX_PAYLOAD_EVENTS) : events;
  const payload = buildPayload(sessionId, trimmed);

  const submission = await startPipelineRun({
    db: kernelDb,
    broadcaster: kernelNextBroadcaster,
    name: "forge-distill",
    seedValues: { session_payload: payload },
  });
  if (!submission.ok) {
    setSessionStatus(forgeDb, sessionId, "distillation_failed", submission.code);
    return { ok: false, code: "DISTILL_SUBMIT_FAILED", message: `${submission.code}: ${submission.message}` };
  }
  const taskId = submission.taskId;

  const svc = new KernelService(kernelDb);
  const startedAt = Date.now();
  while (true) {
    if (Date.now() - startedAt > timeoutMs) {
      setSessionStatus(forgeDb, sessionId, "distillation_failed", "timeout");
      return { ok: false, code: "DISTILL_TIMEOUT", message: `distill timed out after ${timeoutMs} ms`, taskId };
    }
    const status = svc.getTaskStatus(taskId);
    if (!status.ok) {
      // Defensive — getTaskStatus should always be ok=true at runtime.
      await sleep(pollMs);
      continue;
    }
    if (status.status === "completed") break;
    if (status.status === "failed" || status.status === "cancelled" || status.status === "orphaned") {
      setSessionStatus(forgeDb, sessionId, "distillation_failed", status.status);
      return {
        ok: false,
        code: "DISTILL_TASK_FAILED",
        message: `forge-distill task ${status.status}`,
        taskId,
      };
    }
    await sleep(pollMs);
  }

  const port = readLatestPort(kernelDb, "distill", "episodes_json", taskId);
  if (!port) {
    setSessionStatus(forgeDb, sessionId, "distillation_failed", "no episodes_json");
    return { ok: false, code: "DISTILL_NO_OUTPUT", message: "distill stage produced no episodes_json port", taskId };
  }
  const rawJson = typeof port.value === "string" ? port.value : JSON.stringify(port.value);
  let episodes: SessionEpisode[];
  try {
    episodes = extractEpisodes(rawJson, sessionId);
  } catch (err) {
    setSessionStatus(forgeDb, sessionId, "distillation_failed", "parse failed");
    return {
      ok: false,
      code: "DISTILL_PARSE_FAILED",
      message: err instanceof Error ? err.message : String(err),
      taskId,
    };
  }
  for (const ep of episodes) insertEpisode(forgeDb, ep);
  setSessionStatus(forgeDb, sessionId, "distilled");
  return {
    ok: true,
    episodes,
    taskId,
    truncated,
    reasonNoEpisodes: episodes.length === 0 ? "no pipeline-worthy episodes detected" : undefined,
  };
}

function buildPayload(sessionId: string, events: SessionEvent[]): string {
  return JSON.stringify({
    sessionId,
    eventCount: events.length,
    events: events.map((e) => ({
      seq: e.seq,
      role: e.role,
      text: e.textExcerpt ?? "",
      tool: e.toolName,
      args: e.toolArgsExcerpt ?? "",
    })),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
