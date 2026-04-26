# Refactor Proposal: Extract SdkAttemptRunner from real-executor.ts

## Summary

- **Extract lifecycle management**: The `doAttempt` method currently spans 13+ distinct phases (input gathering, MCP factory, AbortController, heartbeat, stream pump, resource cleanup) across 550+ lines. Move the per-attempt SDK infrastructure into a new `SdkAttemptRunner` class.
- **Reduce scope coupling**: The finally block has strict cleanup order with 5 resource lifetimes (abortController, mcpServer, agentActor, heartbeatTimer, deltaThrottler) managed implicitly. Encapsulating these into the runner eliminates brittle implicit dependencies.
- **Clarify responsibilities**: Port input gathering and prompt resolution are orchestration concerns orthogonal to infrastructure (MCP/heartbeat/abort). Separating them makes the control flow explicit: `doAttempt` coordinates, `SdkAttemptRunner` manages lifecycle.
- **Simplify state management**: Currently 6 sidecar capture variables are scattered at method scope but used throughout stream pump callbacks and cleanup paths. The runner will own this state, making it clear what's per-attempt.

## Files Touched

| File | Change |
|------|--------|
| `real-executor.ts` | Refactor `doAttempt` (lines 322–890) to create `SdkAttemptRunner`, call runner.execute(), and move lifecycle/resource-management code into the runner. Keep input gathering, prompt resolution, and error routing at method level. |
| `sdk-attempt-runner.ts` (new) | New class with constructor taking attempt metadata, ports, writer. Methods: `execute()` (orchestrates MCP factory → heartbeat → stream consumption), `close()` (strict cleanup order), private helpers for setup (AbortController, heartbeat, adapter). Own the 6 sidecar capture variables. |
| `stream-pump.ts` | No changes expected; runner will call existing `startStreamPump()` as dependency. |
| `execution-record-writer.ts` | No structural changes; runner calls existing `writer.close()` at 5 exit paths (consolidate in runner's cleanup). |
| `sdk-adapter.ts` | No changes; runner uses existing adapter constructor and methods. |
| `agent-machine.ts` | No changes; runner creates and stops the actor as before. |
| `real-executor-sdk-options.ts` | No changes; runner calls existing `getRealExecutorSdkOptions()`. |
| `executor.ts` | No changes; `executeStage` uses `doAttempt` unchanged. |
| `port-runtime.ts` | No changes; runner reads port values as before. |

## Files Explicitly NOT Touched

- **real-executor.test.ts**: Test file. Tests will be updated separately to mock or test `SdkAttemptRunner` once implementation is in place.
- **mock-executor.ts**: Different executor with different lifecycle concerns; not affected by this SDK-specific refactoring.
- **composite-executor.ts**: Orchestrates other executors, not SDK-specific; no changes needed.
- **inline-script-executor.ts**: Script executor with separate lifecycle; orthogonal to agent SDK extraction.
- **task-registry.ts**: Task tracking infrastructure, not part of SDK attempt lifecycle.
- **real-executor-prompt-builder.ts**: Prompt generation utility consumed by `doAttempt` input gathering; upstream of lifecycle.
- **mcp-servers-expander.ts**: MCP configuration expansion happens before `doAttempt` is called; pre-SDK setup.
- **graceful-shutdown.ts**: Process-level shutdown; orthogonal to per-attempt cleanup.
- **rate-limit-backoff.ts**: Backoff calculation utility used by retry logic; not lifecycle-related.

## Risk and Rollback

**Risk**: The finally block cleanup order (clear heartbeat → remove abort listener → stop actor → abort controller → dispose throttler) is implicit and brittle; if the runner's cleanup sequence is wrong, resource leaks or hanging processes will occur. Additionally, the 5 `writer.close()` call sites with different terminationReason parameters must all route through the runner; missing one path breaks the writer state machine. Schema validation (lines 823–865) reads attempt-scoped port values and calls writer.close() on failure—this delegation must be correct to avoid double-closes or missed error reporting.

**Mitigation**: Extract cleanup into a single `try-finally` within `SdkAttemptRunner.close()`. Add unit tests for each exit path (success, error, abort, schema failure, stream failure) to verify cleanup order. Document the writer.close() precondition (open-before-close invariant).

**Rollback**: If the extraction introduces regressions, revert the commit and inline `SdkAttemptRunner` methods back into `doAttempt`. The extraction is localized to one method and one new file; no cross-file API changes.

## Open Questions for Review

1. **Sidecar state ownership**: Should the 6 capture variables (capturedSessionId, capturedCostUsd, etc.) be properties of `SdkAttemptRunner` or held in a separate state bag? This affects how stream pump callbacks access them and how cleanup reads final values.

2. **writer.close() parameters**: The writer is closed at 5 sites with different (terminationReason, cost) tuples. Should the runner own the decision of *when* and *how* to close the writer, or should doAttempt retain control of close parameters (e.g., pass them as arguments to runner.execute())?

3. **Retry loop interaction**: The `executeStage` retry loop creates a fresh AbortController per attempt and checks abort signals between retries. Is the per-attempt boundary clear enough (does the runner need to know about MCP_STARTUP_RETRY_BUDGET), or should retry logic remain entirely in `executeStage`?

4. **Stream pump abstraction**: `startStreamPump()` is complex and has callbacks that interact with the abort signal and heartbeat timer. Should the runner own the stream pump lifecycle (call it, handle errors, await it), or should doAttempt retain control and pass the pump result to the runner?

5. **Test strategy**: Should `SdkAttemptRunner` be unit-tested in isolation (mocking writer, mcpServer factory, stream), or tested primarily through integration tests of `doAttempt`? The lifecycle has many edge cases (abort during setup, schema failure during pump, heartbeat timeout) that may be easier to cover with an integration harness.
