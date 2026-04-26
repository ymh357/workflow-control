## Phase 1 Summary

After exploring the codebase, I can identify the key lifecycle elements scattered throughout the `doAttempt` method in `real-executor.ts` (lines 322-890):

1. **MCP Server Creation** (line 410): Fresh instance per attempt, passed to SDK
2. **AbortController** (line 401): Created per attempt, passed into SDK options and signal listeners
3. **Heartbeat Timer** (lines 564-569): Synthetic heartbeat to track liveness during SDK thinking time
4. **Stream Pump & Adapter** (lines 508, 576): SDK stream consumed via adapter into AgentMachine
5. **Writer Lifecycle** (lines 366-376, 453, 807-875): ExecutionRecordWriter opened, fed sidecar events, closed with termination reason

The refactoring tension: `doAttempt` has two distinct concerns—the per-attempt SDK lifecycle setup/teardown, versus the actual orchestration of inputs, validation, and error handling. The lifecycle piece (lines 395-796) involves 5+ nested scopes with cleanup in finally blocks, while the orchestration (lines 327-394, 798-889) is the real logic that should be visible.

The main smells:
- **Deep nesting**: 13+ levels of try/catch/finally from variables to stream operations
- **Lifecycle coupling**: AbortController creation/abort/listener-removal scattered across 7 locations
- **Cleanup debt**: Finally block at line 779-796 handles 4 independent concerns (heartbeat, signal listener, actor stop, abort double-check)
- **Sidecar knowledge**: Writer instantiation and close logic interleaved with main flow, making error paths hard to follow

The core insight: lines 395-796 form a self-contained "attempt runner" that could be extracted into a class that owns the lifecycle and presents a simple "run and wait" interface.

---

# Phase 2: Refactor Proposal

## Summary

- Extract per-attempt SDK lifecycle (MCP factory call, AbortController, heartbeat timer, stream pump, writer open/close) into a new `SdkAttemptRunner` class
- `doAttempt` becomes a thin orchestration shell: gather inputs → resolve prompts → call runner → validate outputs
- Runner owns cleanup guarantees via try/finally, reducing `doAttempt` nesting depth from 13+ levels to 3-4
- Improves testability: AbortController, heartbeat, and stream pump behavior can be tested in isolation on the runner class
- Reduces cognitive load on the stage-attempt error matrix (secret_pending, schema_non_compliant, etc.)

## Files Touched

**real-executor.ts** (main change)
- Delete lines 395-796 (the try/finally lifecycle block in `doAttempt`)
- Delete helper functions `abortableDelay` (lines 195-211)
- Add import for new `SdkAttemptRunner` class
- Simplify `doAttempt` to: input gathering → prompt resolution → MCP expansion → call `runner.run()` → output validation
- Update `doAttempt` signature to accept pre-expanded MCP servers (since expansion now happens before runner creation)

**sdk-attempt-runner.ts** (new file)
- Export `SdkAttemptRunner` class that encapsulates:
  - Constructor accepting: `options` (model, maxTurns, maxBudgetUsd, claudePath, workspaceDir, broadcaster, queryFn)
  - Method `run(attempt_context)` that internally:
    - Creates fresh MCP server via factory
    - Builds SDK base options with AbortController
    - Creates and starts heartbeat timer
    - Calls `pumpSdkStream` with writer sidecar
    - Returns `{ agentOutput, capturedSessionId, capturedCost... }`
  - Private finally block that always: stops actor, clears heartbeat, removes signal listener, aborts controller, disposes delta throttler
- Export type `SdkAttemptRunResult` with the return shape (agentOutput + captured metadata)

**execution-record-writer.ts** (no change)
- Writer interface already supports the lifecycle pattern needed (open → append/update → close)
- Remains unchanged; runner will instantiate and pass to the pump options

**stream-pump.ts** (no change)
- Already extracted for reuse; runner will call it directly

**agent-machine.ts** (no change)
- State machine logic unchanged; runner creates actor and drives it via pump

## Files Explicitly NOT Touched

**executor.ts**
- Reason: Stable interface; `ExecuteStageArgs` and `ExecuteStageResult` types need no change. The `doAttempt` internal refactoring is invisible to callers.

**real-executor.test.ts, real-executor.*.test.ts** (all test files)
- Reason: Tests inject a `queryFn` override; the new `SdkAttemptRunner` accepts `queryFn` as a constructor option, so existing test injection patterns remain valid. Tests should continue to pass without modification (they test the executor's contract, not its internal structure). New unit tests for `SdkAttemptRunner` lifecycle can be added separately without touching existing coverage.

**port-runtime.ts**
- Reason: No change to how `portRuntime` is used. The runner is a pure computation-owned component; it calls the same `portRuntime` methods but from a different calling site (still ultimately from `real-executor.ts`).

**mcp-servers-expander.ts, real-executor-sdk-options.ts, real-executor-prompt-builder.ts**
- Reason: Helper modules remain unchanged. The runner can call them (e.g., `SdkAttemptRunner` constructor can accept pre-computed `systemPromptAppend`, `baseOptions`, or it can call them internally — design TBD post-review).

## Risk and Rollback

**Risk Level**: Low
- The change is a pure refactoring (no behavioral change to stage execution logic)
- All error paths remain the same; the try/finally structure is preserved inside the runner
- Abort semantics (F22) are unchanged — still happen on every finishAttempt error path and in the finally
- Tests should pass without modification since they test the executor contract, not its structure

**Rollback**:
- Delete `sdk-attempt-runner.ts`
- Inline the runner's logic back into `doAttempt` (roughly reverse of the extraction)
- Restore the 5+ nested try/finally blocks

**Migration Step**:
1. Create `SdkAttemptRunner` class with the lifecycle logic
2. Update `doAttempt` to call `runner.run()`
3. Run full test suite; expected: all tests pass without modification
4. Verify no behavioral changes via git diff on real-executor.ts (should show only structural simplification in `doAttempt`)

## Open Questions for Review

1. **SdkAttemptRunner constructor options shape**: Should it accept the full `RealStageExecutor` options bag (model, maxTurns, etc.) and a context object (stageName, taskId, etc.)? Or should `doAttempt` pre-compute systemPromptAppend and pass it to the runner? The latter is simpler (runner doesn't need to know stage IR) but splits the "SDK setup" concern.

2. **Captured metadata bubble-up**: Should the runner return the captured metadata (sessionId, cost, tokenInput, etc.) inside the result object, or should the writer itself be returned so `doAttempt` can read it post-run? The former is cleaner (immutable output) but requires the runner to know the schema; the latter couples the runner to ExecutionRecordWriter.

3. **DeltaThrottler instantiation**: Is `deltaThrottler` a runner responsibility (since it's tied to the pump lifecycle) or should it live in `doAttempt` and be passed to the runner? Currently it's optional when broadcaster is undefined; the runner could handle that internally.

4. **Test coverage for SdkAttemptRunner**: Should the new runner have its own unit tests (e.g., abort-on-error, heartbeat ticking, signal listener cleanup), or is it sufficient to rely on existing end-to-end executor tests? Independent runner tests would lock in the lifecycle guarantees.
