# Pipeline-Generator Emits IR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite pipeline-generator so its product is a kernel-next IR+prompts bundle submitted via `submit_pipeline` MCP, not a YAML file on disk.

**Architecture:** Restructure `builtin-pipelines/pipeline-generator/pipeline.yaml` (serialize genSkeleton→genPrompts, drop parallel block, drop refinePrompts, change persisting type from script to agent). Rewrite system prompts to teach kernel-next IR vocabulary. Delete `persist-pipeline.ts` script. Retain converter-compatibility by staying within the legacy YAML subset already covered.

**Tech Stack:** YAML, Markdown (prompts), TypeScript, Vitest, Claude Agent SDK (for real E2E).

**Spec:** `docs/superpowers/specs/2026-04-24-pipeline-generator-emit-ir-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml` | New store_schema (skeletonResult / promptBundle / persistResult), new stages (drop refinePrompts, serialize gen*), persisting type=agent |
| Rewrite | `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md` | Teach kernel-next vocabulary (3 primitives + ports + wires + guards + fanout + run_pipeline) and emit new stageContracts shape |
| Rewrite | `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/gen-skeleton.md` | Translate stageContracts → {ir, subIrs} emitted via write_port |
| Rewrite | `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/gen-prompts.md` | Produce {prompts, subPrompts} as Record<string,string> entries via write_port, with prompt-writer sub-agent |
| Create | `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/persist.md` | Drive persisting agent: submit subIrs in order, submit main IR, verify run_pipeline name references, write_port persistResult |
| Delete | `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/refine-prompts.md` | Obsolete |
| Delete | `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/report-generator.md` | Obsolete orphan |
| Delete | `apps/server/src/scripts/persist-pipeline.ts` | Obsolete — persisting is now agent |
| Delete | `apps/server/src/scripts/persist-pipeline.test.ts` | Obsolete |
| Delete | `apps/server/src/scripts/persist-pipeline.adversarial.test.ts` | Obsolete |
| Modify | `apps/server/src/scripts/index.ts` | Remove persist_pipeline registration |
| Modify | `apps/server/src/kernel-next/converter/pipeline-generator.test.ts` | Update conversion expectations for new shape |

---

## Sequencing Rationale

Changes come in **three groups** ordered to keep the system runnable at each boundary:

- **Group A (Tasks 1-3)**: structural YAML changes + converter test updates. At the end: pipeline-generator YAML still converts cleanly, registers via `registerLegacyPipeline` without errors, but stage prompts are the old ones — running it would produce a design using kernel-next vocab is impossible (old prompts still teach YAML). That's OK because Group B immediately follows.
- **Group B (Tasks 4-7)**: prompt rewrites (analysis, gen-skeleton, gen-prompts, persist). At the end: pipeline-generator is fully functional under the new design.
- **Group C (Tasks 8-10)**: deletions + cleanup (persist-pipeline.ts, orphan prompts, scripts/index.ts). At the end: legacy authoring path fully removed.

Each task commits independently. After Group A alone, tests stay green (old prompts + new schema is internally inconsistent but conversion + registration pass). After Group B, E2E works. Group C is pure deletion, no functional change.

---

## Task 1: Update pipeline.yaml store_schema + stages

**Files:**
- Modify: `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml`

- [ ] **Step 1: Read the existing file**

Run: `cat /Users/minghao/workflow-control/apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml | head -200`

Note: record the exact field names and section ordering used so the rewrite preserves YAML style.

- [ ] **Step 2: Rewrite the YAML**

Replace the entire file with:

```yaml
name: Pipeline Generator
description: Generate high-quality kernel-next pipelines from natural language descriptions. Analyzes requirements, designs the architecture, produces IR + prompts, and submits to the kernel.
engine: claude
official: true
use_cases:
  - Create new workflow pipelines from descriptions
  - Generate kernel-next pipeline configurations for recurring tasks
  - Bootstrap pipeline prototypes for iteration

external_inputs:
  taskDescription:
    type: string
    description: Natural language description of the pipeline to generate.
    required: true

display:
  title_path: pipelineDesign.pipelineName
  completion_summary_path: persistResult.pipelineId

store_schema:
  pipelineDesign:
    produced_by: analyzing
    description: Pipeline Design
    fields:
      pipelineName:
        type: string
        description: Human-readable pipeline name
        required: true
      pipelineId:
        type: string
        description: Directory-safe pipeline ID (kebab-case)
        required: true
      description:
        type: string
        description: Pipeline description
        required: true
      stageDesign:
        type: markdown
        description: Detailed stage-by-stage design with data flow
        required: true
      dataFlowSummary:
        type: markdown
        description: Port/wire flow diagram
      useCases:
        type: string[]
        description: Target use cases
      estimatedStageCount:
        type: number
        description: Total stage count (including sub-pipeline stages)
      usesFanout:
        type: boolean
        description: Whether any stage declares fanout
      usesSubPipelines:
        type: boolean
        description: Whether any stage invokes run_pipeline (sub-pipeline recursion)
      recommendedMcps:
        type: string[]
        description: MCP server names discovered via PulseMCP that should be used in the pipeline
      recommendedSkills:
        type: string[]
        description: Skill names discovered externally that should be used in the pipeline
      targetRepoName:
        type: string
        description: Repository name extracted from task description (empty string if not specified)
      assumptions:
        type: string[]
        description: Assumptions made when user input was ambiguous (shown to user at confirmation gate)
      stageContracts:
        type: object[]
        description: >
          Semantic contract per stage. Each entry has shape
          { name, type ("agent"|"script"|"gate"), purpose, reads?, writes?,
            fanout?, budget?, gateRouting? }. This is the authoritative
          design source consumed by genSkeleton and genPrompts. See spec §5.2.
        required: true
      subPipelineContracts:
        type: object[]
        description: >
          Per-sub-pipeline semantic contract. Each entry has shape
          { name, purpose, externalInputs, returnContract, calledBy }.
          Empty when no sub-pipeline is needed.
      summary:
        type: markdown
        description: Design summary for user review at awaitingConfirm gate
        required: true
  skeletonResult:
    produced_by: genSkeleton
    description: Kernel-next IR Skeleton
    fields:
      ir:
        type: object
        description: Main pipeline IR (kernel-next PipelineIR JSON)
        required: true
      subIrs:
        type: object[]
        description: Sub-pipeline IRs (one per subPipelineContracts entry; may be empty). Each is a full PipelineIR JSON.
  promptBundle:
    produced_by: genPrompts
    description: Prompt Bundle
    fields:
      prompts:
        type: object
        description: promptRef → content map for the main IR's agent stages and fragments
        required: true
      subPrompts:
        type: object[]
        description: Index-aligned with subIrs; each entry is a promptRef → content map for that sub-pipeline's agent stages
  persistResult:
    produced_by: persisting
    description: Persistence Result
    fields:
      versionHash:
        type: string
        description: Main pipeline's versionHash after submit_pipeline
        required: true
      subVersionHashes:
        type: string[]
        description: Sub-pipeline versionHashes, aligned with subIrs
      pipelineId:
        type: string
        description: Pipeline directory-safe ID (kebab-case of pipelineName)
        required: true
      pipelineName:
        type: string
        description: Human-readable pipeline name
        required: true

stages:
  - name: analyzing
    type: agent
    interactive: true
    thinking:
      type: enabled
    mcps:
      - pulsemcp
    runtime:
      engine: llm
      system_prompt: analysis
      reads:
        description: taskDescription
    effort: high
    max_turns: 50
    max_budget_usd: 4

  - name: awaitingConfirm
    type: human_confirm
    runtime:
      engine: human_gate
      on_reject_to: analyzing

  - name: genSkeleton
    type: agent
    thinking:
      type: enabled
    runtime:
      engine: llm
      system_prompt: gen-skeleton
      reads:
        design: pipelineDesign
    effort: high
    max_turns: 60
    max_budget_usd: 5

  - name: genPrompts
    type: agent
    runtime:
      engine: llm
      system_prompt: gen-prompts
      reads:
        design: pipelineDesign
        skeleton: skeletonResult
      agents:
        prompt-writer:
          description: Generates a single system prompt for one kernel-next agent stage.
          prompt: >
            You write system prompts for workflow-control kernel-next agent stages.
            Given a stage specification (name, inputs ports, outputs ports, purpose,
            budget, whether it invokes run_pipeline), produce a high-quality system
            prompt in markdown.


            Required structure: role definition (1-2 sentences), Available Inputs
            section listing each input port with its type and meaning, step-by-step
            Workflow with action verbs, explicit write_port calls for each output
            port using literal syntax, and Error Handling section with concrete
            fallbacks.


            Critical rules:

            - 30-80 lines per prompt. Under 30 is too vague, over 80 dilutes attention.

            - Do NOT include a JSON output schema section — writes go through
            write_port MCP tool calls, which the prompt must show literal examples of.

            - If the stage invokes a sub-pipeline, include explicit run_pipeline
            instructions with the exact sub-pipeline name and input shape.

            - Use specific roles ("security auditor scanning OWASP vulnerabilities")
            not generic ones ("AI assistant").

            - Do not fabricate output ports that are not declared in the stage
            spec.
          tools:
            - Read
            - Write
          model: sonnet
          maxTurns: 20
    effort: high
    max_turns: 80
    max_budget_usd: 8

  - name: persisting
    type: agent
    runtime:
      engine: llm
      system_prompt: persist
      reads:
        skeleton: skeletonResult
        promptBundle: promptBundle
        design: pipelineDesign
    max_turns: 20
    max_budget_usd: 2
```

Note: The `persisting` stage intentionally has **no** `mcps` or `agents` block — kernel-next's external MCP surface (which includes `submit_pipeline`) is always available to agents. Same for `write_port` on the internal surface.

- [ ] **Step 3: Run converter sanity check**

Run:
```
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsx -e '
import { loadLegacyPipelineIR } from "./src/kernel-next/runtime/load-legacy-pipeline.js";
const r = loadLegacyPipelineIR("pipeline-generator");
console.log("stages:", r.ir.stages.map(s => s.name).join(", "));
console.log("externalInputs:", r.ir.externalInputs?.map(p => p.name).join(", "));
console.log("wires count:", r.ir.wires.length);
'
```

Expected output should show:
- stages: `analyzing, awaitingConfirm, genSkeleton, genPrompts, persisting`
- externalInputs: `taskDescription`
- wires count > 0 (exact count depends on converter; record what you see)

If conversion fails, STOP — it means converter does not handle the new shape. Report to user.

- [ ] **Step 4: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml && git commit -m "feat(pg): restructure pipeline.yaml — serialize gen stages, persisting is agent"
```

---

## Task 2: Update converter pipeline-generator test

**Files:**
- Modify: `apps/server/src/kernel-next/converter/pipeline-generator.test.ts`

- [ ] **Step 1: Read the existing test**

Run: `cat /Users/minghao/workflow-control/apps/server/src/kernel-next/converter/pipeline-generator.test.ts`

Note: the test asserts things about the converted IR shape. These assertions likely reference old stages (`refinePrompts`, parallel block `generating`, script `persisting`).

- [ ] **Step 2: Run the test to see what breaks**

Run:
```
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/converter/pipeline-generator.test.ts
```

Capture the failure output. The test suite likely asserts:
- Old stage names present → now some are gone
- Old parallel group structure → now flattened
- `persisting` was `script` → now `agent`

- [ ] **Step 3: Update assertions**

For every failing assertion, update it to match the new YAML structure:
- Expected stage list: `["analyzing", "awaitingConfirm", "genSkeleton", "genPrompts", "persisting"]`
- `persisting` stage type is `"agent"` (was `"script"`)
- No `refinePrompts` stage
- No parallel block named `generating`
- `awaitingConfirm.config.routing.routes.approve` should be `"genSkeleton"` (not an array pointing to a parallel group)
- `awaitingConfirm.config.routing.routes.reject` should be `"analyzing"`

Keep assertion strength — do NOT weaken checks. If a test asserted "gate routing targets a parallel block", update to "gate routing targets genSkeleton". Do not delete the assertion entirely.

If a golden versionHash fixture exists in the test, delete the golden and replace with a shape-based assertion (stage names / types / wire counts), OR record the new hash as the new baseline IF the test explicitly wants to lock the hash.

- [ ] **Step 4: Run the test to verify pass**

Run:
```
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/converter/pipeline-generator.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Full converter suite regression**

