# Gate Reject Runtime Semantics Design

> **Date:** 2026-04-24
> **Status:** Draft — awaiting user approval
> **Related:** `docs/superpowers/plans/2026-04-22-converter-extension-pipeline-generator-done-handoff.md` §10 follow-up #2
> **Companion milestone:** `2026-04-24-pipeline-generator-mcp-entry-design.md` (just shipped; reveals this gap in production)

## 1. Goal & Success Criteria

**Goal:** Make `human_confirm` gate `reject` routing actually roll back and re-run the upstream target stage at runtime. Previously the reject target was only excluded from `gateRouted` at compile time (Bug 3 fix in the converter-extension milestone) — the runtime treated an answered reject as a no-op, leaving the pipeline stuck.

**Success criteria:**
1. Answering a gate with the `reject` routing answer causes the pipeline to re-enter the target upstream stage's `executing` substate without human intervention.
2. All port values, finalized-stage records, gate authorizations, and retry counts belonging to the target stage and its transitive downstream are cleared before the rebuild.
3. Upstream state that predates the reject target is preserved (seedValues, finalized stages before target, their port values).
4. The answered gate itself is re-opened: after rebuild the gate region is back in `executing`, requiring a new `answer_gate` call. The second call may pick `approve` or `reject` again freely.
5. Observers (Web dashboard, `wait_pipeline_result`) receive a `stage_rolled_back` SSE event describing what was reset. They can ignore it (MCP wait handler) or render it (dashboard).
6. No regression in the existing gate approve path, retry-rebuild path, or non-gated pipeline execution.

## 2. Context

The converter-extension milestone (commit `d083457`) added `gateRoutedTargets` upstream-exclusion so that an `analyzing` stage referenced by `awaitingConfirm.routing.routes.reject` is NOT flagged `gateRouted=true`. Without that fix, `analyzing` would have required `gateAuthorizedTargets` to include it for forward execution, which never happens on the happy path. The fix let the pipeline run forward correctly.

But the **backward** path — what actually happens when the user answers `reject` — was left unaddressed. `kernel.answerGate` looks up `routes[answer]` (which is `"analyzing"` for reject), dispatches a `GATE_ANSWERED` event, and the root-level handler adds `analyzing` to `gateAuthorizedTargets`. Since `analyzing` is already in `finalizedStages` from the first run, the XState machine never re-enters it — the gate stays "answered" but nothing happens downstream either. The pipeline deadlocks until the task is cancelled.

The pipeline-generator MCP entry milestone (just shipped) surfaced this as a real daily-usage bug: the moment a user rejects a proposed design, the task hangs.

## 3. Scope

**In scope:**
- Compile-time: produce a per-gate `RejectRollback` descriptor whenever a gate's routing includes an answer whose target is one of the gate's transitive upstream stages.
- Kernel layer (`mcp/kernel.ts::answerGate`): when the answered route matches a rollback descriptor, dispatch a new `GATE_REJECTED` event (not `GATE_ANSWERED`).
- Runner layer (`runtime/runner.ts`): handle `GATE_REJECTED` by stopping the actor, pruning persistent state for the target + transitive downstream, publishing `stage_rolled_back`, and rebuilding the actor via the existing C5 retry-rebuild machinery with a new `rejectFromGate` flag that tells the replay loop not to re-answer the rejected gate.
- SSE: new event type `stage_rolled_back` carrying `{ fromGate, toStage, affectedStages }`.
- MCP `wait_pipeline_result`: add a no-op branch for `stage_rolled_back` so wait clients keep waiting for the next terminal event (done / gate_pending / error) instead of mistakenly treating rollback as a terminal.

**Out of scope:**
- Multi-target rollback (`routing.routes.reject: [stageA, stageB]`): converter only maps `human_confirm` to single-string targets today. YAGNI.
- Partial rollback (re-run target stage but preserve some of its downstream that is logically independent): requires per-port dependency tracking, far beyond a single spec. Follow-up if it ever matters.
- Non-gate roll-back triggers (e.g. an executor deciding "I need to restart from X"): the current rollback contract is user-gate-driven.
- Time-travel / branching state history: rollback discards; no fork kept.

## 4. Dependencies from Prior Work

- Bug 3 fix (`compiler/ir-to-machine.ts`): `gateUpstreamByGate` map + `gateRoutedTargets` set already identify "target is upstream of gate" relationships. This spec reuses the exact same set semantics to decide which answer triggers rollback.
- C5 actor rebuild (`runtime/runner.ts:914-963`): threads `persistentFinalizedStages`, `persistentPortValues`, `persistentGateAuthorized`, `persistentGateSkipped`, `retryCounts` through a rebuild cycle and replays already-answered gates via synthetic `GATE_ANSWERED` events. This spec reuses that whole mechanism; rollback is a specific pruning + replay-exclusion variant.

## 5. IR Topology Analysis (Compile Time)

**Input:** `PipelineIR` with stages + wires.

**Produce:** `rejectRollbackMap: Map<gateName, RejectRollback>` attached to `CompiledMachine`.

