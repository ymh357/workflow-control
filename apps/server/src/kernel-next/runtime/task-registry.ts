// Process-local registry mapping taskId -> live machine dispatcher.
//
// The kernel-next runner registers itself on start and unregisters on
// final. MCP / REST handlers that need to send events to a specific
// task's machine (primarily GATE_ANSWERED from answer_gate) look the
// dispatcher up here. This is the minimum infrastructure required to
// turn pipelines into long-running sessions — terminal design §3.3
// assumes gates pause a task for arbitrary real time.
//
// Stage 5B addition — termination signal. Runner calls signalTermination
// at run-final; external callers (migration orchestrator) awaitTermination
// to detect when it's safe to take over.

import type { EventDispatcher } from "./port-runtime.js";

export interface TerminationReason {
  kind: "natural" | "interrupted" | "error" | "never_started";
  detail?: string;
}

interface TaskEntry {
  dispatcher: EventDispatcher;
  termination: TerminationReason | null;
  waiters: Array<(r: TerminationReason) => void>;
}

class TaskRegistry {
  private readonly byTaskId = new Map<string, TaskEntry>();

  register(taskId: string, dispatcher: EventDispatcher): void {
    if (this.byTaskId.has(taskId)) {
      throw new Error(
        `TaskRegistry: taskId '${taskId}' already registered — ` +
          `double register indicates a bug in the runner lifecycle.`,
      );
    }
    this.byTaskId.set(taskId, {
      dispatcher,
      termination: null,
      waiters: [],
    });
  }

  /**
   * Stage 5B — record the runner's termination reason. Called from runner
   * at run-final. Resolves all pending awaitTermination waiters.
   */
  signalTermination(taskId: string, reason: TerminationReason): void {
    const entry = this.byTaskId.get(taskId);
    if (!entry) return;
    entry.termination = reason;
    const waiters = entry.waiters.slice();
    entry.waiters.length = 0;
    for (const fn of waiters) fn(reason);
  }

  /**
   * Stage 5B — resolve when the task terminates or when timeoutMs elapses.
   * Unregistered task: returns never_started immediately.
   * Already-signalled task (signalTermination called before
   * awaitTermination): returns the stored reason immediately.
   * Timeout: returns { kind: "never_started" } (caller treats as timeout).
   */
  awaitTermination(taskId: string, timeoutMs: number): Promise<TerminationReason> {
    const entry = this.byTaskId.get(taskId);
    if (!entry) {
      return Promise.resolve({ kind: "never_started" });
    }
    if (entry.termination !== null) {
      return Promise.resolve(entry.termination);
    }
    return new Promise<TerminationReason>((resolve) => {
      const timer = setTimeout(() => {
        const idx = entry.waiters.indexOf(wrapped);
        if (idx >= 0) entry.waiters.splice(idx, 1);
        resolve({ kind: "never_started" });
      }, timeoutMs);
      const wrapped = (r: TerminationReason): void => {
        clearTimeout(timer);
        resolve(r);
      };
      entry.waiters.push(wrapped);
    });
  }

  unregister(taskId: string): void {
    const entry = this.byTaskId.get(taskId);
    if (entry && entry.waiters.length > 0) {
      const reason: TerminationReason = entry.termination ?? { kind: "natural" };
      const waiters = entry.waiters.slice();
      entry.waiters.length = 0;
      for (const fn of waiters) fn(reason);
    }
    this.byTaskId.delete(taskId);
  }

  get(taskId: string): EventDispatcher | undefined {
    return this.byTaskId.get(taskId)?.dispatcher;
  }

  /** Test/debug helper: number of live registrations. */
  size(): number {
    return this.byTaskId.size;
  }

  /** Test-only: flush all registrations. */
  __clearForTest(): void {
    this.byTaskId.clear();
  }
}

export const taskRegistry = new TaskRegistry();
