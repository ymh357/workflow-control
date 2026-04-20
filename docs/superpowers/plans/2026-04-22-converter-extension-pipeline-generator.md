# Converter Extension for pipeline-generator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pipeline-generator/pipeline.yaml` convert and run end-to-end on kernel-next without hand-porting to a TypeScript IR factory.

**Architecture:** Extend the legacy-YAML converter with three new passes (parallel unwrap, human_confirm→gate, retry back_to rewrite), extend IR schema with two new optional fields (AgentStage.config.subAgents, ScriptStage.config.retry), widen GateRoutingSchema.routes to accept arrays, add a RETRY_TO_STAGE control loop in runner, and thread sub-agents through RealStageExecutor to the Claude SDK.

**Tech Stack:** TypeScript strict mode, XState v5, Zod v4, Vitest, Claude Agent SDK 0.2.63, better-sqlite3. No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-22-converter-extension-pipeline-generator-design.md`

**R5 resolution (from spec §9.2):** AgentDefinition in Claude Agent SDK 0.2.63 (`sdk.d.ts:34-68`) treats `tools` as allow-list (omit = inherit parent), `disallowedTools` as independent per-sub-agent. Spec's SubAgentDef shape covers what pipeline-generator actually uses (description/prompt/tools/model/maxTurns). disallowedTools/skills/mcpServers pass-through is YAGNI — not in this plan.

---

## File structure overview

**New files (converter):**
- `apps/server/src/kernel-next/converter/unwrap-parallel-blocks.ts`
- `apps/server/src/kernel-next/converter/unwrap-parallel-blocks.test.ts`
- `apps/server/src/kernel-next/converter/map-human-confirm-gates.ts`
- `apps/server/src/kernel-next/converter/map-human-confirm-gates.test.ts`
- `apps/server/src/kernel-next/converter/rewrite-retry-back-to.ts`
- `apps/server/src/kernel-next/converter/rewrite-retry-back-to.test.ts`
- `apps/server/src/kernel-next/converter/topo-downstream.ts` (shared helper; runner also uses)
- `apps/server/src/kernel-next/converter/topo-downstream.test.ts`

**New files (integration tests):**
- `apps/server/src/kernel-next/converter/pipeline-generator.test.ts` (full-convert integration)
- `apps/server/src/kernel-next/runtime/pipeline-generator-run.test.ts` (MockExecutor E2E)

**Modified files:**
- `apps/server/src/kernel-next/ir/schema.ts` — SubAgentDefSchema, RetrySpecSchema, AgentStage.config.subAgents, ScriptStage.config.retry, GateRoutingSchema.routes union
- `apps/server/src/kernel-next/ir/canonical.ts` — canonicalize subAgents + retry; preserve routes input shape
- `apps/server/src/kernel-next/converter/legacy-yaml.ts` — wire in three new passes
- `apps/server/src/kernel-next/converter/map-stages.ts` — extract subAgents/retry; delete four UNSUPPORTED_FEATURE branches
- `apps/server/src/kernel-next/converter/types.ts` — add diagnostic codes
- `apps/server/src/kernel-next/compiler/ir-to-machine.ts` — MachineContext.retryCounts; retry transition on ScriptStage; gate routing array normalization
- `apps/server/src/kernel-next/runtime/runner.ts` — RETRY_TO_STAGE handler; GATE_ANSWERED multi-target handling; stage_retry SSE publish
- `apps/server/src/kernel-next/runtime/real-executor.ts` — buildSdkAgents, thread into options
- `apps/server/src/kernel-next/sse/types.ts` — StageRetryData, KernelNextStageRetryEvent, union update
- `apps/server/src/routes/kernel-run.ts` — register pipeline-generator via helper

**Unchanged (intentional):** apps/web/**, validator/**, mcp/**.

---

# Slice A — Parallel unwrap + human_confirm→gate + back_to redirect

Slice A touches: schema.ts (gate routes widening), canonical.ts, three new converter passes, map-stages.ts (remove 4 UNSUPPORTED branches), types.ts, ir-to-machine.ts (gate routing array normalization), runner.ts (GATE_ANSWERED multi-target).

State after Slice A:
- `pipeline-generator.yaml` converts with zero fatal diagnostics.
- kernel-next can run it up to the point where genPrompts tries to spawn a sub-agent (that happens in Slice D).
- persisting failure reaches `stage_error` (retry happens in Slice C).

## Task A1: Add new diagnostic codes

**Files:**
- Modify: `apps/server/src/kernel-next/converter/types.ts`

- [ ] **Step 1: Read existing types.ts to understand the enum shape**

Run: `cat apps/server/src/kernel-next/converter/types.ts`

Expected: see `ConverterErrorCode` as a string union, `WarningCode` similarly.

- [ ] **Step 2: Add fatal diagnostic codes**

Locate the `ConverterErrorCode` union. Add these members:
```ts
  | "NESTED_PARALLEL_UNSUPPORTED"
  | "PARALLEL_EMPTY"
  | "PARALLEL_NAME_COLLISION"
  | "HUMAN_CONFIRM_AT_END"
  | "HUMAN_CONFIRM_NO_REJECT_TARGET"
  | "RETRY_BACK_TO_UNKNOWN"
  | "SUB_AGENT_INVALID"
```

- [ ] **Step 3: Add warning code**

Locate the `WarningCode` union. Add:
```ts
  | "RETRY_BACK_TO_REDIRECTED"
```

- [ ] **Step 4: Verify tsc clean**

Run: `cd apps/server && npx tsc --noEmit`
Expected: no output (clean). Existing usages of the unions continue to narrow.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/converter/types.ts
git commit -m "feat(converter): add diagnostic codes for parallel/gate/retry mappings"
```

## Task A2: topoDownstream helper

Shared between rewriteRetryBackTo and runner's retry handler. Build it first so later tasks import from it.

**Files:**
- Create: `apps/server/src/kernel-next/converter/topo-downstream.ts`
- Create: `apps/server/src/kernel-next/converter/topo-downstream.test.ts`

- [ ] **Step 1: Write the failing test**

File `apps/server/src/kernel-next/converter/topo-downstream.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { topoDownstream } from "./topo-downstream.js";
import type { WireIR } from "../ir/schema.js";

const wire = (fromStage: string, toStage: string): WireIR => ({
  from: { source: "stage", stage: fromStage, port: "x" },
  to: { stage: toStage, port: "x" },
});

describe("topoDownstream", () => {
  it("returns empty set for a stage with no outgoing wires", () => {
    expect(topoDownstream([], "A")).toEqual([]);
  });

  it("returns direct downstream", () => {
    expect(topoDownstream([wire("A", "B")], "A")).toEqual(["B"]);
  });

  it("returns transitive closure", () => {
    const wires = [wire("A", "B"), wire("B", "C"), wire("C", "D")];
    const result = topoDownstream(wires, "A");
    expect(result.sort()).toEqual(["B", "C", "D"]);
  });

  it("handles diamonds without duplicates", () => {
    const wires = [wire("A", "B"), wire("A", "C"), wire("B", "D"), wire("C", "D")];
    const result = topoDownstream(wires, "A");
    expect(result.sort()).toEqual(["B", "C", "D"]);
  });

  it("skips external wires (external sources have no producer stage)", () => {
    const wires: WireIR[] = [
      { from: { source: "external", port: "seed" }, to: { stage: "A", port: "x" } },
      wire("A", "B"),
    ];
    const result = topoDownstream(wires, "A");
    expect(result).toEqual(["B"]);
  });

  it("does not include the start stage itself", () => {
    expect(topoDownstream([wire("A", "B")], "A")).not.toContain("A");
  });

  it("handles cycles defensively (returns finite set)", () => {
    // Cycles are structurally forbidden by DAG validator, but the helper
    // must not hang if called on malformed input.
    const wires = [wire("A", "B"), wire("B", "A")];
    const result = topoDownstream(wires, "A");
    expect(result).toContain("B");
    expect(result.length).toBeLessThan(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/topo-downstream.test.ts`
Expected: FAIL — "Cannot find module './topo-downstream.js'"

- [ ] **Step 3: Write minimal implementation**

File `apps/server/src/kernel-next/converter/topo-downstream.ts`:
```ts
// Transitive closure of all stages reachable from `start` via
// stage-to-stage wires. External-sourced wires are skipped since
// they have no producing stage. Cycle-safe (uses a visited set).

import type { WireIR } from "../ir/schema.js";

export function topoDownstream(wires: WireIR[], start: string): string[] {
  const visited = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const w of wires) {
      if (w.from.source !== "stage") continue;
      if (w.from.stage !== current) continue;
      const next = w.to.stage;
      if (visited.has(next) || next === start) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return Array.from(visited);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/topo-downstream.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: tsc check**

Run: `cd apps/server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/kernel-next/converter/topo-downstream.ts \
        apps/server/src/kernel-next/converter/topo-downstream.test.ts
git commit -m "feat(converter): add topoDownstream transitive-closure helper"
```

## Task A3: unwrapParallelBlocks

**Files:**
- Create: `apps/server/src/kernel-next/converter/unwrap-parallel-blocks.ts`
- Create: `apps/server/src/kernel-next/converter/unwrap-parallel-blocks.test.ts`

- [ ] **Step 1: Write the failing test**

File `apps/server/src/kernel-next/converter/unwrap-parallel-blocks.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { unwrapParallelBlocks } from "./unwrap-parallel-blocks.js";

