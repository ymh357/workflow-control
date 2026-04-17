import { randomUUID } from "node:crypto";
import type { AgentResult } from "../agent/query-tracker.js";
import { taskLogger } from "../lib/logger.js";
import { getDb } from "../lib/db.js";
import { sseManager } from "../sse/manager.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const HEARTBEAT_WARN_MS = 5 * 60 * 1000; // 5 minutes — warn if no progress

export interface EdgeSlotInfo {
  taskId: string;
  stageName: string;
  createdAt: number;
  nonce: string;
}

interface EdgeSlot extends EdgeSlotInfo {
  resolve: (result: AgentResult) => void;
  reject: (error: Error) => void;
  timeoutTimer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
  lastProgressAt: number;
  heartbeatTimer?: ReturnType<typeof setTimeout>;
}

const slots = new Map<string, EdgeSlot>();

// Event listener for slot creation (used by MCP notifications + event-driven wait)
type SlotListener = (info: EdgeSlotInfo) => void;
const slotListeners = new Set<SlotListener>();

export function addSlotListener(fn: SlotListener): () => void {
  slotListeners.add(fn);
  return () => slotListeners.delete(fn);
}

function notifySlotCreated(info: EdgeSlotInfo): void {
  for (const fn of slotListeners) {
    try { fn(info); } catch { /* listener error should not break slot creation */ }
  }
}

// Task termination listeners — fired when a task reaches a terminal state
type TerminationListener = (taskId: string, reason: string) => void;
const terminationListeners = new Map<string, Set<TerminationListener>>();

export function addTaskTerminationListener(taskId: string, fn: TerminationListener): () => void {
  if (!terminationListeners.has(taskId)) terminationListeners.set(taskId, new Set());
  terminationListeners.get(taskId)!.add(fn);
  return () => {
    terminationListeners.get(taskId)?.delete(fn);
    if (terminationListeners.get(taskId)?.size === 0) terminationListeners.delete(taskId);
  };
}

export function notifyTaskTerminated(taskId: string, reason: string): void {
  const listeners = terminationListeners.get(taskId);
  if (!listeners) return;
  for (const fn of listeners) {
    try { fn(taskId, reason); } catch { /* ignore */ }
  }
  terminationListeners.delete(taskId);
}

function slotKey(taskId: string, stageName: string): string {
  return JSON.stringify([taskId, stageName]);
}

// Pending recovery: results submitted against persisted slots after server restart.
// Stored here so that when the stage re-runs (via RETRY), the new createSlot auto-resolves.
const pendingRecovery = new Map<string, AgentResult>();

export function setPendingRecovery(taskId: string, stageName: string, result: AgentResult): void {
  const key = slotKey(taskId, stageName);
  pendingRecovery.set(key, result);
  // Auto-expire after 5 minutes if not consumed
  setTimeout(() => {
    pendingRecovery.delete(key);
  }, 5 * 60 * 1000).unref();
}

