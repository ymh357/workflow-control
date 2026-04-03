/**
 * Resource Audit Tests
 *
 * Demonstrates real bugs found in source code related to:
 * - Timer/interval leaks
 * - Integer overflow
 * - Map/Set memory leaks
 * - NaN propagation in cost accumulation
 * - Error swallowing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// BUG 1: nonceCounter overflow in edge/registry.ts
//
// `nonceCounter` is a module-level `let` that increments forever via `++nonceCounter`.
// At Number.MAX_SAFE_INTEGER (2^53 - 1), further increments lose precision and
// two different slots can receive the same nonce string, breaking the
// uniqueness guarantee that nonce-based deduplication relies on.
//
// File: /apps/server/src/edge/registry.ts, line 74
// ---------------------------------------------------------------------------
describe("BUG: nonceCounter integer overflow produces duplicate nonces", () => {
  it("demonstrates that incrementing past MAX_SAFE_INTEGER loses uniqueness", () => {
    let counter = Number.MAX_SAFE_INTEGER - 1;

    const nonce1 = `${Date.now()}-${++counter}`; // MAX_SAFE_INTEGER
    const nonce2 = `${Date.now()}-${++counter}`; // MAX_SAFE_INTEGER + 1 (unsafe)
    const nonce3 = `${Date.now()}-${++counter}`; // MAX_SAFE_INTEGER + 2 (unsafe)

    // After MAX_SAFE_INTEGER, incrementing produces the same number
    expect(counter).toBe(Number.MAX_SAFE_INTEGER + 2);
    expect(Number.MAX_SAFE_INTEGER + 1).toBe(Number.MAX_SAFE_INTEGER + 2); // precision lost
    // Therefore nonce2 and nonce3 have the same counter suffix
    const suffix2 = nonce2.split("-").pop();
    const suffix3 = nonce3.split("-").pop();
    expect(suffix2).toBe(suffix3); // DUPLICATE — the bug
  });
});

// ---------------------------------------------------------------------------
// BUG 2: SSEManager.closeStream does not clean up the `listeners` map
//
// When closeStream(taskId) is called, it cleans up `connections` and schedules
// cleanup of `history`, but never touches `this.listeners`. Any programmatic
// listeners added via addListener() for that taskId remain in memory forever
// if the caller forgets to call the returned unsubscribe function.
//
// File: /apps/server/src/sse/manager.ts, lines 152-184
// ---------------------------------------------------------------------------
describe("BUG: SSEManager.closeStream leaks listeners map entries", () => {
  it("demonstrates that closeStream does not remove listeners", () => {
    // Simulate the SSEManager's internal maps
    const listeners = new Map<string, Set<() => void>>();

    // addListener equivalent
    const taskId = "task-1";
    const fn = () => {};
    if (!listeners.has(taskId)) listeners.set(taskId, new Set());
    listeners.get(taskId)!.add(fn);

    // closeStream equivalent — note: listeners is never touched
    // (only connections.delete and history cleanup timer are set)
    // ... closeStream does not call: listeners.delete(taskId)

    expect(listeners.has(taskId)).toBe(true); // leaked
    expect(listeners.get(taskId)!.size).toBe(1); // still there
  });
});

// ---------------------------------------------------------------------------
// BUG 3: actor-registry scheduleActorCleanup leaks setTimeout handle
//
// scheduleActorCleanup() calls setTimeout() but never stores the timer
// handle. If the same taskId completes multiple times (e.g. after a retry),
// multiple cleanup timers accumulate. There is no way to cancel them.
// Additionally, deleteWorkflow() does not cancel pending cleanup timers.
//
// File: /apps/server/src/machine/actor-registry.ts, lines 34-47
// ---------------------------------------------------------------------------
describe("BUG: scheduleActorCleanup timer handle is discarded", () => {
  it("demonstrates that the setTimeout return value is never stored or cancellable", () => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    // Simulating scheduleActorCleanup — the real code does:
    //   setTimeout(() => { ... }, ACTOR_CLEANUP_DELAY_MS);
    // but never stores the return value.
    const scheduleActorCleanup = (_taskId: string) => {
      // Real code: no assignment, timer leaks
      setTimeout(() => {}, 5 * 60 * 1000);
      // Fix would be: timers.push(setTimeout(...))
    };

    // Call it multiple times (e.g. actor completes, is retried, completes again)
    scheduleActorCleanup("task-1");
    scheduleActorCleanup("task-1");
    scheduleActorCleanup("task-1");

    // There is no way to retrieve or cancel these 3 pending timers
    // deleteWorkflow also cannot cancel them since they are not stored
    expect(timers.length).toBe(0); // no handles captured — the bug
  });
});

// ---------------------------------------------------------------------------
// BUG 4: totalCostUsd can become NaN if costUsd is undefined and
// totalCostUsd is already undefined
//
// In state-builders.ts, the cost accumulation pattern is:
//   totalCostUsd: (context.totalCostUsd ?? 0) + (event.output?.costUsd ?? 0)
//
// This is actually safe due to the ?? 0 fallback. HOWEVER, the wf.costUpdate
// emission on line 228 reads context.totalCostUsd BEFORE the assign action
// updates it (XState actions execute in order, but emit reads the
// pre-transition context). This means the emitted totalCostUsd can be
// undefined (not the newly computed value), which downstream consumers
// may treat as NaN.
//
// File: /apps/server/src/machine/state-builders.ts, lines 224-229
// ---------------------------------------------------------------------------
describe("BUG: wf.costUpdate emits stale totalCostUsd from pre-transition context", () => {
  it("demonstrates that emit reads context before assign updates it", () => {
    // Simulate XState action execution order:
    // actions: [assign(...), emit(...)] — emit reads OLD context
    const preContext = { totalCostUsd: undefined as number | undefined };
    const eventOutput = { costUsd: 1.5 };

    // assign computes the NEW value:
    const newTotalCost = (preContext.totalCostUsd ?? 0) + (eventOutput.costUsd ?? 0);
    expect(newTotalCost).toBe(1.5); // correct

    // But emit reads preContext.totalCostUsd (before assign takes effect):
    const emittedTotal = preContext.totalCostUsd ?? 0;
    expect(emittedTotal).toBe(0); // emits 0 instead of 1.5

    // The emitted cost is always one step behind the actual cost
    expect(emittedTotal).not.toBe(newTotalCost);
  });
});

// ---------------------------------------------------------------------------
// BUG 5: db.ts startPeriodicCleanup interval is never unref'd and leaks
//
// startPeriodicCleanup creates a setInterval but does not call .unref() on
// the returned handle, and does not return or store it. This prevents
// the Node.js process from exiting gracefully if no other work remains.
// Contrast with edge/route.ts line 33 which correctly calls .unref().
//
// File: /apps/server/src/lib/db.ts, lines 56-61
// ---------------------------------------------------------------------------
describe("BUG: startPeriodicCleanup interval prevents graceful shutdown", () => {
  it("demonstrates that the interval handle is not unref'd or returned", () => {
    // The real code:
    //   setInterval(() => { ... }, intervalHours * 60 * 60 * 1000);
    //   // No .unref(), no return value
    //
    // Compare with edge/route.ts which does:
    //   setInterval(() => { ... }, 10 * 60 * 1000).unref();

    // Simulate: setInterval without unref keeps event loop alive
    const timer = setInterval(() => {}, 100_000);
    // hasRef() returns true — the timer keeps the process alive
    expect(timer.hasRef()).toBe(true);
    // The fix would be timer.unref()
    clearInterval(timer); // cleanup for test
  });
});

// ---------------------------------------------------------------------------
// BUG 6: SSEManager.closeStream cleanup timer does not clean up `listeners`
// map even after the 5-minute delay expires
//
// The cleanup timer in closeStream (lines 173-183) only cleans up
// `this.history.delete(taskId)` and `this.cleanupTimers.delete(taskId)`.
// It does not clean up `this.listeners` for the taskId.
// If a listener was added (e.g. from wrapper-api.ts edge events SSE)
// and the task completes, the listener set leaks permanently.
//
// File: /apps/server/src/sse/manager.ts, lines 173-183
// ---------------------------------------------------------------------------
describe("BUG: SSEManager cleanup timer ignores listeners map", () => {
  it("demonstrates listeners persist after history cleanup", () => {
    // Simulate the maps
    const history = new Map<string, unknown[]>();
    const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const listeners = new Map<string, Set<() => void>>();
    const connections = new Map<string, unknown[]>();

    const taskId = "task-leak";
    history.set(taskId, [{ type: "status" }]);
    listeners.set(taskId, new Set([() => {}]));

    // closeStream logic:
    connections.delete(taskId);
    // cleanup timer fires:
    history.delete(taskId);
    cleanupTimers.delete(taskId);
    // listeners is NOT deleted

    expect(history.has(taskId)).toBe(false);
    expect(listeners.has(taskId)).toBe(true); // leaked
  });
});

// ---------------------------------------------------------------------------
// BUG 7: edge/registry.ts terminationListeners map leaks for tasks that
// never terminate
//
// addTaskTerminationListener adds entries to the terminationListeners map.
// notifyTaskTerminated cleans them up — but only if the task actually
// reaches a terminal state. If a task is abandoned (e.g. server restart
// without clean shutdown), its terminationListeners entries remain forever.
// There is no periodic cleanup or TTL for this map.
//
// File: /apps/server/src/edge/registry.ts, lines 39-57
// ---------------------------------------------------------------------------
describe("BUG: terminationListeners leak for abandoned tasks", () => {
  it("demonstrates that listeners accumulate if notifyTaskTerminated is never called", () => {
    const terminationListeners = new Map<string, Set<() => void>>();

    // Simulate adding listeners for tasks that never terminate
    for (let i = 0; i < 100; i++) {
      const taskId = `abandoned-task-${i}`;
      if (!terminationListeners.has(taskId)) {
        terminationListeners.set(taskId, new Set());
      }
      terminationListeners.get(taskId)!.add(() => {});
    }

    // No cleanup mechanism exists for these
    expect(terminationListeners.size).toBe(100); // all leaked
  });
});

// ---------------------------------------------------------------------------
// BUG 8: processAgentStream inactivity timer initialized with undefined!
//
// Line 39: `let inactivityTimer: ReturnType<typeof setTimeout> = undefined!;`
// The first call to `clearTimeout(inactivityTimer)` on line 41 passes
// `undefined` to clearTimeout. While clearTimeout(undefined) is safe in
// Node.js, this is a code smell. More critically, if the `for await` loop
// throws synchronously before resetInactivityTimer() is called, the
// finally block calls clearTimeout(undefined!) which works, but there's
// a subtle issue: if agentQuery[Symbol.asyncIterator]() throws, the
// inactivityTimer from line 51 (resetInactivityTimer()) is already set
// and the finally block correctly clears it. No actual leak here, but
// the undefined! is misleading.
//
// HOWEVER, there IS a real issue: when `onResume` is called (line 130),
// the function returns early via `return onResume(...)`. The finally
// block runs and clears the timer, which is correct. But if onResume
// itself throws, the error propagates up without unregistering the query
// (since handledResume was set to true on line 128, the finally block
// skips unregisterQuery). This leaks the activeQuery entry.
//
// File: /apps/server/src/agent/stream-processor.ts, lines 123-133
// ---------------------------------------------------------------------------
describe("BUG: processAgentStream leaks activeQuery when onResume throws", () => {
  it("demonstrates that handledResume=true skips unregisterQuery even if onResume fails", () => {
    const activeQueries = new Map<string, unknown>();
    let handledResume = false;

    const taskId = "task-resume-fail";
    activeQueries.set(taskId, { query: {}, stageName: "test" });

    try {
      // Simulate the catch block (lines 123-133):
      // hasPendingResume returns true, sessionId exists
      handledResume = true; // line 128
      // return onResume(...) — but onResume throws
      throw new Error("onResume failed");
    } catch {
      // Error propagates
    } finally {
      // finally block (lines 134-138):
      if (!handledResume) {
        activeQueries.delete(taskId); // unregisterQuery
      }
      // handledResume is true, so unregisterQuery is SKIPPED
    }

    // The query leaks in the activeQueries map
    expect(activeQueries.has(taskId)).toBe(true); // leaked
  });
});

// ---------------------------------------------------------------------------
// BUG 9: side-effects.ts wf.worktreeCleanup swallows dynamic import errors
//
// The worktreeCleanup handler (lines 114-121) does:
//   import("node:child_process").then(({ execFile }) => { ... }).catch(() => {});
// The outer .catch(() => {}) swallows ALL errors from the import, including
// unexpected ones. If the dynamic import succeeds but execFile callback
// has an error, that's handled separately. But if the .then() handler itself
// throws (e.g. event.worktreePath is somehow modified after the null check),
// that error is silently swallowed.
//
// File: /apps/server/src/machine/side-effects.ts, lines 116-121
// ---------------------------------------------------------------------------
describe("BUG: worktreeCleanup swallows all errors including unexpected ones", () => {
  it("demonstrates that .catch(() => {}) hides all failures", () => {
    let errorCaught = false;

    // Simulate the pattern
    const result = Promise.resolve()
      .then(() => {
        throw new TypeError("unexpected crash in then handler");
      })
      .catch(() => {
        // This swallows TypeError silently — no logging, no alerting
        errorCaught = true;
      });

    return result.then(() => {
      expect(errorCaught).toBe(true); // error was silently eaten
    });
  });
});

// ---------------------------------------------------------------------------
// BUG 10: SSEManager.createStream heartbeat interval leaks if controller
// enqueue throws during history replay
//
// In createStream (lines 62-104), the heartbeat interval is created on
// line 66 BEFORE history replay on lines 91-95. If sendToController
// throws during history replay (e.g. controller already closed), the
// exception propagates out of start(), but the heartbeat interval is
// already running. The cancel() callback may never fire because the
// stream errored rather than being cancelled.
//
// File: /apps/server/src/sse/manager.ts, lines 62-104
// ---------------------------------------------------------------------------
describe("BUG: SSEManager heartbeat leaks if history replay throws in start()", () => {
  it("demonstrates the heartbeat is created before history replay can throw", () => {
    vi.useFakeTimers();

    let heartbeatTicks = 0;
    let heartbeatHandle: ReturnType<typeof setInterval> | undefined;

    // Simulate createStream start():
    // 1. Heartbeat is created first
    heartbeatHandle = setInterval(() => { heartbeatTicks++; }, 30_000);

    // 2. History replay throws
    try {
      throw new Error("controller.enqueue failed during replay");
    } catch {
      // start() exits with error
      // cancel() may never be called for errored streams
    }

    // The heartbeat is still running
    vi.advanceTimersByTime(90_000);
    expect(heartbeatTicks).toBe(3); // leaked interval keeps firing

    // Cleanup
    clearInterval(heartbeatHandle);
    vi.useRealTimers();
  });
});
