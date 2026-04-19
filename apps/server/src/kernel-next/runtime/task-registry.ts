// Process-local registry mapping taskId -> live machine dispatcher.
//
// The kernel-next runner registers itself on start and unregisters on
// final. MCP / REST handlers that need to send events to a specific
// task's machine (primarily GATE_ANSWERED from answer_gate) look the
// dispatcher up here. This is the minimum infrastructure required to
// turn pipelines into long-running sessions — terminal design §3.3
// assumes gates pause a task for arbitrary real time.
//
// Scope: single process, single user. No cross-process coordination,
// no persistence, no auth. The registry resets on restart; any task
// that was gated at restart needs explicit rehydration (deferred —
// today we tell the caller the task is stuck until cancelled). That
// escalation lives in a later phase; A1.2b.2 only handles the
// happy in-process path.

import type { EventDispatcher } from "./port-runtime.js";

class TaskRegistry {
  private readonly byTaskId = new Map<string, EventDispatcher>();

  register(taskId: string, dispatcher: EventDispatcher): void {
    if (this.byTaskId.has(taskId)) {
      throw new Error(
        `TaskRegistry: taskId '${taskId}' already registered — ` +
          `double register indicates a bug in the runner lifecycle.`,
      );
    }
    this.byTaskId.set(taskId, dispatcher);
  }

  unregister(taskId: string): void {
    this.byTaskId.delete(taskId);
  }

  get(taskId: string): EventDispatcher | undefined {
    return this.byTaskId.get(taskId);
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
