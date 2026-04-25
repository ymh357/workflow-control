# Single-Session Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable opt-in `session_mode: "single"` per pipeline so agent-only segments share one SDK conversation across stages, with prompt-cache-friendly resume across forced segment boundaries (gate / script / fanout / pipeline end).

**Architecture:** Hybrid I+II. Pure-function `segment-planner` computes static segments at runner startup. Runner detects "this stage is a segment continuation" and plumbs `segmentContinuation: { resumeSessionId, priorNumTurns, priorAttempts }` into the executor. RealStageExecutor passes `options.resume` to SDK and renders a continuation-style prompt (skips persona, keeps reads-section). reads/writes invariant preserved — every stage's prompt still injects its declared reads. M-R5 crash-recovery resume continues to work for segment-first stages; segment continuation subsumes it for non-first stages.

**Tech Stack:** TypeScript, Zod, Vitest, better-sqlite3, Claude Agent SDK (`@anthropic-ai/claude-agent-sdk@0.2.63`), XState v5.

**Spec:** `docs/superpowers/specs/2026-04-25-single-session-mode-design.md`

---

## File Structure

**Create:**
- `apps/server/src/kernel-next/runtime/segment-planner.ts` — pure function: IR → segments
- `apps/server/src/kernel-next/runtime/segment-planner.test.ts` — segment-shape unit tests
- `apps/server/src/kernel-next/runtime/runner.single-session.test.ts` — runner integration with mock executor
- `apps/server/src/kernel-next/runtime/segment-turn-clamp.test.ts` — segment-wide maxTurns math

**Modify:**
- `apps/server/src/kernel-next/ir/schema.ts` — `PipelineIRSchema` add `session_mode`
- `apps/server/src/kernel-next/ir/canonical.ts` — include `session_mode` in canonical JSON
- `apps/server/src/kernel-next/runtime/executor.ts` — `ExecuteStageArgs.segmentContinuation`
- `apps/server/src/kernel-next/runtime/real-executor.ts` — consume `segmentContinuation`, pass to prompt builder + SDK
- `apps/server/src/kernel-next/runtime/real-executor-prompt-builder.ts` — `continuationMode` rendering
- `apps/server/src/kernel-next/runtime/runner.ts` — segment lookup + plumbing
- `apps/server/src/builtin-pipelines/smoke-test/pipeline.ir.json` — `session_mode: "single"`
- `apps/server/src/builtin-pipelines/pr-description-generator/pipeline.ir.json` — `session_mode: "single"`, prompt rewrite
- `apps/server/src/kernel-next/ir/sql.ts` — view `v_segment_continuity`
- `docs/product-roadmap.md` — close §4 line 105

---

## Task 1: IR schema — `session_mode` field

**Files:**
- Modify: `apps/server/src/kernel-next/ir/schema.ts:311`
- Modify: `apps/server/src/kernel-next/ir/schema.test.ts` (if it exists; otherwise add to nearest sibling test file)

- [ ] **Step 1: Read current `PipelineIRSchema` definition**

```bash
sed -n '309,320p' apps/server/src/kernel-next/ir/schema.ts
```
Expected: shows `PipelineIRSchema = z.object({ name, stages, wires, entry, externalInputs, store_schema })`.

- [ ] **Step 2: Write failing test for `session_mode` defaulting**

Add to `apps/server/src/kernel-next/ir/schema.test.ts` (or sibling `schema.session-mode.test.ts` if schema.test is missing):

```ts
import { describe, it, expect } from "vitest";
import { PipelineIRSchema } from "./schema.js";

describe("PipelineIRSchema.session_mode", () => {
  const minimalIR = {
    name: "p",
    stages: [{
      name: "s1",
      type: "agent",
      inputs: [],
      outputs: [],
      config: { promptRef: "p/r" },
    }],
  };

  it("defaults to 'multi' when omitted", () => {
    const parsed = PipelineIRSchema.parse(minimalIR);
    expect(parsed.session_mode).toBe("multi");
  });

  it("accepts 'single'", () => {
    const parsed = PipelineIRSchema.parse({ ...minimalIR, session_mode: "single" });
    expect(parsed.session_mode).toBe("single");
  });

  it("rejects unknown values", () => {
    expect(() => PipelineIRSchema.parse({ ...minimalIR, session_mode: "foo" })).toThrow();
  });
});
```

- [ ] **Step 3: Run failing test**

```bash
cd apps/server && npx vitest run src/kernel-next/ir/schema.session-mode.test.ts
```
Expected: FAIL — `session_mode` is undefined.

- [ ] **Step 4: Add `session_mode` to schema**

In `apps/server/src/kernel-next/ir/schema.ts`, change `PipelineIRSchema` to:

```ts
export const PipelineIRSchema = z.object({
  name: z.string().min(1).max(128),
  stages: z.array(StageIRSchema).min(1),
  wires: z.array(WireIRSchema).default([]),
  entry: identifier.optional(),
  externalInputs: z.array(PortIRSchema).default([]),
  store_schema: StoreSchemaSchema.optional(),
  // Single-session mode: when "single", consecutive agent stages share
  // one SDK conversation (per spec 2026-04-25-single-session-mode-design).
  // Default "multi" preserves pre-2026-04-25 behavior.
  session_mode: z.enum(["multi", "single"]).default("multi"),
});
```

Update the `PipelineIR` type alias to match the existing `externalInputs`
pattern — Zod's `.default()` makes the inferred output type *required*,
which would force every test fixture and IR-construction site to add
the field. Mirror the optional-in-type / required-at-runtime pattern:

```ts
export type PipelineIR = Omit<z.infer<typeof PipelineIRSchema>, "externalInputs" | "wires" | "session_mode"> & {
  externalInputs?: PortIR[];
  wires: WireIR[];
  session_mode?: "multi" | "single";
};
```
Update the comment above the type alias to mention `session_mode`
alongside `externalInputs`.

- [ ] **Step 5: Run test to verify pass**

```bash
cd apps/server && npx vitest run src/kernel-next/ir/schema.session-mode.test.ts
```
Expected: PASS.

- [ ] **Step 6: Run full schema test suite to verify no regression**

```bash
cd apps/server && npx vitest run src/kernel-next/ir/
```
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/kernel-next/ir/schema.ts apps/server/src/kernel-next/ir/schema.session-mode.test.ts
git commit -m "feat(ir): add session_mode to PipelineIR schema (default 'multi')"
```

---

## Task 2: Canonical JSON includes `session_mode` (version_hash)

**Files:**
- Modify: `apps/server/src/kernel-next/ir/canonical.ts`
- Modify: `apps/server/src/kernel-next/ir/canonical.test.ts`

- [ ] **Step 1: Inspect canonical.ts root function**

```bash
grep -n "session_mode\|name:\|stages:\|store_schema" apps/server/src/kernel-next/ir/canonical.ts | head -20
```
Expected: see how name/stages/store_schema are flattened into the canonical structure.

- [ ] **Step 2: Write failing test for `session_mode` participating in version_hash**

Add to `apps/server/src/kernel-next/ir/canonical.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { canonicalize } from "./canonical.js";
import { PipelineIRSchema } from "./schema.js";

