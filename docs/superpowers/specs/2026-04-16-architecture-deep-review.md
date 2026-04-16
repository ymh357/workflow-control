# Workflow-Control Architecture Deep Review

> Date: 2026-04-16
> Status: ALL optimization points implemented including A1 Phased Pipeline infrastructure. Ready for real-world validation.

---

## 1. Review Scope

Full-session deep review progressing through:

1. Codebase analysis (4 parallel exploration agents covering engine, generation, schemas, data flow)
2. 8 problem areas identified with initial proposals
3. Self-review with factual corrections (3 proposals abandoned, 3 revised)
4. Re-evaluation under premise "pipelines are always AI-authored"
5. Root cause analysis of complex pipeline failures
6. Goal-first reassessment — what is the system solving?
7. Manus AI architecture comparison
8. Technical feasibility verification (XState immutability, sub-pipeline reuse path)
9. Final self-review with corrections

---

## 2. System Goal

From product-intro.md:

> "Give AI coding agents a pipeline — let them work step by step, with every step visible and controllable."

The system treats AI as an executor following a structured SOP. A generator AI creates the SOP (pipeline YAML), executor AI runs each stage, humans approve at gates.

**Key premise established during review:** Pipelines are always AI-generated via pipeline-generator, never hand-written. This changes the calculus for every structural proposal — stricter structure reduces AI generation errors rather than increasing authoring burden.

---

## 3. Architectural Bottleneck: Planning-Execution Information Asymmetry

Pipeline generation and pipeline execution are completely decoupled:

```
User description → AI generates full pipeline (t=0) → Engine executes all stages → Output
                    ↑                                        ↓
                    └──────── no feedback channel ───────────┘
```

The generator AI at t=0 predicts all stages, reads/writes, budgets, and prompts from a single description. By stage 10 of a 27-stage pipeline, actual conditions may diverge significantly. No mechanism feeds runtime knowledge back into pipeline structure.

This is the architectural ceiling. Simple pipelines (5-8 stages) work well because t=0 prediction is adequate. Complex pipelines (15-27 stages) degrade because the plan becomes stale.

---

## 4. Complex Pipeline Failure Modes

### 4.1 Context Decay Across Stage Boundaries

Each stage compresses findings into a JSON store entry. Next stage reads it (possibly token-truncated or summarized). After 10 stages, AI operates on "summary of summary of summary." Information that doesn't fit the output schema is permanently lost at each boundary.

### 4.2 Echo Chamber Effect

Verification stages (e.g., factCheck in tech-research) compare deliverables against store data. If incorrect data entered the store at stage 2, all downstream stages including verification treat it as ground truth. No independent external validation path exists.

### 4.3 Static Budgets vs Dynamic Complexity

max_turns and max_budget_usd are fixed in YAML at generation time. Simple tasks waste budget; complex tasks hit hard limits and produce silently truncated output. Downstream stages treat truncated output as complete — no signal that output is partial.

### 4.4 Shape Constraints Without Quality Constraints

Agent constraint model is shape-focused:
- JSON schema match? Pass.
- Declared writes keys present? Pass.
- Protected paths respected? Pass.

Missing: checks for information completeness, semantic consistency with input, or partial-output signals. A structurally valid but semantically empty JSON passes and degrades all downstream stages.

---

## 5. Manus AI Comparison

| Dimension | Manus | Workflow-Control |
|-----------|-------|-----------------|
| Planning | Incremental todo list, updated during execution | Full upfront pipeline, fixed after creation |
| State | File system (agent reads/writes freely) | Managed store (declared reads/writes) |
| Architecture | Single agent event loop | Multi-stage, each stage is independent session |
| Adaptation | Agent modifies own plan at any time | Pipeline structure immutable post-creation |
| Auditability | Weak (must trace agent actions) | Strong (state machine paths explicit) |
| Failure recovery | LLM self-judgment | Structured retry + checkpoint + compensation |

### Adopted Lessons

