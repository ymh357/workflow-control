import type { StageName } from "./stage-config.js";
import type { StageTokenUsage } from "@workflow-control/shared";
import { taskLogger } from "../lib/logger.js";

const activeQueries = new Map<string, ActiveQuery>();
const pendingResumes = new Map<string, string>(); // taskId -> userMessage

// --- Query lifecycle ---

export function registerQuery(taskId: string, activeQuery: ActiveQuery): void {
  activeQueries.set(taskId, activeQuery);
}

export function unregisterQuery(taskId: string): void {
  activeQueries.delete(taskId);
}

export function getActiveQuery(taskId: string): ActiveQuery | undefined {
  return activeQueries.get(taskId);
}

export function cancelTask(taskId: string): void {
  const active = activeQueries.get(taskId);
  if (active) {
    active.query.close();
    activeQueries.delete(taskId);
  }
  pendingResumes.delete(taskId);
}

export function queueInterruptMessage(taskId: string, message: string): boolean {
  const active = activeQueries.get(taskId);
  if (!active?.sessionId) return false;
  pendingResumes.set(taskId, message);
  return true;
}

export async function interruptActiveQuery(taskId: string): Promise<string | undefined> {
  const active = activeQueries.get(taskId);
  if (!active) return undefined;
  const sid = active.sessionId;
  taskLogger(taskId, "query-tracker").info({ stage: active.stageName, sessionId: sid }, "Executing query.interrupt()");
  try { await active.query.interrupt(); }
  catch {
    try { active.query.close(); } catch { /* best effort */ }
  } finally {
    activeQueries.delete(taskId);
  }
  return sid;
}

export function getActiveQueryInfo(taskId: string): { sessionId?: string; stageName?: string } | undefined {
  const active = activeQueries.get(taskId);
  if (!active) return undefined;
  return { sessionId: active.sessionId, stageName: active.stageName };
}

// --- Pending resume management ---

export function consumePendingResume(taskId: string): string | undefined {
  const msg = pendingResumes.get(taskId);
  if (msg !== undefined) pendingResumes.delete(taskId);
  return msg;
}

export function hasPendingResume(taskId: string): boolean {
  return pendingResumes.has(taskId);
}

// --- Types ---

export interface AgentQuery extends AsyncIterable<any> {
  interrupt(): Promise<void> | void;
  close(): void;
}

export interface ActiveQuery {
  query: AgentQuery;
  sessionId?: string;
  stageName: StageName;
}

export interface AgentResult {
  resultText: string;
  sessionId?: string;
  costUsd: number;
  durationMs: number;
  cwd?: string;
  tokenUsage?: StageTokenUsage;
}

export class AgentError extends Error {
  readonly agentStatus: string;
  constructor(agentStatus: string, message: string) {
    super(message);
    this.name = "AgentError";
    this.agentStatus = agentStatus;
  }
}
