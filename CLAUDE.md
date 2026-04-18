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

## Frozen areas — do not extend

These modules are retained for backward compatibility but receive **no
new features, no refactors, no bug fixes** unless the user explicitly
requests one. See `docs/product-roadmap.md` §3 S1.

- `apps/server/src/edge/` — Edge Runner (terminal-based execution).
- `apps/server/src/agent/gemini-executor.ts` — Gemini engine.
- `apps/server/src/agent/codex-executor.ts` — Codex engine.

If you are asked to touch these, flag the freeze status in your response
before proceeding.

## Primary engine

**Claude is the primary, fully-supported engine.** New pipelines and
new features target Claude (via the Claude Agent SDK). Do not propose
adding features that depend on Gemini or Codex.

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

## When in doubt

Ask. The repo author is also the primary user and reviews changes that
touch the core engine directly. Open questions belong in the session
transcript, not in silent code decisions.