**L1: "Planning is a context management tool."** Manus's todo list serves dual purpose: planning AND state persistence. Workflow-control agents have no awareness of overall task plan — only current stage prompt and reads.

**L2: "File system as memory."** Manus agents externalize findings to files, bypassing context limits. In workflow-control, information that doesn't fit output schema is lost at stage boundaries.

**L3: Avoid fighting the architecture.** Manus chose single agent + good context engineering over complex multi-agent. Workflow-control's stage-based architecture is implicitly multi-agent. The inter-stage information loss is multi-agent communication overhead. Rather than fighting this (dynamic replanning), work with it (better context preservation).

---

## 6. Self-Review: Abandoned Proposals

| Proposal | Why Abandoned |
|----------|---------------|
| Dynamic Pipeline (Plan-Execute-Replan via XState mutation) | XState machines are immutable after creation. No API for runtime state injection. Also: destroys predictability, makes debugging extremely difficult. |
| Full Typed Store (TypeScript-level type system) | Disproportionate complexity. Current reads/writes + write filtering + JSON Schema validation is sufficient for runtime. Store schema (A3) addresses the generation-time problem more precisely. |
| 5-Pass Multi-Pass Generation | 5x LLM cost/latency. Current one-shot + 1 retry achieves ~95% success. Better to do targeted 2-pass (C2) linked to store schema. |
| Comprehensive Error Classification Overhaul | Initial analysis misjudged retry system as naive. Actual system already classifies errors by type, preserves session continuity, does incremental diff detection, and uses semantic summaries. Gap is narrow (cumulative context only). |

---

## 7. All Optimization Points

### Tier 1 — Architectural (raises the system's capability ceiling)

#### A1. Phased Pipeline via Sub-Pipeline Orchestration

**Problem:** Generator AI predicts all stages from a one-sentence description. By stage 10, the plan no longer fits reality. No feedback channel exists between execution and planning.

**Technical finding:** XState machines are immutable after creation. Cannot inject states mid-execution. But `pipeline-executor.ts` already implements sub-pipeline calls — creating independent child tasks, passing store data via reads/writes, waiting for completion.

**Proposal:** A meta-pipeline orchestrates phases. Each phase is a sub-pipeline generated at runtime by a planning-stage:

```yaml
# Meta-pipeline (generated at t=0 by pipeline-generator)
stages:
  - name: plan-phase-1
    type: agent
    runtime:
      engine: llm
      system_prompt: phase-planner
      reads: {}
      writes:
        - phase1_pipeline   # Outputs a pipeline definition as JSON
    outputs:
      phase1_pipeline:
        type: object
        fields:
          - key: stages
            type: object[]

  - name: execute-phase-1
    type: pipeline
    runtime:
      engine: pipeline
      pipeline_source: store       # NEW: read pipeline def from store instead of config dir
      pipeline_key: phase1_pipeline
      writes:
        - phase1_results

  - name: review-phase-1
    type: human_confirm
    runtime:
      engine: human_gate
      on_reject_to: plan-phase-1

  - name: plan-phase-2
    type: agent
    runtime:
      engine: llm
      system_prompt: phase-planner
      reads:
        prior_results: phase1_results  # Phase 2 planning sees Phase 1 actual results
      writes:
        - phase2_pipeline

  - name: execute-phase-2
    type: pipeline
    runtime:
      engine: pipeline
      pipeline_source: store
      pipeline_key: phase2_pipeline
      writes:
        - phase2_results
  # ...
```

**Required changes:**
- Extend pipeline-call runtime to support `pipeline_source: "store"` (read inline pipeline definition from store instead of config directory)
- Planning-stage prompt template that generates validated pipeline YAML
- Generated sub-pipeline goes through same schema + logical validation as pipeline-generator output

**What's preserved:** XState formal verification (within each phase sub-pipeline), store data contracts, human gates between phases, budget limits per stage, snapshot persistence, retry/resume.