```ts
interface RejectRollback {
  answer: string;              // the routing key that triggers rollback (usually "reject")
  targetStage: string;         // the upstream stage to re-run
  affectedStages: string[];    // targetStage + all transitive downstream (BFS over wires.from.stage)
}
```

**Algorithm:**
1. Build adjacency: `downstream: Map<stageName, Set<stageName>>` from `ir.wires` where `w.from.source === "stage"`.
2. Reuse existing `gateUpstreamByGate` computation (already in `ir-to-machine.ts`): `upstreamsOf(gateName)` is the set of stages that have a wire into this gate.
3. For each gate stage `g`:
   - For each `(answer, target)` in `g.config.routing.routes`:
     - If `target` is a string AND `target ∈ upstreamsOf(g)`: compute `affectedStages = bfsDownstream(target, downstream) ∪ {g}` (include the gate itself, since the gate must also be re-opened). Record `{ answer, targetStage: target, affectedStages }` and break (at most one rollback answer per gate — first match wins; in practice there's exactly one `reject` answer).
     - Else: skip.
4. Gates with no matching answer do not appear in the map; they behave as pure forward routers (approve-only, or routing to non-upstream stages).

**BFS helper:** iterative BFS from `targetStage`, following `downstream` adjacency, returning the visited set including the starting node. Deduplicates via a `Set`. No cycle check needed — the DAG validator already rejects cycles at compile time.

## 6. Kernel Layer — `mcp/kernel.ts::answerGate`

**Current flow:**
```ts
const routes = stage.config.routing.routes;
const targetStage = routes[answer] ?? routes["_default"];
if (targetStage === undefined) return { ok: false, error: "GATE_ANSWER_INVALID" };
// dispatch GATE_ANSWERED { gateId, stageName, answer, targetStage }
```

**New flow:** after resolving `targetStage`, look up the rollback descriptor:

```ts
const compiled = getCompiledMachineForTask(taskId);  // load + cache IR + rejectRollbackMap
const rollback = compiled.rejectRollbackMap.get(stage.name);
if (rollback && rollback.answer === answer) {
  dispatcher.send({
    type: "GATE_REJECTED",
    gateId, stageName: stage.name,
    answer, targetStage: rollback.targetStage,
    affectedStages: rollback.affectedStages,
  });
  // persist gate-queue row as answered (status: "answered") same as approve path
  markGateAnswered(db, gateId, answer);
  return { ok: true, kind: "rejected", gateId, ... };
}
// existing GATE_ANSWERED dispatch for non-rollback answers
```

Loading the compiled machine: `kernel.answerGate` already has access to the task's version hash via `stage_attempts`. It re-invokes `compileIRToMachine(ir, { taskId })` or pulls from a per-task cache. Prefer per-task cache keyed by `taskId` to avoid recompile cost; LRU bound not needed for a single-user local tool.

## 7. Runner Layer — `GATE_REJECTED` Handler

**Location:** The dispatcher listener inside `runPipeline`'s attempt promise (same place that currently handles `MACHINE_FAILED` / retry rebuild).

**Handler:**
```ts
if (evt.type === "GATE_REJECTED") {
  const affected = new Set(evt.affectedStages);

  // 1. Snapshot persistent state from the current actor before stopping it.
  const ctx = currentActor.getSnapshot().context as MachineContext;
  persistentFinalizedStages = ctx.finalizedStages.filter(f => !affected.has(f.name));
  persistentPortValues = prunePortValues(ctx.portValues, affected);
  persistentGateAuthorized = ctx.gateAuthorizedTargets.filter(t => !affected.has(t));
  persistentGateSkipped = ctx.gateSkippedTargets.filter(t => !affected.has(t));
  retryCounts = pruneKeys(ctx.retryCounts, affected);

  // 2. Stop the actor.
  currentActor.stop();

  // 3. Publish SSE.
  opts.broadcaster.publish({
    type: "stage_rolled_back",
    taskId: opts.taskId,
    timestamp: isoNow(),
    data: { fromGate: evt.stageName, toStage: evt.targetStage, affectedStages: evt.affectedStages },
  });

  // 4. Rebuild via existing C5 path, with new flag so the replay loop
  //    skips re-answering the rejected gate.
  return rebuildActor({ rejectFromGate: { gateName: evt.stageName } });
}
```

`prunePortValues(values, affected)`: depends on portValues key shape, verified at plan-writing time. If keys are flat `"stageName.portName"` strings, filter by prefix `stageName + "."`. If keys are nested `{ [stageName]: { [portName]: value } }`, delete top-level entries. (Inspected at implementation time; plan specifies which.)

**Rebuild replay change (runner.ts:926-963):** the existing loop walks `persistentFinalizedStages` and synthesizes `GATE_ANSWERED` for each finalized gate. Add a guard:

```ts
if (options.rejectFromGate?.gateName === finalized.name) continue;
```

Since `persistentFinalizedStages` already had the rejected gate pruned in step 1 above, this guard is defense-in-depth — if the pruning is accidentally too narrow in a future refactor, the guard still prevents replaying the rejected answer.

## 8. SSE Event — `stage_rolled_back`

**`apps/server/src/kernel-next/sse/types.ts`:**

```ts
export interface StageRolledBackData {
  fromGate: string;
  toStage: string;
  affectedStages: string[];
}

export interface KernelNextStageRolledBackEvent extends KernelNextSSEEvent {
  type: "stage_rolled_back";
  data: StageRolledBackData;
}

// Add to KernelNextSSEEventType union and AnyKernelNextSSEEvent union.
```

No new table, no DB persistence required. It's a live observability event; late subscribers see it in the history replay buffer.

## 9. MCP `wait_pipeline_result` — No-op branch

In `apps/server/src/kernel-next/mcp/pg-entry.ts`, the subscribe callback currently handles `run_final`, `stage_error`, `stage_executing` (gate detection). Add:

```ts
if (ev.type === "stage_rolled_back") {
  // Pipeline is rolling back; not a terminal. Keep waiting.
  return;
}
```

No behavior change visible to MCP callers — they still receive `gate_pending` (when the re-opened gate comes back into executing) or `done`/`error` (when the new forward path terminates). The terminal remains terminal; rollback is transient.

## 10. Testing Strategy

**Compiler unit tests** (`compiler/ir-to-machine.test.ts`):
- IR with gate routing `{ approve: nextStage, reject: upstreamStage }` where `upstreamStage → gate` wire exists → `rejectRollbackMap` has entry with `affectedStages` BFS result.
- IR with gate whose reject target is NOT an upstream → no entry in `rejectRollbackMap`.
- IR with multi-hop downstream (gate → A → B → C, reject → gate-upstream) → `affectedStages` contains the full reachable downstream.

**Kernel unit tests** (`mcp/kernel.test.ts`):
- `answerGate(gateId, "reject")` on a gate with rollback descriptor → dispatches `GATE_REJECTED`, not `GATE_ANSWERED`.
- `answerGate(gateId, "approve")` on same gate → dispatches `GATE_ANSWERED` (unchanged).
- `answerGate(gateId, "reject")` on a gate WITHOUT rollback descriptor (reject target isn't upstream) → dispatches `GATE_ANSWERED` (fallback to existing behavior).

**Runner unit tests** (`runtime/runner.test.ts` or `runtime/runner.reject-rollback.test.ts`):
- Full path: mock executor runs targetStage → publishes port writes → gate stage enters executing → test dispatches `GATE_REJECTED` → assert:
  - `stage_rolled_back` SSE event published
  - After rebuild, `targetStage` enters executing again
  - `portValues` no longer contain target's ports
  - `gateAuthorizedTargets` cleaned
  - The rejected gate is NOT auto-answered; it waits for a fresh `GATE_ANSWERED`
- Rebuild failure path: if the rebuild itself throws, runner surfaces `run_final: failed` + stageErrors; no partial state left.

**SSE unit tests** (`sse/broadcaster.test.ts` or add a typed-event test):
- New event type round-trips through broadcaster.subscribe/publish.

**MCP wait test** (`mcp/pg-entry.test.ts`):
- Fire `stage_rolled_back` followed by `run_final:completed` → wait resolves `done`, not confused by rollback event.

## 11. Boundaries & Non-Goals

- **Answer string has no semantic meaning at the runtime layer.** The rollback decision is purely topological (`target ∈ upstreams`). A gate with `routes: { a: forward, b: upstream }` would treat `b` as rollback; the string "reject" is conventional, not special-cased.
- **No state branching / time-travel.** Rolled-back state is discarded. If users need to compare pre-reject vs post-reject outputs, execution records (Phase 1) provide the audit trail — this spec does not duplicate that.
- **Concurrent answer protection is existing behavior.** `gate_queue.status` transitions from `open → answered` atomically; a second `answer_gate` on the same gate fails with `GATE_ALREADY_ANSWERED`. Rollback doesn't weaken this; after rebuild a new gate_queue row is created for the re-opened gate.
- **Recursion / repeated rejects.** Fully supported. Each `GATE_REJECTED` goes through the same prune + rebuild cycle; no depth limit.
- **parallel group children.** `parallelChildren` stages appear in `finalizedStages` individually; the pruning logic filters by name. If a parallel group's post-completion gate rejects back through the whole group, every child in the BFS result is pruned. Already covered by the generic algorithm.

## 12. Self-Review Checklist

- [ ] Success criterion 1: reject triggers rollback — covered by runner test
- [ ] Success criterion 2: state pruned — covered by assertions on ctx after rebuild
- [ ] Success criterion 3: upstream state preserved — covered by assertion that pre-target finalized stages remain
- [ ] Success criterion 4: gate re-opens — covered by "gate waits for fresh answer" assertion
- [ ] Success criterion 5: SSE emitted — covered by broadcaster subscribe test
- [ ] Success criterion 6: no regression in approve path — existing gate approve tests stay green
- [ ] kernel.answerGate handles both dispatch paths based on rejectRollbackMap lookup
- [ ] runner rebuild path guards against replaying the rejected gate
- [ ] pg-entry wait handler ignores stage_rolled_back
- [ ] All new code paths have tests; no hand-waving around "it should work"
