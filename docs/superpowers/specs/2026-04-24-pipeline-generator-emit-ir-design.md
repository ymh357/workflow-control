# Pipeline-Generator Emits IR — Stage 2 Design

> **Date:** 2026-04-24
> **Status:** Draft — awaiting user approval
> **Goal-tier:** Stage 2 of the 7-stage Y-direction path to "kernel-next is the only engine"
> **Depends on:** `docs/superpowers/specs/2026-04-24-prompts-in-sqlite-design.md` (landed)
> **Related:**
>   - `docs/kernel-next-terminal-design.md` §3.2 (stage primitives), §3.4 (sub-pipeline recursion), §9 (MCP surface), §11.2 (non-negotiables)
>   - `docs/superpowers/plans/2026-04-24-prompts-in-sqlite.md` (prerequisite milestone)

## 1. Goal & Success Criteria

**Goal:** Replace pipeline-generator's legacy-YAML authoring output with native kernel-next IR authoring. The pipeline-generator builtin itself remains a legacy YAML pipeline consumed via converter (that's Stage 3), but its **product** — the pipeline it generates — becomes an `{ ir: PipelineIR, prompts: Record<string,string> }` bundle submitted directly to kernel-next via `submit_pipeline` MCP.

**Success criteria:**

1. Pipeline-generator's `persisting` stage submits an IR+prompts bundle to kernel-next via `submit_pipeline` MCP. No YAML files written to `config/pipelines/`. No filesystem prompt directory written.
2. pipeline-generator's `refinePrompts` stage is removed; `genSkeleton` → `genPrompts` runs serially so `genPrompts` consumes the generated IR.
3. Sub-pipeline recursion (§3.4) is supported: genSkeleton produces `subIrs: PipelineIR[]`, genPrompts produces `subPrompts: Record<string,string>[]` aligned by index, persisting submits all of them before the main IR and validates that the main IR's `run_pipeline` references resolve to submitted sub-pipeline names.
4. `analyzing` stage's `stageContracts` port is redefined as a semantic-level contract (`{name, type, purpose, reads?, writes?, budget?}`), no longer IR-shaped.
5. System prompts (`analysis.md`, `gen-skeleton.md`, `gen-prompts.md`) are rewritten to teach the AI the kernel-next IR model (3 stage primitives + typed ports + wires + wire guards + fanout flag + run_pipeline recursion) instead of legacy YAML DSL.
6. `refine-prompts.md` and `report-generator.md` prompt files are deleted.
7. `persist-pipeline.ts` script is deleted (persisting is now an agent stage, not a script).
8. End-to-end validation: pipeline-generator running on kernel-next produces a real, `run_pipeline`-executable kernel-next pipeline for at least one representative task description (e.g. a diamond-shaped 4-stage pipeline).
9. No regression in kernel-next test suite (4291+ passing as of Stage 1 completion baseline).

## 2. Scope & Non-Goals

**In scope:**

- `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml` — restructured stages, ports, store_schema
- `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/{analysis,gen-skeleton,gen-prompts,persist}.md` — rewritten or new
- Removal: `prompts/system/refine-prompts.md`, `prompts/system/report-generator.md`
- Removal: `apps/server/src/scripts/persist-pipeline.ts` (and its registration in `scripts/index.ts`)
- Adjustments to converter to keep pipeline-generator.yaml convertible under its new shape

**Out of scope (deferred):**