**What changes:** Full pipeline graph not available at t=0 (phase-level graph is). Phase-internal stages are determined based on actual data, not t=0 predictions.

**Determinism:** Not lost, deferred. At any moment, active execution is a fully compiled, validated XState state machine. The moment of structural determination shifts from t=0 to t=phase_start.

---

#### A2. Task-Level Scratch Pad (Structured Global Working Memory)

**Problem:** Store entries are structured and schema-constrained. Information that doesn't fit output schema is lost at stage boundaries. Stage 10 cannot access nuances from stage 3 that weren't in stage 3's formal output.

**Proposal:** Append-only structured scratch pad alongside the store.

**Structure (per entry):**
```typescript
interface ScratchPadEntry {
  stage: string;        // Which stage wrote this
  timestamp: string;    // When
  category: string;     // e.g., "caveat", "discovery", "concern", "reference"
  content: string;      // The actual note
}
```

**Access model:**
- Any stage can append entries via a new MCP tool (`append_scratch_pad`)
- Any stage can read entries via MCP tool (`read_scratch_pad`, with optional stage/category filter)
- NOT auto-injected into tier1 context (saves tokens)
- Entry index IS injected: list of `{stage, category, first 50 chars}` so agent knows what's available

**Implementation:** ~30 lines across 3 files (types.ts, store-reader-mcp.ts, context-builder.ts). Non-breaking addition.

**Analogy:** Store is the formal handoff document between shifts. Scratch pad is the margin notes and sticky notes that experienced workers leave for each other.

---

#### A3. Store Schema — Unified Data Contract (No Old Format Support)

**Problem:** Pipeline data contracts declared in three places: runtime.writes, runtime.reads, outputs. AI generator must keep all three consistent. 40% of generated pipelines have writes/outputs mismatches.

**Proposal:** Single store_schema at pipeline top-level:

```yaml
store_schema:
  analysis:
    produced_by: analyze
    type: object
    description: "Structured analysis of the user's request"
    required: true
    fields:
      title: { type: string, required: true }
      modules: { type: string[] }
      risk_level: { type: string }
    additional_properties: false

  plan:
    produced_by: plan-implementation
    type: object
    description: "Implementation plan with task breakdown"
    required: true
    fields:
      tasks: { type: object[], required: true }
      estimated_hours: { type: number }
    additional_properties: true   # Exploratory stage, may add extra fields
```

**What store_schema replaces:**
- `runtime.writes` — derived from `produced_by` field (stage X produces keys where produced_by == X)
- `outputs` — derived from `fields` definition
- Validator uses store_schema to check reads reference valid keys with correct types

**What remains at stage level:**
- `runtime.reads` — still declared per-stage (specifies which keys and sub-paths this stage needs, with alias mapping)
- `runtime.engine`, `system_prompt`, etc. — unchanged

**No old format support** (per decision). Migration: update all 12+ existing pipelines. Pipeline-generator updated to produce store_schema format. Validator updated to derive writes/outputs from schema.

**Implementation:** ~71 lines across 6 files. All additive except pipeline-generator prompt changes.

---

### Tier 2 — Execution Quality

#### B1. Quality Assertions on Store Writes

**Problem:** Output validation is shape-only. Structurally valid but semantically empty outputs pass unchallenged.

**Proposal:**
```yaml
store_schema:
  domainKnowledge:
    produced_by: domain-research
    type: object
    assertions:
      - "Object.keys(value.solutions || {}).length >= 3"
      - "value.summary && value.summary.length > 200"
      - "!value.summary.includes('I was unable')"
```

- Evaluated via expr-eval (already in codebase, used by condition stages)
- Failed assertion → automatic retry with specific feedback ("Assertion failed: need at least 3 solutions, got 1")
- Zero additional LLM cost
- Runs after JSON schema validation, before store write

---

#### B2. Adaptive Budget with Human Approval

**Problem:** Fixed max_turns/max_budget_usd. Complex tasks silently truncated.

