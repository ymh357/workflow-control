# CLAUDE.md — Project Conventions for AI Agents

This file tells Claude Code (and any other AI agent operating in this
repository) what this project **is**, what it is **not**, and how to
contribute without drifting from its positioning.

The source of truth for strategic decisions is `docs/product-roadmap.md`.
Read it before proposing architectural changes.

---

## What this project is

Workflow Control is a **local, single-user** workflow engine for running
AI coding agents (primarily Claude) on tasks too large for a single CLI
session. One engineer, one machine, one server process.

- Pipelines are **YAML files authored by AI**, not humans. The
  `pipeline-generator` builtin is the primary authoring surface.
- The XState workflow engine, SSE dashboard, store, and registry exist
  to make long-running AI-driven tasks **reproducible, interruptible,
  and observable** — not to be a multi-user platform.
- Sharing across machines happens via the Registry (pipelines, skills,
  hooks, fragments). Execution always happens locally.

## What this project is not

- **Not** a multi-tenant SaaS. No auth, no tenant isolation, no
  cross-user RBAC.
- **Not** a team scheduling / workflow approval platform. Human gates
  exist for the individual user, not for team review cycles.
- **Not** a general-purpose orchestrator (Temporal, Airflow, Prefect).
  The scope is AI-agent workflows.
- **Not** a chat wrapper. The workflow engine is the product; the dashboard
  is the primary UI.

## Retired areas (deleted 2026-04-24)

The following modules were deleted as part of Stage 4a of the kernel-next migration:

- `apps/server/src/edge/` — Edge Runner
- `apps/server/src/agent/gemini-executor.ts` — Gemini engine
- `apps/server/src/agent/codex-executor.ts` — Codex engine
- `apps/server/src/agent/` (entire directory) — legacy Claude executor stack
- `apps/server/src/machine/` — legacy XState workflow engine
- `apps/server/src/actions/` — legacy orchestration seam
- `apps/server/src/scripts/` — legacy script handlers
- `apps/server/src/__integration__/`, `__audit__/`, `__regression__/` — legacy test suites
- Legacy routes under `apps/server/src/routes/` (trigger, stream, tasks, confirm, answer, retry, cancel, config*, registry, action-helpers)
- Legacy Next.js pages under `apps/web/src/app/` (task/[id], config, registry, help)
- `apps/server/src/kernel-next/converter/` — legacy YAML → IR translator (deleted 2026-04-24 Stage 4b)
- `apps/server/src/builtin-pipelines/web3-research-writer/` — orphan sub-pipeline (deleted 2026-04-24 Stage 4b)
- All `apps/server/src/builtin-pipelines/*/pipeline.yaml` files replaced by `pipeline.ir.json` (canonical IR is the on-disk representation)
- `apps/server/src/lib/execution-record/` + `apps/server/src/cli/execution-record.ts` + `apps/server/src/cli/lib/prune-execution-records.ts` — legacy execution-record writer module + CLI (deleted 2026-04-24 Stage 6). kernel-next now writes `agent_execution_details` in kernel-next.db via `kernel-next/runtime/execution-record-writer.ts`.
- `apps/server/src/lib/config/{pipeline,schema,stage-lookup,store-schema,fragments,prompts,mcp,types}.ts` — legacy YAML pipeline loader + schema + helpers (deleted 2026-04-24 Phase 4.5 T4). kernel-next loads builtins from `src/builtin-pipelines/*/pipeline.ir.json` and manages MCP surfaces in-process. `lib/config/` now contains only `settings.ts` (SystemSettings) + `index.ts` + `clearConfigCache` wrapper.
- `apps/server/src/lib/script-loader.ts` — legacy dynamic script loader for `config/scripts/<name>/manifest.yaml` (deleted 2026-04-24 Phase 4.5 T4). kernel-next `ScriptStageExecutor` uses `ScriptModuleResolver` with in-process module registration; filesystem scanning path is dead.
- The startup fragment-registry validation block in `src/index.ts` (used legacy YAML loader) was also removed; preflight no longer checks `config/pipelines/` or MCP registry.

**Legacy task data not migrated.** Task JSON files under `{data_dir}/tasks/*.json` produced by the legacy engine are inert after this milestone. Per `docs/kernel-next-terminal-design.md §1.3`, zero historical compatibility.

**kernel-next is the only engine.** All new pipelines go through:
- MCP tool `run_pipeline` (primary)
- HTTP `POST /api/kernel/tasks/run` (dashboard entry)

Converter (`kernel-next/converter/`) and the four seeded builtin YAMLs (`builtin-pipelines/{smoke-test,tech-research-collector,tech-research-writer,pipeline-generator}/`) are retained; Stage 4b migrates them to native IR.

## Primary engine

**Claude is the only supported engine.** Gemini and Codex executors
were retired on 2026-04-24 (see §Retired areas). New pipelines and
new features target Claude (via the Claude Agent SDK) exclusively. Do
not propose reintroducing Gemini or Codex support.