describe("unwrapParallelBlocks", () => {
  it("flattens a parallel block and records blockMap entry", () => {
    const legacy = {
      stages: [
        { name: "A", type: "agent" },
        { parallel: { name: "group", stages: [
          { name: "B1", type: "agent" },
          { name: "B2", type: "agent" },
        ] } },
        { name: "C", type: "agent" },
      ],
    };
    const r = unwrapParallelBlocks(legacy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flat.map((s: any) => s.name)).toEqual(["A", "B1", "B2", "C"]);
    expect(r.blockMap.get("group")).toBe("B1");
    expect(r.blockMembers.get("group")).toEqual(["B1", "B2"]);
  });

  it("preserves non-parallel stages unchanged", () => {
    const legacy = { stages: [{ name: "A", type: "agent", foo: 1 }] };
    const r = unwrapParallelBlocks(legacy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flat[0]).toEqual({ name: "A", type: "agent", foo: 1 });
    expect(r.blockMap.size).toBe(0);
  });

  it("rejects nested parallel", () => {
    const legacy = {
      stages: [{
        parallel: {
          name: "outer",
          stages: [{ parallel: { name: "inner", stages: [{ name: "X" }] } }],
        },
      }],
    };
    const r = unwrapParallelBlocks(legacy);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("NESTED_PARALLEL_UNSUPPORTED");
  });

  it("rejects empty parallel block", () => {
    const legacy = { stages: [{ parallel: { name: "g", stages: [] } }] };
    const r = unwrapParallelBlocks(legacy);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("PARALLEL_EMPTY");
  });

  it("rejects name collision between inner and outer stages", () => {
    const legacy = {
      stages: [
        { name: "dup", type: "agent" },
        { parallel: { name: "g", stages: [{ name: "dup", type: "agent" }] } },
      ],
    };
    const r = unwrapParallelBlocks(legacy);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("PARALLEL_NAME_COLLISION");
  });

  it("rejects name collision between two parallel blocks' inner stages", () => {
    const legacy = {
      stages: [
        { parallel: { name: "g1", stages: [{ name: "dup", type: "agent" }] } },
        { parallel: { name: "g2", stages: [{ name: "dup", type: "agent" }] } },
      ],
    };
    const r = unwrapParallelBlocks(legacy);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("PARALLEL_NAME_COLLISION");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/unwrap-parallel-blocks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

File `apps/server/src/kernel-next/converter/unwrap-parallel-blocks.ts`:
```ts
// Flatten legacy `parallel: { name, stages }` blocks into a linear
// stage array. Each block's outer name is recorded in blockMap so
// later passes (rewriteRetryBackTo, mapHumanConfirmGates) can resolve
// references to it.
//
// Rules:
//   - Nested parallel blocks are rejected.
//   - Empty parallel.stages are rejected.
//   - Stage names must be globally unique across inner + outer.

import type { ConverterDiagnostic } from "./types.js";

interface LegacyStage {
  name?: string;
  [k: string]: unknown;
}
interface ParallelBlock {
  parallel: { name: string; stages: LegacyStage[] };
}
type TopLevel = LegacyStage | ParallelBlock;

export type UnwrapResult =
  | { ok: true;
      flat: LegacyStage[];
      blockMap: Map<string, string>;
      blockMembers: Map<string, string[]>;
    }
  | { ok: false; diagnostics: ConverterDiagnostic[] };

function isParallelBlock(s: unknown): s is ParallelBlock {
  return typeof s === "object" && s !== null && "parallel" in s;
}

export function unwrapParallelBlocks(legacy: { stages?: TopLevel[] }): UnwrapResult {
  const flat: LegacyStage[] = [];
  const blockMap = new Map<string, string>();
  const blockMembers = new Map<string, string[]>();
  const seenNames = new Set<string>();
  const diagnostics: ConverterDiagnostic[] = [];

  for (const el of legacy.stages ?? []) {
    if (isParallelBlock(el)) {
      const block = el.parallel;
      if (block.stages.length === 0) {
        diagnostics.push({
          code: "PARALLEL_EMPTY",
          message: `parallel block '${block.name}' has no stages`,
          context: { block: block.name },
        });
        continue;
      }
      const members: string[] = [];
      for (const inner of block.stages) {
        if (isParallelBlock(inner)) {
          diagnostics.push({
            code: "NESTED_PARALLEL_UNSUPPORTED",
            message: `parallel block '${block.name}' contains a nested parallel block`,
            context: { outer: block.name },
          });
          continue;
        }
        const innerName = inner.name;
        if (typeof innerName === "string") {
          if (seenNames.has(innerName)) {
            diagnostics.push({
              code: "PARALLEL_NAME_COLLISION",
              message: `stage '${innerName}' in parallel block '${block.name}' duplicates an earlier stage name`,
              context: { stage: innerName, block: block.name },
            });
            continue;
          }
          seenNames.add(innerName);
          members.push(innerName);
        }
        flat.push(inner);
      }
      const first = block.stages[0];
      if (first && typeof first.name === "string") {
        blockMap.set(block.name, first.name);
      }
      if (members.length > 0) {
        blockMembers.set(block.name, members);
      }
    } else {
      const stage = el;
      const name = stage.name;
      if (typeof name === "string") {
        if (seenNames.has(name)) {
          diagnostics.push({
            code: "PARALLEL_NAME_COLLISION",
            message: `stage '${name}' duplicates an earlier stage name`,
            context: { stage: name },
          });
          continue;
        }
        seenNames.add(name);
      }
      flat.push(stage);
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, flat, blockMap, blockMembers };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/unwrap-parallel-blocks.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: tsc check + commit**

```bash
cd apps/server && npx tsc --noEmit
```
Expected: clean.

```bash
git add apps/server/src/kernel-next/converter/unwrap-parallel-blocks.ts \
        apps/server/src/kernel-next/converter/unwrap-parallel-blocks.test.ts
git commit -m "feat(converter): unwrap parallel blocks into flat stage array"
```

## Task A4: Widen GateRoutingSchema.routes to string | string[]

**Files:**
- Modify: `apps/server/src/kernel-next/ir/schema.ts`
- Modify: `apps/server/src/kernel-next/ir/canonical.ts`

- [ ] **Step 1: Read current schema and canonical shape**

Run: `grep -n "GateRouting\|canonicalizeStage\|canonicalizeGate" apps/server/src/kernel-next/ir/schema.ts apps/server/src/kernel-next/ir/canonical.ts`

Note the existing `routes: z.record(z.string().min(1), identifier)` and any gate-specific canonicalizer.

- [ ] **Step 2: Write the failing test — schema accepts arrays**

File `apps/server/src/kernel-next/ir/schema.test.ts` — find existing gate routing tests and add alongside them:

```ts
it("GateRoutingSchema accepts string-array route targets", () => {
  const parsed = GateRoutingSchema.parse({
    routes: { approve: ["X", "Y"], reject: "Z" },
  });
  expect(parsed.routes.approve).toEqual(["X", "Y"]);
  expect(parsed.routes.reject).toBe("Z");
});

it("GateRoutingSchema rejects empty route-target array", () => {
  expect(() => GateRoutingSchema.parse({ routes: { x: [] } })).toThrow();
});
```

If `schema.test.ts` does not exist, create it with the standard imports:
```ts
import { describe, it, expect } from "vitest";
import { GateRoutingSchema } from "./schema.js";
describe("GateRoutingSchema", () => { /* insert tests */ });
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/server && npx vitest run src/kernel-next/ir/schema.test.ts`
Expected: FAIL — array value fails current `identifier`-only record.

- [ ] **Step 4: Modify GateRoutingSchema**

In `apps/server/src/kernel-next/ir/schema.ts`, replace the current GateRoutingSchema with:

```ts
export const GateRoutingSchema = z.object({
  // Routes: answer value → target stage name(s). Single stage stays a
  // string; multiple stages (used when a human gate gates a parallel
  // block whose stages all need simultaneous authorization) use an
  // array. Canonical form preserves the input shape so existing
  // fixture hashes stay byte-identical.
  routes: z.record(
    z.string().min(1),
    z.union([identifier, z.array(identifier).min(1)]),
  ),
});
```

- [ ] **Step 5: Re-run schema tests**

Run: `cd apps/server && npx vitest run src/kernel-next/ir/schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Write failing test for canonical shape preservation**

In `apps/server/src/kernel-next/ir/canonical.test.ts` find the existing gate-fixture hash assertion (or add if missing). Add:

```ts
it("preserves single-string route targets in canonical form (hash stable)", () => {
  const ir = /* construct IR with gate routes: { approve: "B", reject: "C" } */;
  const canon = canonicalizeIR(ir);
  expect(canon).toContain('"approve":"B"');
  expect(canon).not.toContain('"approve":["B"]');
});

it("preserves array route targets in canonical form", () => {
  const ir = /* IR with routes: { approve: ["B", "C"] } */;
  const canon = canonicalizeIR(ir);
  expect(canon).toContain('"approve":["B","C"]');
});
```

(Use the existing IR-construction helper in the test file; mirror how prior tests build fixtures.)

- [ ] **Step 7: Run canonical tests to verify baseline still passes**

Run: `cd apps/server && npx vitest run src/kernel-next/ir/canonical.test.ts`
Expected: existing gate-fixture hash assertions still pass (shape preservation works automatically since JSON.stringify serializes string and array verbatim). New multi-target test passes if the canonicalizer emits array.

If existing canonicalizer sorts or normalizes differently, update `canonicalizeStage`/`canonicalizeGateConfig` to pass through the routes value verbatim (no widening string → [string]).

- [ ] **Step 8: Full IR test suite**

Run: `cd apps/server && npx vitest run src/kernel-next/ir/`
Expected: PASS. Baseline hashes (diamondIR, smokeTestIR) unchanged.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/kernel-next/ir/schema.ts \
        apps/server/src/kernel-next/ir/schema.test.ts \
        apps/server/src/kernel-next/ir/canonical.ts \
        apps/server/src/kernel-next/ir/canonical.test.ts
git commit -m "feat(ir): widen gate routing to string | string[] (shape-preserving canonical)"
```

## Task A5: ir-to-machine + runner normalize gate routes to arrays internally

**Files:**
- Modify: `apps/server/src/kernel-next/compiler/ir-to-machine.ts` (gate routing target iteration)
- Modify: `apps/server/src/kernel-next/runtime/runner.ts` (GATE_ANSWERED multi-target handling if present there)

- [ ] **Step 1: Inspect current gate-routing iteration**

Run: `grep -n "routing.routes\|gateRoutedTargets\|gateAuthorizedTargets\|gateSkippedTargets" apps/server/src/kernel-next/compiler/ir-to-machine.ts apps/server/src/kernel-next/runtime/runner.ts`

You should see sites that iterate `Object.values(routing.routes)` and push the value into Sets as if it were always a string.

- [ ] **Step 2: Write the failing test — ir-to-machine registers array targets**

In `apps/server/src/kernel-next/compiler/ir-to-machine.test.ts` add:

```ts
it("gate with array routing registers every stage in gateRoutedTargets", () => {
  const ir: PipelineIR = {
    name: "array-gate",
    externalInputs: [],
    stages: [
      { name: "G", type: "gate",
        inputs: [], outputs: [],
        config: {
          question: { text: "?" },
          routing: { routes: { yes: ["A", "B"], no: "C" } },
        } },
      { name: "A", type: "agent", inputs: [], outputs: [],
        config: { promptRef: "p" } },
      { name: "B", type: "agent", inputs: [], outputs: [],
        config: { promptRef: "p" } },
      { name: "C", type: "agent", inputs: [], outputs: [],
        config: { promptRef: "p" } },
    ],
    wires: [],
  };
  const machine = compileIRToMachine(ir);
  // Access the machine-level metadata introspection. Existing tests
  // in this file use a similar pattern — mirror whatever they do to
  // inspect `gateRoutedTargets`.
  // Assert A, B, and C all appear as gate-routed.
  expect(/* gate-routed set */).toContain("A");
  expect(/* ... */).toContain("B");
  expect(/* ... */).toContain("C");
});
```

(If ir-to-machine.test.ts does not have an existing introspection pattern for gateRoutedTargets, fall back to running the machine briefly and observing that A/B/C all require GATE_ANSWERED before executing. Use the mock-runner pattern already in runner.test.ts.)

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/server && npx vitest run src/kernel-next/compiler/ir-to-machine.test.ts`
Expected: FAIL — current loop sees value as string, pushes whole array as a single string, A/B don't get registered individually.

- [ ] **Step 4: Modify ir-to-machine.ts gate target iteration**

Find the loop (reference: around `ir-to-machine.ts:130` for `gateRoutedTargets.add`). Change:

```ts
// before
for (const target of Object.values(s.config.routing.routes)) {
  gateRoutedTargets.add(target);
}
```

to:

```ts
// after
for (const target of Object.values(s.config.routing.routes)) {
  if (Array.isArray(target)) {
    for (const t of target) gateRoutedTargets.add(t);
  } else {
    gateRoutedTargets.add(target);
  }
}
```

- [ ] **Step 5: Modify runner.ts GATE_ANSWERED handling**

Run: `grep -n "GATE_ANSWERED\|gateAuthorizedTargets\|gateSkippedTargets" apps/server/src/kernel-next/runtime/runner.ts`

Identify where GATE_ANSWERED action populates gateAuthorizedTargets (picked answer) and gateSkippedTargets (non-picked answers). Apply the same array/string split:

```ts
// Picked answer -> authorize every target (array-aware)
const pickedTargets = gate.routing.routes[answer];
const authorizedList = Array.isArray(pickedTargets) ? pickedTargets : [pickedTargets];
for (const t of authorizedList) ctx.gateAuthorizedTargets.push(t);

// Non-picked answers -> skip every target (array-aware)
for (const [key, value] of Object.entries(gate.routing.routes)) {
  if (key === answer) continue;
  const skippedList = Array.isArray(value) ? value : [value];
  for (const t of skippedList) ctx.gateSkippedTargets.push(t);
}
```

- [ ] **Step 6: Re-run ir-to-machine test**

Run: `cd apps/server && npx vitest run src/kernel-next/compiler/ir-to-machine.test.ts`
Expected: PASS.

- [ ] **Step 7: Write failing test — runner GATE_ANSWERED with array routing**

In `apps/server/src/kernel-next/runtime/runner.test.ts` add (near existing gate tests):

```ts
it("GATE_ANSWERED with array target authorizes all listed stages", async () => {
  // Pipeline: Gate G → routes { approve: [A, B], reject: C }
  // A and B read from external seed 'ctx' so they're not wire-dependent.
  // Expected: after GATE_ANSWERED { answer: "approve" }, both A and B run.
  // ... construct IR, run, assert stage_done emitted for both A and B
  //     while C is skipped (gateSkippedTargets).
});
```

Mirror the body of an existing runner.test.ts gate test; just use an array-valued route.

- [ ] **Step 8: Run to verify pass**

Run: `cd apps/server && npx vitest run src/kernel-next/runtime/runner.test.ts`
Expected: PASS.

- [ ] **Step 9: Full server suite**

Run: `cd apps/server && npx vitest run`
Expected: all existing tests green, new tests added pass.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/kernel-next/compiler/ir-to-machine.ts \
        apps/server/src/kernel-next/compiler/ir-to-machine.test.ts \
        apps/server/src/kernel-next/runtime/runner.ts \
        apps/server/src/kernel-next/runtime/runner.test.ts
git commit -m "feat(runtime): normalize gate routing array targets in compiler + runner"
```

## Task A6: mapHumanConfirmGates

**Files:**
- Create: `apps/server/src/kernel-next/converter/map-human-confirm-gates.ts`
- Create: `apps/server/src/kernel-next/converter/map-human-confirm-gates.test.ts`

- [ ] **Step 1: Write the failing test**

File `apps/server/src/kernel-next/converter/map-human-confirm-gates.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mapHumanConfirmGates } from "./map-human-confirm-gates.js";

describe("mapHumanConfirmGates", () => {
  it("maps human_confirm with on_reject_to to gate shape with single approve target", () => {
    const flat = [
      { name: "A", type: "agent" },
      { name: "gate1", type: "human_confirm", runtime: { on_reject_to: "A" } },
      { name: "B", type: "agent" },
    ];
    const r = mapHumanConfirmGates(flat as any, new Map());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gate = r.stages.find((s: any) => s.name === "gate1");
    expect(gate!.type).toBe("gate");
    expect((gate as any).config.routing.routes).toEqual({ approve: "B", reject: "A" });
  });

  it("emits array approve target when following stage is first of a parallel block", () => {
    const flat = [
      { name: "A", type: "agent" },
      { name: "gate1", type: "human_confirm", runtime: { on_reject_to: "A" } },
      { name: "B1", type: "agent" },
      { name: "B2", type: "agent" },
    ];
    // Pretend "group" was a parallel block that produced B1 + B2.
    const blockMap = new Map([["group", "B1"]]);
    const blockMembers = new Map([["B1", ["B1", "B2"]]]);
    const r = mapHumanConfirmGates(flat as any, blockMembers);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gate = r.stages.find((s: any) => s.name === "gate1");
    expect((gate as any).config.routing.routes.approve).toEqual(["B1", "B2"]);
  });

  it("rejects human_confirm at the end of the flat array", () => {
    const flat = [
      { name: "A", type: "agent" },
      { name: "gate1", type: "human_confirm", runtime: { on_reject_to: "A" } },
    ];
    const r = mapHumanConfirmGates(flat as any, new Map());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("HUMAN_CONFIRM_AT_END");
  });

  it("rejects human_confirm without on_reject_to", () => {
    const flat = [
      { name: "gate1", type: "human_confirm" },
      { name: "B", type: "agent" },
    ];
    const r = mapHumanConfirmGates(flat as any, new Map());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("HUMAN_CONFIRM_NO_REJECT_TARGET");
  });

  it("passes through non-human_confirm stages unchanged", () => {
    const flat = [
      { name: "A", type: "agent", foo: 1 },
      { name: "B", type: "script", bar: 2 },
    ];
    const r = mapHumanConfirmGates(flat as any, new Map());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stages).toEqual(flat);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/map-human-confirm-gates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

File `apps/server/src/kernel-next/converter/map-human-confirm-gates.ts`:
```ts
// Transforms flat-array legacy stages with type "human_confirm" into
// kernel-next gate stages. The approve target is the following stage
// in the flat array; when that stage was the first stage of a parallel
// block, the approve target is every stage flattened out of the block.
// The reject target is runtime.on_reject_to.

import type { ConverterDiagnostic } from "./types.js";

interface LegacyStage {
  name?: string;
  type?: string;
  runtime?: { on_reject_to?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export type MapHumanConfirmResult =
  | { ok: true; stages: LegacyStage[] }
  | { ok: false; diagnostics: ConverterDiagnostic[] };

export function mapHumanConfirmGates(
  flat: LegacyStage[],
  // Maps the name of a stage that started a parallel block → all the
  // stages that were flattened out of that block (in order). Callers
  // pass the empty map when there were no parallel blocks.
  parallelBlockMembers: Map<string, string[]>,
): MapHumanConfirmResult {
  const diagnostics: ConverterDiagnostic[] = [];
  const stages: LegacyStage[] = [];

  for (let i = 0; i < flat.length; i++) {
    const s = flat[i]!;
    if (s.type !== "human_confirm") {
      stages.push(s);
      continue;
    }

    const rejectTarget = s.runtime?.on_reject_to;
    if (typeof rejectTarget !== "string" || rejectTarget.length === 0) {
      diagnostics.push({
        code: "HUMAN_CONFIRM_NO_REJECT_TARGET",
        message: `stage '${s.name}' is human_confirm but lacks runtime.on_reject_to`,
        context: { stage: s.name },
      });
      continue;
    }

    const next = flat[i + 1];
    if (!next || typeof next.name !== "string") {
      diagnostics.push({
        code: "HUMAN_CONFIRM_AT_END",
        message: `stage '${s.name}' is human_confirm at the end of the pipeline — nothing to approve into`,
        context: { stage: s.name },
      });
      continue;
    }

    const approveTarget: string | string[] =
      parallelBlockMembers.get(next.name) ?? next.name;

    stages.push({
      name: s.name,
      type: "gate",
      // Store the transformed config in a shape map-stages.ts can
      // lift into StageIR unchanged.
      config: {
        question: { text: "Approve this result?" },
        routing: { routes: { approve: approveTarget, reject: rejectTarget } },
      },
    } as LegacyStage);
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, stages };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/map-human-confirm-gates.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
cd apps/server && npx tsc --noEmit
```
Expected: clean.

```bash
git add apps/server/src/kernel-next/converter/map-human-confirm-gates.ts \
        apps/server/src/kernel-next/converter/map-human-confirm-gates.test.ts
git commit -m "feat(converter): human_confirm → gate with approve/reject routing"
```

## Task A7: rewriteRetryBackTo

Depends on ScriptStage.config.retry being present on IR. Retry extraction lives in Slice C, but rewriteRetryBackTo runs in Slice A's pipeline — so the retry field has to be introduced schema-side in Slice A too. Two choices: (1) introduce the schema field in Slice A alongside rewriteRetryBackTo but wire runtime in Slice C; (2) defer rewriteRetryBackTo to Slice C. We pick (1): introducing the optional field is a non-behavior-changing IR change; keeps Slice A's pipeline-generator conversion complete.

**Files:**
- Modify: `apps/server/src/kernel-next/ir/schema.ts` (add RetrySpecSchema, extend ScriptStage.config)
- Modify: `apps/server/src/kernel-next/ir/canonical.ts` (canonicalize retry field when present)
- Create: `apps/server/src/kernel-next/converter/rewrite-retry-back-to.ts`
- Create: `apps/server/src/kernel-next/converter/rewrite-retry-back-to.test.ts`

- [ ] **Step 1: Add RetrySpecSchema and extend ScriptStage.config**

In `apps/server/src/kernel-next/ir/schema.ts`, add near existing fanout/gate supporting shapes (after GateRoutingSchema, before StageCommon):

```ts
export const RetrySpecSchema = z.object({
  // Upper bound chosen arbitrarily to prevent pathological loops in
  // hand-authored YAML; pipeline-generator's real usage is 1, no
  // legacy pipeline uses >3. Raise deliberately if a future case
  // needs more.
  maxRetries: z.number().int().min(1).max(10),
  backToStage: identifier,
});
```

Modify `ScriptStageSchema`:
```ts
export const ScriptStageSchema = z.object({
  ...StageCommon,
  type: z.literal("script"),
  config: z.object({
    moduleId: z.string().min(1),
    retry: RetrySpecSchema.optional(),
  }),
  fanout: FanoutSpecSchema.optional(),
});
```

- [ ] **Step 2: Canonical — write failing test for retry serialization**

In `apps/server/src/kernel-next/ir/canonical.test.ts` add:
```ts
it("script retry canonical is alphabetical and omitted when absent", () => {
  const withRetry: PipelineIR = {
    name: "r",
    stages: [{
      name: "S", type: "script", inputs: [], outputs: [],
      config: { moduleId: "m", retry: { maxRetries: 2, backToStage: "T" } },
    }, {
      name: "T", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }],
      config: { promptRef: "p" },
    }],
    wires: [],
    externalInputs: [],
  };
  const canon = canonicalizeIR(withRetry);
  // Alphabetical within retry: backToStage before maxRetries.
  expect(canon).toContain('"retry":{"backToStage":"T","maxRetries":2}');

  const withoutRetry = structuredClone(withRetry);
  (withoutRetry.stages[0] as any).config = { moduleId: "m" };
  const canon2 = canonicalizeIR(withoutRetry);
  expect(canon2).not.toContain('"retry"');
});
```

- [ ] **Step 3: Run — expect failure**

Run: `cd apps/server && npx vitest run src/kernel-next/ir/canonical.test.ts`
Expected: FAIL — retry not in canonical output.

- [ ] **Step 4: Update canonicalizeStage for script retry**

Inspect the existing `canonicalizeStage` function. For ScriptStage branch, when `config.retry` is present, serialize the retry object with alphabetical key order (backToStage, maxRetries) inside the config.

The canonicalizer emits fields alphabetically already for config objects (verify by reading the function); if it does, adding the field to the source object is enough. If it uses an explicit key-order array, add "retry" to that list.

Concretely: if the function has a pattern like:
```ts
function canonicalizeScriptConfig(cfg) {
  const out: Record<string, unknown> = { moduleId: cfg.moduleId };
  if (cfg.retry) {
    out.retry = { backToStage: cfg.retry.backToStage, maxRetries: cfg.retry.maxRetries };
  }
  return out;
}
```

If the canonicalizer uses a generic "sort object keys" function, no code change — only the new field flows through naturally.

- [ ] **Step 5: Re-run canonical tests**

Run: `cd apps/server && npx vitest run src/kernel-next/ir/canonical.test.ts`
Expected: new test PASS; baseline hashes unchanged (diamondIR, smokeTestIR don't use retry).

- [ ] **Step 6: rewriteRetryBackTo test**

File `apps/server/src/kernel-next/converter/rewrite-retry-back-to.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { rewriteRetryBackTo } from "./rewrite-retry-back-to.js";
import type { StageIR } from "../ir/schema.js";

const script = (name: string, backToStage: string): StageIR => ({
  name, type: "script",
  inputs: [], outputs: [{ name: "r", type: "boolean" }],
  config: { moduleId: "m", retry: { maxRetries: 1, backToStage } },
});

const agent = (name: string): StageIR => ({
  name, type: "agent",
  inputs: [], outputs: [{ name: "x", type: "number" }],
  config: { promptRef: "p" },
});

describe("rewriteRetryBackTo", () => {
  it("leaves direct-stage back_to unchanged", () => {
    const stages = [agent("A"), script("P", "A")];
    const r = rewriteRetryBackTo(stages, new Map(), new Set(["A", "P"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.stages[1] as any).config.retry.backToStage).toBe("A");
    expect(r.warnings).toHaveLength(0);
  });

  it("redirects block-name back_to to the block's first inner stage and warns", () => {
    const stages = [agent("A1"), agent("A2"), script("P", "group")];
    const blockMap = new Map([["group", "A1"]]);
    const r = rewriteRetryBackTo(stages, blockMap, new Set(["A1", "A2", "P"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.stages[2] as any).config.retry.backToStage).toBe("A1");
    expect(r.warnings[0]!.code).toBe("RETRY_BACK_TO_REDIRECTED");
    expect(r.warnings[0]!.context).toMatchObject({
      original: "group",
      rewritten: "A1",
    });
  });

  it("fails when back_to references an unknown name", () => {
    const stages = [agent("A"), script("P", "ghost")];
    const r = rewriteRetryBackTo(stages, new Map(), new Set(["A", "P"]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("RETRY_BACK_TO_UNKNOWN");
  });

  it("is a no-op on stages without retry", () => {
    const stages = [agent("A"), agent("B")];
    const r = rewriteRetryBackTo(stages, new Map(), new Set(["A", "B"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toHaveLength(0);
  });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/rewrite-retry-back-to.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Write rewriteRetryBackTo**

File `apps/server/src/kernel-next/converter/rewrite-retry-back-to.ts`:
```ts
// Resolves script.retry.backToStage against the post-unwrap stage
// universe. If the legacy back_to pointed at a parallel block name
// (no longer present in the flat IR), rewrite it to the block's
// first inner stage and emit RETRY_BACK_TO_REDIRECTED. If it points
// at neither a stage nor a known block name, fail.

import type { StageIR } from "../ir/schema.js";
import type { ConverterDiagnostic, ConverterWarning } from "./types.js";

export type RewriteRetryBackToResult =
  | { ok: true; stages: StageIR[]; warnings: ConverterWarning[] }
  | { ok: false; diagnostics: ConverterDiagnostic[] };

export function rewriteRetryBackTo(
  stages: StageIR[],
  blockMap: Map<string, string>,
  stageNames: Set<string>,
): RewriteRetryBackToResult {
  const warnings: ConverterWarning[] = [];
  const diagnostics: ConverterDiagnostic[] = [];
  const out: StageIR[] = [];

  for (const s of stages) {
    if (s.type !== "script" || !s.config.retry) {
      out.push(s);
      continue;
    }
    const original = s.config.retry.backToStage;
    if (stageNames.has(original)) {
      out.push(s);
      continue;
    }
    const redirected = blockMap.get(original);
    if (redirected !== undefined) {
      warnings.push({
        code: "RETRY_BACK_TO_REDIRECTED",
        message: `stage '${s.name}' retry.back_to redirected from parallel block '${original}' to first inner stage '${redirected}'`,
        context: { stage: s.name, original, rewritten: redirected },
      });
      out.push({
        ...s,
        config: { ...s.config, retry: { ...s.config.retry, backToStage: redirected } },
      });
      continue;
    }
    diagnostics.push({
      code: "RETRY_BACK_TO_UNKNOWN",
      message: `stage '${s.name}' retry.back_to='${original}' names no stage and no parallel block`,
      context: { stage: s.name, backTo: original },
    });
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, stages: out, warnings };
}
```

- [ ] **Step 9: Run to verify pass**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/rewrite-retry-back-to.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 10: tsc + commit**

```bash
cd apps/server && npx tsc --noEmit
```
Expected: clean.

```bash
git add apps/server/src/kernel-next/ir/schema.ts \
        apps/server/src/kernel-next/ir/canonical.ts \
        apps/server/src/kernel-next/ir/canonical.test.ts \
        apps/server/src/kernel-next/converter/rewrite-retry-back-to.ts \
        apps/server/src/kernel-next/converter/rewrite-retry-back-to.test.ts
git commit -m "feat(ir): ScriptStage.config.retry schema + converter rewriteRetryBackTo"
```

## Task A8: map-stages — remove 4 UNSUPPORTED branches, no extraction yet

Slice A still keeps runtime.agents/retry as UNSUPPORTED (those are Slice D/C). But `parallel` and `human_confirm` need to be removed now because unwrap/gate passes handle them upstream. For `runtime.agents` and `runtime.retry`: their parent stages will be reached with those fields still present; we leave the UNSUPPORTED branches in place for this slice.

Wait — that conflicts with "pipeline-generator converts with zero fatal diagnostics after Slice A". Pipeline-generator has runtime.agents (genPrompts) and runtime.retry.back_to (persisting). If Slice A keeps these as UNSUPPORTED, Slice A's conversion fails.

Resolution: Slice A removes ALL four UNSUPPORTED branches. For runtime.agents and runtime.retry, we'll drop the field silently (LEGACY_FIELD_IGNORED warning) until Slice D/C plug in the extraction.

**Files:**
- Modify: `apps/server/src/kernel-next/converter/map-stages.ts`

- [ ] **Step 1: Grep for existing UNSUPPORTED_FEATURE branches**

Run: `grep -n 'UNSUPPORTED_FEATURE' apps/server/src/kernel-next/converter/map-stages.ts`

Identify the four branches:
- `if ("parallel" in s ...)` → now handled by unwrapParallelBlocks
- `if (s.foreach || s.fanout)` → foreach still unsupported; keep
- `if (s.type !== "agent" && s.type !== "script")` → now need to also accept "gate"
- `if (s.runtime?.retry?.back_to)` → remove (retry will be ignored with warning in Slice A; extracted in Slice C)
- `if (s.runtime?.compensation)` → keep (still unsupported)
- `if (s.runtime?.agents)` → remove (ignored with warning in Slice A; extracted in Slice D)

- [ ] **Step 2: Write failing test — parallel and human_confirm are no longer UNSUPPORTED at map-stages level**

In `apps/server/src/kernel-next/converter/map-stages.test.ts`, find and DELETE these tests:
- "fails with UNSUPPORTED_FEATURE for parallel block"
- "fails with UNSUPPORTED_FEATURE for human_confirm type"

Add new tests:
```ts
it("accepts gate stages (post-mapHumanConfirmGates shape)", () => {
  const legacy = {
    stages: [
      { name: "G", type: "gate",
        config: { question: { text: "?" }, routing: { routes: { yes: "A" } } } },
      { name: "A", type: "agent", runtime: { reads: {} } },
    ],
  };
  const r = mapStagesToIR(legacy as any, new Map(), new Map(), new Set());
  expect(r.ok).toBe(true);
});

it("emits LEGACY_FIELD_IGNORED for runtime.agents (Slice A: dropped; Slice D extracts)", () => {
  const legacy = {
    stages: [{
      name: "A", type: "agent",
      runtime: { reads: {}, agents: { a: { description: "x", prompt: "y" } } },
    }],
  };
  const r = mapStagesToIR(legacy as any, new Map(), new Map(), new Set());
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.warnings.some((w: any) =>
    w.code === "LEGACY_FIELD_IGNORED" && w.context?.field === "agents"
  )).toBe(true);
});

it("emits LEGACY_FIELD_IGNORED for runtime.retry (Slice A: dropped; Slice C extracts)", () => {
  const legacy = {
    stages: [{
      name: "P", type: "script",
      runtime: { reads: {}, retry: { max_retries: 1, back_to: "A" },
                 script_id: "m" },
    }, { name: "A", type: "agent", runtime: { reads: {} } }],
  };
  const r = mapStagesToIR(legacy as any, new Map(), new Map(), new Set());
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.warnings.some((w: any) =>
    w.code === "LEGACY_FIELD_IGNORED" && w.context?.field === "retry"
  )).toBe(true);
});
```

- [ ] **Step 3: Run — expect failures**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/map-stages.test.ts`
Expected: New tests fail because old UNSUPPORTED branches still reject.

- [ ] **Step 4: Modify map-stages.ts**

In `apps/server/src/kernel-next/converter/map-stages.ts`:

4a. Remove the UNSUPPORTED branch for parallel (lines around `if ("parallel" in s ...)` — the block starting at ~line 53).

4b. Remove the UNSUPPORTED branch for `retry.back_to` (around line 78).

4c. Remove the UNSUPPORTED branch for `runtime.agents` (around line 94).

4d. Expand the stage-type check to accept "gate":
```ts
if (s.type !== "agent" && s.type !== "script" && s.type !== "gate") {
  diagnostics.push({ /* UNSUPPORTED_FEATURE */ });
  continue;
}
```

4e. Add new warning emission points:
```ts
// Slice A drops retry silently (extracted in Slice C). Warning lets
// the caller know retry config exists but has no runtime effect yet.
if (s.runtime?.retry) {
  warnings.push({
    code: "LEGACY_FIELD_IGNORED",
    message: `stage '${s.name}' runtime.retry ignored (Slice A)`,
    context: { stage: s.name, field: "retry" },
  });
}

// Slice A drops sub-agents silently (extracted in Slice D).
if (s.runtime?.agents) {
  warnings.push({
    code: "LEGACY_FIELD_IGNORED",
    message: `stage '${s.name}' runtime.agents ignored (Slice A)`,
    context: { stage: s.name, field: "agents" },
  });
}
```

4f. Add a new case for `s.type === "gate"`: lift `s.config` directly (it already has question/routing from mapHumanConfirmGates).
```ts
if (s.type === "gate") {
  const gateStage: StageIR = {
    name: s.name!,
    type: "gate",
    inputs: [],
    outputs: [],
    config: s.config as StageIR["config"],  // already validated shape from mapHumanConfirmGates
  };
  stages.push(gateStage);
  continue;
}
```

- [ ] **Step 5: Re-run map-stages tests**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/map-stages.test.ts`
Expected: PASS including new tests.

- [ ] **Step 6: tsc + commit**

```bash
cd apps/server && npx tsc --noEmit
```
Expected: clean.

```bash
git add apps/server/src/kernel-next/converter/map-stages.ts \
        apps/server/src/kernel-next/converter/map-stages.test.ts
git commit -m "feat(converter): accept gate stages; retry/agents dropped with warning (Slice A)"
```

## Task A9: Wire new passes into legacy-yaml.ts

**Files:**
- Modify: `apps/server/src/kernel-next/converter/legacy-yaml.ts`

- [ ] **Step 1: Read existing pipeline to see where to insert new passes**

Run: `cat apps/server/src/kernel-next/converter/legacy-yaml.ts`

Identify the Stage-by-Stage sequence (parseYaml → mapStoreSchemaToPorts → mapInjectedContext → mapStagesToIR → mapReadsToWires → assembleIR).

- [ ] **Step 2: Write failing integration test**

File `apps/server/src/kernel-next/converter/pipeline-generator.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { convertLegacyYaml } from "./legacy-yaml.js";

const PIPELINE_YAML = path.resolve(
  __dirname,
  "../../builtin-pipelines/pipeline-generator/pipeline.yaml",
);

describe("convertLegacyYaml(pipeline-generator.yaml) — Slice A", () => {
  it("converts without fatal diagnostics", () => {
    const yaml = readFileSync(PIPELINE_YAML, "utf8");
    const r = convertLegacyYaml(yaml);
    if (!r.ok) {
      console.log("diagnostics:", JSON.stringify(r.diagnostics, null, 2));
    }
    expect(r.ok).toBe(true);
  });

  it("produces 6 top-level stages", () => {
    const yaml = readFileSync(PIPELINE_YAML, "utf8");
    const r = convertLegacyYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.ir.stages.map(s => s.name);
    expect(names).toEqual([
      "analyzing",
      "awaitingConfirm",
      "genSkeleton",
      "genPrompts",
      "refinePrompts",
      "persisting",
    ]);
  });

  it("awaitingConfirm becomes a gate with array approve target", () => {
    const yaml = readFileSync(PIPELINE_YAML, "utf8");
    const r = convertLegacyYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gate = r.ir.stages.find(s => s.name === "awaitingConfirm");
    expect(gate?.type).toBe("gate");
    if (gate?.type !== "gate") return;
    const approve = gate.config.routing.routes.approve;
    expect(approve).toEqual(["genSkeleton", "genPrompts"]);
    expect(gate.config.routing.routes.reject).toBe("analyzing");
  });

  it("persisting.retry is dropped with LEGACY_FIELD_IGNORED (Slice A placeholder)", () => {
    const yaml = readFileSync(PIPELINE_YAML, "utf8");
    const r = convertLegacyYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.some(w =>
      w.code === "LEGACY_FIELD_IGNORED" && w.context?.field === "retry"
    )).toBe(true);
  });

  it("genPrompts.runtime.agents is dropped with LEGACY_FIELD_IGNORED (Slice A placeholder)", () => {
    const yaml = readFileSync(PIPELINE_YAML, "utf8");
    const r = convertLegacyYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.some(w =>
      w.code === "LEGACY_FIELD_IGNORED" && w.context?.field === "agents"
    )).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/pipeline-generator.test.ts`
Expected: FAIL — existing convertLegacyYaml doesn't run new passes.

- [ ] **Step 4: Wire new passes into legacy-yaml.ts**

In `apps/server/src/kernel-next/converter/legacy-yaml.ts`, replace the existing pipeline with the extended flow:

```ts
import { unwrapParallelBlocks } from "./unwrap-parallel-blocks.js";
import { mapHumanConfirmGates } from "./map-human-confirm-gates.js";
import { rewriteRetryBackTo } from "./rewrite-retry-back-to.js";

// Inside convertLegacyYaml, after parseYaml:
const unwrapResult = unwrapParallelBlocks(parsed);
if (!unwrapResult.ok) {
  return { ok: false, diagnostics: unwrapResult.diagnostics };
}

// Build blockMembers map: each block name → list of flattened stage names.
const blockMembers = new Map<string, string[]>();
for (const [blockName, firstStage] of unwrapResult.blockMap.entries()) {
  // Reconstruct membership by walking the original parallel block's stages.
  // Simplest: cache during unwrapParallelBlocks. Modify unwrap to return
  // blockMembers as well (see Step 4b).
}

// ... continue with store-schema, injected-context mapping

const gatesResult = mapHumanConfirmGates(unwrapResult.flat, blockMembers);
if (!gatesResult.ok) {
  return { ok: false, diagnostics: gatesResult.diagnostics };
}

// Call mapStagesToIR on gatesResult.stages. Signature per map-stages.ts:
//   mapStagesToIR(legacy, stageOutputs, entryDirectory, externalKeys)
// stageOutputs / entryDirectory come from mapStoreSchemaToPorts;
// externalKeys from mapInjectedContext. The variable names match the
// existing legacy-yaml.ts call site — just swap the `stages` input
// from `parsed.stages` to `gatesResult.stages`.
const stagesResult = mapStagesToIR(
  { stages: gatesResult.stages },
  stageOutputs, entryDirectory, externalKeys,
);
if (!stagesResult.ok) {
  return { ok: false, diagnostics: stagesResult.diagnostics };
}

const stageNames = new Set(stagesResult.stages.map(s => s.name));
const rewriteResult = rewriteRetryBackTo(
  stagesResult.stages, unwrapResult.blockMap, stageNames,
);
if (!rewriteResult.ok) {
  return { ok: false, diagnostics: rewriteResult.diagnostics };
}

// assembleIR with rewriteResult.stages instead of stagesResult.stages
// Accumulate warnings from all passes into the final result.
```

- [ ] **Step 4b: Extend unwrapParallelBlocks to return blockMembers**

Back in `apps/server/src/kernel-next/converter/unwrap-parallel-blocks.ts`, extend the return type:
```ts
export type UnwrapResult =
  | { ok: true; flat: LegacyStage[]; blockMap: Map<string, string>;
      blockMembers: Map<string, string[]> }
  | { ok: false; diagnostics: ConverterDiagnostic[] };
```

Populate `blockMembers` inside the loop: for each block, collect every inner stage's name into an array and store under the block's name. Update the corresponding test to assert blockMembers content:

```ts
it("records blockMembers for every flattened parallel block", () => {
  const legacy = { stages: [{ parallel: { name: "g", stages: [
    { name: "A" }, { name: "B" }, { name: "C" },
  ] } }] };
  const r = unwrapParallelBlocks(legacy);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.blockMembers.get("g")).toEqual(["A", "B", "C"]);
});
```

- [ ] **Step 5: Re-run unwrap test to verify new field populated**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/unwrap-parallel-blocks.test.ts`
Expected: PASS including the new test.

- [ ] **Step 6: Re-run pipeline-generator integration test**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/pipeline-generator.test.ts`
Expected: PASS — all 5 assertions.

- [ ] **Step 7: Full server suite sanity**

Run: `cd apps/server && npx vitest run`
Expected: all passing.

- [ ] **Step 8: tsc + commit**

```bash
cd apps/server && npx tsc --noEmit
```
Expected: clean.

```bash
git add apps/server/src/kernel-next/converter/legacy-yaml.ts \
        apps/server/src/kernel-next/converter/unwrap-parallel-blocks.ts \
        apps/server/src/kernel-next/converter/unwrap-parallel-blocks.test.ts \
        apps/server/src/kernel-next/converter/pipeline-generator.test.ts
git commit -m "feat(converter): integrate parallel/gate/retry passes; pipeline-generator converts cleanly"
```

## Task A10: Register pipeline-generator on /api/kernel/tasks/run

**Files:**
- Modify: `apps/server/src/routes/kernel-run.ts`

- [ ] **Step 1: Check existing registerLegacyPipeline usage**

Run: `grep -n "registerLegacyPipeline\|pipelineRegistry" apps/server/src/routes/kernel-run.ts`

Locate the registry object. Existing entries look like:
```ts
"tech-research-collector": registerLegacyPipeline({ pipelineDir: "tech-research-collector" }),
```

- [ ] **Step 2: Add pipeline-generator entry**

Add to the registry:
```ts
"pipeline-generator": registerLegacyPipeline({
  pipelineDir: "pipeline-generator",
  maxTurns: 80,
  maxBudgetUsd: 8,
  timeoutMs: 15 * 60 * 1000,  // 15 minutes
}),
```

(Budget and turn values mirror the values in `pipeline-generator/pipeline.yaml` for genPrompts, the biggest stage.)

- [ ] **Step 3: Run kernel-run tests**

Run: `cd apps/server && npx vitest run src/routes/kernel-run.test.ts`
Expected: PASS. The UNKNOWN_PIPELINE test's `known[]` assertion should include `pipeline-generator`. If not, update that test to include it.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/routes/kernel-run.ts \
        apps/server/src/routes/kernel-run.test.ts
git commit -m "feat(routes): register pipeline-generator via registerLegacyPipeline"
```

## Task A11: Slice A sanity — full test suite + tsc

- [ ] **Step 1: tsc both packages**

Run: `cd apps/server && npx tsc --noEmit && cd ../web && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Run full server suite**

Run: `cd apps/server && npx vitest run`
Expected: all green. Record the new test count for the handoff.

- [ ] **Step 3: Slice A handoff paragraph**

No new document yet (full milestone handoff is written at the end). Just confirm the baseline for the next slice:
- pipeline-generator converts with N warnings (record count).
- Running it via HTTP reaches `error` because retry/sub-agents are still noop — expected.

---

# Slice D — AgentStage.config.subAgents + RealStageExecutor pass-through

State after Slice D: genPrompts can actually spawn its `prompt-writer` sub-agent through the Claude SDK.

## Task D1: Add SubAgentDefSchema and extend AgentStage.config

**Files:**
- Modify: `apps/server/src/kernel-next/ir/schema.ts`
- Modify: `apps/server/src/kernel-next/ir/canonical.ts`

- [ ] **Step 1: Write failing test — schema accepts subAgents**

In `apps/server/src/kernel-next/ir/schema.test.ts` add:
```ts
it("AgentStage.config.subAgents is optional and validates shape", () => {
  const cfg = AgentStageSchema.shape.config.parse({
    promptRef: "p",
    subAgents: [{
      name: "writer",
      description: "Writes prompts",
      prompt: "You are a writer",
      tools: ["Read", "Write"],
      model: "sonnet",
      maxTurns: 20,
    }],
  });
  expect(cfg.subAgents![0]!.name).toBe("writer");
});

it("AgentStage.config.subAgents rejects missing description/prompt", () => {
  expect(() => AgentStageSchema.shape.config.parse({
    promptRef: "p",
    subAgents: [{ name: "w", description: "", prompt: "x" }],
  })).toThrow();
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd apps/server && npx vitest run src/kernel-next/ir/schema.test.ts`
Expected: FAIL — subAgents field doesn't exist yet.

- [ ] **Step 3: Add SubAgentDefSchema and extend AgentStage**

In `apps/server/src/kernel-next/ir/schema.ts`:
```ts
export const SubAgentDefSchema = z.object({
  name: identifier,
  description: z.string().min(1),
  prompt: z.string().min(1),
  tools: z.array(z.string()).optional(),
  model: z.enum(["sonnet", "opus", "haiku", "inherit"]).optional(),
  maxTurns: z.number().int().positive().optional(),
});

export const AgentStageSchema = z.object({
  ...StageCommon,
  type: z.literal("agent"),
  config: z.object({
    promptRef: z.string().min(1),
    subAgents: z.array(SubAgentDefSchema).optional(),
  }),
  fanout: FanoutSpecSchema.optional(),
});
```

- [ ] **Step 4: Re-run schema tests**

Run: `cd apps/server && npx vitest run src/kernel-next/ir/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Canonical test — subAgents sorted by name, omitted when absent**

In `apps/server/src/kernel-next/ir/canonical.test.ts`:
```ts
it("subAgents canonical is sorted by name and omitted when absent", () => {
  const withSub: PipelineIR = {
    name: "s",
    stages: [{
      name: "A", type: "agent", inputs: [], outputs: [],
      config: {
        promptRef: "p",
        subAgents: [
          { name: "zeta", description: "z", prompt: "z" },
          { name: "alpha", description: "a", prompt: "a" },
        ],
      },
    }],
    wires: [],
    externalInputs: [],
  };
  const canon = canonicalizeIR(withSub);
  const alphaIdx = canon.indexOf("alpha");
  const zetaIdx = canon.indexOf("zeta");
  expect(alphaIdx).toBeLessThan(zetaIdx);

  const withoutSub = structuredClone(withSub);
  (withoutSub.stages[0] as any).config = { promptRef: "p" };
  expect(canonicalizeIR(withoutSub)).not.toContain("subAgents");
});
```

- [ ] **Step 6: Update canonicalizeStage for agent subAgents**

In the AgentStage branch of `canonicalizeStage`, when `config.subAgents` is non-empty:
```ts
if (cfg.subAgents && cfg.subAgents.length > 0) {
  out.subAgents = [...cfg.subAgents]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(sa => {
      const ordered: Record<string, unknown> = {
        description: sa.description, name: sa.name, prompt: sa.prompt,
      };
      if (sa.maxTurns !== undefined) ordered.maxTurns = sa.maxTurns;
      if (sa.model !== undefined) ordered.model = sa.model;
      if (sa.tools !== undefined) ordered.tools = [...sa.tools];
      return ordered;
    });
}
```

- [ ] **Step 7: Re-run canonical tests**

Run: `cd apps/server && npx vitest run src/kernel-next/ir/canonical.test.ts`
Expected: PASS. Baseline hashes unchanged.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/kernel-next/ir/schema.ts \
        apps/server/src/kernel-next/ir/schema.test.ts \
        apps/server/src/kernel-next/ir/canonical.ts \
        apps/server/src/kernel-next/ir/canonical.test.ts
git commit -m "feat(ir): AgentStage.config.subAgents + canonical sorted by name"
```

## Task D2: Converter extracts runtime.agents to config.subAgents

**Files:**
- Modify: `apps/server/src/kernel-next/converter/map-stages.ts`
- Modify: `apps/server/src/kernel-next/converter/map-stages.test.ts`

- [ ] **Step 1: Write failing test — subAgents extraction**

Add to `map-stages.test.ts`:
```ts
it("extracts runtime.agents to AgentStage.config.subAgents", () => {
  const legacy = {
    stages: [{
      name: "A", type: "agent",
      runtime: {
        reads: {},
        agents: {
          writer: {
            description: "Writes prompts",
            prompt: "You are a writer",
            tools: ["Read", "Write"],
            model: "sonnet",
            maxTurns: 20,
          },
        },
      },
    }],
  };
  const r = mapStagesToIR(legacy as any, new Map(), new Map(), new Set());
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const a = r.stages[0]!;
  expect(a.type).toBe("agent");
  if (a.type !== "agent") return;
  expect(a.config.subAgents).toHaveLength(1);
  expect(a.config.subAgents![0]).toMatchObject({
    name: "writer", description: "Writes prompts",
    prompt: "You are a writer", tools: ["Read", "Write"],
    model: "sonnet", maxTurns: 20,
  });
});

it("emits SUB_AGENT_INVALID when agents is not an object", () => {
  const legacy = {
    stages: [{ name: "A", type: "agent", runtime: { reads: {}, agents: ["x"] } }],
  };
  const r = mapStagesToIR(legacy as any, new Map(), new Map(), new Set());
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.diagnostics[0]!.code).toBe("SUB_AGENT_INVALID");
});

it("emits SUB_AGENT_INVALID when a sub-agent lacks description or prompt", () => {
  const legacy = {
    stages: [{
      name: "A", type: "agent",
      runtime: { reads: {}, agents: { bad: { description: "x" } } },
    }],
  };
  const r = mapStagesToIR(legacy as any, new Map(), new Map(), new Set());
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.diagnostics[0]!.code).toBe("SUB_AGENT_INVALID");
});
```

Also UPDATE the Slice A test from Task A8 that asserted `runtime.agents` produces a LEGACY_FIELD_IGNORED warning — now extraction happens instead; that test should assert the warning is NOT emitted and subAgents IS populated.

- [ ] **Step 2: Run — expect failure**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/map-stages.test.ts`
Expected: FAIL — new tests fail; old "emits LEGACY_FIELD_IGNORED for runtime.agents" test fails too.

- [ ] **Step 3: Remove the Slice A placeholder + add extraction in map-stages.ts**

In `apps/server/src/kernel-next/converter/map-stages.ts`:

3a. DELETE the Slice A placeholder:
```ts
if (s.runtime?.agents) {
  warnings.push({ code: "LEGACY_FIELD_IGNORED", ... });
}
```

3b. Add extraction logic inside the agent-stage arm (after reads-derivation, before pushing the stage):
```ts
let subAgents: SubAgentDef[] | undefined;
if (s.runtime?.agents !== undefined) {
  if (typeof s.runtime.agents !== "object" ||
      Array.isArray(s.runtime.agents) ||
      s.runtime.agents === null) {
    diagnostics.push({
      code: "SUB_AGENT_INVALID",
      message: `stage '${name}': runtime.agents must be an object map of name → def`,
      context: { stage: name, got: typeof s.runtime.agents },
    });
    readsErrored = true;
  } else {
    const collected: SubAgentDef[] = [];
    for (const [saName, def] of Object.entries(s.runtime.agents)) {
      if (!def || typeof def !== "object" ||
          typeof (def as any).description !== "string" || !(def as any).description ||
          typeof (def as any).prompt !== "string" || !(def as any).prompt) {
        diagnostics.push({
          code: "SUB_AGENT_INVALID",
          message: `stage '${name}': sub-agent '${saName}' missing description or prompt`,
          context: { stage: name, subAgent: saName },
        });
        readsErrored = true;
        continue;
      }
      const d = def as Record<string, unknown>;
      collected.push({
        name: saName,
        description: d.description as string,
        prompt: d.prompt as string,
        tools: Array.isArray(d.tools) ? d.tools as string[] : undefined,
        model: (d.model === "sonnet" || d.model === "opus" ||
                d.model === "haiku" || d.model === "inherit")
               ? d.model : undefined,
        maxTurns: typeof d.maxTurns === "number" && Number.isInteger(d.maxTurns) && d.maxTurns > 0
                  ? d.maxTurns : undefined,
      });
    }
    if (collected.length > 0) subAgents = collected;
  }
}
```

3c. Thread `subAgents` into the StageIR config when pushing:
```ts
const stage: StageIR = {
  name, type: "agent", inputs, outputs,
  config: {
    promptRef: /* existing computation */,
    ...(subAgents ? { subAgents } : {}),
  },
};
```

Import SubAgentDef at the top:
```ts
import type { SubAgentDef, ... } from "../ir/schema.js";
```

(Add to the existing type-only import; if SubAgentDef is not yet exported as a type alias, add `export type SubAgentDef = z.infer<typeof SubAgentDefSchema>;` in `schema.ts`.)

- [ ] **Step 4: Re-run tests**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/map-stages.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-run pipeline-generator integration**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/pipeline-generator.test.ts`
Expected: Still PASS. The "agents LEGACY_FIELD_IGNORED" assertion from Task A9 should be DELETED and replaced with:

```ts
it("genPrompts.runtime.agents extracted into config.subAgents", () => {
  const yaml = readFileSync(PIPELINE_YAML, "utf8");
  const r = convertLegacyYaml(yaml);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const genPrompts = r.ir.stages.find(s => s.name === "genPrompts");
  expect(genPrompts?.type).toBe("agent");
  if (genPrompts?.type !== "agent") return;
  expect(genPrompts.config.subAgents).toBeDefined();
  expect(genPrompts.config.subAgents!.map(sa => sa.name)).toContain("prompt-writer");
});
```

- [ ] **Step 6: tsc + commit**

```bash
cd apps/server && npx tsc --noEmit
```
Expected: clean.

```bash
git add apps/server/src/kernel-next/converter/map-stages.ts \
        apps/server/src/kernel-next/converter/map-stages.test.ts \
        apps/server/src/kernel-next/converter/pipeline-generator.test.ts \
        apps/server/src/kernel-next/ir/schema.ts
git commit -m "feat(converter): extract runtime.agents to AgentStage.config.subAgents"
```

## Task D3: RealStageExecutor threads subAgents into SDK options.agents

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/real-executor.ts`
- Modify: `apps/server/src/kernel-next/runtime/real-executor.test.ts`

- [ ] **Step 1: Read real-executor.ts for the SdkOptions site**

Run: `grep -n "SdkOptions\|options:\|agents" apps/server/src/kernel-next/runtime/real-executor.ts | head`

Identify the `executeStage` method and the `const options: SdkOptions = { ... }` block (around line 209 per spec).

- [ ] **Step 2: Write failing test — subAgents flow into SDK options**

In `apps/server/src/kernel-next/runtime/real-executor.test.ts`:
```ts
it("passes subAgents from StageIR.config into SDK options.agents", async () => {
  const capturedOptions: any[] = [];
  const fakeQuery = (args: any) => {
    capturedOptions.push(args.options);
    // Return an async iterable that immediately yields result:error so
    // the executor finishes without depending on SDK semantics beyond
    // the options check.
    return (async function*() {
      yield { type: "result", subtype: "error_during_execution",
              is_error: true, total_cost_usd: 0,
              usage: {}, result: "test abort" };
    })();
  };

  const exec = new RealStageExecutor({
    db: makeDb(),
    queryFn: fakeQuery as any,
    // ... other required fields from the existing real-executor.test.ts
    //     setup; mirror the existing test's helper.
  });

  await exec.executeStage({
    ir: /* minimal PipelineIR with one agent stage containing subAgents */,
    stage: {
      name: "A", type: "agent", inputs: [], outputs: [],
      config: {
        promptRef: "p",
        subAgents: [{
          name: "writer", description: "Writes",
          prompt: "You are", tools: ["Read"], model: "sonnet", maxTurns: 20,
        }],
      },
    },
    // ... remaining args
  });

  expect(capturedOptions).toHaveLength(1);
  expect(capturedOptions[0].agents).toEqual({
    writer: {
      description: "Writes",
      prompt: "You are",
      tools: ["Read"],
      model: "sonnet",
      maxTurns: 20,
    },
  });
});

it("omits options.agents when subAgents is undefined or empty", async () => {
  const capturedOptions: any[] = [];
  const fakeQuery = (args: any) => {
    capturedOptions.push(args.options);
    return (async function*() {
      yield { type: "result", subtype: "success", is_error: false,
              total_cost_usd: 0, usage: {}, result: "" };
    })();
  };
  // Same setup but stage without subAgents.
  // ...
  expect(capturedOptions[0].agents).toBeUndefined();
});
```

(The existing test file has a helper for constructing RealStageExecutor with a mock query function — mirror it.)

- [ ] **Step 3: Run — expect failure**

Run: `cd apps/server && npx vitest run src/kernel-next/runtime/real-executor.test.ts`
Expected: FAIL — subAgents are not yet wired.

- [ ] **Step 4: Modify real-executor.ts**

Add a helper near the top-level of the file (after imports):
```ts
function buildSdkAgents(
  defs: NonNullable<AgentStageIR["config"]["subAgents"]>,
): NonNullable<SdkOptions["agents"]> {
  const out: Record<string, NonNullable<SdkOptions["agents"]>[string]> = {};
  for (const d of defs) {
    out[d.name] = {
      description: d.description,
      prompt: d.prompt,
      ...(d.tools ? { tools: d.tools } : {}),
      ...(d.model ? { model: d.model } : {}),
      ...(d.maxTurns !== undefined ? { maxTurns: d.maxTurns } : {}),
    };
  }
  return out;
}
```

Import `AgentStageIR` type if needed. Then in the existing `executeStage` method, locate where `options: SdkOptions = { ... }` is constructed and expand the StageIR context. Since executeStage currently receives the stage name but may not directly have the StageIR, pull it from `this.ir.stages.find(s => s.name === stageName)` or from the method arguments (inspect actual signature before writing).

Insert:
```ts
const stageIR = this.ir.stages.find(s => s.name === stageName);
const isAgent = stageIR?.type === "agent";
const subAgents = isAgent ? stageIR.config.subAgents : undefined;

const options: SdkOptions = {
  // ... existing fields ...
  ...(subAgents && subAgents.length > 0
    ? { agents: buildSdkAgents(subAgents) }
    : {}),
};
```

- [ ] **Step 5: Re-run test**

Run: `cd apps/server && npx vitest run src/kernel-next/runtime/real-executor.test.ts`
Expected: PASS including new tests.

- [ ] **Step 6: Manual E2E against Claude SDK (out of CI)**

Start server: `pnpm --filter=server dev` in one terminal.

In another terminal, POST pipeline-generator with minimal seedValues (check the YAML's injected_context for what keys to provide). Record the task ID.

Subscribe SSE: `curl -sN http://localhost:3001/api/kernel-next/tasks/<taskId>/stream`.

Verify:
- genPrompts stage reaches `stage_executing`.
- Watching the SDK's stderr/logs, confirm the `prompt-writer` sub-agent is invoked at least once during genPrompts execution.

This E2E is not automated; record the observation in the eventual handoff.

(Allowed to skip in CI; still required before Slice D commit.)

- [ ] **Step 7: Full server test suite**

Run: `cd apps/server && npx vitest run`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/kernel-next/runtime/real-executor.ts \
        apps/server/src/kernel-next/runtime/real-executor.test.ts
git commit -m "feat(executor): thread AgentStage.config.subAgents to SDK options.agents"
```

---

# Slice C — ScriptStage.config.retry runtime loop

State after Slice C: pipeline-generator's `persisting` failure automatically reruns `genSkeleton` up to maxRetries times. Full milestone closed.

## Task C1: MachineContext.retryCounts + retry transition

**Files:**
- Modify: `apps/server/src/kernel-next/compiler/ir-to-machine.ts`
- Modify: `apps/server/src/kernel-next/compiler/ir-to-machine.test.ts`

- [ ] **Step 1: Add retryCounts to MachineContext**

In `apps/server/src/kernel-next/compiler/ir-to-machine.ts`, locate the `MachineContext` interface (around lines 40-90 per spec). Add:
```ts
export interface MachineContext {
  // ... existing fields ...
  // Map stage name → number of retries already consumed. Used by the
  // retry transition guard on ScriptStage with config.retry. Default
  // empty; mutated only by the root-level RETRY_TO_STAGE handler in
  // runner.
  retryCounts: Record<string, number>;
}
```

Update the `initialContext` construction to include `retryCounts: {}`.

Add the MachineEvent union member:
```ts
export type MachineEvent =
  | /* ... existing ... */
  | {
      type: "RETRY_TO_STAGE";
      failedStageName: string;
      backToStage: string;
      reason: "executor_failed";
      retryIdx: number;
      maxRetries: number;
      errorMessage: string;
    }
  | { type: "RESET_STAGE"; stage: string };
```

- [ ] **Step 2: Write failing test — retry transition shape**

In `apps/server/src/kernel-next/compiler/ir-to-machine.test.ts`:
```ts
it("ScriptStage with retry emits guarded STAGE_FAILED transition + raise RETRY_TO_STAGE", () => {
  const ir: PipelineIR = {
    name: "retry-shape",
    externalInputs: [],
    stages: [
      { name: "A", type: "agent", inputs: [],
        outputs: [{ name: "x", type: "number" }],
        config: { promptRef: "p" } },
      { name: "S", type: "script",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "r", type: "boolean" }],
        config: { moduleId: "m", retry: { maxRetries: 2, backToStage: "A" } } },
    ],
    wires: [
      { from: { source: "stage", stage: "A", port: "x" },
        to: { stage: "S", port: "x" } },
    ],
  };
  const machine = compileIRToMachine(ir);
  // Introspect the compiled machine: find the ScriptStage region `S`
  // and verify its executing state has two STAGE_FAILED transitions:
  //   1. guard (retryCounts.S < 2) → target waiting + raise RETRY_TO_STAGE
  //   2. fallback → target error (when retries exhausted)
  const scriptRegion = machine.config.states?.regions?.states?.S;
  // Adapt selector to the actual XState config path used by the project.
  // Assert presence of at least two entries in on.STAGE_FAILED.
  expect(/* transition count on STAGE_FAILED */).toBe(2);
});

it("ScriptStage without retry keeps the original single STAGE_FAILED → error transition", () => {
  const ir: PipelineIR = {
    name: "no-retry",
    externalInputs: [],
    stages: [{ name: "S", type: "script", inputs: [], outputs: [],
               config: { moduleId: "m" } }],
    wires: [],
  };
  const machine = compileIRToMachine(ir);
  // Assert on.STAGE_FAILED has exactly one entry → error.
  expect(/* transition count */).toBe(1);
});
```

- [ ] **Step 3: Run — expect failure**

Run: `cd apps/server && npx vitest run src/kernel-next/compiler/ir-to-machine.test.ts`
Expected: FAIL.

- [ ] **Step 4: Add retry transition in the ScriptStage region builder**

Locate the ScriptStage region builder inside ir-to-machine.ts (search for "type: 'script'" or "ScriptStage" inside the compile function).

For the `executing` state, change the `on: { STAGE_FAILED: ... }` entry. Currently it's a single transition to `error`. Replace with an array:

```ts
const stageRetry = s.type === "script" ? s.config.retry : undefined;

const stageFailedTransitions = stageRetry
  ? [
      {
        guard: ({ context }: { context: MachineContext }) =>
          (context.retryCounts[s.name] ?? 0) < stageRetry.maxRetries,
        target: "waiting",
        actions: raise(({ context, event }: any) => ({
          type: "RETRY_TO_STAGE" as const,
          failedStageName: s.name,
          backToStage: stageRetry.backToStage,
          reason: "executor_failed" as const,
          retryIdx: context.retryCounts[s.name] ?? 0,
          maxRetries: stageRetry.maxRetries,
          errorMessage: event.error ?? "executor error",
        })),
      },
      { target: "error" },
    ]
  : [{ target: "error" }];
```

(The `raise` import from xstate — add if absent.)

Thread `stageFailedTransitions` into the state config.

- [ ] **Step 5: Re-run test**

Run: `cd apps/server && npx vitest run src/kernel-next/compiler/ir-to-machine.test.ts`
Expected: PASS.

- [ ] **Step 6: Full ir-to-machine suite**

Run: `cd apps/server && npx vitest run src/kernel-next/compiler/`
Expected: all passing. Baseline tests unchanged.

- [ ] **Step 7: tsc + commit**

```bash
cd apps/server && npx tsc --noEmit
```
Expected: clean.

```bash
git add apps/server/src/kernel-next/compiler/ir-to-machine.ts \
        apps/server/src/kernel-next/compiler/ir-to-machine.test.ts
git commit -m "feat(compiler): retry transition + RETRY_TO_STAGE event on ScriptStage.config.retry"
```

## Task C2: RESET_STAGE transitions on each stage region

**Files:**
- Modify: `apps/server/src/kernel-next/compiler/ir-to-machine.ts`
- Modify: `apps/server/src/kernel-next/compiler/ir-to-machine.test.ts`

- [ ] **Step 1: Write failing test — RESET_STAGE drops a done region back to waiting**

In ir-to-machine.test.ts:
```ts
it("RESET_STAGE event for stage X drops X's region from done back to waiting", () => {
  // Build a minimal IR, compile, start the actor, drive stage X to done,
  // send { type: "RESET_STAGE", stage: "X" }, assert X's region value
  // is now "waiting".
  // Use the existing pattern in this test file for creating and
  // driving an actor.
});

it("RESET_STAGE with non-matching stage name is a no-op for this region", () => {
  // Same setup; send RESET_STAGE { stage: "Y" } to region X; X stays done.
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd apps/server && npx vitest run src/kernel-next/compiler/ir-to-machine.test.ts`
Expected: FAIL — RESET_STAGE not yet handled.

- [ ] **Step 3: Add RESET_STAGE handler to every stage region**

In the region builder, each of `waiting | executing | done | error` accepts:
```ts
on: {
  RESET_STAGE: {
    guard: ({ event }: any) => event.stage === s.name,
    target: "waiting",
  },
  // ... existing transitions ...
}
```

(`waiting` itself can accept RESET_STAGE to re-enter waiting as a no-op via self-transition.)

- [ ] **Step 4: Re-run tests**

Run: `cd apps/server && npx vitest run src/kernel-next/compiler/ir-to-machine.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify parent machine allDone condition re-evaluates**

In the same file add:
```ts
it("parent machine exits `completed` when a region RESET_STAGEs back to waiting", () => {
  // Drive a 1-stage IR to completed. Send RESET_STAGE. Assert snapshot
  // value transitions back away from "completed".
});
```

Run: `cd apps/server && npx vitest run src/kernel-next/compiler/ir-to-machine.test.ts`
Expected: PASS. (XState v5 re-evaluates onDone guards automatically when child states change.)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/kernel-next/compiler/ir-to-machine.ts \
        apps/server/src/kernel-next/compiler/ir-to-machine.test.ts
git commit -m "feat(compiler): RESET_STAGE drops any stage region back to waiting"
```

## Task C3: Converter extracts runtime.retry

**Files:**
- Modify: `apps/server/src/kernel-next/converter/map-stages.ts`
- Modify: `apps/server/src/kernel-next/converter/map-stages.test.ts`

- [ ] **Step 1: Write failing test**

In `map-stages.test.ts`, UPDATE the Slice A test:
```ts
// Replaces the old "emits LEGACY_FIELD_IGNORED for runtime.retry" test.
it("extracts runtime.retry with back_to into ScriptStage.config.retry", () => {
  const legacy = {
    stages: [
      { name: "A", type: "agent", runtime: { reads: {} } },
      { name: "S", type: "script",
        runtime: { reads: {}, script_id: "m",
                   retry: { max_retries: 2, back_to: "A" } } },
    ],
  };
  const r = mapStagesToIR(legacy as any, new Map(), new Map(), new Set());
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const s = r.stages.find(x => x.name === "S")!;
  expect(s.type).toBe("script");
  if (s.type !== "script") return;
  expect(s.config.retry).toEqual({ maxRetries: 2, backToStage: "A" });
});

it("emits LEGACY_FIELD_IGNORED when retry has max_retries but no back_to", () => {
  const legacy = {
    stages: [{ name: "S", type: "script",
               runtime: { reads: {}, script_id: "m",
                          retry: { max_retries: 3 } } }],
  };
  const r = mapStagesToIR(legacy as any, new Map(), new Map(), new Set());
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.warnings.some(w =>
    w.code === "LEGACY_FIELD_IGNORED" && w.context?.field === "retry"
  )).toBe(true);
  const s = r.stages[0]!;
  expect(s.type === "script" && s.config.retry).toBeUndefined();
});

it("also accepts legacy max_attempts as retry count", () => {
  const legacy = {
    stages: [
      { name: "A", type: "agent", runtime: { reads: {} } },
      { name: "S", type: "script",
        runtime: { reads: {}, script_id: "m",
                   retry: { max_attempts: 2, back_to: "A" } } },
    ],
  };
  const r = mapStagesToIR(legacy as any, new Map(), new Map(), new Set());
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const s = r.stages.find(x => x.name === "S")!;
  if (s.type !== "script") return;
  expect(s.config.retry).toEqual({ maxRetries: 2, backToStage: "A" });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/map-stages.test.ts`
Expected: FAIL.

- [ ] **Step 3: Remove Slice A placeholder, add retry extraction in map-stages.ts**

3a. DELETE the Slice A placeholder warning for `runtime.retry`:
```ts
if (s.runtime?.retry) {
  warnings.push({ code: "LEGACY_FIELD_IGNORED", ... });
}
```

3b. Inside the script-stage arm, add extraction:
```ts
let retry: { maxRetries: number; backToStage: string } | undefined;
if (s.runtime?.retry) {
  const rr = s.runtime.retry;
  const maxRetries = rr.max_retries ?? rr.max_attempts;
  if (typeof maxRetries === "number" && maxRetries >= 1 && maxRetries <= 10
      && typeof rr.back_to === "string" && rr.back_to.length > 0) {
    retry = { maxRetries, backToStage: rr.back_to };
  } else {
    warnings.push({
      code: "LEGACY_FIELD_IGNORED",
      message: `stage '${name}' runtime.retry ignored: requires both max_retries(1..10) and back_to`,
      context: { stage: name, field: "retry" },
    });
  }
}
```

3c. Thread into the StageIR:
```ts
const stage: StageIR = {
  name, type: "script", inputs, outputs,
  config: {
    moduleId: /* existing */,
    ...(retry ? { retry } : {}),
  },
};
```

- [ ] **Step 4: Re-run tests**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/map-stages.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-run pipeline-generator integration**

Run: `cd apps/server && npx vitest run src/kernel-next/converter/pipeline-generator.test.ts`
Expected: Still PASS. Update the integration test to assert persisting's retry is now extracted:
```ts
it("persisting.retry is extracted with back_to rewritten to genSkeleton", () => {
  const yaml = readFileSync(PIPELINE_YAML, "utf8");
  const r = convertLegacyYaml(yaml);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const p = r.ir.stages.find(s => s.name === "persisting");
  expect(p?.type).toBe("script");
  if (p?.type !== "script") return;
  expect(p.config.retry).toEqual({ maxRetries: 1, backToStage: "genSkeleton" });
  expect(r.warnings.some(w => w.code === "RETRY_BACK_TO_REDIRECTED")).toBe(true);
});
```

DELETE the Slice A "persisting.retry is dropped" assertion.

- [ ] **Step 6: tsc + commit**

```bash
cd apps/server && npx tsc --noEmit
```
Expected: clean.

```bash
git add apps/server/src/kernel-next/converter/map-stages.ts \
        apps/server/src/kernel-next/converter/map-stages.test.ts \
        apps/server/src/kernel-next/converter/pipeline-generator.test.ts
git commit -m "feat(converter): extract runtime.retry to ScriptStage.config.retry"
```

## Task C4: SSE StageRetryData + union member

**Files:**
- Modify: `apps/server/src/kernel-next/sse/types.ts`

- [ ] **Step 1: Add StageRetryData and KernelNextStageRetryEvent**

In `apps/server/src/kernel-next/sse/types.ts`:

Add to the `KernelNextEventType` union: `"stage_retry"`.

Add the data interface alongside StageErrorData:
```ts
export interface StageRetryData {
  stage: string;          // the failed stage name
  backToStage: string;    // the stage the run is retrying from
  retryIdx: number;       // 0-based retry count BEFORE increment
                          // (0 = this is the first retry)
  maxRetries: number;
  errorMessage: string;
}

export interface KernelNextStageRetryEvent extends KernelNextSSEEvent {
  type: "stage_retry";
  data: StageRetryData;
}
```

Add to `AnyKernelNextSSEEvent` union:
```ts
| KernelNextStageRetryEvent
```

- [ ] **Step 2: tsc check**

Run: `cd apps/server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/kernel-next/sse/types.ts
git commit -m "feat(sse): add stage_retry event type + StageRetryData"
```

## Task C5: Runner — RETRY_TO_STAGE handler + stage_retry publish

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/runner.ts`
- Modify: `apps/server/src/kernel-next/runtime/runner.test.ts`

- [ ] **Step 1: Write failing test — runner clears portValues + finalizedStages + publishes stage_retry + increments retryCounts**

In `runner.test.ts`:
```ts
describe("runPipeline RETRY_TO_STAGE handling", () => {
  it("on retry: clears portValues of target+downstream, increments retryCounts, publishes stage_retry, runs to completion on second attempt", async () => {
    const { KernelNextBroadcaster } = await import("../sse/broadcaster.js");
    const broadcaster = new KernelNextBroadcaster();
    const db = makeDb();

    // Pipeline: A -> S (script). S fails first, succeeds second.
    const ir: PipelineIR = {
      name: "retry-ok",
      externalInputs: [],
      stages: [
        { name: "A", type: "agent", inputs: [],
          outputs: [{ name: "x", type: "number" }],
          config: { promptRef: "p" } },
        { name: "S", type: "script",
          inputs: [{ name: "x", type: "number" }],
          outputs: [{ name: "r", type: "boolean" }],
          config: { moduleId: "m", retry: { maxRetries: 1, backToStage: "A" } } },
      ],
      wires: [
        { from: { source: "stage", stage: "A", port: "x" },
          to: { stage: "S", port: "x" } },
      ],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    let sAttempts = 0;
    const scriptExecutor = {
      executeStage: async () => {
        sAttempts += 1;
        if (sAttempts === 1) {
          return { attemptId: `s-a${sAttempts}`, attemptIdx: sAttempts,
                   status: "error" as const, error: "boom" };
        }
        return { attemptId: `s-a${sAttempts}`, attemptIdx: sAttempts,
                 status: "success" as const, outputs: { r: true } };
      },
    };

    const events: Array<{ type: string; data: unknown }> = [];
    broadcaster.subscribe("retry-ok", (e) => events.push({ type: e.type, data: e.data }));

    const result = await runPipeline({
      db, ir, taskId: "retry-ok", versionHash: hash,
      handlers: { A: () => ({ x: 5 }), S: () => ({}) },
      executor: scriptExecutor,
      broadcaster,
    });
    db.close();

    expect(result.finalState).toBe("completed");
    expect(result.stageErrors).toHaveLength(0);

    const retryEvents = events.filter(e => e.type === "stage_retry");
    expect(retryEvents).toHaveLength(1);
    const rd = retryEvents[0]!.data as any;
    expect(rd).toMatchObject({
      stage: "S", backToStage: "A",
      retryIdx: 0, maxRetries: 1,
      errorMessage: "boom",
    });

    // A must have been executed twice (first pass + after retry).
    const aExecutingEvents = events.filter(e =>
      e.type === "stage_executing" && (e.data as any).stage === "A"
    );
    expect(aExecutingEvents.length).toBe(2);
  });

  it("on retry exhaustion: publishes stage_error with reason=executor_failed, finalState=failed", async () => {
    // Script fails twice; maxRetries=1 → second failure triggers the
    // fallback transition to error.
    const { KernelNextBroadcaster } = await import("../sse/broadcaster.js");
    const broadcaster = new KernelNextBroadcaster();
    const db = makeDb();
    const ir: PipelineIR = {
      name: "retry-exhaust",
      externalInputs: [],
      stages: [
        { name: "A", type: "agent", inputs: [],
          outputs: [{ name: "x", type: "number" }],
          config: { promptRef: "p" } },
        { name: "S", type: "script",
          inputs: [{ name: "x", type: "number" }],
          outputs: [{ name: "r", type: "boolean" }],
          config: { moduleId: "m", retry: { maxRetries: 1, backToStage: "A" } } },
      ],
      wires: [
        { from: { source: "stage", stage: "A", port: "x" },
          to: { stage: "S", port: "x" } },
      ],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const events: Array<{ type: string; data: unknown }> = [];
    broadcaster.subscribe("retry-exhaust", (e) => events.push({ type: e.type, data: e.data }));

    const result = await runPipeline({
      db, ir, taskId: "retry-exhaust", versionHash: hash,
      handlers: { A: () => ({ x: 5 }), S: () => ({}) },
      executor: {
        executeStage: async () => ({
          attemptId: "x", attemptIdx: 0,
          status: "error" as const, error: "always broken",
        }),
      },
      broadcaster,
    });
    db.close();

    expect(result.finalState).toBe("failed");
    expect(result.stageErrors[0]!.stage).toBe("S");

    const retryEvents = events.filter(e => e.type === "stage_retry");
    expect(retryEvents).toHaveLength(1);  // one retry (maxRetries=1)
    const errEvents = events.filter(e => e.type === "stage_error");
    expect(errEvents).toHaveLength(1);
    expect((errEvents[0]!.data as any).reason).toBe("executor_failed");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd apps/server && npx vitest run src/kernel-next/runtime/runner.test.ts`
Expected: FAIL — RETRY_TO_STAGE not yet handled.

- [ ] **Step 3: Add RETRY_TO_STAGE handling in runner.ts**

In `apps/server/src/kernel-next/runtime/runner.ts`, locate the actor `subscribe(snapshot)` loop. Import topoDownstream:
```ts
import { topoDownstream } from "../converter/topo-downstream.js";
```

Inside the subscribe callback, after inspecting the latest event (or use XState inspection API — mirror existing patterns in this file for event observation):

```ts
// Detect RETRY_TO_STAGE by examining latest internal event (use the
// same mechanism existing code uses to observe GATE_ANSWERED, which
// sits on the parent machine similarly).
const lastEvent = /* the way this file already reads latest event */;
if (lastEvent?.type === "RETRY_TO_STAGE") {
  const { failedStageName, backToStage, retryIdx, maxRetries, errorMessage } = lastEvent;

  const downstream = topoDownstream(ir.wires, backToStage);
  const toReset = [backToStage, ...downstream];

  // Mutate context atomically via a transition or assign — mirror how
  // existing code in this file mutates MachineContext (e.g. the
  // GATE_ANSWERED handler). Simplest option: send a dedicated
  // RETRY_BOOKKEEP event that an assign handler at the machine root
  // picks up to do the mutations. Alternative: runner directly
  // manipulates a kept-in-memory copy and sends commands.
  //
  // Whichever pattern the rest of the file uses, apply it here to:
  //   1. For each stage in toReset: delete ctx.portValues[`${stage}.*`]
  //   2. ctx.finalizedStages = filter out resetted stages
  //   3. ctx.retryCounts[failedStageName] = (ctx.retryCounts[failedStageName] ?? 0) + 1
  //   4. send { type: "RESET_STAGE", stage: backToStage }

  publish({
    type: "stage_retry",
    taskId: opts.taskId,
    timestamp: isoNow(),
    data: {
      stage: failedStageName,
      backToStage,
      retryIdx,
      maxRetries,
      errorMessage,
    },
  });

  // Also structured log:
  taskLogger(opts.taskId).info(
    { stage: failedStageName, backToStage, retryIdx, maxRetries, errorMessage },
    "stage retry triggered",
  );
}
```

Add a root-level machine transition or runner-owned state updater to apply the three context mutations. The exact mechanism should match how GATE_ANSWERED currently updates `gateAuthorizedTargets` and `gateSkippedTargets` in this codebase — use the same pattern.

- [ ] **Step 4: Re-run tests**

Run: `cd apps/server && npx vitest run src/kernel-next/runtime/runner.test.ts`
Expected: PASS, both retry tests.

- [ ] **Step 5: Additional tests — downstream cleared, gate-routed preserved**

```ts
it("on retry: downstream done stage is cleared from portValues and re-executes", async () => {
  // Pipeline: A -> S (script, retry: A) -> B (agent)
  // S fails once, recovers. Verify B's portValues are cleared when
  // RETRY_TO_STAGE is processed, and B re-executes on the second pass.
  // ... construct IR, test.
});

it("on retry: gate-routed target stays authorized without re-asking", async () => {
  // Pipeline: G (gate, approve: A) -> A -> S (script, retry: A)
  // Answer G once, let S fail, verify A reruns without requiring
  // a second GATE_ANSWERED.
});
```

Run: `cd apps/server && npx vitest run src/kernel-next/runtime/runner.test.ts`
Expected: PASS.

- [ ] **Step 6: tsc + commit**

```bash
cd apps/server && npx tsc --noEmit
```
Expected: clean.

```bash
git add apps/server/src/kernel-next/runtime/runner.ts \
        apps/server/src/kernel-next/runtime/runner.test.ts
git commit -m "feat(runner): RETRY_TO_STAGE handler + stage_retry SSE + retryCounts"
```

## Task C6: pipeline-generator MockExecutor E2E

**Files:**
- Create: `apps/server/src/kernel-next/runtime/pipeline-generator-run.test.ts`

- [ ] **Step 1: Write the integration test**

File `apps/server/src/kernel-next/runtime/pipeline-generator-run.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { convertLegacyYaml } from "../converter/legacy-yaml.js";
import { runPipeline } from "./runner.js";
import { versionHash } from "../ir/canonical.js";
import { insertPipelineVersion } from "../ir/sql.js";
import { makeDb } from "../test-utils/makeDb.js"; // or whichever helper

const PIPELINE_YAML = path.resolve(
  __dirname,
  "../../builtin-pipelines/pipeline-generator/pipeline.yaml",
);

describe("pipeline-generator end-to-end with MockExecutor + induced retry", () => {
  it("converts, runs through gate answer, induces persisting failure once, retries, completes", async () => {
    const yaml = readFileSync(PIPELINE_YAML, "utf8");
    const conv = convertLegacyYaml(yaml);
    expect(conv.ok).toBe(true);
    if (!conv.ok) return;

    const db = makeDb();
    const hash = versionHash(conv.ir);
    insertPipelineVersion(db, conv.ir, { versionHash: hash, tsSource: "" });

    let persistCalls = 0;
    const executor = {
      executeStage: async (args: { stageName: string }) => {
        if (args.stageName === "persisting") {
          persistCalls += 1;
          if (persistCalls === 1) {
            return { attemptId: `p${persistCalls}`, attemptIdx: persistCalls,
                     status: "error" as const, error: "first attempt fails" };
          }
          return { attemptId: `p${persistCalls}`, attemptIdx: persistCalls,
                   status: "success" as const,
                   outputs: { pipelineId: "foo", pipelineName: "Foo",
                              savedFiles: [], validationPassed: true } };
        }
        // Other stages: return the outputs their YAML declares with
        // dummy values.
        const stage = conv.ir.stages.find(s => s.name === args.stageName);
        const outputs: Record<string, unknown> = {};
        for (const o of stage?.outputs ?? []) {
          outputs[o.name] = stubValueForPortType(o.type);
        }
        return { attemptId: `${args.stageName}-a1`, attemptIdx: 1,
                 status: "success" as const, outputs };
      },
    };

    const result = await runPipeline({
      db, ir: conv.ir, taskId: "pg-e2e", versionHash: hash,
      handlers: {},
      executor,
      // Gate auto-answer hook: whenever a gate enters executing, send
      // GATE_ANSWERED { answer: "approve" }. Mirror how existing
      // human_confirm tests work.
      onGate: (gate: string) => ({ answer: "approve", stageName: gate }),
    });
    db.close();

    expect(result.finalState).toBe("completed");
    expect(persistCalls).toBe(2);  // one failure + one retry
  });
});

function stubValueForPortType(t: string): unknown {
  if (t === "string") return "stub";
  if (t === "string[]") return [];
  if (t === "number") return 0;
  if (t === "boolean") return true;
  if (t === "object[]") return [];
  return null;
}
```

(The actual `runPipeline` signature for `onGate` may differ — inspect existing gate tests for the real mechanism and adapt.)

- [ ] **Step 2: Run**

Run: `cd apps/server && npx vitest run src/kernel-next/runtime/pipeline-generator-run.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/kernel-next/runtime/pipeline-generator-run.test.ts
git commit -m "test(pipeline-generator): MockExecutor E2E with induced retry"
```

## Task C7: Real-SDK manual E2E + handoff

- [ ] **Step 1: Clean dev DB**

```bash
rm -f /tmp/workflow-control-data/kernel-next.db \
      /tmp/workflow-control-data/kernel-next.db-shm \
      /tmp/workflow-control-data/kernel-next.db-wal
```

- [ ] **Step 2: Start server**

```bash
pnpm --filter=server dev
```

- [ ] **Step 3: POST pipeline-generator task**

In another terminal:
```bash
curl -X POST http://localhost:3001/api/kernel/tasks/run \
  -H 'Content-Type: application/json' \
  -d '{
    "taskId": "pg-real-e2e",
    "pipeline": "pipeline-generator",
    "seedValues": { /* the seed keys that pipeline-generator's
                      injected_context / analyzing expects;
                      inspect pipeline-generator.yaml */ },
    "maxTurns": 80,
    "maxBudgetUsd": 8
  }'
```

Expect: 202 with taskId + versionHash.

- [ ] **Step 4: Watch SSE**

```bash
curl -sN http://localhost:3001/api/kernel-next/tasks/pg-real-e2e/stream
```

Observe events through at least analyzing → awaitingConfirm (answer via MCP or API) → genSkeleton + genPrompts → refinePrompts → persisting. Confirm:
- genPrompts's `prompt-writer` sub-agent is invoked (visible in SDK logs or persistResult).
- If persisting fails, a `stage_retry` event is published, and genSkeleton re-executes.

Record observations in the handoff.

- [ ] **Step 5: Write milestone handoff**

File `docs/superpowers/plans/2026-04-22-converter-extension-pipeline-generator-done-handoff.md`:

Standard handoff format (follow the style of `2026-04-21-kernel-next-followup-done-handoff.md`):
- §1 Overview: three slices delivered, commits list
- §2–§4 per-slice detail with decisions
- §5 Test delta (before/after counts)
- §6 Decision records
- §7 Follow-up candidates (MCP surface for pipeline-generator = milestone #5)
- §8 Dev DB gotcha (if still relevant)
- §9 Real-SDK E2E record with taskId, SSE event counts, anomalies

- [ ] **Step 6: Commit handoff**

```bash
git add docs/superpowers/plans/2026-04-22-converter-extension-pipeline-generator-done-handoff.md
git commit -m "docs: handoff for converter extension milestone (parallel/gate/subAgents/retry)"
```

## Task C8: Final sanity

- [ ] **Step 1: tsc both packages**

```bash
cd apps/server && npx tsc --noEmit && cd ../web && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 2: Full server suite**

```bash
cd apps/server && npx vitest run
```
Expected: all green. Record new test count.

- [ ] **Step 3: Web build**

```bash
cd apps/web && pnpm build
```
Expected: success.

---

# Self-Review Checklist (mandatory before declaring milestone complete)

- [ ] Spec §1 success criteria all achieved (1 = conversion ok, 2 = E2E runs, 3 = no test regression)
- [ ] All 7 new fatal diagnostic codes have at least one test
- [ ] Both new warning codes have at least one test
- [ ] Canonical hash baselines (diamondIR, smokeTestIR) unchanged
- [ ] No dependency on `runtime.agents.disallowed_tools` / `skills` / `mcpServers` (deferred per spec §9.4)
- [ ] `foreach` still returns UNSUPPORTED_FEATURE
- [ ] Manual E2E recorded with taskId, commit SHAs, SSE event counts