describe("canonical: session_mode in version_hash", () => {
  const base = PipelineIRSchema.parse({
    name: "p",
    stages: [{
      name: "s1",
      type: "agent",
      inputs: [],
      outputs: [],
      config: { promptRef: "p/r" },
    }],
  });

  it("differs when session_mode differs", () => {
    const multi = canonicalize({ ...base, session_mode: "multi" });
    const single = canonicalize({ ...base, session_mode: "single" });
    expect(multi).not.toBe(single);
    expect(multi).not.toEqual(single);
  });

  it("includes session_mode field in output", () => {
    const out = canonicalize({ ...base, session_mode: "single" });
    expect(out).toContain("session_mode");
    expect(out).toContain("single");
  });
});
```

- [ ] **Step 3: Run failing test**

```bash
cd apps/server && npx vitest run src/kernel-next/ir/canonical.test.ts -t "session_mode"
```
Expected: FAIL.

- [ ] **Step 4: Update canonicalize() in canonical.ts**

Find the place where the root pipeline object is constructed (search for `name: ir.name`). Add `session_mode` to that object alongside the other top-level fields. Place it in alphabetical position so `sortKeys` produces a stable order. Example fragment to insert:

```ts
session_mode: ir.session_mode ?? "multi",
```

The exact line depends on the existing structure — preserve current key ordering style (the canonicalize function should already sort keys).

- [ ] **Step 5: Run test to verify pass**

```bash
cd apps/server && npx vitest run src/kernel-next/ir/canonical.test.ts
```
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/kernel-next/ir/canonical.ts apps/server/src/kernel-next/ir/canonical.test.ts
git commit -m "feat(ir): include session_mode in canonical JSON / version_hash"
```

---

## Task 3: Segment planner — pure function

**Files:**
- Create: `apps/server/src/kernel-next/runtime/segment-planner.ts`
- Create: `apps/server/src/kernel-next/runtime/segment-planner.test.ts`

- [ ] **Step 1: Write failing tests covering all segment shapes**

Create `apps/server/src/kernel-next/runtime/segment-planner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { planSegments } from "./segment-planner.js";
import type { PipelineIR } from "../ir/schema.js";

const agentStage = (name: string, inputs: string[] = [], outputs: string[] = [], extra: Record<string, unknown> = {}) => ({
  name,
  type: "agent" as const,
  inputs: inputs.map(p => ({ name: p, type: "unknown" })),
  outputs: outputs.map(p => ({ name: p, type: "unknown" })),
  config: { promptRef: "p/r" },
  ...extra,
});
const scriptStage = (name: string, inputs: string[] = [], outputs: string[] = []) => ({
  name,
  type: "script" as const,
  inputs: inputs.map(p => ({ name: p, type: "unknown" })),
  outputs: outputs.map(p => ({ name: p, type: "unknown" })),
  config: { source: "registry" as const, moduleId: "x" },
});
const gateStage = (name: string, inputs: string[] = [], outputs: string[] = []) => ({
  name,
  type: "gate" as const,
  inputs: inputs.map(p => ({ name: p, type: "unknown" })),
  outputs: outputs.map(p => ({ name: p, type: "unknown" })),
  config: { question: { text: "q" }, routing: { routes: {} } },
});
const wire = (fromStage: string, fromPort: string, toStage: string, toPort: string) => ({
  from: { source: "stage" as const, stage: fromStage, port: fromPort },
  to: { stage: toStage, port: toPort },
});

describe("planSegments", () => {
  it("returns size-1 segments for every stage when session_mode='multi'", () => {
    const ir: PipelineIR = {
      name: "p",
      session_mode: "multi",
      stages: [agentStage("a", [], ["x"]), agentStage("b", ["x"], [])],
      wires: [wire("a", "x", "b", "x")],
    };
    const segs = planSegments(ir);
    expect(segs).toEqual([["a"], ["b"]]);
  });

  it("merges linear agent chain in single mode", () => {
    const ir: PipelineIR = {
      name: "p",
      session_mode: "single",
      stages: [
        agentStage("a", [], ["x"]),
        agentStage("b", ["x"], ["y"]),
        agentStage("c", ["y"], []),
      ],
      wires: [wire("a", "x", "b", "x"), wire("b", "y", "c", "y")],
    };
    expect(planSegments(ir)).toEqual([["a", "b", "c"]]);
  });

  it("breaks segment at script stage", () => {
    const ir: PipelineIR = {
      name: "p",
      session_mode: "single",
      stages: [
        agentStage("a", [], ["x"]),
        scriptStage("s", ["x"], ["y"]),
        agentStage("c", ["y"], []),
      ],
      wires: [wire("a", "x", "s", "x"), wire("s", "y", "c", "y")],
    };
    expect(planSegments(ir)).toEqual([["a"], ["s"], ["c"]]);
  });

  it("breaks segment at gate stage", () => {
    const ir: PipelineIR = {
      name: "p",
      session_mode: "single",
      stages: [
        agentStage("a", [], ["x"]),
        gateStage("g", ["x"], ["y"]),
        agentStage("c", ["y"], []),
      ],
      wires: [wire("a", "x", "g", "x"), wire("g", "y", "c", "y")],
    };
    expect(planSegments(ir)).toEqual([["a"], ["g"], ["c"]]);
  });

  it("breaks segment when fanout flag present", () => {
    const ir: PipelineIR = {
      name: "p",
      session_mode: "single",
      stages: [
        agentStage("a", [], ["x"]),
        agentStage("b", ["x"], [], { fanout: { input: "x" } }),
      ],
      wires: [wire("a", "x", "b", "x")],
    };
    expect(planSegments(ir)).toEqual([["a"], ["b"]]);
  });

  it("starts new segment on multi-input fan-in", () => {
    const ir: PipelineIR = {
      name: "p",
      session_mode: "single",
      stages: [
        agentStage("a", [], ["x"]),
        agentStage("b", [], ["y"]),
        agentStage("c", ["x", "y"], []),
      ],
      wires: [wire("a", "x", "c", "x"), wire("b", "y", "c", "y")],
    };
    const segs = planSegments(ir);
    // a is its own; b is its own; c starts new (multi-input fan-in).
    expect(segs).toEqual([["a"], ["b"], ["c"]]);
  });

  it("at-most-one continuation per segment", () => {
    // a fans out to b and c (both consume x). a's segment can adopt at
    // most one of them (the first in topological order); the other
    // starts a new segment.
    const ir: PipelineIR = {
      name: "p",
      session_mode: "single",
      stages: [
        agentStage("a", [], ["x"]),
        agentStage("b", ["x"], []),
        agentStage("c", ["x"], []),
      ],
      wires: [wire("a", "x", "b", "x"), wire("a", "x", "c", "x")],
    };
    const segs = planSegments(ir);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual(["a", "b"]);
    expect(segs[1]).toEqual(["c"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/server && npx vitest run src/kernel-next/runtime/segment-planner.test.ts
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write `segment-planner.ts` minimal implementation**

Create `apps/server/src/kernel-next/runtime/segment-planner.ts`:

```ts
// Single-session mode segment planner.
//
// Pure function: given a parsed PipelineIR, produces a list of "segments".
// Each segment is an ordered list of stage names that will share one SDK
// conversation (when session_mode === "single"). When session_mode is
// "multi", every stage is its own segment of size 1 (current behaviour).
//
// See docs/superpowers/specs/2026-04-25-single-session-mode-design.md
// §6.1 for the segmentation rules.

