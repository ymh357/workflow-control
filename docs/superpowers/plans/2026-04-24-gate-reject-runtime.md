# Gate Reject Runtime Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `human_confirm` gate `reject` routing actually roll back to the upstream target stage at runtime: prune affected stages' state, re-run them, re-open the rejected gate.

**Architecture:** Compile-time topology analysis produces a `rejectRollbackMap` (gateName → {answer, targetStage, affectedStages}). At answer time, kernel returns `kind: "rejected" | "answered"` so the dispatch sites (MCP `answer_gate` handler + HTTP `kernel-gates.ts` route) send `GATE_REJECTED` instead of `GATE_ANSWERED` for rollback answers. Runner reacts to `GATE_REJECTED` by pruning persistent state for `affectedStages` and rebuilding the actor via the existing C5 retry-rebuild path, excluding the rejected gate from the replay-answers loop. A new `stage_rolled_back` SSE event surfaces the transition.

**Tech Stack:** TypeScript, XState v5, node:sqlite, Vitest, Hono (for the HTTP answer route).

**Spec:** `docs/superpowers/specs/2026-04-24-gate-reject-runtime-design.md`

---

## Key Codebase Facts (Verified Before Writing)

These are concrete signatures the plan depends on — verified from the live codebase so tasks compile against reality:

1. **`portValues` keys are flat strings** `"stageName.portName"` (and `"__external__.<name>"` for seeds). See `compiler/ir-to-machine.ts:246-260 buildInitialPortValues` + `runtime/port-runtime.ts:174-195 writePort`. Prune = `Object.keys(values).filter(k => !affectedPrefixes.some(p => k.startsWith(p + ".")))`.
2. **`kernel.answerGate` does NOT dispatch events.** It writes DB and returns `AnswerGateResult`. Dispatch happens at the two call sites: `mcp/server.ts:601-617` (MCP handler) and `routes/kernel-gates.ts:91-104` (HTTP route). Both will learn to branch on a new `kind` field.
3. **`CompiledMachine` shape** (`compiler/ir-to-machine.ts:262-265`): `{ machine, stageMeta }`. Plan extends to `{ machine, stageMeta, rejectRollbackMap }`.
4. **C5 retry rebuild** lives inside the inner attempt Promise in `runtime/runner.ts` (state lives at method scope: `persistentFinalizedStages`, `persistentPortValues`, `persistentGateAuthorized`, `persistentGateSkipped`, `retryCounts`). The gate replay loop is `runner.ts:926-963`. Plan threads a new option `rejectFromGate?: { gateName: string }` through the rebuild path to mark the rejected gate as non-replay.
5. **SSE event type union** lives in `sse/types.ts`; new event type must be added to `KernelNextSSEEventType` + `AnyKernelNextSSEEvent`.
6. **`taskRegistry`** (`runtime/task-registry.ts`): `get(taskId) → dispatcher`; dispatcher exposes `send(event)`. No changes required — used as-is for the new `GATE_REJECTED` event.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `apps/server/src/kernel-next/compiler/ir-to-machine.ts` | Add `rejectRollbackMap` computation; extend `CompiledMachine` type |
| Modify | `apps/server/src/kernel-next/compiler/ir-to-machine.test.ts` | Compile-time tests for rollback map |
| Modify | `apps/server/src/kernel-next/mcp/kernel.ts` | `answerGate` returns `kind: "rejected" | "answered"` with `affectedStages` |
| Modify | `apps/server/src/kernel-next/mcp/kernel.test.ts` | Test both return kinds |
| Modify | `apps/server/src/kernel-next/sse/types.ts` | Add `KernelNextStageRolledBackEvent` + `StageRolledBackData` |
| Modify | `apps/server/src/kernel-next/runtime/runner.ts` | Handle `GATE_REJECTED` dispatcher event: prune + rebuild |
| Create | `apps/server/src/kernel-next/runtime/runner.reject-rollback.test.ts` | Reject → rollback → re-run end-to-end test |
| Modify | `apps/server/src/kernel-next/mcp/server.ts` | `answer_gate` handler dispatches `GATE_REJECTED` when `kind === "rejected"` |
| Modify | `apps/server/src/routes/kernel-gates.ts` | Same branching at HTTP layer |
| Modify | `apps/server/src/routes/kernel-gates.test.ts` | Add test for reject path |
| Modify | `apps/server/src/kernel-next/mcp/pg-entry.ts` | `handleWaitPipelineResult` ignores `stage_rolled_back` |
| Modify | `apps/server/src/kernel-next/mcp/pg-entry.test.ts` | Assert rollback event does not settle the wait prematurely |

---

## Task 1: Compile-time `rejectRollbackMap`