## Who writes the YAML

**The AI writes the YAML, not the human.** When a user describes a
workflow, the expected path is:

1. Route the description through `pipeline-generator` (or propose to).
2. Let the pipeline emit a validated YAML + prompt set.
3. Iterate via edits to the generated YAML, not by asking the user to
   hand-write DSL.

This means:
- YAML schema changes are cheap (no human migration burden) as long
  as `pipeline-generator` is updated in lockstep.
- Breaking changes to stage DSL require `pipeline-generator` prompt
  updates as part of the same change set.

## Development principles (from the roadmap)

1. **Cut before build.** Remove / freeze obsolete code first, then build
   on the clean base. Phase 0 in the roadmap exists for this reason.
2. **Design data structures first, then implementation, then exposure.**
   Types + interfaces + unit tests before wiring to the main flow.
3. **One step at a time, each independently shippable.** Each change
   must leave the system in a working state. No multi-step migrations
   where intermediate states are broken.
4. **Never regress already-executed information.** Across retries,
   interrupts, hot-updates, and agent restarts, what has been executed
   must remain available as reference for the next attempt. This is a
   hard invariant — see roadmap A1 (execution record layer) and B
   (real hot-update) for the design.

## Hard invariants when modifying the engine

- `Task.pipelineSnapshot` captures pipeline state at task creation.
  Running tasks never silently pick up global config changes — this is
  a correctness property, not a quality-of-life feature.
- Stage `reads` / `writes` are the only legitimate data flow between
  stages. Do not add implicit cross-stage state access.
- Store writes are final per stage. Re-running a stage overwrites its
  own writes but must not delete prior stages' writes.
- Pipeline version = content hash (canonical JSON of the parsed YAML
  plus referenced fragments). Do not invent alternative version schemes.

## Testing expectations

- Maintain the existing test discipline: every non-trivial module has
  a `*.test.ts` and (for critical modules) `*.adversarial.test.ts`.
- Do not weaken existing adversarial tests to make new changes pass.
  Fix the underlying issue instead.
- Do not add tests to frozen modules (see §Frozen areas).

## Investigate the codebase before proposing plans

Before writing any design doc, evaluation, or plan that claims "X is
missing / broken / needs to be built", **read the relevant source files
first** and confirm the claim against actual code. The repo has evolved
across sessions; prior-session memory is stale. Specifically:

- Do not cite "what the system does" from a summary or an older design
  doc. Open the file and read the current implementation.
- When proposing to add a module, search for an existing module with
  that responsibility (`Grep`/`Glob` across `apps/server/src/**`) before
  drafting the design. Many responsibilities are already implemented
  under different names.
- When comparing to industry frameworks (LangGraph, Temporal, Airflow,
  etc.), cite the specific file+line in *this* repo that exhibits the
  pattern being compared — never assert by analogy without a code
  reference.
- When a doc claims a metric ("saves X% tokens", "reduces Y ms"), the
  number must come from a measurement or explicit estimation range, not
  from intuition. If no baseline exists, say so and propose measuring
  before claiming.

Evaluations that assume the codebase state without verification have
historically produced fabricated gaps and wasted review cycles. Spend
the time up front.

## Secret handling

When a pipeline, MCP tool, or any process you orchestrate needs a
secret (API token, password, private key, OAuth credential, etc.):

1. **Never** ask the user to paste the secret in chat. Once a secret
   appears in the conversation, it is committed to the session JSONL
   on disk (`~/.claude-personal/projects/<encoded-cwd>/<session-id>.jsonl`)
   and replayed to the Anthropic API on every subsequent resume of
   this session. There is no reliable cleanup.

2. **Direct the user to set the secret in the server process
   environment.** Either:
   - `export GITHUB_TOKEN=...; <restart kernel-next dev server>`, OR
   - pass `envValues: { GITHUB_TOKEN: "..." }` to `run_pipeline`
     (kernel writes to `task_env_values`; expanded into MCP server
     `${VAR}` references at runtime; never enters agent context).

3. **If neither path works** (hosted instance without shell access,
   missing tooling), document the limitation and stop. Do **not**
   request the secret as a fallback — degraded UX is preferable to
   leaked credentials.

4. **Before invoking a pipeline**, scan the IR for any stage with
   `config.mcpServers[*].envKeys` non-empty. Verify every required
   envKey is satisfied via `envValues` or `process.env` before calling
   `run_pipeline`. The kernel will fail-fast on missing envKeys
   (`MCP_ENV_MISSING`); recovery requires either a server restart or
   the (currently unimplemented) secret-gate runtime feature.

**Do not** propose to mutate a pipeline IR (e.g. via
`propose_pipeline_change`) to remove a `mcpServers` entry just because
its envKey is unsatisfied. The IR encodes the pipeline author's
intent; corrupting it to work around a missing input is wrong.

## When in doubt

Ask. The repo author is also the primary user and reviews changes that
touch the core engine directly. Open questions belong in the session
transcript, not in silent code decisions.