import type { PipelineIR, StageIR, WireIR } from "../ir/schema.js";

/**
 * Plan segments for the given IR. The result preserves stage order:
 * `segments.flat()` is a topological enumeration of every stage in the IR.
 *
 * In multi mode every stage is its own segment.
 *
 * In single mode, a stage S joins the segment of its sole upstream
 * predecessor P iff:
 *   - S.type === "agent" && S.fanout === undefined
 *   - P.type === "agent" && P.fanout === undefined
 *   - S has exactly one upstream agent stage by wires
 *   - P's segment has not yet been extended by another stage
 *     (at-most-one continuation per segment)
 *   - P and S are connected by a stage-source wire
 *
 * Otherwise S opens a new segment of size 1.
 */
export function planSegments(ir: PipelineIR): string[][] {
  if (ir.session_mode !== "single") {
    return ir.stages.map((s) => [s.name]);
  }

  const stageByName = new Map<string, StageIR>(
    ir.stages.map((s) => [s.name, s]),
  );
  // For each stage, the set of upstream stages (per stage-source wires).
  const upstreamAgents = new Map<string, string[]>();
  for (const s of ir.stages) upstreamAgents.set(s.name, []);
  for (const w of ir.wires as WireIR[]) {
    if (w.from.source === "external") continue;
    if (w.from.source && w.from.source !== "stage") continue;
    const fromStage = "stage" in w.from ? w.from.stage : undefined;
    if (!fromStage) continue;
    const upstream = stageByName.get(fromStage);
    if (!upstream) continue;
    if (upstream.type !== "agent") continue;
    if ("fanout" in upstream && upstream.fanout) continue;
    const list = upstreamAgents.get(w.to.stage);
    if (list && !list.includes(fromStage)) list.push(fromStage);
  }

  // Map of stage -> index of segment it belongs to.
  const segmentOf = new Map<string, number>();
  // Segment that has been extended already (cannot adopt another stage).
  const segmentClosed = new Set<number>();
  const segments: string[][] = [];

  for (const stage of ir.stages) {
    const isAgent = stage.type === "agent";
    const hasFanout = "fanout" in stage && stage.fanout;
    const ups = upstreamAgents.get(stage.name) ?? [];
    const uniqueAgentUp = ups.length === 1 ? ups[0] : null;

    if (isAgent && !hasFanout && uniqueAgentUp) {
      const upIdx = segmentOf.get(uniqueAgentUp);
      if (upIdx !== undefined && !segmentClosed.has(upIdx)) {
        segments[upIdx].push(stage.name);
        segmentOf.set(stage.name, upIdx);
        segmentClosed.add(upIdx);
        continue;
      }
    }

    const newIdx = segments.length;
    segments.push([stage.name]);
    segmentOf.set(stage.name, newIdx);
  }

  return segments;
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
cd apps/server && npx vitest run src/kernel-next/runtime/segment-planner.test.ts
```
Expected: All 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/runtime/segment-planner.ts apps/server/src/kernel-next/runtime/segment-planner.test.ts
git commit -m "feat(runtime): add segment-planner for single-session mode"
```

---

## Task 4: Executor contract — `segmentContinuation` field

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/executor.ts:37-85`

- [ ] **Step 1: Add new field to `ExecuteStageArgs`**

In `apps/server/src/kernel-next/runtime/executor.ts`, after the `priorNumTurns` field (around line 84), add:

```ts
  /**
   * Single-session segment continuation (spec
   * 2026-04-25-single-session-mode-design §6.2). When set, this stage
   * is a non-first stage in an agent-only segment; the executor must
   *   - pass `options.resume = resumeSessionId` to the SDK
   *   - clamp `maxTurns` against `priorNumTurns` (segment-wide sum)
   *   - render the prompt in continuation form (skip persona, keep
   *     reads-section)
   *
   * `priorAttempts` is informational — recorded for cross-reference
   * in execution-record but not consumed by the SDK call.
   *
   * Distinct from the existing M-R5 `resumeSessionId`/`priorNumTurns`
   * fields: those are for crash-recovery resume of a single stage.
   * Both can coexist; segmentContinuation takes precedence when both
   * are set (the segment's session subsumes any per-stage resume
   * since the whole segment is one conversation).
   */
  segmentContinuation?: {
    resumeSessionId: string;
    priorNumTurns: number;
    priorAttempts: string[];
  };
```

- [ ] **Step 2: Verify type-check passes**

```bash
cd apps/server && npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/kernel-next/runtime/executor.ts
git commit -m "feat(executor): add ExecuteStageArgs.segmentContinuation contract"
```

---

## Task 5: Prompt builder — `continuationMode` rendering

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/real-executor-prompt-builder.ts`
- Modify: `apps/server/src/kernel-next/runtime/real-executor-prompt-builder.test.ts`

- [ ] **Step 1: Read current `buildSystemPromptAppend` signature and structure**

```bash
sed -n '40,80p' apps/server/src/kernel-next/runtime/real-executor-prompt-builder.ts
```
Expected: see signature `(stage, resolvedPrompt, inputs, ctx, migrationHint?, ir?) => string`.

- [ ] **Step 2: Write failing test for continuation mode**

Add to `apps/server/src/kernel-next/runtime/real-executor-prompt-builder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSystemPromptAppend } from "./real-executor-prompt-builder.js";
import type { AgentStage } from "../ir/schema.js";

const stage: AgentStage = {
  name: "writePr",
  type: "agent",
  inputs: [{ name: "diff", type: "string" }],
  outputs: [{ name: "prText", type: "string" }],
  config: { promptRef: "system/write-pr" },
};

describe("buildSystemPromptAppend continuationMode", () => {
  it("includes Inputs section when continuationMode is true", () => {
    const out = buildSystemPromptAppend(
      stage,
      "Now produce the PR description.",
      { diff: "+++ a\n--- b\n" },
      { taskId: "t1", attemptId: "a1" },
      null,
      undefined,
      { continuationMode: true },
    );
    expect(out).toContain("Inputs");
    expect(out).toContain("diff");
  });

  it("omits Stage-contract overview in continuation form, keeps Output protocol", () => {
    const fullForm = buildSystemPromptAppend(
      stage,
      "Now produce the PR description.",
      { diff: "+++" },
      { taskId: "t1", attemptId: "a1" },
    );
    const continuationForm = buildSystemPromptAppend(
      stage,
      "Now produce the PR description.",
      { diff: "+++" },
      { taskId: "t1", attemptId: "a1" },
      null,
      undefined,
      { continuationMode: true },
    );
    // Continuation is shorter (no preamble, no Stage-contract block)
    expect(continuationForm.length).toBeLessThan(fullForm.length);
    // Stage-contract block must be gone
    expect(continuationForm).not.toContain("Stage contract");
    expect(continuationForm).not.toContain("You are running stage");
    // Output protocol must remain — this stage's output ports still need to be written
    expect(continuationForm).toContain("Output protocol");
    expect(continuationForm).toContain("write_port");
    expect(continuationForm).toContain("CRITICAL RULES");
    // Identity for this attempt (taskId/attemptId) also remains
    expect(continuationForm).toContain("t1");
    expect(continuationForm).toContain("a1");
  });

  it("non-continuation behaves identically to before (no flag)", () => {
    const a = buildSystemPromptAppend(stage, "x", {}, { taskId: "t1", attemptId: "a1" });
    const b = buildSystemPromptAppend(stage, "x", {}, { taskId: "t1", attemptId: "a1" }, null, undefined);
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 3: Run failing test**

```bash
cd apps/server && npx vitest run src/kernel-next/runtime/real-executor-prompt-builder.test.ts -t "continuationMode"
```
Expected: FAIL — `buildSystemPromptAppend` does not accept the options arg.

- [ ] **Step 4: Add `continuationMode` option to `buildSystemPromptAppend`**

In `real-executor-prompt-builder.ts`:

(a) Add a new optional parameter to the existing function signature:

```ts
export function buildSystemPromptAppend(
  stage: AgentStage,
  resolvedPrompt: string,
  inputs: Record<string, unknown>,
  ctx: { taskId: string; attemptId: string },
  migrationHint?: MigrationHint | null,
  ir?: PipelineIR,
  options?: { continuationMode?: boolean },  // NEW
): string {
```

(b) Inside the function body, after `inputDump` is computed (search the file for `const inputDump =` — keep the existing computation) and after `promptSummary` is computed (search for `const promptSummary =`), insert this early-return block. Place it **before** the existing full-form return statement (search for the current `return` that builds the full append):

```ts
  if (options?.continuationMode === true) {
    // Continuation form: drop the "you are running stage X" preamble +
    // the per-stage "Stage contract" overview (input/output port
    // listings), since the SDK has the segment's prior turns in
    // conversation history. Keep:
    //   - Inputs section (reads — auditability invariant per spec §4.2)
    //   - Task summary (this stage's instruction)
    //   - emptyInputsWarning + migrationNote (per-stage, may apply)
    //   - Output protocol + Identity + Required tool calls + CRITICAL
    //     RULES (output ports DIFFER per stage; SDK needs them every
    //     turn)
    return [
      "### Inputs",
      inputDump,
      "",
      "### Task",
      promptSummary,
      emptyInputsWarning,
      migrationNote,
      "",
      "### Output protocol (MANDATORY — read carefully)",
      "The ONLY way to emit output for this stage is to call the MCP tool",
      "  `mcp____kernel_next____write_port`",
      "exactly once per declared output port. The arguments are:",
      "  - taskId      (use the exact string provided below)",
      "  - attemptId   (use the exact string provided below)",
      "  - stage       (this stage's name)",
      "  - port        (one of the declared output port names)",
      "  - value       (the port value — a plain JSON value of the declared type)",
      "",
      "Identity for this attempt (use verbatim):",
      `  taskId    = "${ctx.taskId}"`,
      `  attemptId = "${ctx.attemptId}"`,
      `  stage     = "${stage.name}"`,
      "",
      "Required tool calls for this stage:",
      writeCallExamples || "  (none — this stage has no declared outputs)",
      "",
      "CRITICAL RULES",
      "1. The `value` argument is the RAW port value. For a port declared",
      "   `string`, pass a plain string literal — NOT a JSON-encoded envelope",
      "   like '{\"<port>\": \"...\"}'. For `number`, pass a bare number.",
      "2. Do NOT return a final JSON object in your text reply. The text reply",
      "   is discarded. Only write_port tool calls count.",
      "3. Do NOT call write_port more than once per port. Do NOT omit any",
      "   declared port — missing ports fail the stage.",
      "4. After every declared output port has been written, you may end your",
      "   turn with a short confirmation message (one sentence). The kernel",
      "   only inspects the tool calls.",
    ].join("\n");
  }
```

(c) Do NOT modify the existing full-form return statement. The function should now look like: param list (with new `options`) → existing prep code (inputPortLines, outputPortLines, promptSummary, inputSourceStage, inputDump, writeCallExamples, emptyInputsWarning, migrationNote) → NEW early-return block above → existing full-form return unchanged.

The continuation form keeps every block whose content **changes per stage** (Inputs, Task, output protocol with this stage's `writeCallExamples`, identity, CRITICAL RULES) and drops every block that is **identical or near-identical for every agent stage in the segment** (the "you are running stage X" preamble + the Stage contract overview). The output protocol stays because output port names differ per stage, and the SDK needs to know which ports to write for *this* turn.

Imports: `AgentStage` and `PipelineIR` are already imported per line 8 of this file (verified). No new imports needed.

- [ ] **Step 5: Run tests to verify pass**

```bash
cd apps/server && npx vitest run src/kernel-next/runtime/real-executor-prompt-builder.test.ts
```
Expected: All pass (including pre-existing tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/kernel-next/runtime/real-executor-prompt-builder.ts apps/server/src/kernel-next/runtime/real-executor-prompt-builder.test.ts
git commit -m "feat(prompt-builder): add continuationMode for single-session segments"
```

---

## Task 6: RealStageExecutor consumes `segmentContinuation`

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/real-executor.ts:325-375` (resume path) and `:418-422` (capture vars)

- [ ] **Step 1: Locate the SDK options assembly in real-executor.ts**

```bash
grep -n "options.resume\|resumeSessionId\|capturedSessionId\|effectiveMaxTurns" apps/server/src/kernel-next/runtime/real-executor.ts | head -20
```
Expected output around lines 325-375.

- [ ] **Step 2: Write failing test for segmentContinuation passthrough**

NOTE — Plan originally pointed at `real-executor.resume.test.ts`, but
that file is unit tests for pure helpers (`clampMaxTurns`, `parseNumTurnsFromStream`)
and lacks the queryFn harness. Append to `real-executor.test.ts` instead,
which already has `makeFakeStream`, `oneStageIR`, `makeDb`, and
`insertPipelineVersion` helpers used by integration-style executor tests.

Append to `apps/server/src/kernel-next/runtime/real-executor.test.ts`:

```ts
describe("real-executor: segmentContinuation", () => {
  it("uses segmentContinuation.resumeSessionId when present", async () => {
    // The test must verify two things by inspecting captured SDK options:
    //   1. options.resume === segmentContinuation.resumeSessionId
    //   2. continuation prompt is rendered (no persona block)
    // Re-use the existing fake-queryFn harness in this file's earlier
    // tests; pass segmentContinuation.priorNumTurns=4 and assert
    // effectiveMaxTurns is configured maxTurns minus 4 (clamped >= 1).
    const seenOptions: SdkOptions[] = [];
    const fakeQuery = ((args: unknown) => {
      seenOptions.push((args as { options: SdkOptions }).options);
      return mkAsyncIterableResult();
    }) as unknown as typeof query;
    const exec = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      maxTurns: 10,
      queryFn: fakeQuery,
      promptResolver: new TrivialPromptResolver(),
    });
    await exec.executeStage({
      ir: makeIR(),
      stageName: "s2",
      taskId: "t",
      versionHash: "h",
      portValues: {},
      handlers: {},
      portRuntime: makeFakePortRuntime(),
      segmentContinuation: {
        resumeSessionId: "sess-1",
        priorNumTurns: 4,
        priorAttempts: ["att-0"],
      },
    });
    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]?.resume).toBe("sess-1");
    expect(seenOptions[0]?.maxTurns).toBe(6); // 10 - 4
  });
});
```

(The existing test file already imports `SdkOptions`, `query`, `RealStageExecutor`, `mkAsyncIterableResult`, `makeIR`, `makeFakePortRuntime`, `TrivialPromptResolver`. If any are missing in the file, copy from the top of `real-executor.resume.test.ts` — do not invent.)

- [ ] **Step 3: Run failing test**

```bash
cd apps/server && npx vitest run src/kernel-next/runtime/real-executor.resume.test.ts -t "segmentContinuation"
```
Expected: FAIL.

- [ ] **Step 4: Wire `segmentContinuation` through real-executor.ts**

Find the block (≈line 325-375) where `effectiveMaxTurns` and `options` are computed:

```ts
const effectiveMaxTurns = args.resumeSessionId
  ? clampMaxTurns(this.maxTurns, args.priorNumTurns ?? 0)
  : this.maxTurns;
