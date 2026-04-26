## Summary

Extract the per-attempt SDK lifecycle (abort controller, MCP server factory, heartbeat timer, stream pump, writer close) from `RealStageExecutor.doAttempt()` into a new `SdkAttemptRunner` class. This reduces `doAttempt` from ~570 lines to ~150-200 lines of orchestration, following the precedent set by `stream-pump.ts` and `real-executor-sdk-options.ts`. The refactor improves testability, readability, and isolates critical F22 lifecycle semantics into a single well-scoped responsibility.

## Files touched

- **real-executor.ts** (lines 322–890): Remove SDK lifecycle code from `doAttempt()` method; instantiate and delegate to `SdkAttemptRunner`; keep orchestration shell (attempt start, input gathering, prompt resolution, output validation)
- **sdk-attempt-runner.ts** (new file): New class owning the complete SDK attempt lifecycle: abort controller, MCP server instantiation, signal→INTERRUPT bridging, heartbeat timer, stream pump execution, writer coordination, and cleanup

## Files explicitly NOT touched

- **stream-pump.ts** — Already extracted; reused by the new class, no changes
- **real-executor-sdk-options.ts** — Reused to build SDK options, no changes
- **execution-record-writer.ts** — Interface and contract unchanged; called from new class instead of doAttempt
- **agent-machine.ts, sdk-adapter.ts, agent-message-delta.ts** — Used unchanged by new class
- **executor.ts** — Public `StageExecutor` interface and `executeStage()` signature unchanged; all existing callers in `runner.ts` and tests unaffected

## Risk and rollback

**Primary risk:** The F22 abort controller timing is critical. The signal must abort the SDK subprocess at the exact moment the attempt becomes terminal, and the finally block must be foolproof — otherwise the subprocess outlives the attempt and corrupts `port_values`. **Mitigation:** (1) copy the exact finally logic (lines 779–796) unchanged into the new class, (2) preserve all abort() call sites (error, secret_pending, interrupted, outer catch), (3) keep belt-and-suspenders pattern (abort in finally AND before finishAttempt), (4) run full test suite with special focus on `real-executor.abort-on-error.test.ts`. **Secondary risk:** Writer.close() is idempotent but order matters (cost/token captures must precede close). **Mitigation:** Move all close() calls into the new class to enforce a single, correct sequence. **Rollback:** Inline the `SdkAttemptRunner` methods back into `doAttempt` (mechanical undo; no schema or logic changes).

## Open questions for review

1. **Class location:** Should `SdkAttemptRunner` be a nested class inside `RealStageExecutor` (better encapsulation, mirrors the private nature of `doAttempt`) or a top-level export (follows `stream-pump.ts` precedent, enables future SDK runner patterns)?

2. **Writer lifecycle ownership:** The writer.close() call currently appears in 6+ places (success, error, secret_pending, nested catch). Should the new class own ALL close() calls and return the closed-or-open state to `doAttempt`, or should `doAttempt` retain error-path close() for defensive cleanup?

3. **Optional resources:** Heartbeat timer and DeltaThrottler are conditionally created (broadcaster-dependent). Should these be lazily constructed inside the new class, or passed in as pre-built optionals so `doAttempt` controls their lifecycle?

4. **Signal-to-INTERRUPT bridging:** Currently at lines 510–535, this bridging logic connects `args.signal` to the AgentMachine. Should it move into the new class's pump phase, or stay in `doAttempt` as part of the orchestration setup?

5. **Input preparation:** Migration hint (line 381) and system prompt append (line 389) are produced in `doAttempt` but consumed by SDK.query. Should these move into the new class constructor/run method, or remain parameters passed from `doAttempt`?