- Stage 3 (pipeline-generator itself authored in kernel-next IR; currently still legacy YAML consumed via converter — acceptable because converter support for pipeline-generator's actual shape landed in the earlier converter-extension milestone and remains functional)
- Retire converter / legacy engine (Stage 4-5)
- Regenerating the other 4 registered pipelines (smoke-test / tech-research-collector / tech-research-writer / web3-research-writer) via new pipeline-generator — that happens in Stage 3 once the new generator is validated
- Rewriting `fix-validator` prompt — it was deleted in the prompts-in-sqlite Stage 1 and not re-added (if validation-loop concerns arise post-milestone, treat as follow-up)
- Kernel-next `retry.back_to` feedback port extension — this milestone deliberately avoids that by handling validation failures inside the persisting agent's own turn loop (§7)
- Dry-run / preview of generated IR before submit — out of scope; user reviews via `awaitingConfirm` gate which gates the design, not the IR

**Non-goals (explicit rejections):**

- **NOT** exposing `submit_pipeline` on the internal MCP surface. It stays external. The persisting agent is the caller — and agents legitimately use external MCP tools per §3.4's run_pipeline precedent.
- **NOT** a "capability injection" API on StageExecutor. persisting is agent, not script; no new kernel↔userland bridge needed.
- **NOT** adding an `update_prompt` IRPatch operation. Prompt changes flow through the existing resubmit-produces-new-versionHash mechanism (landed in Stage 1).

## 3. Architectural Foundations

Three principles drive the design:

**3.1 Agent + external MCP is kernel-next's canonical pattern for cross-pipeline kernel calls.**

kernel-next-design §3.4 established: *"A stage that runs a sub-pipeline is just an agent stage whose prompt instructs the agent to call run_pipeline MCP."* The pipeline-generator's persist stage is the same pattern one level up: an agent stage whose prompt instructs the agent to call `submit_pipeline` MCP. The recursion closes cleanly — pipeline-generator submits pipeline-X; pipeline-X may contain agent stages that run sub-pipelines via run_pipeline; all go through the external MCP surface.

This decision obviates any need for a "script can call kernel internals" bridge. The existing MCP surface split (§9) is preserved.

**3.2 Turn-level validation loop, not stage-level retry.**

When `submit_pipeline` returns diagnostics, the persisting agent sees them in its own conversation turn (as tool_result). It can try to fix and resubmit within its own `max_turns` budget. This:
- Preserves kernel-next's "no cross-stage retry feedback channel" constraint (decisions on retry feedback are deferred)
- Confines fix logic to where it happens (agent in persisting, with full context)
- Uses AgentMachine's turn-level replay semantics (§4) naturally

If the agent exhausts its max_turns on failed submits, the stage errors out and the task fails. User then either reopens the task or (future) proposes a hot-update patch. No silent recovery.

**3.3 Sub-pipelines share the `submit_pipeline` recursion via a stable name contract.**

Sub-pipelines are submitted **before** the main pipeline so that the main pipeline's `run_pipeline` references resolve by name. The `analyzing` agent is responsible for naming sub-pipelines in `stageContracts` (the semantic contract). `genSkeleton` preserves those names as `subIrs[i].name`. The main IR's agent prompts that contain `run_pipeline(name="X")` literal references are emitted by `genPrompts`, which reads `skeletonResult.subIrs` to know the exact names.

Consistency between a main IR's prompt literal and a sub IR's name is a semantic invariant genSkeleton + genPrompts must honor. `persisting` performs a post-submit sanity check: after all subIrs are submitted, verify that every `run_pipeline(name=...)` literal inside main IR prompts resolves to a submitted name. Mismatch → persisting agent fails the stage.

## 4. New Pipeline Topology

Compare old vs new:

```
OLD (as of prompts-in-sqlite end):
  analyzing(agent, thinking) → awaitingConfirm(gate) → parallel{
    genSkeleton(agent, thinking),
    genPrompts(agent + prompt-writer sub-agent)
  } → refinePrompts(agent) → persisting(script)

NEW:
  analyzing(agent, thinking) → awaitingConfirm(gate) →
  genSkeleton(agent, thinking) → genPrompts(agent + prompt-writer sub-agent)
  → persisting(agent)
```

Changes:
- **Remove** parallel group; serialize genSkeleton → genPrompts
- **Remove** refinePrompts stage
- **Convert** persisting from `type: script` to `type: agent`
- **Preserve** analyzing + awaitingConfirm + awaitingConfirm's `on_reject_to: analyzing` semantics

### 4.1 Store schema changes

| Entry | Action |
|-------|--------|
| `pipelineDesign` | Kept. Field `stageContracts` redefined (§6). Field `summary` extended to describe design, not YAML output. |
| `pipelineYaml` | **Renamed to `skeletonResult`** with new fields: `ir: PipelineIR`, `subIrs: PipelineIR[]`. Old `pipeline` / `warnings` / `sub_pipelines` fields removed. |
| `promptFiles` | **Renamed to `promptBundle`** with new fields: `prompts: Record<string,string>`, `subPrompts: Record<string,string>[]` (index-aligned with `subIrs`). Old `outputDir` / `generatedFiles` / `hasGlobalConstraints` fields removed. |
| `refinedPromptFiles` | **Removed entirely** — refinePrompts stage gone. |
| `persistResult` | Kept. Fields `savedFiles` / `validationPassed` / `mcpSetupNeeded` / `yamlPath` **removed**. New fields: `versionHash: string` (main), `subVersionHashes: string[]` (aligned with subIrs). `pipelineId` / `pipelineName` retained (derived from IR, useful for display/summary). |

### 4.2 Full pipeline.yaml shape (after)

```yaml
name: Pipeline Generator
description: Generate high-quality kernel-next pipelines from natural language descriptions.
engine: claude
official: true

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
    fields:
      pipelineName: { type: string, required: true }
      pipelineId: { type: string, required: true }
      description: { type: string, required: true }
      stageDesign: { type: markdown, required: true }
      dataFlowSummary: { type: markdown }
      useCases: { type: string[] }
      estimatedStageCount: { type: number }
      usesFanout: { type: boolean }            # was: usesParallelGroups — renamed per kernel-next vocab
      usesSubPipelines: { type: boolean }      # new — signals subIrs[] will be non-empty
      recommendedMcps: { type: string[] }
      recommendedSkills: { type: string[] }
      targetRepoName: { type: string }
      assumptions: { type: string[] }
      stageContracts: { type: object[], required: true }  # new shape — see §6
      subPipelineContracts: { type: object[] }            # new — per-sub-pipeline semantic contract
      summary: { type: markdown, required: true }
  skeletonResult:
    produced_by: genSkeleton
    fields:
      ir: { type: object, required: true }             # PipelineIR JSON
      subIrs: { type: object[] }                       # Array<PipelineIR>; empty when no sub-pipelines
  promptBundle:
    produced_by: genPrompts
    fields:
      prompts: { type: object, required: true }        # Record<promptRef, content>
      subPrompts: { type: object[] }                   # Array<Record<promptRef, content>>, index-aligned with subIrs
  persistResult:
    produced_by: persisting
    fields:
      versionHash: { type: string, required: true }
      subVersionHashes: { type: string[] }
      pipelineId: { type: string, required: true }
      pipelineName: { type: string, required: true }

stages:
  - name: analyzing
    type: agent
    interactive: true
    thinking: { type: enabled }
    mcps: [pulsemcp]
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
    thinking: { type: enabled }
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
            [Updated — teaches kernel-next IR vocabulary; see §7.3]
          tools: [Read, Write]
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

Note: `max_turns: 20` on persisting accommodates the turn-level submit retry loop (§3.2) plus slack. Typical successful submit takes 1-2 turns; most retries cap at 5-8 turns; failures exhaust 20.

## 5. `analyzing` Stage — Design Phase

Unchanged in role: the AI receives `taskDescription`, optionally uses PulseMCP to discover relevant tools, and produces a complete pipeline design.

### 5.1 Prompt rewrite (`analysis.md`)

The analysis prompt taught legacy YAML DSL concepts: `type: agent|script|human_confirm|condition|foreach|pipeline`, store blackboard reads/writes, parallel blocks. Replace with kernel-next vocabulary:

- **3 stage primitives**: agent / script / gate
- **Typed ports**: each stage declares inputs (PortIR[]) and outputs (PortIR[]); ports carry TypeScript type literals
- **Wires**: 1-to-1 from source.stage.port → target.stage.port, optional guard expression evaluated against source port value
- **Wire guards** replace legacy condition stages — explain the "guards don't short-circuit; exhaustiveness is author's responsibility; NO_ACTIVE_WIRE is fail-fast" (§6.2 of terminal-design)
- **Fanout** flag replaces legacy foreach — agent or script stage may declare `fanout: { input: <portName> }` for per-element instantiation (§6.3 of terminal-design)
- **Sub-pipelines via run_pipeline** recursion replaces legacy `type: pipeline` (§3.4 of terminal-design)
- **Gates** replace legacy human_confirm + llm_decision — one stage type, answerer decided at runtime (§3.3)

The prompt enumerates when to choose each primitive and gives small canonical examples for each pattern (branch via guard; iterate via fanout; recurse via run_pipeline; pause via gate).

### 5.2 `stageContracts` new shape

Each entry is a semantic contract, not an IR fragment:

```typescript
interface StageContract {
  name: string;                                    // camelCase identifier
  type: "agent" | "script" | "gate";               // kernel-next primitive
  purpose: string;                                  // 1-2 sentences, what this stage does
  reads?: Record<string, string>;                   // inputLabelForAgent → upstreamStageName.portName
                                                    //                   OR externalInputs.portName
                                                    //                   OR stageName (means "all outputs of that stage as one object")
  writes?: Record<string, string>;                  // outputPortName → TS type literal
                                                    // e.g. "url": "string", "report": "{summary: string, items: string[]}"
  fanout?: { input: string };                       // if set, this stage fanouts over the named input port
  budget?: { maxTurns?: number; maxBudgetUsd?: number }; // optional hints carried forward to ExecutionPolicy
  gateRouting?: Record<string, string>;             // for type=gate only — answerValue → targetStageName
                                                    // includes "reject" routing to upstream stages explicitly
}
```

Note intentional gaps:
- No `subAgents` on contract — if a stage needs sub-agents, that's a prompt-writing detail surfaced at `genPrompts` time, not design time
- No `promptRef` — `genPrompts` names it (convention: same as `name`)
- No `guard` expressions on contract — guards are wire-level, so they belong in `dataFlowSummary` / `stageDesign` markdown prose at design time, and genSkeleton translates them to `WireIR.guard`

### 5.3 `subPipelineContracts` new field

When the design requires sub-pipelines (fanout-over-items-with-complex-work, or logical recursion), each sub-pipeline gets its own contract:

```typescript
interface SubPipelineContract {
  name: string;                                    // must match later subIrs[i].name
  purpose: string;
  externalInputs: Record<string, string>;          // inputName → TS type
  returnContract: Record<string, string>;          // outputName → TS type; captured via run_pipeline's wait behavior
  calledBy: string;                                // main IR stage name that invokes run_pipeline
}
```

`analyzing` decides the sub-pipeline names; every downstream stage treats them as fixed.

## 6. `genSkeleton` Stage — Design → IR

Input: `pipelineDesign` (full object).  
Output: `skeletonResult { ir: PipelineIR, subIrs: PipelineIR[] }`.

### 6.1 Prompt rewrite (`gen-skeleton.md`)

The prompt teaches:

1. **Translation map** from stageContracts to IR:
   - `contract.type === "agent"` + `contract.reads` → AgentStage with inputs derived from reads keys (each key becomes an input port; type inferred from upstream writes declaration) + config.promptRef = contract.name
   - `contract.type === "script"` → ScriptStage with config.moduleId (only `persist_pipeline` script exists historically; for generated pipelines, the AI SHOULD avoid script stages unless the design calls for a known existing userland script)
   - `contract.type === "gate"` → GateStage with config.routing.routes from contract.gateRouting
   - `contract.fanout` → stage.fanout field
   - Wire rules: for each stage's `reads`, emit one WireIR per read entry; `from` is resolved by scanning all other contracts' `writes` for the matching port name (DAG contract)
2. **Port type derivation**: contract.writes gives TS type strings directly; inputs derive type from the matching upstream write's type. Conflicts → the AI should fail fast in its own output, signaling the design is internally inconsistent.
3. **Guards**: the AI is told to look at `stageDesign` prose for "when X then Y" language; branches there become wire guards. Guard expression evaluates against the single source port value — so the prompt instructs the AI to pick a source stage whose output carries the routing signal (and fail if no such stage exists — indicates a design flaw).
4. **Sub-pipelines**: for each `subPipelineContract`, produce a `PipelineIR` in subIrs. Each sub IR's `name` === `subPipelineContract.name`. Sub IR has its own stages / wires / externalInputs and is self-contained.
5. **`run_pipeline` integration**: main IR agent stages that invoke a sub-pipeline emit wire sources as if the `run_pipeline` call's return is an output of that agent stage. The agent's prompt (written by genPrompts later) handles the actual call.

The prompt emphasizes: **produce one JSON object with two keys — `ir` and `subIrs`. Both must be valid kernel-next IR (parseable by `PipelineIRSchema`). Do not produce prose around it. Do not include comments. Use `write_port` to emit both values.**

### 6.2 Validation inside the agent's own turn loop

The prompt instructs the AI: before calling `write_port`, sanity-check the IR:
- Every stage name unique
- Every wire target port exists on target stage's inputs
- Every wire source port exists on source stage's outputs (or on externalInputs if `source: "external"`)
- DAG has no cycles
- Every AgentStage has config.promptRef set (convention: same as stage name)
- Every gate's routing targets are stage names that exist in the IR

The AI is also told: the kernel's `submit_pipeline` will run Zod + structural + DAG + tsc checks, so this is just a pre-check; final authority is the kernel.

## 7. `genPrompts` Stage — IR → Prompts

Input: `pipelineDesign` + `skeletonResult` (both ir and subIrs).  
Output: `promptBundle { prompts: Record<string,string>, subPrompts: Record<string,string>[] }`.

### 7.1 Contract

For each `AgentStage` in the main IR (and in every subIr), genPrompts produces one prompt entry in `prompts` (or `subPrompts[i]`) whose key is the AgentStage's `config.promptRef`.

Additionally, genPrompts may emit:
- `system/*` entries: any fragment referenced implicitly by userland assembly (e.g. shared invariants)
- `global-constraints`: if the pipeline defines pipeline-wide rules; key literally `global-constraints`, matches the Stage 1 whitelist

### 7.2 Prompt rewrite (`gen-prompts.md`)

The prompt teaches:

1. **For every AgentStage in ir + each subIrs[i]**: produce a markdown prompt. 30-80 lines, no JSON schema section, no fabricating fields not in `stage.outputs`.
2. **Inputs contract**: the prompt must explain the agent's inputs, which come directly from AgentStage.inputs port declarations. Each input is named on the stage; reference them by those names in the prompt body.
3. **Outputs contract**: the prompt must produce output ports declared in AgentStage.outputs via `write_port` MCP tool calls. The prompt gives one explicit example of write_port usage per stage (not hypothetical — literal syntax grounded in actual port names).
4. **`run_pipeline` recursion**: for any AgentStage whose contract (surfaced via pipelineDesign.subPipelineContracts.calledBy) indicates it invokes a sub-pipeline, include explicit instructions: "Call `run_pipeline(name='<exact sub pipeline name>', task=<constructed task description>, policy=?). Poll get_task_status. On completion, read_port to collect outputs. Write_port your own stage's outputs from the sub-pipeline's results."
5. **Tool scope**: derive from stage config — if stage has `allowedTools` set, repeat them in prompt; if not, say "full tool access".

### 7.3 `prompt-writer` sub-agent

Retained from old design. Its prompt is updated to teach kernel-next IR conventions (same changes as §7.2 apply to sub-agent's body). The sub-agent is given one AgentStage at a time and returns one prompt body.

## 8. `persisting` Stage — IR → SQLite

Input: `skeletonResult` + `promptBundle` + `pipelineDesign`.  
Output: `persistResult`.

### 8.1 Prompt (`persist.md`) — new file

The prompt:

1. Explains: your job is to submit all IRs + prompts to kernel-next and produce persistResult.
2. Enumerates submit order:
   - For each `subIrs[i]` in order: call `submit_pipeline(ir=subIrs[i], prompts=subPrompts[i])`. Capture versionHash. If diagnostics, fix (most likely by reconciling port names / prompt refs) and resubmit. Cap: 2 attempts per sub-pipeline.
   - Then call `submit_pipeline(ir=skeletonResult.ir, prompts=promptBundle.prompts)`. Capture versionHash. Up to 2 attempts.
3. Sanity-check: for every AgentStage's prompt body in `promptBundle.prompts` that contains a literal `run_pipeline(name=...)` call, verify the name is in the submitted subVersionHashes map. Mismatch → throw (do not attempt auto-fix; this is a genSkeleton/genPrompts coordination bug and should fail visibly).
4. On any submit returning diagnostics that the agent **cannot fix within 2 turns** (semantic errors, not syntax typos), throw via writing an error port or calling a failure-mode tool. Stage errors → task fails.
5. On all submits succeeding, write_port `persistResult` with versionHash, subVersionHashes, pipelineId (from ir.name slugified), pipelineName (from ir.name).

### 8.2 Syntax-fix latitude

The persisting agent is explicitly allowed to rewrite the IR or prompts to fix diagnostics like:
- `PROMPT_REF_MISSING` — add the missing prompt content (may be empty-placeholder if agent cannot infer it; agent is told: prefer real content; fall back to "TODO: fill in prompt for <stageName>" if inference impossible — and then throw because a placeholder prompt is a design bug)
- `PROMPT_REF_UNUSED` — remove the orphan prompt entry
- `WIRE_TARGET_PORT_MISSING` / `WIRE_SOURCE_PORT_MISSING` — adjust port names to match
- Zod type violations on ports — rewrite the port type string

The agent is **not** allowed to silently accept semantic-level errors:
- Missing stages / removed wires that would break the DAG
- Gate routing that leaves gates unanswerable
- Sub-pipeline references the agent cannot reconcile

These throw. Task fails; main Claude / user decides to reopen with a revised design or patch.

### 8.3 Why agent, not script

As established in §3.1, pipeline-generator's persist stage calling `submit_pipeline` is the same architectural pattern as any main-Claude session calling `run_pipeline`. Both cross into kernel via external MCP. Script would require a new "script can import KernelService" bridge that violates MCP surface separation.

## 9. Removed Artifacts

After this milestone:
- `apps/server/src/scripts/persist-pipeline.ts` — DELETED
- `apps/server/src/scripts/persist-pipeline.test.ts` — DELETED
- `apps/server/src/scripts/persist-pipeline.adversarial.test.ts` — DELETED
- Registration of `persist_pipeline` script in `apps/server/src/scripts/index.ts` — REMOVED
- `prompts/system/refine-prompts.md` — DELETED
- `prompts/system/report-generator.md` — DELETED (was already orphan per Stage 1 enumeration; prompts-in-sqlite left it whitelisted because it lives under `system/`; now deleted outright)

The `persist_pipeline` script registration removal may break tests or routes that reference `script_id: persist_pipeline`. Grep at plan time to confirm scope.

## 10. Converter Adjustments

Pipeline-generator itself is still a legacy YAML pipeline converted to kernel-next IR at module load. The structural changes in §4.2 must survive converter without new diagnostic failures. Specifically:

- Serialized `genSkeleton` → `genPrompts` (no longer in a parallel block): converter's `unwrapParallelBlocks` pass handles absence of parallel block fine (no-op).
- `refinePrompts` removal: converter should not emit a stage not present.
- `persisting` changes type from `script` to `agent`: converter already handles both types; no change needed.
- `genPrompts.reads.skeleton: skeletonResult` as a full-object read: converter's existing entry-level read path (the "展开成多端口" mode) handles this — each field of `skeletonResult` becomes an input port on `genPrompts`.

No converter code changes expected. If any diagnostic surfaces during conversion, report as blocker and fix in converter (small changes) rather than restructure the design.

## 11. Sub-Pipeline Name Consistency

An invariant maintained through three stages:

1. `analyzing` writes each sub-pipeline's name in `pipelineDesign.subPipelineContracts[i].name`
2. `genSkeleton` ensures `subIrs[i].name === subPipelineContracts[i].name` (prompt explicitly requires this)
3. `genPrompts` writes agent prompts that, where they include literal `run_pipeline(name='X', ...)` calls, reference exactly those names
4. `persisting` submits subIrs in order (each gets a versionHash), then verifies every `run_pipeline(name=...)` literal in main IR's prompts matches a submitted name

The chain is language-level (prompt convention) + one runtime check (§8.1 step 3). If a future milestone adds `propose_pipeline_change` usage to pipeline-generator (for editing an existing pipeline), this invariant shifts to patch diffs — out of scope.

## 12. Testing Strategy

### Unit tests

- No new code to unit-test except for removed artifacts (deletion of `persist-pipeline.ts` removes ~4 test files — expected)
- Converter regression: `apps/server/src/kernel-next/converter/pipeline-generator.test.ts` may need updating — pipeline-generator.yaml now has different stages; the test asserts convertLegacyYaml returns ok. Update the fixture expectation for the new stage names + removed stages.
- Prompt snapshot tests (if any): update — prompts now teach IR, not YAML.

### Integration tests

- `registerLegacyPipeline("pipeline-generator")` module-load path: must still submit clean (Stage 1 milestone invariant). Since only the YAML structure changed, not the contract interface, this should continue to work.
- Pipeline-generator's `start_pipeline_generator` MCP tool: test fixtures that invoke it need new seed expectations because the final persistResult shape changed (versionHash instead of savedFiles / yamlPath). Update expected output.

### End-to-end validation (manual)

- Start dev server, POST `start_pipeline_generator` with a representative task description (e.g. "create a 4-stage research pipeline with human review at stage 2")
- Answer the `awaitingConfirm` gate approve
- Observe: genSkeleton produces an ir + empty subIrs; genPrompts produces prompts Record; persisting submits and emits a versionHash
- Manually POST `/api/kernel/tasks/run` with `pipeline: <newly-generated pipeline's name>` — does the submitted pipeline actually run end-to-end?

The last bullet is the terminal acceptance — a pipeline-generator-generated pipeline must be runnable on kernel-next.

### Negative paths (manual)

- Intentionally garbled design (e.g. mis-typed port reference): verify persisting agent attempts fix, ideally succeeds; if unfixable, verify stage_error surfaces and task_state transitions to failed.

## 13. Known Limitations & Deferred Follow-ups

- **No retry feedback across stages.** If persisting exhausts its max_turns on validation failures, the task fails. Recovery path is: user reopens task with revised prompt, or (future) uses `propose_pipeline_change` on a partial IR. Not a regression — legacy pipeline-generator also had no cross-stage retry feedback for generation errors.
- **stageContracts as pre-IR semantic layer.** Requires `genSkeleton` to reliably translate. If translation fidelity is poor in practice, follow-up milestone adds a `validate_design` stage between analyzing and genSkeleton that checks contracts against IR-translatability.
- **Sub-pipeline contracts are declared at analyze-time.** pipeline-generator cannot discover the need for a sub-pipeline during genSkeleton and go back. If design needs adjustment, user rejects at awaitingConfirm gate.
- **prompt-writer sub-agent's quality.** Its prompt teaches IR vocabulary but prompt-level quality depends on downstream iteration. A separate quality-feedback milestone may follow once real pipeline-generator runs expose failure modes.
- **No post-persist smoke-run.** persisting submits and exits. Whether the generated pipeline actually runs is not verified in-pipeline. Future milestone may add a `smokeTest` stage that does a dry_run or a minimal-input run_pipeline to catch egregious bugs.

## 14. Non-Negotiables Checklist

Lifted from kernel-next-terminal-design §11.2:

- ✅ Kernel is executor-agnostic: persisting agent is just another agent; kernel sees no special behavior.
- ✅ IR does not encode policy: policy stays in ExecutionPolicy (budget goes through contract.budget → future ExecutionPolicy mapping, not inside IR).
- ✅ MCP surface claims are physical: persisting agent uses external `submit_pipeline`; internal MCP surface unchanged.
- ✅ Lineage is synchronous: genSkeleton's write_port / persisting's submit_pipeline both go through normal port_values persistence.
- ✅ Hot-update never silently migrates: not applicable — this milestone does not trigger migration; resubmits produce new versionHash, existing tasks stay on their snapshot.
- ✅ No mutable global state: all state in SQLite via existing tables.
- ✅ Zero legacy compatibility: legacy YAML persistence path (`config/pipelines/` writes) is deleted in this milestone. Existing `config/pipelines/` dirs on user machines become stale data; no migration written.

## 15. Self-Review Checklist

- [ ] Every success criterion in §1 is mapped to work in §4-§9
- [ ] Every store_schema change in §4.1 survives converter without new diagnostics (§10)
- [ ] Every removed artifact in §9 has corresponding grep to verify no live references remain
- [ ] `submit_pipeline` diagnostic codes referenced in §8.2 exist (checked against mcp/kernel.ts enum)
- [ ] stageContracts shape in §5.2 is complete (all fields used by genSkeleton in §6.1 are declared)
- [ ] Sub-pipeline name invariant (§11) is preserved at every stage that touches it
- [ ] No fragment of the spec relies on a kernel-next feature that does not exist (all features cited exist per Stage 1 landed code)
- [ ] Tests in §12 cover the success criteria; manual E2E is the terminal acceptance