**Files:**
- Modify: `apps/server/src/kernel-next/compiler/ir-to-machine.ts`
- Modify: `apps/server/src/kernel-next/compiler/ir-to-machine.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `ir-to-machine.test.ts`:

```typescript
describe("compileIRToMachine — rejectRollbackMap", () => {
  it("builds rollback entry when gate routes reject to a transitive upstream", () => {
    const ir: PipelineIR = {
      name: "t",
      version: "1.0.0",
      externalInputs: [],
      stages: [
        { name: "A", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [{ name: "out1", type: "unknown" }] } as any,
        { name: "B", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [{ name: "a", type: "unknown" }], outputs: [{ name: "o", type: "unknown" }] } as any,
        { name: "G", type: "gate", config: { routing: { routes: { approve: "C", reject: "A" } } }, inputs: [{ name: "b", type: "unknown" }], outputs: [] } as any,
        { name: "C", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [] } as any,
      ],
      wires: [
        { from: { source: "stage", stage: "A", port: "out1" }, to: { stage: "B", port: "a" } },
        { from: { source: "stage", stage: "B", port: "o" }, to: { stage: "G", port: "b" } },
      ],
    } as unknown as PipelineIR;
    const { rejectRollbackMap } = compileIRToMachine(ir, { taskId: "t1" });
    const entry = rejectRollbackMap.get("G");
    expect(entry).toBeDefined();
    expect(entry!.answer).toBe("reject");
    expect(entry!.targetStage).toBe("A");
    // BFS downstream of A, then include G itself.
    expect(new Set(entry!.affectedStages)).toEqual(new Set(["A", "B", "G"]));
  });

  it("no entry when reject target is not a transitive upstream", () => {
    const ir: PipelineIR = {
      name: "t2",
      version: "1.0.0",
      externalInputs: [],
      stages: [
        { name: "A", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [] } as any,
        { name: "G", type: "gate", config: { routing: { routes: { approve: "C", reject: "X" } } }, inputs: [], outputs: [] } as any,
        { name: "C", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [] } as any,
        { name: "X", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [] } as any,
      ],
      wires: [],
    } as unknown as PipelineIR;
    const { rejectRollbackMap } = compileIRToMachine(ir, { taskId: "t2" });
    expect(rejectRollbackMap.has("G")).toBe(false);
  });

  it("no entry for a gate whose only routes target downstream stages", () => {
    const ir: PipelineIR = {
      name: "t3",
      version: "1.0.0",
      externalInputs: [],
      stages: [
        { name: "A", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [] } as any,
        { name: "G", type: "gate", config: { routing: { routes: { yes: "B", no: "C" } } }, inputs: [], outputs: [] } as any,
        { name: "B", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [] } as any,
        { name: "C", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [] } as any,
      ],
      wires: [
        { from: { source: "stage", stage: "A", port: "o" }, to: { stage: "G", port: "i" } },
      ],
    } as unknown as PipelineIR;
    const { rejectRollbackMap } = compileIRToMachine(ir, { taskId: "t3" });
    expect(rejectRollbackMap.has("G")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `pnpm --filter server vitest run src/kernel-next/compiler/ir-to-machine.test.ts -t "rejectRollbackMap"`
Expected: FAIL — `rejectRollbackMap` not present on CompiledMachine.

- [ ] **Step 3: Extend `CompiledMachine` type**

In `apps/server/src/kernel-next/compiler/ir-to-machine.ts`:

```typescript
export interface RejectRollback {
  answer: string;
  targetStage: string;
  affectedStages: string[];
}

export interface CompiledMachine {
  machine: AnyStateMachine;
  stageMeta: Map<string, StageMeta>;
  rejectRollbackMap: Map<string, RejectRollback>;
}
```

- [ ] **Step 4: Build the map inside `compileIRToMachine`**

After the existing `gateRoutingMap` block (around line 280-293), compute `rejectRollbackMap`. Reuse the existing `gateUpstreamByGate` map that Bug 3 fix already computes (search the file for `gateUpstreamByGate`; if absent, compute it here from `ir.wires`):

```typescript
// Downstream adjacency: stageName -> set of immediate downstream stages.
const downstreamAdj = new Map<string, Set<string>>();
for (const w of ir.wires) {
  if (w.from.source !== "stage") continue;
  const src = w.from.stage;
  const dst = w.to.stage;
  if (!downstreamAdj.has(src)) downstreamAdj.set(src, new Set());
  downstreamAdj.get(src)!.add(dst);
}

function bfsDownstream(start: string): string[] {
  const visited = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const nexts = downstreamAdj.get(cur);
    if (!nexts) continue;
    for (const n of nexts) {
      if (visited.has(n)) continue;
      visited.add(n);
      queue.push(n);
    }
  }
  return Array.from(visited);
}

// gateUpstreamByGate: gateName -> Set of stages that wire into it.
const gateUpstreamByGate = new Map<string, Set<string>>();
for (const w of ir.wires) {
  if (w.from.source !== "stage") continue;
  const target = ir.stages.find((s) => s.name === w.to.stage);
  if (!target || target.type !== "gate") continue;
  if (!gateUpstreamByGate.has(target.name)) {
    gateUpstreamByGate.set(target.name, new Set());
  }
  gateUpstreamByGate.get(target.name)!.add(w.from.stage);
}

const rejectRollbackMap = new Map<string, RejectRollback>();
for (const s of ir.stages) {
  if (s.type !== "gate") continue;
  const upstreams = gateUpstreamByGate.get(s.name) ?? new Set<string>();
  for (const [answer, target] of Object.entries(s.config.routing.routes)) {
    if (typeof target !== "string") continue;
    // Transitive upstream check: if target is ANY ancestor of the gate
    // (not just direct), it's a rollback answer. We already have direct
    // upstreams; compute transitive upstream set via BFS on reversed
    // adjacency if needed. For Bug-3 semantics and pipeline-generator's
    // shape, direct upstream is sufficient: if reject target is a direct
    // upstream, it's a rollback. If the user ever ships an IR where
    // reject target is an ancestor two hops back, we still treat it as
    // rollback if any stage in the BFS-downstream set of `target`
    // contains the gate itself.
    const downstream = new Set(bfsDownstream(target));
    if (!downstream.has(s.name)) continue; // target doesn't reach gate → not rollback
    const affected = Array.from(downstream); // includes target and gate
    rejectRollbackMap.set(s.name, { answer, targetStage: target, affectedStages: affected });
    break; // one rollback answer per gate
  }
}
```

Then include it in the return:

```typescript
return { machine, stageMeta, rejectRollbackMap };
```

If `gateUpstreamByGate` already exists elsewhere in the file, reuse it instead of recomputing.

- [ ] **Step 5: Run tests — expect PASS**

Run: `pnpm --filter server vitest run src/kernel-next/compiler/ir-to-machine.test.ts -t "rejectRollbackMap"`
Expected: all 3 tests pass.

- [ ] **Step 6: Type-check**

Run: `pnpm -C apps/server exec tsc --noEmit`
Expected: clean. If other call sites destructure `{ machine, stageMeta }` from `compileIRToMachine`, they still work because field addition is additive.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/kernel-next/compiler/ir-to-machine.ts apps/server/src/kernel-next/compiler/ir-to-machine.test.ts
git commit -m "$(cat <<'EOF'
feat(compiler): add rejectRollbackMap to CompiledMachine

For each gate, if any routing answer's target can BFS-reach the gate
(target is a transitive ancestor), record {answer, targetStage,
affectedStages = BFS-downstream(target) including target + gate}.
Used by the kernel answerGate dispatch layer to decide whether to
emit GATE_ANSWERED (forward) or GATE_REJECTED (rollback).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: SSE event type `stage_rolled_back`

**Files:**
- Modify: `apps/server/src/kernel-next/sse/types.ts`
- Modify: `apps/server/src/kernel-next/sse/broadcaster.test.ts` (minimal typed-event smoke)

- [ ] **Step 1: Write failing test**

Append to `broadcaster.test.ts` (or create a typed-event round-trip test if the file has one):

```typescript
it("round-trips a stage_rolled_back event", () => {
  const b = new KernelNextBroadcaster();
  const received: AnyKernelNextSSEEvent[] = [];
  b.subscribe("task-rb", (ev) => received.push(ev));
  b.publish({
    taskId: "task-rb",
    timestamp: new Date().toISOString(),
    type: "stage_rolled_back",
    data: { fromGate: "G", toStage: "A", affectedStages: ["A", "B", "G"] },
  });
  expect(received).toHaveLength(1);
  expect(received[0].type).toBe("stage_rolled_back");
  if (received[0].type === "stage_rolled_back") {
    expect(received[0].data.fromGate).toBe("G");
    expect(received[0].data.toStage).toBe("A");
    expect(received[0].data.affectedStages).toEqual(["A", "B", "G"]);
  }
});
```

Use whatever import style matches the file.

- [ ] **Step 2: Run — expect FAIL (type mismatch or event type not in union)**

Run: `pnpm --filter server vitest run src/kernel-next/sse/broadcaster.test.ts`

- [ ] **Step 3: Extend SSE types**

In `apps/server/src/kernel-next/sse/types.ts`:

```typescript
// Add to KernelNextSSEEventType union:
export type KernelNextSSEEventType =
  | "task_state"
  | "stage_executing"
  | "stage_done"
  | "stage_error"
  | "stage_retry"
  | "port_written"
  | "stage_rolled_back"    // NEW
  | "run_final";

export interface StageRolledBackData {
  fromGate: string;
  toStage: string;
  affectedStages: string[];
}

export interface KernelNextStageRolledBackEvent extends KernelNextSSEEvent {
  type: "stage_rolled_back";
  data: StageRolledBackData;
}

// Add to AnyKernelNextSSEEvent union:
export type AnyKernelNextSSEEvent =
  | KernelNextTaskStateEvent
  | KernelNextStageExecutingEvent
  | KernelNextStageDoneEvent
  | KernelNextStageErrorEvent
  | KernelNextStageRetryEvent
  | KernelNextPortWrittenEvent
  | KernelNextStageRolledBackEvent    // NEW
  | KernelNextRunFinalEvent;
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter server vitest run src/kernel-next/sse/broadcaster.test.ts`
Expected: test passes.

- [ ] **Step 5: Type-check**

Run: `pnpm -C apps/server exec tsc --noEmit`
Expected: clean. Any switch on `ev.type` that was previously exhaustive will now be non-exhaustive; if any production code relies on that, TypeScript will flag and those sites need a `case "stage_rolled_back":` branch. Check SSE HTTP handler (`sse/http.ts`) and handle it: pass through to client with no special encoding.

If `sse/http.ts` has a switch, add:

```typescript
case "stage_rolled_back":
  // Pass through as-is to the SSE client.
  break;
```

Re-run tsc until clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/kernel-next/sse/types.ts apps/server/src/kernel-next/sse/broadcaster.test.ts
# Include sse/http.ts if it was modified:
# git add apps/server/src/kernel-next/sse/http.ts
git commit -m "$(cat <<'EOF'
feat(sse): add stage_rolled_back event type

Surfaces {fromGate, toStage, affectedStages} whenever the runner
prunes state for a gate-reject rollback. Observers can render
transient rollback UI; MCP wait clients ignore it and keep
waiting for the next terminal event.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Kernel `answerGate` returns `kind` discriminator

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/kernel.ts`
- Modify: `apps/server/src/kernel-next/mcp/kernel.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `kernel.test.ts`:

```typescript
describe("KernelService.answerGate — reject rollback kind", () => {
  it("returns kind='rejected' with affectedStages when reject target is upstream", () => {
    // Seed a db with a pipeline_version whose IR has a gate with
    // routes.reject = "upstreamStage" and a wire upstreamStage → gate.
    // Insert a gate_queue row for that gate stage.
    // (Use existing test helpers in this file; mirror any seeding patterns
    // the file already uses. If the file doesn't have helpers, inline the
    // minimum INSERTs.)
    const db = setupReject ReadyDb();  // helper constructed below
    const svc = new KernelService(db, { skipTypeCheck: true });
    const result = svc.answerGate("gate-1", "reject");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.affectedStages).toEqual(expect.arrayContaining(["upstreamStage", "gateStage"]));
      expect(result.targetStage).toBe("upstreamStage");
    }
  });

  it("returns kind='answered' for approve and all non-rollback answers", () => {
    const db = setupRejectReadyDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const result = svc.answerGate("gate-1", "approve");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("answered");
  });
});
```

The `setupRejectReadyDb()` helper: construct an in-memory DB, init schema, insert a `pipeline_versions` row with an IR JSON containing a gate whose routes include `reject → upstreamStage`, and a `gate_queue` row plus the requisite `stage_attempts` FK row. Follow the seeding idioms already in `kernel.test.ts`. If that file uses a different helper naming pattern, adapt.

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/kernel.test.ts -t "reject rollback"`
Expected: FAIL — `kind` field absent from AnswerGateResult.

- [ ] **Step 3: Extend `AnswerGateResult`**

In `apps/server/src/kernel-next/mcp/kernel.ts`:

```typescript
export type AnswerGateResult =
  | {
      ok: true;
      kind: "answered";
      gateId: string;
      taskId: string;
      stageName: string;
      targetStage: string | string[];
      answer: string;
    }
  | {
      ok: true;
      kind: "rejected";
      gateId: string;
      taskId: string;
      stageName: string;
      targetStage: string;
      answer: string;
      affectedStages: string[];
    }
  | {
      ok: false;
      diagnostics: Array<{ code: string; message: string; context?: unknown }>;
    };
```

(Existing success path has `targetStage: string | string[]`; the new `rejected` variant narrows to string because multi-target reject isn't supported — Spec §3 out-of-scope.)

- [ ] **Step 4: Route kind in `answerGate` body**

After the existing `targetStage` resolution, compute the rollback descriptor. Because we need `rejectRollbackMap` here but don't want to recompile the machine every call, import and call `compileIRToMachine(ir, { taskId: row.task_id })` — the IR is already loaded at line ~555. Compilation is pure and fast (millisecond-scale).

Insert before the existing transaction (around line ~600):

```typescript
const compiled = compileIRToMachine(ir, { taskId: row.task_id });
const rollback = compiled.rejectRollbackMap.get(row.stage_name);
const isReject =
  rollback !== undefined &&
  rollback.answer === answer &&
  typeof targetStage === "string" &&
  targetStage === rollback.targetStage;
```

Then inside the existing return-success block (after the COMMIT), branch the return value:

```typescript
if (isReject) {
  return {
    ok: true,
    kind: "rejected",
    gateId,
    taskId: row.task_id,
    stageName: row.stage_name,
    targetStage: rollback!.targetStage,
    answer,
    affectedStages: rollback!.affectedStages,
  };
}
return {
  ok: true,
  kind: "answered",
  gateId,
  taskId: row.task_id,
  stageName: row.stage_name,
  targetStage,
  answer,
};
```

Add `import { compileIRToMachine } from "../compiler/ir-to-machine.js";` at the top.

- [ ] **Step 5: Run tests — expect PASS**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/kernel.test.ts`
Expected: all existing tests + new reject tests pass. Existing tests asserting the old shape must be updated: change `result.targetStage` references to also check `result.kind === "answered"` first, or relax to structural checks that work for both kinds. Update minimally.

- [ ] **Step 6: Type-check**

Run: `pnpm -C apps/server exec tsc --noEmit`
Expected: clean. Call sites consuming the old shape (MCP handler, HTTP route, tests) will get "kind doesn't exist" — they're Task 4-5's responsibility. For now, the only TS errors should be at `mcp/server.ts:601-617` and `routes/kernel-gates.ts:91-104` which read `result.targetStage`. These two sites continue to compile because `kind: "answered"` branch still has `targetStage` on the discriminated union, so `if (result.ok) result.targetStage` narrows successfully IF the narrow reaches both kinds. If TypeScript complains that `result.targetStage` without a `kind` check is ambiguous (string vs string[]), temporarily add `if (result.ok && result.kind === "answered")` in Task 4-5.

If TS fails elsewhere, fix minimally in this task — but do NOT yet change Task 4/5 dispatch logic.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/kernel-next/mcp/kernel.ts apps/server/src/kernel-next/mcp/kernel.test.ts
git commit -m "$(cat <<'EOF'
feat(kernel): answerGate returns kind=rejected for rollback answers

When the answer matches a gate's rejectRollbackMap entry, return
kind: "rejected" + affectedStages so dispatchers can emit
GATE_REJECTED instead of GATE_ANSWERED. Non-rollback answers
(including approve) return kind: "answered" — identical payload
shape as before.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: MCP `answer_gate` handler — dispatch `GATE_REJECTED`

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/server.ts`
- Modify: `apps/server/src/kernel-next/mcp/server.test.ts`

- [ ] **Step 1: Write failing test**

Add to `server.test.ts`:

```typescript
describe("answer_gate MCP handler — reject dispatch", () => {
  it("dispatches GATE_REJECTED when kernel returns kind='rejected'", async () => {
    // Arrange: mock taskRegistry.get(taskId) to return a capturing dispatcher
    // and seed DB so kernel.answerGate returns kind: "rejected".
    // (Mirror the existing answer_gate tests' setup; if none exist, use
    // the pattern from kernel-gates HTTP test for fixture setup.)

    const captured: any[] = [];
    const dispatcher = { send: (ev: any) => captured.push(ev) };
    taskRegistry.register("task-1", dispatcher as any);

    // Arrange DB so that answerGate returns kind="rejected".
    // Use the same helper from Task 3 tests (may need to export).

    const mcp = createKernelMcp(dbWithRejectableGate, { surface: "external" });
    const tool = findTool(mcp, "answer_gate");
    const res = await tool.handler({ gateId: "gate-1", answer: "reject" });

    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe("GATE_REJECTED");
    expect(captured[0].stageName).toBe("gateStage");
    expect(captured[0].targetStage).toBe("upstreamStage");
    expect(Array.isArray(captured[0].affectedStages)).toBe(true);

    taskRegistry.unregister("task-1");
  });
});
```

`findTool(mcp, name)` — the existing tests in `server.test.ts` already have a pattern for accessing individual tool definitions; reuse.

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/server.test.ts -t "reject dispatch"`
Expected: FAIL — dispatched event is still `GATE_ANSWERED`.

- [ ] **Step 3: Branch on `kind` in the MCP handler**

In `apps/server/src/kernel-next/mcp/server.ts` around lines 601-617, replace the `if (result.ok)` dispatch block with:

```typescript
if (result.ok) {
  const dispatcher = taskRegistry.get(result.taskId);
  if (result.kind === "rejected") {
    dispatcher?.send({
      type: "GATE_REJECTED",
      gateId: result.gateId,
      stageName: result.stageName,
      answer: result.answer,
      targetStage: result.targetStage,
      affectedStages: result.affectedStages,
    });
  } else {
    dispatcher?.send({
      type: "GATE_ANSWERED",
      gateId: result.gateId,
      stageName: result.stageName,
      answer: result.answer,
      targetStage: result.targetStage,
    });
  }
}
return jsonResponse(result);
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/server.test.ts`
Expected: all green including the new reject dispatch test.

- [ ] **Step 5: Type-check + full suite**

Run: `pnpm -C apps/server exec tsc --noEmit`
Run: `pnpm --filter server vitest run`

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/kernel-next/mcp/server.ts apps/server/src/kernel-next/mcp/server.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): answer_gate handler dispatches GATE_REJECTED for rollback

Branches on AnswerGateResult.kind: "rejected" answers dispatch
GATE_REJECTED with affectedStages so the runner can prune + rebuild;
"answered" continues to dispatch GATE_ANSWERED as before.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: HTTP `kernel-gates` route — dispatch `GATE_REJECTED`

**Files:**
- Modify: `apps/server/src/routes/kernel-gates.ts`
- Modify: `apps/server/src/routes/kernel-gates.test.ts`

- [ ] **Step 1: Write failing test**

Append to `kernel-gates.test.ts`:

```typescript
it("POST /api/kernel/gates/:id/answer dispatches GATE_REJECTED for rollback answers", async () => {
  // Seed DB with a pipeline_version whose IR has rejectable gate.
  // Register a capturing dispatcher.
  const captured: any[] = [];
  taskRegistry.register("task-rb-http", { send: (ev: any) => captured.push(ev) } as any);

  const res = await app.request("/api/kernel/gates/gate-http-1/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer: "reject" }),
  });
  expect(res.status).toBe(200);
  expect(captured.some((e) => e.type === "GATE_REJECTED")).toBe(true);

  taskRegistry.unregister("task-rb-http");
});
```

Follow the existing `kernel-gates.test.ts` fixture pattern.

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter server vitest run src/routes/kernel-gates.test.ts -t "GATE_REJECTED"`
Expected: FAIL — route still dispatches GATE_ANSWERED.

- [ ] **Step 3: Mirror the MCP branching in the HTTP route**

In `apps/server/src/routes/kernel-gates.ts` around lines 91-104, replace the dispatch block:

```typescript
const result = svc.answerGate(id, parsed.data.answer);
if (result.ok) {
  const dispatcher = taskRegistry.get(result.taskId);
  if (result.kind === "rejected") {
    dispatcher?.send({
      type: "GATE_REJECTED",
      gateId: result.gateId,
      stageName: result.stageName,
      answer: result.answer,
      targetStage: result.targetStage,
      affectedStages: result.affectedStages,
    });
  } else {
    dispatcher?.send({
      type: "GATE_ANSWERED",
      gateId: result.gateId,
      stageName: result.stageName,
      answer: result.answer,
      targetStage: result.targetStage,
    });
  }
  return c.json(result);
}
return c.json(result, statusForDiagnostic(result.diagnostics[0]?.code));
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter server vitest run src/routes/kernel-gates.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `pnpm -C apps/server exec tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/kernel-gates.ts apps/server/src/routes/kernel-gates.test.ts
git commit -m "$(cat <<'EOF'
feat(http): kernel-gates route dispatches GATE_REJECTED for rollback

Matches the MCP handler's dispatch branching: kind=rejected →
GATE_REJECTED, kind=answered → GATE_ANSWERED. HTTP and MCP stay in
lockstep so the runner sees the same event regardless of caller.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Runner — handle `GATE_REJECTED`

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/runner.ts`
- Create: `apps/server/src/kernel-next/runtime/runner.reject-rollback.test.ts`

This is the core change. Task 6 splits into sub-steps.

- [ ] **Step 1: Write the failing end-to-end test**

Create `apps/server/src/kernel-next/runtime/runner.reject-rollback.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash as computeVersionHash } from "../ir/canonical.js";
import { KernelNextBroadcaster } from "../sse/broadcaster.js";
import { taskRegistry } from "./task-registry.js";
import { runPipeline } from "./runner.js";
import { MockStageExecutor } from "./mock-executor.js";
import type { PipelineIR } from "../ir/schema.js";

function rollbackIR(): PipelineIR {
  return {
    name: "rb-test",
    version: "1.0.0",
    externalInputs: [],
    stages: [
      { name: "A", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [{ name: "out", type: "unknown" }] } as any,
      { name: "G", type: "gate", config: { routing: { routes: { approve: "B", reject: "A" } } }, inputs: [{ name: "i", type: "unknown" }], outputs: [] } as any,
      { name: "B", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [] } as any,
    ],
    wires: [
      { from: { source: "stage", stage: "A", port: "out" }, to: { stage: "G", port: "i" } },
    ],
  } as unknown as PipelineIR;
}

describe("runner — gate reject rollback", () => {
  it("rolls back to target, re-runs A, re-opens G", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const ir = rollbackIR();
    const vh = computeVersionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const broadcaster = new KernelNextBroadcaster();

    // MockStageExecutor returning port writes per stage.
    // A writes {out: "first"} on first attempt, {out: "second"} on rebuild.
    // (Configure via call-count internal to the mock.)
    let aCalls = 0;
    const executor = new MockStageExecutor({
      // The mock is expected to accept per-stage handlers; adjust shape
      // to match actual MockStageExecutor constructor — see
      // runner.test.ts for the canonical usage.
      handlers: {
        A: async () => {
          aCalls++;
          return { ok: true, portValues: { out: aCalls === 1 ? "first" : "second" } };
        },
        B: async () => ({ ok: true, portValues: {} }),
      },
    } as any);

    const rollbackEvents: any[] = [];
    broadcaster.subscribe("task-rb", (ev) => {
      if (ev.type === "stage_rolled_back") rollbackEvents.push(ev);
    });

    // Start runner in the background; it will pause at gate G.
    const runPromise = runPipeline({
      db, ir, taskId: "task-rb", versionHash: vh,
      handlers: {}, executor, broadcaster,
    });

    // Wait for G to become executing — poll gate_queue.
    await waitForGateQueue(db, "task-rb", "G");

    // Dispatch GATE_REJECTED via taskRegistry.
    const dispatcher = taskRegistry.get("task-rb");
    expect(dispatcher).toBeDefined();
    dispatcher!.send({
      type: "GATE_REJECTED",
      gateId: (await getGateId(db, "task-rb", "G")),
      stageName: "G",
      answer: "reject",
      targetStage: "A",
      affectedStages: ["A", "G"],  // B not downstream of A's wire to G
    });

    // Wait for second G-queue row to appear (rebuild re-opened the gate).
    await waitForSecondGateQueue(db, "task-rb", "G");

    // Answer the re-opened gate with "approve" to complete the pipeline.
    const secondGateId = await getLatestGateId(db, "task-rb", "G");
    dispatcher!.send({
      type: "GATE_ANSWERED",
      gateId: secondGateId,
      stageName: "G",
      answer: "approve",
      targetStage: "B",
    });

    const result = await runPromise;
    expect(result.ok).toBe(true);

    // Assertions:
    expect(aCalls).toBe(2); // A re-ran after rollback
    expect(rollbackEvents).toHaveLength(1);
    expect(rollbackEvents[0].data.fromGate).toBe("G");
    expect(rollbackEvents[0].data.toStage).toBe("A");
  });
});

// Helper impls — poll DB every 20ms up to 3s, fail on timeout:
async function waitForGateQueue(db: DatabaseSync, taskId: string, stageName: string) { /* ... */ }
async function waitForSecondGateQueue(db: DatabaseSync, taskId: string, stageName: string) { /* ... */ }
async function getGateId(db: DatabaseSync, taskId: string, stageName: string): Promise<string> { /* ... */ }
async function getLatestGateId(db: DatabaseSync, taskId: string, stageName: string): Promise<string> { /* ... */ }
```

Helpers: standard polling, typical shape:
```typescript
async function waitForGateQueue(db: DatabaseSync, taskId: string, stageName: string) {
  for (let i = 0; i < 150; i++) {
    const row = db.prepare(
      "SELECT gate_id FROM gate_queue WHERE task_id=? AND stage_name=? AND answered_at IS NULL"
    ).get(taskId, stageName);
    if (row) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for gate ${stageName}`);
}
```

Adapt to the actual `MockStageExecutor` constructor — look at `runner.test.ts` for usage.

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter server vitest run src/kernel-next/runtime/runner.reject-rollback.test.ts`
Expected: FAIL — timeout waiting for rebuild (runner ignores GATE_REJECTED).

- [ ] **Step 3: Add `MachineEvent`/`DispatcherEvent` variant for `GATE_REJECTED`**

Search `ir-to-machine.ts` and `runner.ts` for the `MachineEvent` union type. Add:

```typescript
| {
    type: "GATE_REJECTED";
    gateId: string;
    stageName: string;
    answer: string;
    targetStage: string;
    affectedStages: string[];
  }
```

to the union. The XState machine DOES NOT need to handle this event — it's intercepted by the runner's dispatcher listener BEFORE reaching the actor. But adding it to the union keeps TypeScript honest.

- [ ] **Step 4: Intercept `GATE_REJECTED` in the runner's dispatcher**

In `apps/server/src/kernel-next/runtime/runner.ts`, find where the dispatcher relays events to `currentActor`. Look for the dispatcher construction (around the `taskRegistry.register(opts.taskId, dispatcher)` call, line ~215). The dispatcher is typically a wrapper: `{ send: (ev) => { if (shouldIntercept) handleHere(); else currentActor.send(ev); } }`. If the current dispatcher is a direct passthrough, wrap it:

```typescript
const rawDispatcher = /* existing dispatcher */;
const dispatcher: EventDispatcher = {
  send: (ev: DispatcherEvent) => {
    if (ev.type === "GATE_REJECTED") {
      void handleGateReject(ev);
      return;
    }
    rawDispatcher.send(ev);
  },
};
```

`handleGateReject` is the new helper to write. Define it inline (closure over `currentActor`, `persistent*` state, `opts.broadcaster`, `opts.taskId`, `isRetryRebuild`, etc.):

```typescript
const handleGateReject = async (ev: Extract<DispatcherEvent, { type: "GATE_REJECTED" }>) => {
  if (!currentActor) return;

  const affected = new Set(ev.affectedStages);

  // 1. Snapshot & prune persistent state.
  const ctx = currentActor.getSnapshot().context as MachineContext;
  persistentFinalizedStages = ctx.finalizedStages.filter(f => !affected.has(f.name));
  persistentPortValues = prunePortValues(ctx.portValues, affected);
  persistentGateAuthorized = ctx.gateAuthorizedTargets.filter(t => !affected.has(t));
  persistentGateSkipped = ctx.gateSkippedTargets.filter(t => !affected.has(t));
  retryCounts = pruneRetryCounts(ctx.retryCounts, affected);

  // 2. Publish SSE.
  opts.broadcaster.publish({
    type: "stage_rolled_back",
    taskId: opts.taskId,
    timestamp: new Date().toISOString(),
    data: {
      fromGate: ev.stageName,
      toStage: ev.targetStage,
      affectedStages: ev.affectedStages,
    },
  });

  // 3. Stop current actor.
  try {
    currentActor.stop();
  } catch {
    // ignore double-stop
  }

  // 4. Trigger rebuild. Reuse the same rebuild path as retry. Signal
  //    "don't replay this gate" via rejectFromGate.
  rebuildActor({ rejectFromGate: { gateName: ev.stageName } });
};
```

`prunePortValues` and `pruneRetryCounts` helpers:

```typescript
function prunePortValues(
  values: Record<string, unknown>,
  affected: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    const stage = k.split(".")[0];
    if (affected.has(stage)) continue;
    out[k] = v;
  }
  return out;
}

function pruneRetryCounts(
  counts: Record<string, number>,
  affected: Set<string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) {
    if (affected.has(k)) continue;
    out[k] = v;
  }
  return out;
}
```

Add these as module-level functions near the existing helpers.

- [ ] **Step 5: Extract `rebuildActor(options)` helper if it's inline**

Task C5's rebuild logic is currently inline inside the retry path. Extract it into a function `rebuildActor(opts: { rejectFromGate?: { gateName: string } })` if feasible. If extraction is too invasive, leave retry rebuild inline and add a parallel function that does the same thing for reject rollback — but pay DRY tax by duplicating the replay loop.

Prefer extraction. The extracted function should:
1. Build `initialContext` from current `persistent*` state.
2. Call `compileIRToMachine(opts.ir, { taskId: opts.taskId, initialContext, seedValues: opts.seedValues })`.
3. `createActor(compiled.machine)`; register inspector; start; `send({ type: "START" })`.
4. Run the gate replay loop, SKIPPING the rejected gate if `opts.rejectFromGate?.gateName === finalized.name`.
5. Update `currentActor` reference so subsequent dispatches hit the new actor.

- [ ] **Step 6: Update the gate replay loop**

At `runner.ts:926-963` inside the for-loop that iterates `persistentFinalizedStages` and synthesizes `GATE_ANSWERED` for each finalized gate:

```typescript
for (const finalized of persistentFinalizedStages) {
  if (finalized.outcome !== "done") continue;
  // NEW: skip replaying the gate that was just rejected.
  if (rebuildOptions.rejectFromGate?.gateName === finalized.name) continue;
  // ... existing code ...
}
```

Threading `rebuildOptions` through depends on how Step 5's extraction lands. If extraction didn't happen, add a local variable `rejectFromGate: { gateName: string } | undefined` scoped to the attempt Promise, set when `handleGateReject` runs, and consulted here.

- [ ] **Step 7: Run test — expect PASS**

Run: `pnpm --filter server vitest run src/kernel-next/runtime/runner.reject-rollback.test.ts`
Expected: PASS. If fails, debug incrementally: is `rollbackEvents` empty (SSE not published)? Is `aCalls !== 2` (re-run didn't happen)? Narrow one at a time.

- [ ] **Step 8: Type-check + full runner test suite**

Run: `pnpm -C apps/server exec tsc --noEmit`
Run: `pnpm --filter server vitest run src/kernel-next/runtime/`
Expected: all PASS, no regression in existing runner tests.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/kernel-next/runtime/runner.ts apps/server/src/kernel-next/runtime/runner.reject-rollback.test.ts
git commit -m "$(cat <<'EOF'
feat(runner): handle GATE_REJECTED via prune + rebuild

On GATE_REJECTED, snapshot the current actor's context, prune all
persistent state entries (finalizedStages, portValues, gateAuthorized,
gateSkipped, retryCounts) whose stage belongs to affectedStages,
publish stage_rolled_back, stop the actor, and rebuild via the
existing C5 retry-rebuild machinery. The rebuild replay loop skips
the rejected gate so it re-enters executing and blocks for a fresh
answer.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: MCP `wait_pipeline_result` — ignore `stage_rolled_back`

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.ts`
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.test.ts`

- [ ] **Step 1: Write failing test**

Append to `pg-entry.test.ts`:

```typescript
describe("handleWaitPipelineResult — rollback transparency", () => {
  it("ignores stage_rolled_back and keeps waiting for terminal event", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-rb-wait";
    const ir = realIR();

    // Seed done data so run_final completed can assemble.
    seedDone(db, taskId, "desc");

    // Sequence: publish stage_rolled_back FIRST, then run_final completed.
    broadcaster.publish({
      taskId, timestamp: new Date().toISOString(),
      type: "stage_rolled_back",
      data: { fromGate: "G", toStage: "A", affectedStages: ["A", "G"] },
    });
    broadcaster.publish({
      taskId, timestamp: new Date().toISOString(),
      type: "run_final",
      data: { finalState: "completed", stageErrors: [] } as any,
    });

    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 2000 }, { db, broadcaster, ir });
    expect(res.ok).toBe(true);
    if (!res.ok || res.status !== "done") throw new Error("expected done");
  });
});
```

`seedDone` helper already exists in `pg-entry.test.ts` (Task 6/11 of the prior milestone).

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/pg-entry.test.ts -t "rollback transparency"`
Expected: FAIL — current code has no branch for `stage_rolled_back`; the switch falls through to default which may or may not settle. If the current listener ends with an implicit ignore, test may PASS accidentally; still write it as a regression guard.

- [ ] **Step 3: Add explicit no-op branch**

In `apps/server/src/kernel-next/mcp/pg-entry.ts`, inside the broadcaster subscribe callback of `handleWaitPipelineResult`, add after the existing terminal-event branches:

```typescript
if (ev.type === "stage_rolled_back") {
  // Transient event; pipeline will re-open a gate or reach a new
  // terminal. Keep waiting.
  return;
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/pg-entry.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp/pg-entry.ts apps/server/src/kernel-next/mcp/pg-entry.test.ts
git commit -m "$(cat <<'EOF'
feat(pg-entry): ignore stage_rolled_back in wait_pipeline_result

Rollback is transient; wait handlers should not treat it as a
terminal. Explicit no-op branch documents the intent and locks it
in a regression test.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Final sanity

**Files:** none (verification only)

- [ ] **Step 1: Type-check**

Run: `pnpm -C apps/server exec tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Full server vitest**

Run: `pnpm --filter server vitest run`
Expected: PASS — 4242 + new tests, no regressions.

- [ ] **Step 3: Full web tsc**

Run: `pnpm -C apps/web exec tsc --noEmit`
Expected: clean. If any frontend code imports SSE event union, the new `stage_rolled_back` case may require handling — add a minimal case or default-ignore.

- [ ] **Step 4: Verify git log**

Run: `git log --oneline -10`
Expected: 7 milestone commits in order (Tasks 1-7) + this verification has no new commit of its own.

- [ ] **Step 5: Optional manual smoke**

Start the server locally, run a pipeline-generator task to the `awaitingConfirm` gate, answer `reject` via the MCP `answer_gate` tool. Observe:
- `stage_rolled_back` SSE event arrives
- `analyzing` re-enters executing
- A new `awaitingConfirm` gate_queue row appears, waiting for fresh answer

Not required for plan completion.

---

## Self-Review

**Spec coverage:**
- §1 success criteria 1 (reject triggers re-run): Tasks 3+4+5+6
- §1 success criteria 2 (state pruned): Task 6 Steps 4 + helpers
- §1 success criteria 3 (upstream state preserved): Task 6 prune logic + Task 6 test assertions
- §1 success criteria 4 (gate re-opens): Task 6 replay-loop skip + reject-rollback test
- §1 success criteria 5 (SSE emitted): Task 2 + Task 6 Step 4
- §1 success criteria 6 (no regression): Task 8 full suite
- §5 compile-time algorithm: Task 1
- §6 kernel layer: Task 3
- §7 runner layer: Task 6
- §8 SSE type: Task 2
- §9 wait ignores: Task 7

**Placeholder scan:** Task 3 test helper `setupRejectReadyDb()` is described at an abstract level ("inline the minimum INSERTs"). This is necessary because the concrete SQL depends on the existing test file's fixture idioms; the plan cannot reproduce them verbatim without reading the file. The instruction is actionable ("follow the seeding idioms already in kernel.test.ts"). Similarly Task 6 Step 1 leaves poll helpers as skeletons with worked-example SQL. Not placeholders — they are concrete engineering instructions.

**Type consistency:** `RejectRollback` / `AnswerGateResult.kind` / `GATE_REJECTED` event / `StageRolledBackData` / `rejectFromGate.gateName` all named consistently across Tasks 1-7.

**Potential gap:** Task 3 Step 6 notes TS may complain at Task 4/5 dispatch sites. If it does, Task 3's commit leaves the tree broken for the short interval between Task 3 and Task 4. Acceptable because implementer does them in sequence; if parallelism were a concern, Task 3 would add a temporary `if (result.kind === "answered")` narrowing at the two dispatch sites to keep TS happy. The plan assumes sequential execution (subagent-driven development default).
