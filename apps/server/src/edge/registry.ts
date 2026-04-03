import { randomUUID } from "node:crypto";
import type { AgentResult } from "../agent/query-tracker.js";
import { taskLogger } from "../lib/logger.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

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

export function createSlot(taskId: string, stageName: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<AgentResult> {
  const key = slotKey(taskId, stageName);

  const existing = slots.get(key);
  if (existing) {
    taskLogger(taskId).warn({ stageName }, "Replacing existing edge slot — previous invocation will error");
    clearTimeout(existing.timeoutTimer);
    existing.reject(new Error(`Edge slot for "${stageName}" replaced by new invocation — previous caller should retry or abort`));
    slots.delete(key);
  }

  const nonce = randomUUID();

  return new Promise<AgentResult>((resolve, reject) => {
    const timeoutTimer = setTimeout(() => {
      slots.delete(key);
      reject(new Error(`Edge agent timed out after ${Math.round(timeoutMs / 1000)}s waiting for stage "${stageName}"`));
    }, timeoutMs);

    const info: EdgeSlotInfo = { taskId, stageName, createdAt: Date.now(), nonce };

    slots.set(key, {
      ...info,
      resolve,
      reject,
      timeoutTimer,
    });

    notifySlotCreated(info);
  });
}

export function resolveSlot(taskId: string, stageName: string, result: AgentResult, nonce?: string): boolean {
  const key = slotKey(taskId, stageName);
  const slot = slots.get(key);
  if (!slot) return false;

  if (nonce && slot.nonce !== nonce) {
    taskLogger(taskId).warn({ stageName, expected: slot.nonce, received: nonce }, "Slot nonce mismatch — rejecting stale submission");
    return false;
  }

  clearTimeout(slot.timeoutTimer);
  slots.delete(key);
  slot.resolve(result);
  return true;
}

export function rejectSlot(taskId: string, stageName: string, error: Error): boolean {
  const key = slotKey(taskId, stageName);
  const slot = slots.get(key);
  if (!slot) return false;

  clearTimeout(slot.timeoutTimer);
  slots.delete(key);
  slot.reject(error);
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
    slot.reject(new Error("Task cancelled"));
    slots.delete(key);
    taskLogger(taskId).info({ stageName: slot.stageName }, "Edge slot cleared on cancel");
  }
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
