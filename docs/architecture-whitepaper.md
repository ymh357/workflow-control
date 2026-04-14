# Workflow Control: Technical Architecture Whitepaper

> Version 1.0 | 2026-04-14

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Overview](#2-system-overview)
3. [Architecture Topology](#3-architecture-topology)
4. [Workflow Engine Core](#4-workflow-engine-core)
5. [Stage Type System](#5-stage-type-system)
6. [Data Flow & Store Model](#6-data-flow--store-model)
7. [Prompt Engineering Architecture](#7-prompt-engineering-architecture)
8. [Execution Modes](#8-execution-modes)
9. [Error Handling & Recovery](#9-error-handling--recovery)
10. [Human-in-the-Loop](#10-human-in-the-loop)
11. [Pipeline DSL & Validation](#11-pipeline-dsl--validation)
12. [Observability & Real-time Streaming](#12-observability--real-time-streaming)
13. [Persistence & State Recovery](#13-persistence--state-recovery)
14. [Registry & Extension System](#14-registry--extension-system)
15. [Security Model](#15-security-model)
16. [Known Deficiencies & Honest Assessment](#16-known-deficiencies--honest-assessment)
17. [Comparison with Alternatives](#17-comparison-with-alternatives)
18. [Conclusion](#18-conclusion)

---

## 1. Executive Summary

Workflow Control is an AI agent orchestration system that coordinates LLM agents (Claude, Gemini, Codex) through multi-stage pipelines using formally verified state machines. The system's core thesis is that **AI workflow orchestration is fundamentally a state machine problem** — and that adopting a proven formal state management framework (XState v5) rather than ad-hoc orchestration yields superior reliability, debuggability, and recoverability.

The system enables:

- **Declarative pipeline definitions** via YAML DSL with 7 stage types
- **Multi-engine agent execution** across Claude, Gemini, and Codex within a single pipeline
- **Formal state transitions** via XState v5 state machines with typed events
- **Human-in-the-loop gates** with Slack integration and feedback routing
- **Git-native isolation** via worktrees for parallel and foreach execution
- **Cost-controlled budgets** per stage with automatic enforcement
- **Edge execution** enabling distributed agent runs outside the orchestrator process

---

## 2. System Overview

### 2.1 Monorepo Structure

```
workflow-control/
├── apps/
│   ├── server/           # Hono REST API + XState v5 workflow engine
│   ├── web/              # Next.js 16 dashboard (React 19)
│   └── slack-cli-bridge/ # Slack Socket Mode integration
├── packages/
│   └── shared/           # TypeScript type contracts (Zod v4 validated)
├── registry/             # Pipeline/skill/hook/fragment package store
├── docs/                 # Architecture documentation
└── scripts/              # Utility scripts
```

### 2.2 Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Workflow Engine | XState v5.28 | Formal state machines with typed events, serializable snapshots |
| HTTP Server | Hono 4.12 | Lightweight, edge-compatible, TypeScript-native |
| Agent SDK | @anthropic-ai/claude-agent-sdk 0.2.x | Session persistence, tool use, streaming |
| Terminal I/O | node-pty 1.1 | Pseudo-terminal for CLI agent execution |
| Validation | Zod v4.3 | Runtime schema validation for pipeline configs |
| Database | SQLite (WAL mode) | SSE history, pending questions, edge slots |
| Frontend | Next.js 16 + React 19 | Dashboard with SSE-driven real-time updates |
| DAG Visualization | @xyflow/react 12 + dagre | Interactive pipeline graph rendering |
| Logging | Pino 10.3 | Structured JSON logging with per-task loggers |
| Package Manager | pnpm workspaces | Monorepo dependency management |

---

## 3. Architecture Topology

```
┌──────────────────────────────────────────────────────────┐
│                     Web Dashboard                        │
│              (Next.js 16, React 19, SSE)                 │
│   ┌──────────┐ ┌──────────────┐ ┌────────────────────┐   │
│   │ Task List│ │ Task Monitor │ │ Pipeline Editor    │   │
│   │ (SSE)    │ │ (SSE Stream) │ │ (Monaco + Mermaid) │   │
│   └────┬─────┘ └──────┬───────┘ └────────┬───────────┘   │
└────────┼──────────────┼─────────────────┼────────────────┘
         │              │                 │
    ┌────▼──────────────▼─────────────────▼────────────────┐
    │                  Hono REST API                        │
    │    /api/tasks  /api/tasks/:id/events  /api/config     │
    ├──────────────────────────────────────────────────────┤
    │              Workflow Engine (XState v5)              │
    │  ┌──────────┐ ┌────────────┐ ┌───────────────────┐   │
    │  │ Machine  │ │ Pipeline   │ │ State Builders    │   │
    │  │ Factory  │ │ Builder    │ │ (per stage type)  │   │
    │  └────┬─────┘ └──────┬─────┘ └────────┬──────────┘   │
    │       │              │                │              │
    │  ┌────▼──────────────▼────────────────▼──────────┐   │
    │  │              Actor Registry                    │   │
    │  │  runAgent | runScript | runEdgeAgent           │   │
    │  │  runPipelineCall | runForeach | runLlmDecision │   │
    │  └──────────────────┬────────────────────────────┘   │
    ├─────────────────────┼────────────────────────────────┤
    │  ┌──────────────────▼────────────────────────────┐   │
    │  │            Execution Layer                     │   │
    │  │  ┌──────────┐ ┌─────────┐ ┌───────────────┐   │   │
    │  │  │ Claude   │ │ Gemini  │ │ Codex         │   │   │
    │  │  │ Agent SDK│ │ CLI/pty │ │ CLI/pty       │   │   │
    │  │  └──────────┘ └─────────┘ └───────────────┘   │   │
    │  └───────────────────────────────────────────────┘   │
    ├──────────────────────────────────────────────────────┤
    │  ┌──────────────┐ ┌──────────┐ ┌────────────────┐   │
    │  │ SSE Manager  │ │ SQLite   │ │ Git Checkpoint │   │
    │  │ (per-task)   │ │ (WAL)    │ │ (compensation) │   │
    │  └──────────────┘ └──────────┘ └────────────────┘   │
    └──────────────────────────────────────────────────────┘
         │
    ┌────▼─────────────────────────────────────────────────┐
    │                   MCP Server (:3001)                  │
    │   trigger_task | get_stage_context | submit_result    │
    │   confirm_gate | get_task_status | report_progress    │
    └────┬─────────────────────────────────────────────────┘
         │
    ┌────▼─────────────────────────────────────────────────┐
    │                   Edge Runner                         │
    │   Isolated pty sessions per stage                     │
    │   Transcript sync (JSONL → SSE events)               │
    │   Hook-based interrupt checking                       │
    └──────────────────────────────────────────────────────┘
```

---

## 4. Workflow Engine Core

### 4.1 XState v5 as the Foundation

Every task is an independent XState v5 state machine instance. The pipeline YAML is compiled into a state machine definition at task creation time via `createWorkflowMachine(pipeline)`. This compilation is deterministic — the same pipeline config always produces the same machine structure.

**Machine lifecycle:**

```
idle → [stages...] → completed
  ↓                    ↑
  └──── error ─────────┘
  └──── blocked ──(RETRY/RESUME)──→ [stage]
  └──── cancelled ──(RESUME)──→ [stage]
```

**Global events** handled at the machine root level:
- `CANCEL`: Transition to `cancelled` from any non-terminal state
- `INTERRUPT`: Transition to `blocked` with reason and agent cancellation
- `UPDATE_CONFIG`: Hot-update pipeline config without restarting
- `RETRY` / `RETRY_FROM`: Resume from `blocked` state
- `SYNC_RETRY`: Resume with existing session ID
- `RESUME`: Resume from `cancelled` state

### 4.2 Context Model

```typescript
interface WorkflowContext {
  taskId: string;
  taskText?: string;
  status: string;                              // Current state name
  store: Record<string, any>;                  // Shared data store
  worktreePath?: string;                       // Git worktree directory
  branch?: string;                             // Git branch name
  retryCount: number;                          // Global retry counter
  stageRetryCount: Record<string, number>;     // Per-stage retry counters
  stageSessionIds: Record<string, string>;     // Claude session IDs
  stageCheckpoints: Record<string, StageCheckpoint>;  // Git HEAD snapshots
  totalCostUsd?: number;                       // Accumulated cost
  totalTokenUsage?: TokenUsage;                // Token counters
  config?: {
    pipelineName: string;
    pipeline: PipelineConfig;
    prompts: { system, fragments, globalConstraints, ... };
    skills: string[];
    mcps: string[];
  };
}
```

### 4.3 Machine Compilation

`buildPipelineStates()` in `pipeline-builder.ts` transforms the pipeline YAML into XState state definitions:

1. **Linear stages** become sequential states with automatic transitions
2. **Parallel groups** become XState `type: "parallel"` states with concurrent regions
3. **`depends_on` declarations** are topologically sorted into parallel levels
4. **Routing targets** (`on_reject_to`, `on_approve_to`, `back_to`) become guard-conditional transitions

`derivePipelineLists()` pre-computes which stages are retryable and resumable, generating the guard arrays for `RETRY`/`RETRY_FROM`/`RESUME` events in the `blocked` and `cancelled` states.

### 4.4 Actor Registry

Each stage type maps to a registered XState actor (invoked service):

| Stage Type | Actor | Execution Model |
|-----------|-------|-----------------|
| `agent` | `runAgent` / `runEdgeAgent` | Claude Agent SDK or pty-spawned CLI |
| `script` | `runScript` | Deterministic TypeScript function |
| `human_confirm` | (none — waits for event) | Paused until `CONFIRM`/`REJECT` |
| `condition` | (inline guard evaluation) | Synchronous expression eval |
| `pipeline` | `runPipelineCall` | Nested XState machine |
| `foreach` | `runForeach` | Iterative sub-pipeline invocations |
| `llm_decision` | `runLlmDecision` | Single Claude API call (not Agent SDK) |

---

## 5. Stage Type System

### 5.1 Agent Stage

The primary stage type. Invokes an LLM agent with a layered prompt, tool access via MCP, and structured output validation.

**Key configuration fields:**
```yaml
- name: implement
  type: agent
  engine: claude              # claude | gemini | codex
  model: claude-opus-4        # Optional model override
  max_budget_usd: 2.00        # Cost ceiling
  max_turns: 50               # Tool use turn limit
  thinking: true              # Extended thinking enabled
  effort: high                # Thinking effort level
  interactive: true           # Allow mid-execution human questions
  permission_mode: auto       # auto | plan | bypassPermissions
  mcps: [github, filesystem]  # MCP servers to attach
  runtime:
    system_prompt: implement  # Prompt file reference
    reads:
      plan: store.implementation_plan
      context: store.gathered_context
    writes:
      - key: implementation_result
        strategy: replace
      - key: code_changes
        strategy: append
    verify_commands:
      - command: "npx tsc --noEmit"
        policy: must_pass
    retry:
      max_retries: 2
      back_to: planning       # QA feedback routing target
    compensation:
      strategy: git_reset     # Rollback on failure
```

**Execution flow:**
1. Build 6-layer prompt via `prompt-builder.ts`
2. Build Tier 1 context from declared `reads`
3. Launch Claude Agent SDK session (or resume existing)
4. Stream tool use events to SSE
5. Parse structured output from agent response
6. Validate output against declared `writes`
7. Execute `verify_commands` if configured
8. Apply write strategies to store

### 5.2 Script Stage

Deterministic automation without LLM involvement. Six built-in scripts plus user-defined custom scripts.

**Built-in scripts:**
| Script | Purpose |
|--------|---------|
| `git-worktree` | Create isolated worktree + branch |
| `create-branch` | Minimal branch creation |
| `build-gate` | TypeScript/lint validation |
| `pr-creation` | GitHub PR automation |
| `notion-sync` | Notion page status updates |
| `persist-pipeline` | State persistence with git integration |

### 5.3 Human Confirm (Gate) Stage

Pauses execution until human approval. Supports Slack notifications and feedback routing.

```yaml
- name: review_gate
  type: human_confirm
  runtime:
    notify:
      type: slack
      template: "Review needed for {{store.pr_url}}"
    on_approve_to: deploy        # Next stage on approval
    on_reject_to: implement      # Route back on rejection
    max_feedback_loops: 3        # Max reject-implement cycles
```

**Event handling:**
- `CONFIRM` → transitions to `on_approve_to` (or next sequential stage)
- `REJECT` → transitions to `on_reject_to` (or error)
- `REJECT_WITH_FEEDBACK` → stores feedback, routes to `on_reject_to` with context

### 5.4 Condition Stage

Expression-based branching using `expr-eval` library over store values.

```yaml
- name: check_complexity
  type: condition
  runtime:
    reads:
      analysis: store.analysis_result
    branches:
      - when: "analysis.complexity > 8"
        to: deep_review
      - when: "analysis.has_tests == false"
        to: add_tests
      - default: true
        to: quick_review
```

### 5.5 LLM Decision Stage

LLM-powered routing for decisions too nuanced for expression evaluation.

```yaml
- name: route_approach
  type: llm_decision
  runtime:
    prompt: "Given this codebase analysis, which approach is best?"
    reads:
      analysis: store.codebase_analysis
    choices:
      - id: refactor
        description: "Major refactoring needed"
        goto: refactor_stage
      - id: patch
        description: "Simple patch sufficient"
        goto: patch_stage
    default_choice: patch
```

Uses a single Claude Sonnet API call (not the Agent SDK) for fast, low-cost decisions.

### 5.6 Pipeline Call Stage

Invokes a sub-pipeline as a nested workflow.

```yaml
- name: run_sub_workflow
  type: pipeline
  runtime:
    pipeline_name: code-review-pipeline
    reads:
      code_changes: store.implementation_result
    writes:
      - key: review_result
```

Data flows: parent `reads` → sub-pipeline initial store; sub-pipeline `writes` → parent store.

### 5.7 Foreach Stage

Iterates over an array with optional worktree isolation per item.

```yaml
- name: process_files
  type: foreach
  runtime:
    items: store.file_list
    item_var: current_file
    pipeline_name: process-single-file
    isolation: worktree          # Each item gets isolated git worktree
    max_concurrency: 3           # Up to 3 parallel items
    collect_to: processed_results
    item_writes: [result, changes]
    on_item_error: continue      # Don't fail entire foreach on item error
    reads:
      config: store.processing_config
```

**Isolation modes:**
- `shared`: All items share the same working directory (sequential only)
- `worktree`: Each item gets an isolated git worktree + branch; branches preserved for later integration

---

## 6. Data Flow & Store Model

### 6.1 Store Architecture

The store is a flat key-value dictionary (`Record<string, any>`) on the workflow context, shared across all stages. Stages declare their data dependencies explicitly:

```
reads: { alias: "store.path.to.value" }   → Input declaration
writes: [{ key: "field", strategy: "..." }] → Output declaration
```

### 6.2 Write Strategies

| Strategy | Behavior | Use Case |
|----------|----------|----------|
| `replace` | Overwrite entire value | Default; single-producer fields |
| `append` | Concatenate arrays | Multi-producer aggregation |
| `merge` | Shallow object merge | Incremental property addition |

### 6.3 Tiered Context Injection

Context is delivered to agents in two tiers to manage token budgets:

**Tier 1 (System Prompt Injection):**
- Token budget: ~8000 tokens (configurable)
- Includes declared `reads` values
- Compression cascade:
  1. Full inline JSON (if ≤ 8000 chars and fits budget)
  2. Semantic summary (LLM-generated, cached)
  3. Mechanical summary (`field.__summary` in store)
  4. Field preview (first 5 fields + truncation indicator)
  5. Summarized view (first 20 fields, 80-char value truncation)

**Tier 2 (On-Demand MCP):**
- Available via `get_store_value(key)` MCP tool
- No token budget constraint
- Full JSON returned
- Listed as "Other Available Context" in agent prompt

### 6.4 Parallel Write Safety

Within parallel groups, direct store writes would race. The system uses **staged writes**:

1. Each parallel child buffers writes to `parallelStagedWrites[stageName]`
2. On group completion, all staged writes atomically merge to `store`
3. Validation at YAML level: overlapping write keys within a group require `append`/`merge` strategy
4. Sibling reads of sibling writes are prohibited (validated at pipeline parse time)

### 6.5 Resume Optimization

On retry/resume, the system avoids re-injecting unchanged context:

1. Capture `stableHash()` of each read value at stage start
2. Store in `stageCheckpoints[stageName].readsSnapshot`
3. On retry, compare current hashes against snapshot
4. Unchanged reads rendered as "Context unchanged" with `get_store_value()` hint

---

## 7. Prompt Engineering Architecture

### 7.1 Six-Layer Prompt Hierarchy

`buildSystemAppendPrompt()` assembles the agent's system prompt from six layers:

```
┌─────────────────────────────────────────┐
│ Layer 1: Global Constraints             │  Behavioral rules across all stages
├─────────────────────────────────────────┤
│ Layer 2: Project Rules                  │  CLAUDE.md / GEMINI.md / CODEX.md
├─────────────────────────────────────────┤
│ Layer 3: Stage System Prompt            │  Stage-specific instructions
├─────────────────────────────────────────┤
│ Layer 4: Knowledge Fragments            │  Keyword-matched domain knowledge
├─────────────────────────────────────────┤
│ Layer 5: Output Schema                  │  Auto-generated JSON format spec
├─────────────────────────────────────────┤
│ Layer 6: Step Prompts                   │  Conditional capability instructions
└─────────────────────────────────────────┘
```

### 7.2 Knowledge Fragment System

Fragments are reusable knowledge units injected into prompts based on:
- **Keyword matching**: Fragment metadata declares keywords; stage name and reads are matched
- **Stage name matching**: Direct name association
- **Always-on flag**: Injected into every agent stage

This enables domain knowledge (API conventions, coding standards, architectural decisions) to be automatically surfaced to agents without polluting individual stage prompts.

### 7.3 Output Schema Auto-Generation

Agent stages declare structured outputs via the `outputs` field:

```yaml
outputs:
  implementation_result:
    type: object
    fields:
      - key: files_changed
        type: array
        description: "List of modified file paths"
      - key: summary
        type: string
        description: "Brief description of changes"
```

The system auto-generates JSON format instructions in the system prompt, including field descriptions, types, and required/optional indicators. The agent's response is parsed and validated against this schema before store writes occur.

---

## 8. Execution Modes

### 8.1 Local Execution (Default)

The orchestrator server directly invokes agents:
- Claude: via `@anthropic-ai/claude-agent-sdk` (in-process, streaming)
- Gemini/Codex: via `node-pty` pseudo-terminal spawning CLI tools

### 8.2 Edge Execution

Decouples agent execution from the orchestrator. The edge runner is an independent process that:

1. Connects to the MCP server at `:3001/mcp`
2. Polls `list_available_stages` for pending work
3. Fetches full stage context via `get_stage_context`
4. Spawns isolated Claude/Gemini session in pty
5. Streams transcript events to server via `report_progress`
6. Submits results with nonce-based validation via `submit_stage_result`

**Nonce-based concurrency control:** Each stage execution slot is assigned a nonce. If the task is retried while an edge agent is running, the old nonce is invalidated — preventing stale results from being accepted.

**Hook-based interruption:** Edge agents check `/api/edge/{taskId}/check-interrupt` via a `PreToolUse` hook before each tool invocation. If interrupted, the hook aborts the tool call.

### 8.3 Mixed Execution

A single pipeline can mix engines and execution modes:

```yaml
stages:
  - name: cheap_analysis
    type: agent
    engine: gemini                  # Use Gemini for cost-efficient analysis
    execution_mode: edge            # Run on edge worker
  - name: critical_implementation
    type: agent
    engine: claude                  # Use Claude for complex implementation
    execution_mode: auto            # Run locally
```

---

## 9. Error Handling & Recovery

### 9.1 Per-Stage Retry

```
Stage Error → MAX_STAGE_RETRIES (2) exceeded?
  ├── No → Resume with feedback (if session available) or restart stage
  └── Yes → Transition to blocked state
```

Retry logic in `handleStageError()`:
- **Session resume**: If a Claude session ID exists, retry with feedback message
- **Clean restart**: If no session, restart stage from scratch
- **Escalation**: After max retries, transition to `blocked` for human intervention

### 9.2 QA Feedback Routing

The `retry.back_to` field enables automated QA loops:

```
implement → qa_review → (blockers found) → implement (with feedback)
                       → (passed) → next_stage
```

The QA stage detects failure patterns in outputs (e.g., `{ passed: false, blockers: [...] }`) and routes back to the originating stage with structured feedback injected into the agent's context.

### 9.3 Verify Commands

Post-execution validation scripts:

```yaml
verify_commands:
  - command: "npx tsc --noEmit"
    policy: must_pass       # must_pass | warn | skip
  - command: "npx eslint . --quiet"
    policy: warn
```

- `must_pass`: Verification failure triggers retry (up to `verify_max_retries`)
- `warn`: Log warning, continue execution
- `skip`: Do not execute

### 9.4 Git Compensation

Stages can declare compensation strategies for rollback on error:

```yaml
compensation:
  strategy: git_reset    # git_reset | git_stash | none
```

Before each stage, a git checkpoint captures `HEAD`. On error:
- `git_reset`: Hard reset to pre-stage commit
- `git_stash`: Stash uncommitted changes
- `none`: No cleanup

### 9.5 State Recovery Hierarchy

```
1. Auto-retry (per-stage, up to MAX_STAGE_RETRIES)
   ↓ exceeded
2. blocked state (human can RETRY / RETRY_FROM / CANCEL)
   ↓ human action
3. RETRY: Resume last stage with session continuity
   RETRY_FROM: Jump to any retryable stage (with compensation)
   CANCEL → cancelled state → RESUME: Resume from last stage
```

---

## 10. Human-in-the-Loop

### 10.1 Gate Stage Flow

```
Pipeline → human_confirm stage
  ├── SSE event to dashboard
  ├── Slack notification (if configured)
  └── Wait for human action
       ├── CONFIRM → on_approve_to (or next stage)
       ├── REJECT → on_reject_to (or error)
       └── REJECT_WITH_FEEDBACK → on_reject_to with context
```

### 10.2 Interactive Agent Mode

Agent stages with `interactive: true` can ask questions mid-execution:

1. Agent calls `AskUserQuestion` tool
2. Question stored in SQLite `pending_questions` table
3. SSE event broadcast to dashboard
4. Slack notification sent (if configured)
5. User answers via dashboard or Slack
6. Answer injected back into agent session

### 10.3 Slack Integration

- **Protocol**: Socket Mode via `@slack/bolt` + `@slack/socket-mode`
- **Capabilities**: Interactive buttons for approve/reject, notification formatting with stage context
- **Architecture**: Dedicated `slack-cli-bridge` app in monorepo

---

## 11. Pipeline DSL & Validation

### 11.1 YAML Schema

```yaml
name: my-pipeline
engine: claude                        # Default engine
display:
  title_path: store.ticket_title      # Dynamic task title from store
  completion_summary_path: store.pr_url

stages:
  # Linear stage
  - name: analysis
    type: agent
    runtime: { ... }

  # Parallel group (fork/join)
  - parallel:
      name: gather_context
      stages:
        - name: gather_notion
          type: agent
          runtime: { ... }
        - name: gather_figma
          type: agent
          runtime: { ... }

  # Condition routing
  - name: route
    type: condition
    runtime:
      branches:
        - when: "expr"
          to: target
        - default: true
          to: fallback
```

### 11.2 Static Validation

`validatePipelineLogic()` performs compile-time checks:

1. **Data flow**: Every `reads` key must reference a prior stage's `writes`
2. **Routing targets**: `on_reject_to`, `on_approve_to`, `back_to`, condition `to` must reference existing stages
3. **Parallel safety**: No `human_confirm` inside parallel groups; no overlapping `replace` writes; no sibling cross-reads
4. **Cycle detection**: DFS on `depends_on` graph
5. **Output consistency**: `writes` keys must have matching `outputs` entries
6. **Prompt alignment**: System prompt content validated against `permission_mode` and `disallowed_tools`
7. **MCP validation**: Referenced MCPs checked against registry
8. **Foreach validation**: Required fields (`items`, `item_var`, `pipeline_name`) verified

### 11.3 Mutual Exclusivity

`depends_on` (DAG syntax) and `parallel` groups are mutually exclusive. When `depends_on` is used, `transformDagToParallelGroups()` performs topological sort and converts each dependency level into a parallel group automatically.

---

## 12. Observability & Real-time Streaming

### 12.1 SSE Architecture

`SSEManager` is a singleton managing per-task event streams:

- **Per-task state**: Active connections, memory history (last 500 messages), programmatic listeners
- **Persistence**: SQLite `sse_messages` table (7-day retention)
- **Reconnection**: Memory history replayed on reconnect; falls back to DB if empty
- **Keep-alive**: 30-second heartbeat comments

### 12.2 Event Types

| Event Type | Content | Producer |
|-----------|---------|----------|
| `status` | Stage/task status changes | State machine transitions |
| `stage_change` | Stage transition notification | State machine |
| `agent_text` | Agent output text | Stream processor |
| `agent_tool_use` | Tool invocation details | Stream processor |
| `agent_tool_result` | Tool execution results | Stream processor |
| `agent_thinking` | Extended thinking content | Stream processor |
| `cost_update` | Cost accumulation | Stage completion |
| `question` | Human gate question | Gate stage entry |
| `error` | Error messages | Error handlers |
| `agent_red_flag` | Safety flag detection | Red flag scanner |

### 12.3 Cost Tracking

- Per-stage: `costUsd` extracted from agent result stream
- Global: `totalCostUsd` accumulated across all completed stages
- Token breakdown: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`
- Per-model: `StageTokenUsage.modelBreakdown` for multi-model pipelines
- SSE broadcast: `wf.costUpdate` event on each stage completion

---

## 13. Persistence & State Recovery

### 13.1 Snapshot Model

Every task's XState snapshot is persisted as a versioned JSON file:

```
{data_dir}/tasks/{taskId}.json
→ { version: 1, snapshot: { ... } }
```

- **Atomic writes**: Temp file + rename to prevent corruption
- **Flush triggers**: Every stage completion, user actions (confirm/reject/retry)
- **Startup recovery**: All persisted task IDs loaded; snapshots restored lazily on access

### 13.2 Database Schema

SQLite in WAL mode at `{data_dir}/workflow.db`:

| Table | Purpose | Retention |
|-------|---------|-----------|
| `sse_messages` | Event stream history | 7 days (configurable) |
| `pending_questions` | Active human questions | Until answered/cancelled |
| `edge_slots` | Edge execution slots | Active task lifetime |

### 13.3 Git State Checkpoints

```typescript
interface StageCheckpoint {
  gitHead?: string;        // git rev-parse HEAD before stage
  startedAt: string;       // ISO timestamp
  readsSnapshot?: Record<string, string>;  // Hash of read values
}
```

Captured before each stage execution. Used for:
- Compensation (git reset on error)
- Resume optimization (skip unchanged reads)

---

## 14. Registry & Extension System

### 14.1 Package Types

| Type | Purpose | Format |
|------|---------|--------|
| Pipeline | Workflow definitions | YAML + prompt .md files |
| Skill | Reusable prompt instructions | Markdown |
| Hook | Pre/post-stage scripts | TypeScript |
| Fragment | Knowledge injection units | Markdown with keyword metadata |
| Script | Custom stage executors | TypeScript module |

### 14.2 Registry Service

- Local storage in `registry/` directory with manifest files
- Bootstrap with default package set on fresh install
- Publish/install workflow for sharing pipelines across projects
- CLI tools: `registry:build` (build index), `registry:bootstrap` (install defaults)

### 14.3 AI-Powered Pipeline Generation

The `pipeline-generator` built-in pipeline creates new pipelines from natural language descriptions:

```
User description → analysis → parallel(gen-skeleton, gen-prompts) → prompt-refinement → persist
```

1. **Analysis**: Clarifies ambiguities, produces `stageContracts` (single source of truth for naming)
2. **Skeleton generation**: Converts contracts to YAML structure
3. **Prompt generation**: Per-stage prompt writing with constraints alignment
4. **Refinement**: Enhances prompt clarity and error handling
5. **Persistence**: Validates and writes to registry

---

## 15. Security Model

### 15.1 Agent Permission Modes

| Mode | Capabilities |
|------|-------------|
| `auto` | Full tool access with standard Claude permissions |
| `plan` | Read-only; no file writes, no Bash, no tool use |
| `bypassPermissions` | All tools allowed without confirmation |

### 15.2 MCP Tool Scoping

Each stage declares which MCP servers it needs via `mcps: [...]`. Only declared MCPs are attached to the agent session, limiting tool surface area per stage.

### 15.3 Known Security Gaps

- Task control endpoints lack authentication middleware
- Edge runner communicates over unencrypted HTTP (no TLS on localhost)
- No rate limiting on MCP tool calls
- Worktree paths are user-controllable through pipeline config

---

## 16. Known Deficiencies & Honest Assessment

### 16.1 Architectural Weaknesses

#### Single-Process Bottleneck
The orchestrator runs as a single Node.js process. There is no horizontal scaling, no process clustering, no distributed state. For a team running 50+ concurrent pipelines, this is a hard ceiling. The edge runner partially mitigates this by offloading agent execution, but the state machine coordination remains centralized.

**Severity: High for enterprise use; acceptable for individual/small team use.**

#### SQLite as the Only Database
SQLite is excellent for single-writer workloads but fundamentally limits:
- No remote access (local file only)
- Write contention under high SSE throughput
- No replication or backup strategy beyond file copy
- WAL mode helps but doesn't eliminate the single-writer constraint

**Severity: Medium. Adequate for current scale but prevents multi-server deployment.**

#### No Authentication or Authorization
The REST API and MCP server are completely open. Any process on localhost can:
- Create and cancel tasks
- Submit stage results
- Read all store data
- Modify pipeline configurations

**Severity: High for any shared or production environment.**

#### Memory-Bound SSE History
The SSE manager keeps the last 500 messages per task in memory, with LRU eviction at 100 tasks. Under sustained load with many active tasks, memory pressure grows linearly. The SQLite fallback exists but introduces latency on reconnect.

**Severity: Low-Medium. The 100-task LRU cap is reasonable but not configurable without code changes.**

### 16.2 Workflow Engine Bugs

#### Cycle Detection Misses Gate Routing Edges
In `pipeline-validator.ts`, the cycle detector only follows `depends_on` edges via DFS (lines 136-158). In `pipeline-builder.ts`, a separate `back_to` cycle detector exists (lines 390-414). Neither validator constructs a graph including `on_approve_to` / `on_reject_to` edges. A pipeline like `gate1 --on_approve_to--> stage2 --> gate2 --on_reject_to--> gate1` passes all validation but creates an infinite loop at runtime.

**Impact: Potential infinite loops in pipelines with complex gate routing. Severity: Medium.**

#### Stale Retry Count in Log Messages
In `helpers.ts` (lines 208-231), the `handleStageError` function's action array calls `assign({ retryCount: context.retryCount + 1 })` followed by `emit()` and logging that reads `context.retryCount`. In XState, actions in an array execute before the assign takes effect on context, so the logged/emitted value is always the pre-increment value. The first retry logs "attempt 0" instead of "attempt 1".

**Impact: Misleading log output during debugging; no functional impact. Severity: Low.**

#### No Guard Against Recursive Pipeline Calls
In `pipeline-executor.ts`, the `runPipelineCall` function creates child tasks via `createTaskDraft` but has no depth tracking, parent task ID chain validation, or circular dependency detection. A pipeline that calls itself (directly or transitively) could create unbounded recursion.

**Impact: Potential resource exhaustion via unbounded sub-pipeline spawning. Severity: Medium.**

### 16.3 Design Limitations

#### No Conditional Parallel Groups
Parallel groups are statically defined in YAML. You cannot conditionally include/exclude parallel children based on runtime state. A stage that should only run under certain conditions must use a `condition` stage *before* the parallel group.

**Workaround: Split into condition + two separate parallel groups.**

#### No Cross-Parallel-Group Data Dependencies
Sibling stages within a parallel group cannot read each other's writes. This is by design (staged writes are atomic at group completion), but prevents incremental data sharing between concurrent stages.

**Workaround: Post-group stages can merge parallel outputs.**

#### Gemini Cost Tracking Not Implemented
The Gemini CLI does not report cost data. `totalCostUsd` for Gemini stages is always 0, making mixed-engine pipelines have incomplete cost accounting.

**Impact: Budget enforcement doesn't work for Gemini stages.**

#### Edge Runner Transcript Parsing is Fragile
Transcript sync relies on finding the newest `.jsonl` file in a Claude-specific directory path (`~/.claude/projects/<normalized-cwd>/`). Multiple fragility points exist: (1) path normalization replaces `/` with `-`, which creates collisions (e.g., `/a/b` and `/a-b` both normalize to `a-b`); (2) the transcript file path is bound on first discovery and never updated — if Claude CLI creates a new file mid-session, the runner continues reading the stale one; (3) all errors are silently swallowed (`catch { /* non-critical */ }`), making failures invisible.

**Impact: Edge runner observability breaks silently on Claude updates or path collisions. Severity: Medium.**

#### Store is Untyped at Runtime
Despite YAML output schemas, the store is `Record<string, any>` at runtime. There is no runtime type enforcement — a stage can write any shape to any key. Schema validation only checks *presence* of declared keys, not *shape*.

**Impact: Downstream stages may receive unexpected data shapes, causing silent failures.**

### 16.4 Operational Gaps

#### No Metrics or Alerting
No Prometheus/OpenTelemetry integration. No health check endpoint. No alerting on task failures, cost overruns, or system errors. Observability is limited to SSE streams and Pino logs.

**Severity: Medium. Acceptable for development use; blocks production deployment.**

#### No Backup or Disaster Recovery
Task snapshots are local JSON files. SQLite is a local file. No automated backup, no point-in-time recovery, no data export.

**Severity: Low-Medium. Mitigated by git-based state (code changes recoverable via branches).**

#### Graceful Shutdown Has No Agent Drain
The server handles `SIGTERM`/`SIGINT` and properly closes HTTP server, sweep timer, Slack app, and database. However, there is no drain period for active agent sessions — running agents are abruptly killed on shutdown. Tasks can be resumed from `blocked` state after restart, but in-flight work is lost.

**Severity: Low. Existing recovery mechanisms cover the gap adequately.**

---

## 17. Comparison with Alternatives

### 17.1 vs. LangGraph

| Dimension | Workflow Control | LangGraph |
|-----------|-----------------|-----------|
| State Machine | XState v5 (formal, typed) | Custom graph runner |
| Language | TypeScript | Python |
| Agent SDK | Claude/Gemini/Codex native | LangChain abstractions |
| Persistence | JSON snapshots + SQLite | Checkpointer (pluggable) |
| Human-in-loop | First-class gate stages + Slack | Interrupt mechanism |
| Cost Control | Per-stage budgets | Manual implementation |
| Edge Execution | Built-in edge runner | Not available |
| Pipeline DSL | YAML (no code) | Python code |

**Key differentiator:** Workflow Control's YAML DSL enables non-programmers to define pipelines, while LangGraph requires Python code for every workflow.

### 17.2 vs. Temporal

| Dimension | Workflow Control | Temporal |
|-----------|-----------------|----------|
| Focus | AI agent orchestration | General workflow orchestration |
| Scale | Single process | Distributed, horizontally scalable |
| Durability | JSON files + SQLite | Event-sourced, production-grade |
| Learning Curve | YAML config | SDK + server deployment |
| AI-Native | Yes (prompt layers, token tracking, cost budgets) | No (generic activities) |
| Maturity | Early stage | Production-proven |

**Key differentiator:** Workflow Control is purpose-built for AI agents; Temporal is a general-purpose workflow engine that requires significant custom development for AI use cases.

### 17.3 vs. Claude Code Native

| Dimension | Workflow Control | Claude Code (standalone) |
|-----------|-----------------|--------------------------|
| Multi-stage | Formal pipeline stages | Single session |
| Cost Control | Per-stage budgets | Session-level only |
| Human Gates | Structured approval flows | Manual interruption |
| Multi-engine | Claude + Gemini + Codex | Claude only |
| Persistence | Cross-restart recovery | Session-bound |
| Parallel Execution | Fork/join with isolation | Sequential only |

**Key differentiator:** Workflow Control adds orchestration, gates, and multi-engine support on top of what Claude Code provides as a single-agent tool.

---

## 18. Conclusion

Workflow Control represents a thoughtful approach to AI agent orchestration that prioritizes **formal correctness** (XState), **declarative configuration** (YAML DSL), and **human oversight** (gate stages) over raw scalability. Its architecture makes strong bets:

**Bets that are paying off:**
- XState v5 as the state machine foundation provides genuine debuggability and state recovery
- The tiered context system (Tier 1 budget + Tier 2 on-demand) elegantly manages token costs
- YAML pipeline DSL with static validation catches errors before execution
- Edge runner architecture cleanly separates orchestration from execution
- Git-native worktree isolation is a natural fit for code-producing workflows

**Bets that carry risk:**
- Single-process architecture limits scaling beyond individual/small team use
- SQLite as the only persistence layer prevents distributed deployment
- Untyped runtime store relies on convention over enforcement
- Edge runner transcript parsing depends on undocumented Claude internals

The system is well-suited for teams of 1-5 developers orchestrating complex AI workflows with human oversight. For larger-scale enterprise deployment, the single-process bottleneck, lack of authentication, and absence of operational tooling (metrics, alerting, backup) are blockers that would require significant engineering investment.

The codebase demonstrates high engineering quality — extensive test coverage (including adversarial tests), comprehensive type contracts, and thoughtful error handling. The pipeline validator alone covers 15+ categories of static checks. But the gap between "works correctly for one user" and "operates reliably at scale" remains wide, and the project's architecture would need fundamental changes (distributed state, real database, auth layer) to bridge it.

---

*This document reflects the codebase state as of 2026-04-14. All claims are based on direct source code analysis.*