// ...
const options: SdkOptions = args.resumeSessionId
  ? { ...baseOptions, resume: args.resumeSessionId }
  : baseOptions;
```

Replace with:

```ts
// segmentContinuation takes precedence over per-stage resumeSessionId
// (segment-level conversation subsumes per-stage crash-recovery).
const sessionToResume = args.segmentContinuation?.resumeSessionId
  ?? args.resumeSessionId;
const turnsAlreadyUsed = args.segmentContinuation?.priorNumTurns
  ?? args.priorNumTurns
  ?? 0;
const effectiveMaxTurns = sessionToResume
  ? clampMaxTurns(this.maxTurns, turnsAlreadyUsed)
  : this.maxTurns;
// ...
const options: SdkOptions = sessionToResume
  ? { ...baseOptions, resume: sessionToResume }
  : baseOptions;
```

- [ ] **Step 5: Pass `continuationMode` to prompt builder**

Find the call site of `buildSystemPromptAppend` in real-executor.ts (single call, around the prompt-resolution path). Add the new options arg:

```ts
const systemPromptAppend = buildSystemPromptAppend(
  stage,
  resolvedPrompt,
  inputs,
  { taskId: args.taskId, attemptId },
  migrationHint,
  args.ir,
  { continuationMode: args.segmentContinuation !== undefined },
);
```

(The exact identifier names in the surrounding context — `stage`, `resolvedPrompt`, `inputs`, `attemptId`, `migrationHint` — should match what's already there. Do not rename them.)

- [ ] **Step 6: Run tests to verify pass**

```bash
cd apps/server && npx vitest run src/kernel-next/runtime/real-executor.resume.test.ts
```
Expected: all existing + new tests pass.

```bash
cd apps/server && npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/kernel-next/runtime/real-executor.ts apps/server/src/kernel-next/runtime/real-executor.resume.test.ts
git commit -m "feat(real-executor): consume segmentContinuation; pass continuationMode to prompt"
```

---

## Task 7: Runner segment lookup and plumbing

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/runner.ts:1039-1052` (executeStage call site) and `:1573-1595` (resumeFieldsForStage)
- Create: `apps/server/src/kernel-next/runtime/runner.single-session.test.ts`