Run:
```
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/converter
```

Expected: all PASS. If any other converter test fails because it shared a golden with pipeline-generator, update that test too (in-scope).

- [ ] **Step 6: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/converter/pipeline-generator.test.ts && git commit -m "test(converter): update pipeline-generator shape assertions"
```

---

## Task 3: Verify pipeline-generator module-load still works

**Files:**
- No file changes; verification-only task.

- [ ] **Step 1: Run kernel-run registration test**

Run:
```
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/routes/kernel-run.test.ts
```

Expected: all PASS. Of particular interest: `registerLegacyPipeline populates pipeline_prompt_refs on module load` test (added in Task 10 of prompts-in-sqlite). It asserts that pipeline-generator's prompts table has entries. Since YAML structure changed but prompt files haven't (old prompts still on disk), this should still pass.

If the test fails because `PROMPT_REF_MISSING` fires (the new YAML references `persist` promptRef but no `persist.md` file exists yet), STOP. The fix is to add `persist.md` in Task 7, but Task 3 is a checkpoint — we accept that kernel-run tests may fail here temporarily. Record the exact failure and continue to Task 4.

Actually, re-check: task 1 added `persisting` with `system_prompt: persist`. If `persist.md` does not exist, converter will fail during load because the stage references a promptRef that doesn't resolve. This will break Task 1's Step 3 sanity check too.

Decision: **add an empty stub `persist.md` as part of Task 1** to keep things convertible at this boundary. It will be replaced in Task 7. Verify this:

Check:
```
ls /Users/minghao/workflow-control/apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/persist.md 2>/dev/null
```

If the file does not exist, create it with:
```
# Persist (placeholder — will be rewritten in Task 7)
```

and commit:
```bash
cd /Users/minghao/workflow-control && git add apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/persist.md && git commit -m "chore(pg): placeholder persist.md prompt to keep YAML convertible"
```

- [ ] **Step 2: Run the full kernel-next suite**

Run:
```
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next src/routes
```

Expected: all PASS. Kernel-run test should show pipeline-generator has prompt_refs entries after module load.

- [ ] **Step 3: Type check**

Run:
```
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: No commit (verification-only)**

Move to Task 4.

---

## Task 4: Rewrite `analysis.md` prompt

**Files:**
- Rewrite: `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md`

- [ ] **Step 1: Read the current analysis prompt**

Run: `cat /Users/minghao/workflow-control/apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md`

Capture its overall structure (role / workflow / examples / rules / output).

- [ ] **Step 2: Rewrite the prompt to teach kernel-next vocabulary**

Replace the entire file with the following content. This prompt teaches 3 primitives + ports + wires + guards + fanout + run_pipeline, and instructs `analyzing` to produce `stageContracts` and `subPipelineContracts` in the new shape (§5.2, §5.3 of the spec):

