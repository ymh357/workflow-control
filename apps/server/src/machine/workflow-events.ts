import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { taskLogger } from "../lib/logger.js";
import { loadSystemSettings } from "../lib/config-loader.js";

// --- Types ---

export type WorkflowEventType =
  | "stage_started"
  | "stage_completed"
  | "stage_failed"
  | "stage_skipped"
  | "retry"
  | "retry_from"
  | "gate_approved"
  | "gate_rejected"
  | "gate_feedback"
  | "store_write"
  | "cost_update"
  | "task_interrupted"
  | "task_cancelled";

export interface WorkflowEvent {
  id: number;
  ts: string;
  type: WorkflowEventType;
  stage?: string;
  payload?: Record<string, unknown>;
}

// --- Paths ---

export function eventsPath(taskId: string): string {
  const settings = loadSystemSettings();
  const dataDir = settings.paths?.data_dir || "/tmp/workflow-control-data";
  return join(dataDir, "tasks", taskId, "events.jsonl");
}

// --- Write ---

export async function appendEvent(taskId: string, event: WorkflowEvent): Promise<void> {
  const p = eventsPath(taskId);
  try {
    await mkdir(dirname(p), { recursive: true });
    await appendFile(p, JSON.stringify(event) + "\n");
  } catch (err) {
    taskLogger(taskId).error({ err }, "append workflow event failed");
  }
}

// --- Read ---

export function loadEvents(taskId: string): WorkflowEvent[] {
  const p = eventsPath(taskId);
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
    const events: WorkflowEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
    return events;
  } catch (err) {
    taskLogger(taskId).error({ err }, "load workflow events failed");
    return [];
  }
}