- [ ] **Step 1: Plan the extension**

The runner today calls `executeStage` with `...resumeFieldsForStage(opts, stageName, taskId)`. Extension: also call a new helper `segmentContinuationFor(opts, ir, stageName, taskId, db, segments)` that returns either `undefined` (this stage is a segment-first stage) or `{ resumeSessionId, priorNumTurns, priorAttempts }`.

- [ ] **Step 2: Write a failing integration test**

Create `apps/server/src/kernel-next/runtime/runner.single-session.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runOnce, type RunnerOptions } from "./runner.js";
import { applyMigrations } from "../ir/sql.js";
import { MockStageExecutor } from "./mock-executor.js";
import { PipelineIRSchema } from "../ir/schema.js";

describe("runner: single-session segment plumbing", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  it("passes segmentContinuation to stage 2 of a single-mode 2-stage segment", async () => {
    const ir = PipelineIRSchema.parse({
      name: "p",
      session_mode: "single",
      stages: [
        { name: "a", type: "agent", inputs: [], outputs: [{ name: "x", type: "string" }], config: { promptRef: "p/r" } },
        { name: "b", type: "agent", inputs: [{ name: "x", type: "string" }], outputs: [], config: { promptRef: "p/r" } },
      ],
      wires: [{ from: { source: "stage", stage: "a", port: "x" }, to: { stage: "b", port: "x" } }],
    });

    const seenArgs: any[] = [];
    const executor = new MockStageExecutor({
      handlers: {
        a: async () => {
          // Simulate a session_id + num_turns persisted by writer.
          // Real-executor would do this via writer.updateSessionId; in
          // mock we insert directly to mimic the persistence side-effect.
          return { x: "a-out" };
        },
        b: async () => ({}),
      },
      onExecute: (args) => seenArgs.push({ stage: args.stageName, segCont: args.segmentContinuation }),
      // Mock executor must persist a session_id row for stage 'a' so
      // the runner's segment lookup can find it. Provide a hook to do
      // so via the test harness — see mock-executor.ts persistSessionId
      // option (add if missing as part of this task).
      persistSessionIdMap: { a: "sess-a" },
    });

    await runOnce({ ir, taskId: "t1", db, executor } as RunnerOptions);

    expect(seenArgs).toHaveLength(2);
    expect(seenArgs[0].segCont).toBeUndefined();
    expect(seenArgs[1].segCont).toBeDefined();
    expect(seenArgs[1].segCont.resumeSessionId).toBe("sess-a");
  });

  it("does NOT pass segmentContinuation when session_mode='multi'", async () => {
    const ir = PipelineIRSchema.parse({
      name: "p",
      // default session_mode: "multi"
      stages: [
        { name: "a", type: "agent", inputs: [], outputs: [{ name: "x", type: "string" }], config: { promptRef: "p/r" } },
        { name: "b", type: "agent", inputs: [{ name: "x", type: "string" }], outputs: [], config: { promptRef: "p/r" } },
      ],
      wires: [{ from: { source: "stage", stage: "a", port: "x" }, to: { stage: "b", port: "x" } }],
    });

    const seenArgs: any[] = [];
    const executor = new MockStageExecutor({
      handlers: { a: async () => ({ x: "a-out" }), b: async () => ({}) },
      onExecute: (args) => seenArgs.push(args.segmentContinuation),
      persistSessionIdMap: { a: "sess-a" },
    });

    await runOnce({ ir, taskId: "t2", db, executor } as RunnerOptions);

    expect(seenArgs[0]).toBeUndefined();
    expect(seenArgs[1]).toBeUndefined();
  });
});
```