```markdown
# Pipeline Design Analysis (kernel-next)

You are a senior workflow architect designing a kernel-next pipeline from a natural language task description. Your output is the authoritative semantic design that downstream stages (`genSkeleton`, `genPrompts`, `persisting`) translate into an executable kernel-next IR.

## kernel-next primer

Kernel-next has **three stage primitives**:

1. **`agent`** — an LLM-driven stage running on Claude. It reads input ports, runs a Claude SDK session, makes tool calls (including MCPs), and emits output ports via `write_port` MCP calls.
2. **`script`** — a deterministic TypeScript module (no LLM). Kernel-next currently has no user-authored scripts in scope; **do not propose new script stages** unless the task is built around an existing known script. For this pipeline-generator's outputs, assume agent-only unless the user explicitly demands deterministic processing.
3. **`gate`** — pauses the pipeline, poses a question, waits for an answer (from main Claude, user, or an AI). Routes execution based on answer.

Data flows through **typed ports** (each stage declares input/output port names with TypeScript type literals like `string`, `string[]`, `{ url: string, title: string }`). Ports are connected by **wires** (source.stage.port → target.stage.port). Wires may carry a `guard` expression evaluated against the source port's value (e.g. `value.complexity > 8`). Guards replace the legacy `condition` stage.

A stage may declare **`fanout: { input: <portName> }`** — kernel reads that input as an array and instantiates N virtual stage instances (one per element), parallelizable. This replaces legacy `foreach`.

Sub-pipelines are invoked via **`run_pipeline` MCP tool** from within an agent stage's prompt (no dedicated stage type). This replaces legacy `pipeline` type.

**Gates** replace both legacy `human_confirm` and `llm_decision` — the answerer is decided at runtime. You do not specify who answers; you only specify the question text and the answer→stage routing.

## When to choose each primitive

| Need | Primitive |
|------|-----------|
| AI decides / reasons / produces content | `agent` |
| Pause for review / approval / decision | `gate` |
| Branch on existing data (A or B depending on value) | wire with `guard` — NOT a gate, NOT a condition stage |
| Iterate over list of items | stage with `fanout: { input: <listPort> }` |
| Recursively invoke another pipeline | `agent` stage whose prompt calls `run_pipeline` MCP |

Do NOT propose legacy concepts. You are not designing YAML with condition/foreach/pipeline stage types.

## Your task

1. Read `taskDescription` to understand the user's goal.
2. Identify the minimum set of stages needed. Favor fewer stages — each extra stage costs tokens + latency.
3. Design data flow. For each stage, know what it reads (inputs) and what it writes (outputs).
4. Identify branching: does execution split conditionally? If so, where are the guard predicates?
5. Identify iteration: is there a list-over-items pattern? If so, which stage fans out over which port?
6. Identify recursion: do you need a sub-pipeline? If so, give it a name and document its contract.
7. (Optional) Search PulseMCP for relevant tools if the task benefits from specific MCPs.
8. Write a `stageDesign` (markdown) walking through the stages in execution order. Include branching / fanout / recursion in prose.
9. Produce the structured `stageContracts` + optional `subPipelineContracts` (§ output schema below).

## Available inputs

- `description: string` — the user's task description (via `reads: { description: taskDescription }`).

## Available tools

- PulseMCP (`mcps: [pulsemcp]`) — discover MCP servers relevant to the task.
- User interaction (`interactive: true`) — you may ask clarifying questions via `AskUserQuestion` when the description is ambiguous. Record your assumptions in `assumptions` for later user review at `awaitingConfirm` gate.

## Workflow

1. **Parse the description.** Pull out target repository, subject matter, expected output format, human-gate requirements, budget sensitivity.
2. **Decide pipeline shape.** Linear? Branching on input classification? Iterative over a list? Recursive via sub-pipeline?
3. **Name and contract each stage.** For each stage, produce one `StageContract`:
   - `name`: camelCase
   - `type`: "agent" | "script" | "gate"
   - `purpose`: 1-2 sentences
   - `reads`: `Record<string, string>` — input label → source. Source format: `"stageName.portName"` OR `"stageName"` (whole stage) OR `"externalInputs.portName"`.
   - `writes`: `Record<string, string>` — output port name → TS type literal (e.g. `"string"`, `"string[]"`, `"{ url: string, title: string }[]"`).
   - `fanout` (optional): `{ input: <inputPortName> }` if this stage iterates over that input port.
   - `budget` (optional): `{ maxTurns?: number, maxBudgetUsd?: number }` if this stage needs more than defaults.
   - `gateRouting` (for `type: "gate"` only): `Record<string, string>` — answer value → target stage name. Must include "reject" → <upstream stage> if the gate is a review gate.
4. **For each sub-pipeline needed**, produce one `SubPipelineContract`:
   - `name`: the exact name the main IR's agent will use in `run_pipeline(name=...)`
   - `purpose`: 1-2 sentences
   - `externalInputs`: `Record<string, string>` — input port name → TS type
   - `returnContract`: `Record<string, string>` — output port name → TS type (what main caller reads back)
   - `calledBy`: name of the main IR stage that invokes it
5. **Write `stageDesign` (markdown)**: walk through stages in execution order, noting data flow and control flow (guards, fanout, recursion).
6. **Write `summary` (markdown)**: the high-level overview shown to the user at `awaitingConfirm` gate for review.

## Rules

- **Gates for human/AI review only.** Do not use gates for conditional branching — use wire guards.
- **Guards are expressions over a single source port's value.** Design routes so the guard target port carries the routing signal directly. If no such port exists in your design, introduce an earlier stage whose output IS that signal.
- **No reserved identifiers.** Stage names and port names must be valid JS identifiers; avoid reserved words like `class`, `function`, `default`, `new`, etc.
- **Every AgentStage must have at least one output port** so downstream wires have something to consume.
- **Wire exhaustiveness.** If a stage has multiple inbound wires with guards, at least one guard must evaluate true at runtime; otherwise kernel fails with NO_ACTIVE_WIRE. Design guards to cover every reachable state.
- **Sub-pipeline names must be decided here.** They are propagated forward unchanged; if you name the sub-pipeline `"per-item-analysis"`, that exact name appears in main IR's prompt as `run_pipeline(name="per-item-analysis", ...)`.

## Error handling

- If `taskDescription` is empty or unreadable, emit a minimal design with `pipelineName="unknown"`, `pipelineId="unknown"`, `assumptions=["Task description was empty; produced placeholder design."]`, and a `stageDesign` that explains the gap.
- If required MCPs/skills are not discoverable via PulseMCP, write what's found in `recommendedMcps` and explain the gap in `assumptions`.

## Output (via write_port)

Emit all of the following port values:

- `pipelineName: string` — human-readable (e.g. "Technical Research").
- `pipelineId: string` — kebab-case (e.g. "tech-research").
- `description: string` — pipeline description.
- `stageDesign: markdown` — full stage-by-stage design.
- `dataFlowSummary: markdown` — optional; port/wire flow diagram.
- `useCases: string[]` — optional; target use cases.
- `estimatedStageCount: number` — total stage count including sub-pipeline stages.
- `usesFanout: boolean` — whether any stage has fanout.
- `usesSubPipelines: boolean` — whether any stage invokes run_pipeline.
- `recommendedMcps: string[]` — MCP names from PulseMCP search.
- `recommendedSkills: string[]` — skills from external discovery.
- `targetRepoName: string` — repository name if specified; empty string otherwise.
- `assumptions: string[]` — assumptions made for user review.
- `stageContracts: object[]` — array of StageContract objects (§ shape above).
- `subPipelineContracts: object[]` — optional; array of SubPipelineContract objects.
- `summary: markdown` — design summary for user.
```

- [ ] **Step 3: Verify the prompt file is readable by the loader**

Run:
```
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsx -e '
import { loadLegacyPipelineIR } from "./src/kernel-next/runtime/load-legacy-pipeline.js";
const r = loadLegacyPipelineIR("pipeline-generator");
console.log("analysis prompt length:", r.prompts["system/analysis"]?.length ?? 0);
'
```

Expected: length > 2000 (new prompt is long).

- [ ] **Step 4: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md && git commit -m "feat(pg): rewrite analysis.md — kernel-next vocabulary + new stageContracts shape"
```

---

## Task 5: Rewrite `gen-skeleton.md` prompt

**Files:**
- Rewrite: `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/gen-skeleton.md`

- [ ] **Step 1: Replace gen-skeleton.md**

Replace the entire file with:

```markdown
# Generate IR Skeleton (kernel-next)

You are a pipeline-IR synthesizer. You read a fully-specified pipeline design (including `stageContracts` and `subPipelineContracts`) and produce a valid kernel-next `PipelineIR` for the main pipeline plus an array of `PipelineIR`s for sub-pipelines.

## Available inputs

- `design: object` — full `pipelineDesign` object with fields including `pipelineName`, `pipelineId`, `stageContracts`, `subPipelineContracts`, `stageDesign`, etc.

## Target schema

### PipelineIR shape