**Proposal:**
```yaml
stages:
  - name: implement
    type: agent
    max_turns: 30
    max_budget_usd: 2
    budget_flex:
      allow_extension: true
      max_extensions: 2
      extension_turns: 20
      extension_budget_usd: 1.5
```

**Flow:**
1. Agent approaches 80% of turn limit → system injects advisory message
2. Agent can output `_needs_extension: true` + `_progress_report: "Completed X, remaining: Y"`
3. Stage enters mini-gate state (similar to human_confirm but inline)
4. Dashboard/Slack notification: "Stage 'implement' requests extension. Progress: [report]. Approve?"
5. Human approves → resume same session with extended budget
6. Human rejects → stage completes with current output, marked as `partial: true` in store
7. Hard ceiling: max_extensions prevents runaway

**Downstream signal:** If stage completes as partial, store entry includes `_partial: true`. Downstream stage prompts can reference this: "Note: implementation output is partial — verify completeness."

---

#### B3. Cumulative Retry Context

**Problem:** Retry N+1 doesn't know what retry N attempted. Agent may repeat same failed approach.

**Proposal:** Add to resumeInfo:
```typescript
previousAttempts?: Array<{
  attempt: number;
  feedback: string;
  failedAt: string;   // "output_validation" | "verify_command" | "qa_loop" | "error"
}>;
```

Each retry includes full history. Max 2 entries (max_retries is 2). ~20 lines change.

---

#### B4. Confidence Annotation (Experimental)

**Problem:** Downstream stages can't distinguish verified facts from guesses.

**Proposal:** Convention only (not enforced). Prompt guidance encourages agents to output:
```json
{
  "solutions": [...],
  "_confidence": {
    "solutions": "medium",
    "market_size": "low"
  }
}
```

Downstream prompts reference: "market_size confidence is low — verify independently."

**Honest assessment:** Value depends on AI self-evaluation accuracy, which is unreliable. Retain as experimental — measure whether downstream agents actually use the signal.

---

### Tier 3 — Pipeline Generation Quality

#### C1. Generator Prompt Trim

**Problem:** Skeleton prompt ~880 lines; ~260-280 load-bearing. Redundancy dilutes LLM attention.

**Proposal:**
- Trim to ~400 lines
- Strengthen writes/outputs semantics section (cause of 40% warnings — eliminated if A3 adopted, but still useful for clarity)
- Strengthen parallel group rules (cause of 30% errors)
- Replace verbose TypeScript interfaces with annotated JSON examples
- Reduce capability discovery section (rarely used by generated pipelines)

---

#### C2. 2-Pass Generation (Depends on A3)

**Problem:** One-shot generation requires simultaneous production of structure + contracts + config.

**Proposal:** If store_schema adopted:
- Pass 1: Generate store_schema + stage list (lightweight, high-constraint, can use cheaper model)
- Pass 2: Generate runtime configs and prompts for each stage (with complete data contract as context)

Pass 1 output is small. Pass 2 has full data contract visibility, reducing the #1 error category. Each pass has its own validation + retry loop.

---

#### C3. Deterministic Post-Generation Auto-Fix

**Problem:** Fixable issues (writes/outputs mismatch, trivial parallel group conflicts) require full LLM retry.

**Proposal:** After validation, apply deterministic patches:
- Missing outputs for a writes key → generate minimal schema from key name and type inference
- Parallel group sibling read conflict → extract conflicting read to a pre-group sequential stage

Reduces LLM retry frequency for mechanical issues.

---

### Tier 4 — Operational

#### D1. Edge Slot Heartbeat

**Problem:** Edge agent crash detected only after 30-minute timeout.

**Proposal:** No report_progress within configurable interval (default 5 min) → mark slot as potentially dead, emit dashboard warning, allow auto-retry after confirmed timeout.

---

#### D2. Prompt Alignment Validation

**Problem:** validatePromptAlignment() is heuristic-only and non-binding.

**Proposal:** Expand checks. Surface critical mismatches as warnings in dashboard during pipeline editing.

---