(`MockStageExecutor.onExecute` and `.persistSessionIdMap` may not exist yet. If they don't, add them as part of this task before continuing — see Step 4.)

- [ ] **Step 3: Run failing test**

```bash
cd apps/server && npx vitest run src/kernel-next/runtime/runner.single-session.test.ts
```
Expected: FAIL — segmentContinuation is undefined on stage 2.

- [ ] **Step 4: Extend MockStageExecutor with `onExecute` + `persistSessionIdMap` (only if missing)**

Read `apps/server/src/kernel-next/runtime/mock-executor.ts`. If it does not already accept `onExecute(args)` callback and `persistSessionIdMap: Record<string, string>` — add them. The map should cause the executor to write a row to `agent_execution_details` with the given `session_id` for the corresponding stage. Use the existing `writer` integration if available; otherwise a direct `INSERT` statement is acceptable for test scaffolding.

- [ ] **Step 5: Implement `segmentContinuationFor` helper in runner.ts**

In `apps/server/src/kernel-next/runtime/runner.ts`, near the existing `resumeFieldsForStage` function, add:

```ts
import { planSegments } from "./segment-planner.js";

// Returns segmentContinuation for `stageName` if it is a non-first
// stage in an agent-only segment of the IR; otherwise undefined.
function segmentContinuationFor(
  opts: RunnerOptions,
  stageName: string,
  taskId: string,
  segments: string[][],
): { resumeSessionId: string; priorNumTurns: number; priorAttempts: string[] } | undefined {
  // Find the segment this stage belongs to.
  const seg = segments.find((s) => s.includes(stageName));
  if (!seg || seg.length < 2) return undefined;
  const idx = seg.indexOf(stageName);
  if (idx === 0) return undefined; // first stage of segment → fresh session

  // Look up session_id from the most recent successful attempt of the
  // segment's PREDECESSOR stage. Walking back stage-by-stage to find
  // the most recent persisted session_id handles the case where the
  // immediate predecessor's attempt failed (rare but possible).
  for (let i = idx - 1; i >= 0; i--) {
    const prevName = seg[i];
    const row = opts.db.prepare(
      `SELECT aed.session_id, aed.agent_stream_json, aed.attempt_id
         FROM agent_execution_details aed
         JOIN stage_attempts sa ON sa.attempt_id = aed.attempt_id
        WHERE sa.task_id = ? AND sa.stage_name = ? AND aed.session_id IS NOT NULL
        ORDER BY aed.started_at DESC
        LIMIT 1`,
    ).get(taskId, prevName) as
      | { session_id: string; agent_stream_json: string | null; attempt_id: string }
      | undefined;
    if (!row) continue;
    // Sum num_turns across all prior stages in the segment that have
    // a persisted attempt — segment-wide budget.
    let priorNumTurns = 0;
    const priorAttempts: string[] = [];
    for (let j = 0; j <= i; j++) {
      const pn = seg[j];
      const r2 = opts.db.prepare(
        `SELECT aed.agent_stream_json, aed.attempt_id
           FROM agent_execution_details aed
           JOIN stage_attempts sa ON sa.attempt_id = aed.attempt_id
          WHERE sa.task_id = ? AND sa.stage_name = ?
          ORDER BY aed.started_at DESC
          LIMIT 1`,
      ).get(taskId, pn) as { agent_stream_json: string | null; attempt_id: string } | undefined;
      if (!r2) continue;
      priorAttempts.push(r2.attempt_id);
      priorNumTurns += parseNumTurnsFromStream(r2.agent_stream_json ?? null);
    }
    return {
      resumeSessionId: row.session_id,
      priorNumTurns,
      priorAttempts,
    };
  }
  return undefined;
}
```

(`parseNumTurnsFromStream` is already exported from `real-executor.ts` per line 165 of that file — import it at the top of runner.ts.)

- [ ] **Step 6: Plumb segments + segmentContinuation into the executeStageLogic block**

Near the top of the `runOnce` function (where `opts.ir` and `dispatcher` are set up), compute segments once:

```ts
const segments = planSegments(opts.ir);
```

In the `executeStageLogic = fromCallback(...)` block (around line 1042), change the executor call:

```ts
const result = await executor.executeStage({
  ir: opts.ir,
  stageName: input.stageName,
  taskId: input.taskId,
  versionHash,
  portValues: input.portValues,
  handlers: opts.handlers,
  portRuntime,
  signal: ac.signal,
  ...resumeForThisStage,
  segmentContinuation: segmentContinuationFor(opts, input.stageName, input.taskId, segments),
});
```

- [ ] **Step 7: Run test to verify pass**

```bash
cd apps/server && npx vitest run src/kernel-next/runtime/runner.single-session.test.ts
```
Expected: All pass.

```bash
cd apps/server && npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 8: Run full runtime test suite for regression**

```bash
cd apps/server && npx vitest run src/kernel-next/runtime/
```
Expected: All pre-existing tests still pass.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/kernel-next/runtime/runner.ts apps/server/src/kernel-next/runtime/runner.single-session.test.ts apps/server/src/kernel-next/runtime/mock-executor.ts
git commit -m "feat(runner): plumb segmentContinuation through executor for single-session"
```

---

## Task 8: Migrate `smoke-test` to single mode (min canary)

**Files:**
- Modify: `apps/server/src/builtin-pipelines/smoke-test/pipeline.ir.json`
- Possibly modify: `apps/server/src/builtin-pipelines/smoke-test/prompts/...`
- Modify: `apps/server/src/kernel-next/runtime/smoke-test.linear-two-stage.test.ts`

- [ ] **Step 1: Read current smoke-test pipeline + prompts**

```bash
cat apps/server/src/builtin-pipelines/smoke-test/pipeline.ir.json
ls apps/server/src/builtin-pipelines/smoke-test/prompts/
```
Note the structure and the `echoBack` stage's `promptRef`.

- [ ] **Step 2: Inspect existing test harness in smoke-test.linear-two-stage.test.ts**

```bash
sed -n '1,50p' apps/server/src/kernel-next/runtime/smoke-test.linear-two-stage.test.ts
```
Note: which loader is used to read the smoke-test IR (likely `loadBuiltinPipeline` from `./load-builtin-pipeline.js`); how the runner is invoked; what DB harness is in place.

- [ ] **Step 3: Write failing test asserting smoke-test runs as single segment**

Append to `apps/server/src/kernel-next/runtime/smoke-test.linear-two-stage.test.ts`:

```ts
it("smoke-test runs greet+echoBack as one segment with shared session_id", async () => {
  // Reuse whatever loader the file uses for the smoke-test IR. Example
  // (adjust to actual import name found in Step 2):
  const ir = loadBuiltinPipeline("smoke-test");
  expect(ir.session_mode).toBe("single");

  // Use the same MockStageExecutor harness as runner.single-session.test.ts;
  // make stage 'greet' persist a fixed session_id so the runner can
  // pick it up for stage 'echoBack' via segmentContinuationFor.
  const seenContinuation: any[] = [];
  const executor = new MockStageExecutor({
    handlers: {
      greet: async () => ({ greeting: "hello" }),
      echoBack: async () => ({}),
    },
    onExecute: (args) => seenContinuation.push({
      stage: args.stageName, segCont: args.segmentContinuation,
    }),
    persistSessionIdMap: { greet: "smoke-sess" },
  });

  await runOnce({ ir, taskId: "smoke-1", db, executor } as RunnerOptions);

  expect(seenContinuation).toHaveLength(2);
  expect(seenContinuation[0].segCont).toBeUndefined();
  expect(seenContinuation[1].segCont?.resumeSessionId).toBe("smoke-sess");
});
```

- [ ] **Step 4: Run failing test**

```bash
cd apps/server && npx vitest run src/kernel-next/runtime/smoke-test.linear-two-stage.test.ts
```
Expected: FAIL — `ir.session_mode` is "multi" (default).

- [ ] **Step 5: Add `session_mode: "single"` to smoke-test pipeline.ir.json**

Edit `apps/server/src/builtin-pipelines/smoke-test/pipeline.ir.json`. Add the field at the top level alphabetically (after `name`, before `stages` or wherever the canonical sort order places it):

```json
{
  "name": "smoke-test",
  "session_mode": "single",
  "stages": [...]
}
```

- [ ] **Step 6: Inspect echoBack prompt; rewrite to continuation if needed**

Open the prompt file referenced by echoBack's `promptRef`. If it contains a "you are an echo bot" persona, drop it. Keep only the task-instruction line (e.g., "Repeat back the previous message verbatim, prepended with EOI:"). The full reads-section is auto-injected by the prompt builder, so the prompt itself can be a single sentence.

- [ ] **Step 7: Run test to verify pass**

```bash
cd apps/server && npx vitest run src/kernel-next/runtime/smoke-test.linear-two-stage.test.ts
```
Expected: All pass.

- [ ] **Step 8: Verify version_hash changed (sanity check)**

```bash
cd apps/server && npx vitest run src/kernel-next/ir/canonical.test.ts
```
Expected: All pass (no regression — this verifies session_mode flows through canonicalize).

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/builtin-pipelines/smoke-test/ apps/server/src/kernel-next/runtime/smoke-test.linear-two-stage.test.ts
git commit -m "feat(smoke-test): migrate to session_mode=single (min canary)"
```

---

## Task 9: Migrate `pr-description-generator` to single mode (prod canary)

**Files:**
- Modify: `apps/server/src/builtin-pipelines/pr-description-generator/pipeline.ir.json`
- Modify: `apps/server/src/builtin-pipelines/pr-description-generator/prompts/<writePr-prompt-file>.md`

- [ ] **Step 1: Inspect pipeline.ir.json and writePr prompt**

```bash
cat apps/server/src/builtin-pipelines/pr-description-generator/pipeline.ir.json
ls apps/server/src/builtin-pipelines/pr-description-generator/prompts/
```
Note the `writePr` stage's `promptRef`.

- [ ] **Step 2: Add `session_mode: "single"` to pipeline.ir.json**

```json
{
  "name": "pr-description-generator",
  "session_mode": "single",
  "stages": [...]
}
```

- [ ] **Step 3: Rewrite `writePr` prompt to continuation form**

Open the prompt file. Drop:
- Any "You are a PR description writer" / persona block (covered by `fetchDiff`'s context already in conversation history)
- Any restatement of "the input is a git diff" (already in reads-section)

Keep:
- The actual instruction: "Now produce the PR description for the diff above. Use this format: ..."
- The output format spec (markdown headers, bullet style, etc.)
- The reads-section is auto-injected by the prompt builder — do NOT manually duplicate it.

The resulting prompt should be 5-10 lines. If it's longer, persona is leaking; cut.

- [ ] **Step 4: Run a manual end-to-end smoke**

```bash
# From repo root:
cd apps/server && npm run dev
```

In another terminal, trigger the pipeline (use the dashboard or MCP `run_pipeline` tool with a real PR diff input). Inspect the resulting `agent_execution_details` rows:

```bash
sqlite3 ~/.local/share/workflow-control/kernel-next.db \
  "SELECT stage_name, session_id, token_input, cache_read_input_tokens FROM agent_execution_details JOIN stage_attempts USING(attempt_id) WHERE task_id = '<task-id>' ORDER BY started_at;"
```

Expected:
- Both rows have the same `session_id`
- `cache_read_input_tokens` on the second row (writePr) is non-zero — proves the SDK is hitting prompt cache on the resumed conversation
- `token_input` on the second row is significantly less than what stage 1 sent (most input is in the resumed history, not in the new turn's prompt)

- [ ] **Step 5: Stop dev server**

Kill the `npm run dev` process. (The user is fine with you killing dev processes — see CLAUDE.md context.)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/builtin-pipelines/pr-description-generator/
git commit -m "feat(pr-description-generator): migrate to session_mode=single (prod canary)"
```

---

## Task 10: pipeline-generator prompt update (§6.4)

**Files:**
- Modify: `apps/server/src/builtin-pipelines/pipeline-generator/prompts/<system-prompt-file>.md` (find via the IR's promptRef for the analyzing/genSkeleton stages)

This is a prompt-only change — no code changes, no tests beyond verifying the IR still loads.

- [ ] **Step 1: Locate pipeline-generator's IR-authoring system prompt**

```bash
grep -r "promptRef" apps/server/src/builtin-pipelines/pipeline-generator/pipeline.ir.json
ls apps/server/src/builtin-pipelines/pipeline-generator/prompts/
```
Note: which prompt file the agent stage that emits the IR uses (typically `genSkeleton` or similar). Open it.

- [ ] **Step 2: Append new section to that prompt file**

Append (do not replace any existing content):

```markdown
## Choosing session_mode

Pipelines may declare a top-level `session_mode: "multi" | "single"`.
Default is `"multi"`. Choose `"single"` ONLY when the pipeline meets
all of:

- Two or more consecutive `agent` stages with no `script` or `gate` in
  between, AND
- Each downstream agent stage interprets / refines / extends the prior
  stage's output (not just consumes it as a typed value), AND
- No `fanout` declared on any stage in that consecutive chain.

Examples that should be `single`:
- explore -> propose -> refine
- fetch_diff -> write_pr_description
- gather_context -> draft_response

Examples that should stay `multi`:
- Single-agent-stage pipelines (mode is irrelevant)
- Pipelines whose agent stages are separated by gates or scripts
  (segment-1 anyway)
- Pipelines where each agent stage is an independent, idempotent
  transformation over its inputs

When `session_mode: "single"` is chosen, the AI MUST emit prompts in
**continuation form** for every non-first agent stage in each
agent-only segment:
- DO drop persona blocks ("You are a..."), output-port overviews, and
  full task restatements. The SDK already saw these in the segment's
  first stage.
- KEEP the actual instruction for this turn ("Now produce X based on
  the prior output").
- DO NOT manually inject the reads-section — the prompt-builder does
  it automatically.

When uncertain, default to `multi`. Choosing `single` requires
explicit reasoning in the plan output so the human reviewer can
sanity-check.
```

- [ ] **Step 3: Verify IR still loads**

```bash
cd apps/server && npx vitest run src/kernel-next/runtime/load-builtin-pipeline.test.ts
```
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/builtin-pipelines/pipeline-generator/prompts/
git commit -m "feat(pipeline-generator): teach session_mode + continuation prompts (§6.4)"
```

---

## Task 11: Optional — `v_segment_continuity` SQL view

**Files:**
- Modify: `apps/server/src/kernel-next/ir/sql.ts`
- Modify: `apps/server/src/kernel-next/ir/sql.test.ts` (if test for views exists)

- [ ] **Step 1: Locate end of CREATE TABLE block in sql.ts**

```bash
grep -n "CREATE INDEX\|CREATE VIEW" apps/server/src/kernel-next/ir/sql.ts | tail -5
```
Place the new view after the last CREATE INDEX statement, before any closing template literal delimiter.

- [ ] **Step 2: Add view definition**

In `apps/server/src/kernel-next/ir/sql.ts`, append to the migration SQL:

```sql
-- v_segment_continuity: surface single-session segment metadata for
-- observability. Each row is one segment (session_id) of one task,
-- showing the chain of stages, total input tokens, and cache stats.
-- Excludes size-1 segments (which are equivalent to multi mode).
CREATE VIEW IF NOT EXISTS v_segment_continuity AS
SELECT
  sa.task_id,
  aed.session_id,
  COUNT(*)                          AS stages_in_segment,
  GROUP_CONCAT(sa.stage_name, '->') AS stage_path,
  SUM(aed.token_input)              AS segment_input_tokens,
  SUM(aed.cache_read_input_tokens)  AS segment_cache_reads,
  SUM(aed.cache_creation_input_tokens) AS segment_cache_creates
FROM agent_execution_details aed
JOIN stage_attempts sa ON sa.attempt_id = aed.attempt_id
WHERE aed.session_id IS NOT NULL
GROUP BY sa.task_id, aed.session_id
HAVING COUNT(*) > 1;
```

- [ ] **Step 3: Run sql migration tests**

```bash
cd apps/server && npx vitest run src/kernel-next/ir/sql.test.ts
```
Expected: All pre-existing pass; if a test asserts schema fingerprint, update it to include the new view.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/kernel-next/ir/sql.ts apps/server/src/kernel-next/ir/sql.test.ts
git commit -m "feat(observability): add v_segment_continuity SQL view"
```

---

## Task 12: Roadmap update — close §4 line 105

**Files:**
- Modify: `docs/product-roadmap.md:105`
- Modify: `docs/product-roadmap.md` (revision history section)

- [ ] **Step 1: Update line 105**

In `docs/product-roadmap.md`, find the line:

```
| Single-session 模式 | **TODO / 决策 open — deferred 2026-04-25** | ...
```

Replace with:

```
| Single-session 模式 | **已落地 2026-04-25** | Hybrid I+II 实现：agent-only 段单 SDK query + 段间 session_id resume；per-pipeline `session_mode: "single"\|"multi"` 声明；`smoke-test` 与 `pr-description-generator` 已切 single canary。详见 `docs/superpowers/specs/2026-04-25-single-session-mode-design.md` 与 `docs/superpowers/plans/2026-04-25-single-session-mode.md` |
```

- [ ] **Step 2: Add revision history entry**

Find the §修订历史 section. Add a new top entry:

```
- 1.20 (2026-04-25): single-session mode 落地（spec + plan + 实现 + 2 个 builtin canary）。§4 line 105 关闭。
```

- [ ] **Step 3: Commit**

```bash
git add docs/product-roadmap.md
git commit -m "docs(roadmap): close §4 line 105 — single-session mode shipped"
```

---

## Final verification

After all tasks:

- [ ] **Run full server test suite**

```bash
cd apps/server && npx vitest run
```
Expected: All pass.

- [ ] **Type-check**

```bash
cd apps/server && npx tsc --noEmit
```
Expected: No errors.

- [ ] **Lint**

```bash
cd apps/server && npx eslint . --quiet
```
Expected: No errors. (If lint not configured, skip.)

- [ ] **Git log review**

```bash
git log --oneline -15
```
Expected: 12 well-scoped commits matching the task numbering above.