```typescript
interface PipelineIR {
  name: string;                          // stable identity
  stages: StageIR[];
  wires: WireIR[];
  entry?: string;                        // optional; first stage by default
  externalInputs?: PortIR[];             // port name + type for task-level inputs
}

type StageIR = AgentStage | ScriptStage | GateStage;

interface StageCommon { name: string; inputs: PortIR[]; outputs: PortIR[]; }

interface AgentStage extends StageCommon {
  type: "agent";
  config: { promptRef: string };         // convention: same as stage.name
  fanout?: { input: string };
}

interface ScriptStage extends StageCommon {
  type: "script";
  config: { moduleId: string };
  fanout?: { input: string };
}

interface GateStage extends StageCommon {
  type: "gate";
  config: {
    question: { text: string; options?: string[] };
    routing: { routes: Record<string, string> };     // answer → stage name
  };
}

interface PortIR { name: string; type: string; zod?: string; }

interface WireIR {
  from: { source: "stage"; stage: string; port: string }
      | { source: "external"; port: string };
  to: { stage: string; port: string };
  guard?: string;                        // evaluated against `value` (source port value)
}
```

## Translation map: StageContract → StageIR

For each entry in `design.stageContracts`:

1. **Derive inputs** from `contract.reads`:
   - For each `(inputLabel, source)` in reads:
     - If `source.startsWith("externalInputs.")`: port name = `inputLabel`, type inferred from `design.externalInputs` (this is pipelineDesign's implicit contract — the pipeline the user wants has externalInputs declared via external_inputs in the generated YAML but also inferable from stageContracts that read them).
     - Else `source === "stageName.portName"`: port name = `inputLabel`, type = the matching upstream's `writes[portName]`.
     - Else `source === "stageName"` (whole stage): unusual; treat each of that stage's writes as one input port.
   - Emit a `PortIR` for each.

2. **Derive outputs** from `contract.writes`:
   - For each `(portName, tsType)` in writes: `{ name: portName, type: tsType }`.

3. **Emit the right stage variant**:
   - `contract.type === "agent"` → `AgentStage` with `config.promptRef = contract.name`.
   - `contract.type === "script"` → `ScriptStage` with `config.moduleId = contract.name` (userland must implement it; flag this in warnings if no such script exists).
   - `contract.type === "gate"` → `GateStage` with `config.question.text` inferred from `contract.purpose` and `config.routing.routes` directly from `contract.gateRouting`.

4. **Add fanout** if present: `fanout: { input: contract.fanout.input }`.

## Wire generation

For each stage's input port, generate one `WireIR` connecting it to the source:

- If source is `"externalInputs.<port>"`: `from: { source: "external", port: "<port>" }`.
- If source is `"<upstreamStage>.<port>"`: `from: { source: "stage", stage: "<upstreamStage>", port: "<port>" }`.
- Target: `to: { stage: <currentStage>, port: <inputLabel> }`.

**Wire guards**: inspect `design.stageDesign` (markdown) for conditional branching language ("if X then Y"). For each conditional branch, identify which wire it corresponds to and attach a `guard` expression over the source port's `value`. Examples:

- "If `routing.verdict === 'approve'`, continue to `finalize`, otherwise to `review`" → two wires from `routing.verdict` with guards `value === 'approve'` and `value !== 'approve'` (the latter covers reject as fallback; exhaustive).
- "If `analysis.complexity > 8`, run `deep_dive`, otherwise `summary`" → two wires with guards `value.complexity > 8` and `!(value.complexity > 8)`.

Guards must be **exhaustive** — at least one guard must evaluate true for every possible source value. Fail-fast if you cannot achieve exhaustiveness from the stageDesign as written (emit `stageDesign` improvements as part of your own IR and note a warning via `summary`).

## Sub-pipeline generation

For each entry in `design.subPipelineContracts`:

1. Create a full `PipelineIR` with `name: contract.name`.
2. Design its internal stages based on the sub-pipeline's `purpose`. (You are designing both the main and each sub-pipeline's stages; treat each sub-pipeline as its own mini-design.)
3. Set `externalInputs` from `contract.externalInputs`.
4. Ensure the sub-IR has at least one stage whose outputs match `contract.returnContract`.

Add the sub-IR to `subIrs[]`.

**Sub-pipeline invocation wiring**: in the main IR, the stage named `contract.calledBy` will have an agent prompt that calls `run_pipeline(name=<contract.name>, task=..., policy=?)`. From your IR's perspective, that agent stage must have an output port that will hold the sub-pipeline's result. Do not explicitly model the sub-pipeline call as a wire — it's an in-agent tool call. Your responsibility is naming (ensuring the sub-IR's name matches `contract.calledBy`'s prompt reference, which genPrompts will honor).

## Pre-submit self-check

Before emitting the IR, verify:

- [ ] Every stage name is unique.
- [ ] Every wire's target port exists on the target stage's `inputs`.
- [ ] Every wire's source port exists on the source stage's `outputs` (or on `externalInputs` if `source === "external"`).
- [ ] No cycles in the stage DAG.
- [ ] Every AgentStage has `config.promptRef` set (== stage name).
- [ ] Every gate's routing targets are existing stage names.
- [ ] Every `fanout.input` port exists as an input of the stage declaring it.

If any check fails, fix or emit diagnostics in your own thinking and try again before calling `write_port`.

## Error handling

- If stageContracts has internal inconsistencies the converter cannot reconcile (e.g. reads an upstream port that no other stage writes): emit the best-effort IR and note the inconsistency in your `write_port` call of `warnings` — but **still emit `ir`** so downstream can continue. Persisting agent will see submit_pipeline's diagnostics and may fix.
- If `design.subPipelineContracts` is missing or empty, `subIrs: []`.

## Output (via write_port)

- `ir: object` — the main PipelineIR JSON.
- `subIrs: object[]` — array of sub-pipeline PipelineIRs (empty if no sub-pipelines).

Do not emit any other port. Do not emit prose.
```

- [ ] **Step 2: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/gen-skeleton.md && git commit -m "feat(pg): rewrite gen-skeleton.md — emit kernel-next IR + subIrs"
```

---

## Task 6: Rewrite `gen-prompts.md` prompt

**Files:**
- Rewrite: `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/gen-prompts.md`

- [ ] **Step 1: Replace gen-prompts.md**

Replace the entire file with:

```markdown
# Generate Prompts (kernel-next)

You produce the markdown prompts that accompany a kernel-next IR. Each AgentStage in the IR must have one corresponding prompt whose key is that stage's `config.promptRef` (by convention: same as `stage.name`).

## Available inputs

- `design: object` — `pipelineDesign` (for context like subPipelineContracts and stageContracts' purposes).
- `skeleton: object` — `skeletonResult` with `ir: PipelineIR` and `subIrs: PipelineIR[]`.

## Available sub-agents

- `prompt-writer` — a sub-agent specialized in writing a single stage's prompt. Invoke it via `Task` tool with a detailed stage spec.

## Your task

1. For **each AgentStage in `skeleton.ir.stages`**, produce one markdown prompt.
2. For **each `subIrs[i]`**, iterate over `subIrs[i].stages` and produce one markdown prompt per AgentStage.
3. Additionally, emit any pipeline-wide fragment prompts (keys starting with `system/` for shared invariants, or `global-constraints` for pipeline-level rules) — only if the design calls for them.

## Prompt-writer invocation

For each AgentStage, invoke `prompt-writer` with:

```
Task: Write a system prompt for stage "<stage.name>" in pipeline "<pipelineName>".

Stage spec:
- Name: <stage.name>
- Purpose: <from stageContracts.purpose>
- Inputs: <for each input port: name, type, source description>
- Outputs: <for each output port: name, type>
- Fanout (if any): <stage.fanout.input> — this stage instance receives ONE element of that input
- Invokes sub-pipeline (if applicable): <subPipelineContract.name>; policy: pass through the user's task context

Requirements:
- 30-80 lines
- Include Available Inputs section with each port name, type, and meaning
- Include Workflow section (step-by-step)
- Include literal write_port example for each output port
- If the stage invokes run_pipeline, include exact MCP call template with the sub-pipeline's literal name
- Include Error Handling section
```

Collect the returned prompt body.

## Sub-pipeline invocation prompts

For any AgentStage in the main IR where `stageContracts[<name>].purpose` indicates sub-pipeline invocation (check `design.subPipelineContracts` for entries with `calledBy === stage.name`):

Ensure the prompt-writer instruction explicitly includes:

```
run_pipeline(name="<exact subPipelineContract.name>", task=<task description constructed from inputs>, policy=?)
// Poll: get_task_status(taskId) until completed or failed
// Read: read_port for each port in subPipelineContract.returnContract
// Write: write_port your own stage's outputs mapped from the sub-pipeline's results
```

The literal sub-pipeline name is propagated from `design.subPipelineContracts[i].name` → must match `subIrs[i].name`.

## Consistency contract

- Every AgentStage in `skeleton.ir.stages` must have a prompt entry in `prompts` with key === `stage.config.promptRef`.
- For every `subIrs[i]`, every AgentStage in `subIrs[i].stages` must have a prompt entry in `subPrompts[i]` with key === `stage.config.promptRef`.
- Every `run_pipeline(name="X")` literal in any prompt must match a `subIrs[j].name`.
- Orphan prompts (keys not referenced by any AgentStage) are allowed only if they start with `system/` or are exactly `global-constraints`.

## Error handling

- If a stage's inputs don't align with what the prompt can reasonably produce (e.g. the design claims the stage reads `analysis.summary` but no upstream stage named `analysis` exists in the IR), emit the prompt anyway with the best guess AND include a warning note in the prompt's "Error Handling" section — persisting agent will see the diagnostic at submit time.

## Output (via write_port)

- `prompts: object` — `Record<promptRef, content>` for the main IR.
- `subPrompts: object[]` — index-aligned with `subIrs`; each element is a `Record<promptRef, content>` for that sub-pipeline.
```

- [ ] **Step 2: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/gen-prompts.md && git commit -m "feat(pg): rewrite gen-prompts.md — produce prompts map aligned with kernel-next IR"
```

---

## Task 7: Write `persist.md` prompt (replacing placeholder)

**Files:**
- Rewrite: `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/persist.md`

- [ ] **Step 1: Replace the placeholder persist.md**

Replace the entire file with:

```markdown
# Persist Pipeline to kernel-next

You receive the IR skeleton (`skeleton`), prompt bundle (`promptBundle`), and full design (`design`). Your job: submit sub-pipelines and the main pipeline to kernel-next via `submit_pipeline` MCP, and produce `persistResult`.

## Available inputs

- `skeleton: object` — `{ ir: PipelineIR, subIrs: PipelineIR[] }`.
- `promptBundle: object` — `{ prompts: Record<string,string>, subPrompts: Record<string,string>[] }` (index-aligned with `subIrs`).
- `design: object` — full `pipelineDesign` (for `pipelineName` / `pipelineId` fallbacks).

## Available tools

- `submit_pipeline` MCP — submits an IR+prompts bundle, returns `{ ok: true, versionHash, ... }` or `{ ok: false, diagnostics: [...] }`.
- `write_port` MCP — emit output ports.

## Workflow

1. **Submit sub-pipelines first.** For each `subIrs[i]` in order:
   - Call `submit_pipeline(ir=subIrs[i], prompts=promptBundle.subPrompts[i])`.
   - On success: record the returned `versionHash` into a local `subVersionHashes[i]` accumulator.
   - On diagnostics:
     - If diagnostics are syntax-level (`PROMPT_REF_MISSING`, `PROMPT_REF_UNUSED`, `WIRE_TARGET_PORT_MISSING`, `WIRE_SOURCE_PORT_MISSING`, Zod parse errors on port types): attempt ONE fix by adjusting the sub-IR / sub-prompts and resubmitting. Cap: 2 attempts per sub-pipeline.
     - If diagnostics indicate semantic errors (missing stage the design required, cycles, unroutable gates): abandon fix attempts, throw via `write_port error: "<reason>"` on a terminal error port **OR** call a tool that causes the agent to fail the stage. Do not silently proceed.
   - After 2 failed attempts on a sub-pipeline: throw. Task fails.

2. **Verify main IR's run_pipeline references.** Scan `promptBundle.prompts` for every occurrence of `run_pipeline(name="X")`. For each match, verify `X` appears in your accumulated `subVersionHashes` map (via the sub-IR's `name` field). Mismatch → throw. This catches genSkeleton / genPrompts naming drift.