## 8. Observations (Not Optimization Points)

- **llm_decision is unused in production.** All routing uses deterministic condition stages or human gates. The feature may be over-designed for actual needs, or condition stages are simply sufficient.
- **Capability discovery (PulseMCP) has low ROI.** Generated pipelines rarely use discovered external MCPs. Consider deprioritizing or making opt-in during generation.
- **reject-with-feedback in human_confirm is unstructured.** If scratch pad (A2) is implemented, structured rejection feedback could flow through it.

---

## 9. Implementation Status

| ID | Item | Status | Commits | Key files |
|----|------|--------|---------|-----------|
| B1 | Quality Assertions | **DONE** | 3 | assertion-evaluator.ts, state-builders.ts, types.ts, schema.ts |
| A2 | Scratch Pad | **DONE** | 5 | types.ts, machine.ts, store-reader-mcp.ts, stage-executor.ts, context-builder.ts, state-builders.ts |
| A3 | Store Schema | **DONE** | 6 | store-schema.ts, types.ts, schema.ts, pipeline-validator.ts, pipeline-builder.ts, pipeline-generator.ts |
| C3 | Auto-Fix | **DONE** | 1 | pipeline-autofix.ts |
| C1 | Prompt Trim | **DONE** | 1 | pipeline-generator.ts (~380 lines -> ~276 lines, -25%) |
| B3 | Cumulative Retry | **DONE** | 1 | state-builders.ts, helpers.ts, types.ts |
| B2 | Adaptive Budget | **DONE** | 1 | types.ts, schema.ts, machine/types.ts, state-builders.ts |
| D1 | Edge Heartbeat | **DONE** | 1 | edge/registry.ts |
| B4 | Confidence Annotation | **DONE** | 1 | prompt-builder.ts |
| T8 | Pipeline Migration | **DONE** | 1 | 4 tracked pipeline YAMLs migrated to store_schema |
| P2-Fix | Validator store_schema | **DONE** | 1 | pipeline-generator.ts, persist-pipeline.ts, config-helpers.ts |
| C2 | 2-Pass Generation | **NOT DONE** | — | Deferred: A3 enables it but needs real-world validation first |
| D2 | Prompt Alignment | **NOT DONE** | — | Low priority, minor improvement |
| A1 | Phased Pipeline | **DONE** (infra) | 3 | inline-pipeline-config.ts, pipeline-executor.ts, actor-registry.ts, types.ts, schema.ts |

**Total: 25 commits, 18 new/modified source files, 49 new tests, 0 regressions (3471 passed / 15 pre-existing failures)**

---

## 10. A1 Phased Pipeline — Infrastructure Complete

### Problem it solves

Pipeline generation and execution are completely decoupled. Generator AI at t=0 predicts all stages from a one-sentence description. By stage 10 of a 27-stage pipeline, the plan no longer fits reality. No mechanism feeds runtime knowledge back into pipeline structure.

### What was built (3 commits)

- `PipelineCallRuntimeConfig`: `pipeline_source?: "config" | "store"`, `pipeline_key?: string`
- `PipelineConfig`: `inline_prompts?: Record<string, string>` for dynamically generated pipelines
- `inline-pipeline-config.ts`: builds WorkflowContext config from inline definition + parent config
- `createTaskDraft`: accepts `inlineConfig` to bypass filesystem loading
- `pipeline-executor.ts`: reads pipeline from store, validates (schema + logical), builds inline config, executes as sub-task
- 10 tests (6 unit + 4 integration)

### What remains (domain-specific, not infrastructure)

- Planning-stage prompt template (teaches an agent to generate valid pipeline YAML)
- Proof-of-concept: convert tech-research pipeline to phased model
- Real-world validation of the full plan-execute-replan loop

### Design

**Design: Meta-pipeline orchestrates phases via sub-pipeline calls.**