export function createSlot(taskId: string, stageName: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<AgentResult> {
  const key = slotKey(taskId, stageName);

  const existing = slots.get(key);
  if (existing) {
    taskLogger(taskId).warn({ stageName }, "Replacing existing edge slot — previous invocation will error");
    clearTimeout(existing.timeoutTimer);
    if (existing.heartbeatTimer) clearTimeout(existing.heartbeatTimer);
    existing.reject(new Error(`Edge slot for "${stageName}" replaced by new invocation — previous caller should retry or abort`));
    slots.delete(key);
  }

  const nonce = randomUUID();

  return new Promise<AgentResult>((resolve, reject) => {
    const timeoutTimer = setTimeout(() => {
      const dying = slots.get(key);
      if (dying?.heartbeatTimer) clearTimeout(dying.heartbeatTimer);
      slots.delete(key);
      try {
        getDb().prepare("DELETE FROM edge_slots WHERE task_id = ? AND stage_name = ?").run(taskId, stageName);
      } catch { /* non-critical */ }
      reject(new Error(`Edge agent timed out after ${Math.round(timeoutMs / 1000)}s waiting for stage "${stageName}"`));
    }, timeoutMs);

    const info: EdgeSlotInfo = { taskId, stageName, createdAt: Date.now(), nonce };

    const slot: EdgeSlot = {
      ...info,
      resolve,
      reject,
      timeoutTimer,
      timeoutMs,
      lastProgressAt: Date.now(),
    };
    slots.set(key, slot);

    // Use recursive setTimeout instead of setInterval to avoid post-cleanup firings
    function scheduleHeartbeat() {
      slot.heartbeatTimer = setTimeout(() => {
        if (!slots.has(key)) return; // slot already cleaned up
        if (Date.now() - slot.lastProgressAt > HEARTBEAT_WARN_MS) {
          sseManager.pushMessage(taskId, {
            type: "agent_progress",
            taskId,
            timestamp: new Date().toISOString(),
            data: { phase: "heartbeat_warning", stage: stageName, silentSeconds: Math.floor((Date.now() - slot.lastProgressAt) / 1000) },
          });
          taskLogger(taskId, stageName).warn(
            { silentMs: Date.now() - slot.lastProgressAt },
            "Edge agent has not reported progress — possible crash"
          );
        }
        scheduleHeartbeat();
      }, HEARTBEAT_WARN_MS);
    }
    scheduleHeartbeat();

    try {
      getDb().prepare(
        "INSERT OR REPLACE INTO edge_slots (task_id, stage_name, nonce, created_at) VALUES (?, ?, ?, ?)"
      ).run(taskId, stageName, nonce, Date.now());
    } catch { /* non-critical — slot still works in-memory */ }

    notifySlotCreated(info);

    // Check if there's a pending recovery result for this slot (submitted after server restart)
    const recoveryKey = slotKey(taskId, stageName);
    const pending = pendingRecovery.get(recoveryKey);
    if (pending) {
      pendingRecovery.delete(recoveryKey);
      taskLogger(taskId).info({ stageName }, "Auto-resolving slot from pending recovery result");
      clearTimeout(timeoutTimer);
      if (slot.heartbeatTimer) clearTimeout(slot.heartbeatTimer);
      slots.delete(key);
      try {
        getDb().prepare("DELETE FROM edge_slots WHERE task_id = ? AND stage_name = ?").run(taskId, stageName);
      } catch { /* ignore */ }
      resolve(pending);
    }
  });
}

export type ResolveSlotResult = "resolved" | "persisted" | "nonce_mismatch" | "not_found" | "expired";

export function resolveSlot(taskId: string, stageName: string, result: AgentResult, nonce?: string): ResolveSlotResult {
  const key = slotKey(taskId, stageName);
  const slot = slots.get(key);

  if (slot) {
    if (nonce && slot.nonce !== nonce) {
      taskLogger(taskId).warn({ stageName, expected: slot.nonce, received: nonce }, "Slot nonce mismatch — rejecting stale submission");
      return "nonce_mismatch";
    }

    clearTimeout(slot.timeoutTimer);
    if (slot.heartbeatTimer) clearTimeout(slot.heartbeatTimer);
    slots.delete(key);
    slot.resolve(result);
    try {
      getDb().prepare("DELETE FROM edge_slots WHERE task_id = ? AND stage_name = ?").run(taskId, stageName);
    } catch { /* non-critical */ }
    return "resolved";
  }

  // Fallback: check DB for persisted slot (server restarted since slot was created)
  try {
    const row = getDb().prepare(
      "SELECT nonce, created_at FROM edge_slots WHERE task_id = ? AND stage_name = ?"
    ).get(taskId, stageName) as { nonce: string; created_at: number } | undefined;
    if (row) {
      // Check if slot has expired
      if (row.created_at && (Date.now() - row.created_at > DEFAULT_TIMEOUT_MS)) {
        getDb().prepare("DELETE FROM edge_slots WHERE task_id = ? AND stage_name = ?").run(taskId, stageName);
        taskLogger(taskId).warn({ stageName }, "Persisted slot expired, ignoring");
        return "expired";
      }
      if (nonce && row.nonce !== nonce) {
        taskLogger(taskId).warn({ stageName }, "Persisted slot nonce mismatch");
        return "nonce_mismatch";
      }
      getDb().prepare("DELETE FROM edge_slots WHERE task_id = ? AND stage_name = ?").run(taskId, stageName);
      taskLogger(taskId).info({ stageName }, "Resolved persisted slot (server had restarted)");
      return "persisted";
    }
  } catch { /* DB access failed */ }

  return "not_found";
}

export function rejectSlot(taskId: string, stageName: string, error: Error): boolean {
  const key = slotKey(taskId, stageName);
  const slot = slots.get(key);
  if (!slot) return false;

  clearTimeout(slot.timeoutTimer);
  if (slot.heartbeatTimer) clearTimeout(slot.heartbeatTimer);
  slots.delete(key);
  slot.reject(error);
  try {
    getDb().prepare("DELETE FROM edge_slots WHERE task_id = ? AND stage_name = ?").run(taskId, stageName);
  } catch { /* non-critical */ }
  return true;
}

const MAX_ABSOLUTE_LIFETIME_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Reset the timeout timer for an active slot. Returns true if renewed. */
export function renewSlot(taskId: string, stageName: string): boolean {
  const key = slotKey(taskId, stageName);
  const slot = slots.get(key);
  if (!slot) return false;

  if (Date.now() - slot.createdAt > MAX_ABSOLUTE_LIFETIME_MS) {
    if (slot.heartbeatTimer) clearTimeout(slot.heartbeatTimer);
    slots.delete(key);
    try {
      getDb().prepare("DELETE FROM edge_slots WHERE task_id = ? AND stage_name = ?").run(taskId, stageName);
    } catch { /* non-critical */ }
    slot.reject(new Error(`Edge slot exceeded absolute lifetime (${MAX_ABSOLUTE_LIFETIME_MS / 3600000}h) for ${stageName}`));
    return false;
  }

  clearTimeout(slot.timeoutTimer);
  slot.lastProgressAt = Date.now();
  slot.timeoutTimer = setTimeout(() => {
    if (slot.heartbeatTimer) clearTimeout(slot.heartbeatTimer);
    slots.delete(key);
    try {
      getDb().prepare("DELETE FROM edge_slots WHERE task_id = ? AND stage_name = ?").run(taskId, stageName);
    } catch { /* non-critical */ }
    slot.reject(new Error(`Edge slot timed out for ${stageName} (after renewal)`));
  }, slot.timeoutMs);

  return true;
}

export function hasSlot(taskId: string, stageName: string): boolean {
  return slots.has(slotKey(taskId, stageName));
}

export function getSlotNonce(taskId: string, stageName: string): string | undefined {
  return slots.get(slotKey(taskId, stageName))?.nonce;
}

export function getTaskSlots(taskId: string): EdgeSlotInfo[] {
  const result: EdgeSlotInfo[] = [];
  for (const slot of slots.values()) {
    if (slot.taskId === taskId) {
      result.push({ taskId: slot.taskId, stageName: slot.stageName, createdAt: slot.createdAt, nonce: slot.nonce });
    }
  }
  return result;
}

export function getAllSlots(): EdgeSlotInfo[] {
  return Array.from(slots.values()).map((s) => ({
    taskId: s.taskId,
    stageName: s.stageName,
    createdAt: s.createdAt,
    nonce: s.nonce,
  }));
}

export function clearTaskSlots(taskId: string): void {
  const toDelete: string[] = [];
  for (const [key, slot] of slots) {
    if (slot.taskId === taskId) toDelete.push(key);
  }
  for (const key of toDelete) {
    const slot = slots.get(key)!;
    clearTimeout(slot.timeoutTimer);
    if (slot.heartbeatTimer) clearTimeout(slot.heartbeatTimer);
    slot.reject(new Error("Task cancelled"));
    slots.delete(key);
    taskLogger(taskId).info({ stageName: slot.stageName }, "Edge slot cleared on cancel");
  }
  // Clean pendingRecovery for this task
  for (const key of pendingRecovery.keys()) {
    if (key.startsWith(`["${taskId}",`)) {
      pendingRecovery.delete(key);
    }
  }
  try {
    getDb().prepare("DELETE FROM edge_slots WHERE task_id = ?").run(taskId);
  } catch { /* non-critical */ }
}

// Event-driven wait: resolves when the next edge slot for this task is created,
// or rejects when the task reaches a terminal state. No fixed timeout needed.
export function waitForNextSlot(taskId: string): Promise<EdgeSlotInfo> {
  // Check existing slots first
  for (const slot of slots.values()) {
    if (slot.taskId === taskId) {
      taskLogger(taskId).info({ stageName: slot.stageName }, "waitForNextSlot: found existing slot");
      return Promise.resolve({ taskId: slot.taskId, stageName: slot.stageName, createdAt: slot.createdAt, nonce: slot.nonce });
    }
  }

  taskLogger(taskId).info("waitForNextSlot: no existing slot, listening...");

  return new Promise<EdgeSlotInfo>((resolve, reject) => {
    let settled = false;
    const WAIT_TIMEOUT_MS = 30 * 60 * 1000;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      removeSlotListener();
      removeTerminationListener();
      taskLogger(taskId).warn("waitForNextSlot: timed out");
      reject(new Error(`waitForNextSlot timed out after ${WAIT_TIMEOUT_MS / 1000}s for task ${taskId}`));
    }, WAIT_TIMEOUT_MS);

    const removeSlotListener = addSlotListener((info) => {
      if (info.taskId !== taskId || settled) return;
      settled = true;
      clearTimeout(timer);
      removeTerminationListener();
      removeSlotListener();
      taskLogger(taskId).info({ stageName: info.stageName }, "waitForNextSlot: slot appeared");
      resolve(info);
    });

    const removeTerminationListener = addTaskTerminationListener(taskId, (_, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeSlotListener();
      taskLogger(taskId).info({ reason }, "waitForNextSlot: task terminated");
      reject(new Error(`Task ${taskId} terminated: ${reason}`));
    });
  });
}