3. **Submit the main pipeline.** Call `submit_pipeline(ir=skeleton.ir, prompts=promptBundle.prompts)`.
   - On success: record the returned `versionHash` as `mainVersionHash`.
   - On diagnostics: same policy as step 1 — 2 attempts max; syntax-fix only; semantic errors abandon.

4. **Derive `pipelineId` and `pipelineName`:**
   - `pipelineName = skeleton.ir.name` (or `design.pipelineName` if absent — rare).
   - `pipelineId = slugify(pipelineName)` — kebab-case, lowercase, ASCII only.

5. **Emit `persistResult`** via `write_port`:

```
write_port({
  port: "persistResult",
  value: {
    versionHash: "<mainVersionHash>",
    subVersionHashes: [...subVersionHashes],
    pipelineId: "<pipelineId>",
    pipelineName: "<pipelineName>"
  }
})
```

## Rules

- **Atomic intent.** Either all submits succeed and you emit `persistResult`, or you fail the stage. Do not emit a partial `persistResult`.
- **Syntax fix scope.** You may rewrite port names, prompt references, and prompt content. You may NOT add or remove stages, change stage types, or alter gate routing. Those are semantic decisions belonging to analyzing / genSkeleton.
- **No filesystem writes.** Do not attempt to write any files. All persistence goes through `submit_pipeline`.

## Error handling

- `submit_pipeline` unavailable (MCP tool missing) → throw with an explanatory message. This is a kernel bug; do not work around.
- Disk IO errors, network errors → retry once, then throw.
- `versionHash` collision (re-submit of existing identical pipeline): returned `versionHash` still comes back ok; that's expected (submit is idempotent for identical content). Use the returned hash directly.

## Output (via write_port)

- `persistResult: object` with fields `versionHash`, `subVersionHashes`, `pipelineId`, `pipelineName`.
```

- [ ] **Step 2: Verify length**

Run:
```
wc -l /Users/minghao/workflow-control/apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/persist.md
```

Expect > 30 lines (substantive content replaced the placeholder).

- [ ] **Step 3: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/persist.md && git commit -m "feat(pg): write persist.md — agent prompt for submit_pipeline workflow"
```

---

## Task 8: Delete obsolete prompts

**Files:**
- Delete: `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/refine-prompts.md`
- Delete: `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/report-generator.md`

- [ ] **Step 1: Verify no live references**

Run:
```
cd /Users/minghao/workflow-control/apps/server
grep -rn "refine-prompts\|report-generator" src/ --include="*.ts" --include="*.yaml" --include="*.md" | grep -v "builtin-pipelines/pipeline-generator/prompts/system"
```

Expect zero hits. If any, investigate — the new YAML should not reference `refine-prompts` anywhere.

- [ ] **Step 2: Delete**

```bash
cd /Users/minghao/workflow-control && git rm apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/refine-prompts.md apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/report-generator.md
```

- [ ] **Step 3: Regenerate orphan enumeration**

Run:
```
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsx -e '
import { loadLegacyPipelineIR } from "./src/kernel-next/runtime/load-legacy-pipeline.js";
const r = loadLegacyPipelineIR("pipeline-generator");
const refs = new Set(r.ir.stages.filter(s => s.type === "agent").map(s => s.config.promptRef));
const provided = Object.keys(r.prompts);
const orphans = provided.filter(k => !refs.has(k));
console.log("pipeline-generator orphans:", JSON.stringify(orphans));
'
```

Expected: `[]` or only `system/*` / `global-constraints` entries.

- [ ] **Step 4: Run kernel-run regression**

Run:
```
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/routes/kernel-run.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/minghao/workflow-control && git commit -m "chore(pg): delete obsolete refine-prompts.md + report-generator.md"
```

---

## Task 9: Delete persist-pipeline script + tests

**Files:**
- Delete: `apps/server/src/scripts/persist-pipeline.ts`
- Delete: `apps/server/src/scripts/persist-pipeline.test.ts`
- Delete: `apps/server/src/scripts/persist-pipeline.adversarial.test.ts`
- Modify: `apps/server/src/scripts/index.ts`

- [ ] **Step 1: Verify no live references beyond scripts/index.ts**

Run:
```
cd /Users/minghao/workflow-control/apps/server
grep -rn "persist_pipeline\|persistPipeline" src/ --include="*.ts" --include="*.yaml" | grep -v "scripts/persist-pipeline\|scripts/index.ts"
```

Expect zero hits. If any (e.g. a test elsewhere references `persist_pipeline` script_id), investigate — those may need updating or also deleting.

- [ ] **Step 2: Delete test files**

```bash
cd /Users/minghao/workflow-control && git rm apps/server/src/scripts/persist-pipeline.test.ts apps/server/src/scripts/persist-pipeline.adversarial.test.ts
```

- [ ] **Step 3: Delete the script itself**

```bash
cd /Users/minghao/workflow-control && git rm apps/server/src/scripts/persist-pipeline.ts
```

- [ ] **Step 4: Remove registration from scripts/index.ts**

Read current state:
```
cat /Users/minghao/workflow-control/apps/server/src/scripts/index.ts
```

Remove lines:
```typescript
import { persistPipelineScript } from "./persist-pipeline.js";
// ...
scriptRegistry.register(persistPipelineScript);
```

Leave other imports and registrations intact.

- [ ] **Step 5: Type check**

```
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 6: Full test regression**

```
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run
```

Expected: all PASS. Any test that referenced `persist_pipeline` script — those should already have been cleaned up in Step 1 (if they existed).

- [ ] **Step 7: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/scripts/index.ts && git commit -m "chore(scripts): delete persist-pipeline script and its tests"
```

---

## Task 10: Full regression + acceptance gate

**Files:**
- No new files. Verification-only.

- [ ] **Step 1: Full server test suite**

```
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run
```

Expected: all PASS. Record counts (passed / skipped / failed). Failed = 0.

- [ ] **Step 2: Server type check**

```
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Web type check**

```
cd /Users/minghao/workflow-control/apps/web && ./node_modules/.bin/tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Verify no live references to deleted artifacts**