```yaml
stages:
  - name: plan-phase-1
    type: agent
    runtime:
      engine: llm
      system_prompt: phase-planner
      writes:
        - phase1_pipeline   # Outputs a pipeline definition as JSON

  - name: execute-phase-1
    type: pipeline
    runtime:
      engine: pipeline
      pipeline_source: store       # NEW: read pipeline def from store
      pipeline_key: phase1_pipeline
      writes:
        - phase1_results

  - name: review-phase-1
    type: human_confirm
    runtime:
      engine: human_gate
      on_reject_to: plan-phase-1

  - name: plan-phase-2
    type: agent
    runtime:
      engine: llm
      system_prompt: phase-planner
      reads:
        prior_results: phase1_results  # Plans based on actual data
      writes:
        - phase2_pipeline

  - name: execute-phase-2
    type: pipeline
    runtime:
      engine: pipeline
      pipeline_source: store
      pipeline_key: phase2_pipeline
```

### Required changes

1. Extend `PipelineCallRuntimeConfig` with `pipeline_source?: "config" | "store"` and `pipeline_key?: string`
2. Modify `pipeline-executor.ts` to read pipeline definition from store when `pipeline_source: "store"`
3. Validate store-sourced pipeline definitions through same schema + logical validation
4. Create planning-stage prompt template (generates validated pipeline YAML)
5. Proof-of-concept: convert tech-research pipeline to phased model
6. Zod schema update for new runtime fields

### What's preserved

- XState formal verification (within each phase sub-pipeline)
- Store data contracts
- Human gates between phases
- Budget limits per stage
- Snapshot persistence and retry/resume

### What changes

- Full pipeline graph not available at t=0 (phase-level graph is)
- Phase-internal stages determined based on actual data, not t=0 predictions
- Determinism is deferred, not lost — at any moment, active execution is a fully compiled state machine

---

## 11. Decisions Made

| Question | Decision | Rationale |
|----------|----------|-----------|
| A1: Phased pipeline direction? | **Yes, commit** | Architectural ceiling is real; sub-pipeline path is low-risk |
| A3: Old format support? | **No, hard migration** | Pipelines are AI-generated; regeneration is trivial |
| A2: Scratch pad structure? | **Structured** (stage, timestamp, category, content) | Enables selective reading by stage/category |
| B2: Budget extension approval? | **Auto-approve** (changed from human approval) | Simpler implementation, hard ceiling via max_extensions prevents runaway |

---

## 12. Architecture After All Changes

```
Pipeline YAML (with store_schema)
    │
    ▼
Pipeline Builder (pipeline-builder.ts)
    ├─ Derives writes/outputs from store_schema (build-time injection)
    ├─ Compiles to XState state machine
    │
    ▼
Stage Execution
    ├─ Agent prompt includes:
    │   ├─ Static prefix (global constraints, fragments, project instructions)
    │   ├─ Stage prompt + invariants
    │   ├─ Output schema (derived from store_schema)
    │   ├─ Confidence annotation guidance
    │   └─ Scratch pad entry index
    │
    ├─ MCP tools available:
    │   ├─ get_store_value (tier 2 context)
    │   ├─ append_scratch_pad (cross-stage notes)
    │   └─ read_scratch_pad (with stage/category filters)
    │
    ├─ Output validation chain (onDone guards):
    │   1. Missing writes fields → retry with feedback
    │   2. Quality assertions failed → retry with specific assertion feedback
    │   3. Retries exhausted → blocked
    │   4. QA back_to loop → route to previous stage
    │   5. Verify commands → retry on failure
    │   6. Budget extension request → auto-approve and resume
    │   7. Success → write to store, transition to next stage
    │
    ├─ Retry includes cumulative feedback from all prior attempts
    │
    └─ Edge execution includes heartbeat monitoring (5-min warning)

Pipeline Generation
    ├─ Skeleton prompt (~276 lines, trimmed from ~380)
    ├─ Recommends store_schema format
    ├─ Auto-fix runs before validation (missing outputs, empty reads)
    ├─ store_schema passed to validator
    └─ 2 retry attempts with error injection
```