```
cd /Users/minghao/workflow-control/apps/server
grep -rn "persistPipelineScript\|persist_pipeline\|refine-prompts\|report-generator\|refinedPromptFiles\|refinePrompts\|pipelineYaml" src/ --include="*.ts" --include="*.yaml" --include="*.md"
```

Expected: zero hits for all of these identifiers in production code. Any match indicates incomplete cleanup.

If the grep shows residual matches (e.g. a stale doc reference), evaluate case-by-case. Docs in `docs/` may reference deleted things historically — leave those alone. Production `src/` should be clean.

- [ ] **Step 5: Verify prompts table contents for pipeline-generator**

Run:
```
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsx -e '
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "./src/kernel-next/ir/sql.js";
import { KernelService } from "./src/kernel-next/mcp/kernel.js";
import { loadLegacyPipelineIR } from "./src/kernel-next/runtime/load-legacy-pipeline.js";
const db = new DatabaseSync(":memory:");
initKernelNextSchema(db);
const svc = new KernelService(db, { skipTypeCheck: true });
const r = loadLegacyPipelineIR("pipeline-generator");
const res = svc.submit(r.ir, { prompts: r.prompts });
if (!res.ok) {
  console.error("FAILED", JSON.stringify(res.diagnostics));
  process.exit(1);
}
console.log("versionHash:", res.versionHash.slice(0,10));
const refs = db.prepare("SELECT prompt_ref FROM pipeline_prompt_refs WHERE version_hash = ? ORDER BY prompt_ref").all(res.versionHash);
console.log("prompts registered:", refs);
'
```

Expected: output like:
```
versionHash: <some 10-char prefix>
prompts registered: [
  { prompt_ref: 'system/analysis' },
  { prompt_ref: 'system/gen-prompts' },
  { prompt_ref: 'system/gen-skeleton' },
  { prompt_ref: 'system/persist' }
]
```

(Four prompts total. No `refine-prompts` or `report-generator` entries.)

- [ ] **Step 6: Manual E2E (report-only, do not gate on this in the automated plan)**

Note for the operator: once all tasks land, manually:
1. Start dev server: `pnpm --filter server dev`
2. POST to `start_pipeline_generator` MCP (or via curl to the underlying route) with a short `taskDescription` like `"create a pipeline that summarizes a GitHub repository README"`
3. Observe SSE events: `task_state running` → `stage_executing analyzing` → (many `port_written`) → `stage_done analyzing` → `stage_executing awaitingConfirm` (gate)
4. Answer the gate via MCP `answer_gate` or REST endpoint with `approve`
5. Observe: `stage_executing genSkeleton` → `stage_done genSkeleton` → `stage_executing genPrompts` → `stage_done genPrompts` → `stage_executing persisting` → (submit_pipeline MCP calls) → `stage_done persisting` → `run_final completed`
6. Check `persistResult` port value — should have `versionHash` matching a fresh row in `pipeline_versions`.
7. POST `/api/kernel/tasks/run` with the new pipeline's name and appropriate `seedValues`. Observe it runs.

If manual E2E fails at step 7 (generated pipeline doesn't run), that's a prompt-engineering defect; file a follow-up. Infrastructure completeness IS met if step 1-6 passes.

- [ ] **Step 7: No commit for verification**

Move to handoff.

---

## Self-Review

**Spec coverage:**

| Spec § | Requirement | Task(s) |
|---|---|---|
| §1 SC 1 | persisting submits via MCP, no YAML files | Tasks 1 (YAML type=agent), 7 (persist.md) |
| §1 SC 2 | refinePrompts removed, serial gen | Tasks 1 (YAML), 8 (prompt delete) |
| §1 SC 3 | sub-pipeline support | Tasks 1 (schema), 5 (gen-skeleton), 6 (gen-prompts), 7 (persist.md verification) |
| §1 SC 4 | stageContracts new shape | Tasks 1 (schema), 4 (analysis.md) |
| §1 SC 5 | prompts teach IR vocabulary | Tasks 4, 5, 6, 7 |
| §1 SC 6 | delete refine-prompts.md + report-generator.md | Task 8 |
| §1 SC 7 | delete persist-pipeline.ts | Task 9 |
| §1 SC 8 | E2E validation | Task 10 Step 6 (manual) |
| §1 SC 9 | no regression | Task 10 Steps 1-4 |
| §4.1 store_schema | new schema fields | Task 1 |
| §4.2 full YAML | complete new YAML | Task 1 |
| §5 analyzing prompt | rewrite analysis.md | Task 4 |
| §6 genSkeleton prompt | rewrite gen-skeleton.md | Task 5 |
| §7 genPrompts prompt | rewrite gen-prompts.md | Task 6 |
| §8 persisting prompt | write persist.md | Tasks 3 (placeholder), 7 (real) |
| §9 removed artifacts | delete script + prompts | Tasks 8, 9 |
| §10 converter adjust | converter still OK | Task 2 |
| §11 sub-pipeline name invariant | enforced in prompts | Tasks 4, 5, 6, 7 (each teaches the invariant) |
| §12 tests | unit + integration | Task 2 (converter), Task 10 (full regression) |

**Placeholder scan:** no "TBD", "TODO", "implement later", "fill in" in the plan body.

**Type consistency check:**
- `StageContract` shape: `{name, type, purpose, reads?, writes?, fanout?, budget?, gateRouting?}` — consistent across Tasks 4 (emitted in analysis.md), 5 (consumed in gen-skeleton.md).
- `SubPipelineContract` shape: `{name, purpose, externalInputs, returnContract, calledBy}` — consistent across Tasks 4 (emitted), 5 (consumed), 6 (consumed for run_pipeline naming).
- `skeletonResult` port: `{ir, subIrs}` — consistent in Tasks 1 (schema), 5 (written), 6 (read), 7 (read).
- `promptBundle` port: `{prompts, subPrompts}` — consistent in Tasks 1 (schema), 6 (written), 7 (read).
- `persistResult` port: `{versionHash, subVersionHashes, pipelineId, pipelineName}` — consistent in Tasks 1 (schema), 7 (written).
- `run_pipeline(name=...)` name invariant: taught in analysis.md (Task 4), maintained in gen-skeleton.md (Task 5), emitted by gen-prompts.md (Task 6), verified in persist.md (Task 7).

All consistent.
