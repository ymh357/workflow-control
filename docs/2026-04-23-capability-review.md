# Workflow Control: Capability Review

> **Initial Date**: 2026-04-23
> **Rewritten**: 2026-04-24 — aligned with `docs/superpowers/plans/2026-04-24-capability-closure.md` execution decisions + P1 retrospective.
> **Scope**: End-to-end capability inventory of kernel-next as the basis for the capability-closure sprint.
> **Status tracking**: this document is **advisory only** — the plan file is the executable source of truth. Progress tracked in git log + TodoWrite, not in this file.

---

## 1. Methodology

Walked the "end user: idea → running pipeline → operating it" path and cross-referenced against:

- `apps/server/src/kernel-next/` source tree (runtime / mcp / hot-update / validator / sse / ir)
- `apps/server/src/routes/` HTTP surface
- `apps/web/src/app/kernel-next/` dashboard
- `apps/server/config/mcps/registry.yaml` (legacy MCP registry)
- `docs/product-roadmap.md` original goals
- `docs/kernel-next-terminal-design.md` terminal spec and `§11.3 Known deferred items`
- Git history of retired modules

All presence/absence claims grep-verified against current source.

**Known review methodology error (surfaced during P1 execution)**: the initial audit relied on the grep pattern `from.*kernel-next/<dir>` filtered against files inside `<dir>/` itself. That filter was correct but the *interpretation* was wrong for `debug/` — `mcp/server.ts:28-31` imports from `debug/` to wire 3 MCP tools (`dry_run_stage`, `replay_stage`, `propose_pipeline_fix`) + the patch synthesizer. An implementer following the original D31 plan deleted `debug/` and — to pass tsc — deleted those tools too, destroying live product functionality. Commit was reset (see §P1 retrospective). **Lesson: importer grep must be interpreted case-by-case; "no hits" is evidence of nothing only when the claimant re-reads the hits they actually got.**

---

## 2. What works (capabilities delivered, verified 2026-04-24)

| Capability | State | Evidence |
|---|---|---|
| Pipeline IR schema | Complete | `ir/schema.ts` zod schema, content-hashed `pipeline_versions` table |
| Submit-time validation | Complete | structural + DAG + `store_schema` + `validateTypes` (tsc) |
| AI-authored pipelines | Basic complete | PG 100% success on simple (5/5 real end-to-end); complex-with-MCP generated but needs D1 to run |
| Hot-update full path | Complete | propose / approve / reject / migrate / rollback / audit all exposed |
| Crash recovery | Complete | PID-lock + `bootResumability` + SDK `options.resume` + mid-stage `session_id` flush |
| Observability (backend) | Complete | SSE, lineage, `agent_execution_details` + `script_execution_details`, compact events, monotonic SSE seq |
| Per-stage cost cap | Partial | `stage.maxBudgetUsd` threaded to SDK; no global cap (see D14, declined from sprint) |
| 5 builtin pipelines | Complete dogfood | smoke-test, tech-research-collector, tech-research-writer, pipeline-generator, pr-description-generator |
| Sub-agent support | Complete | `SubAgentDefSchema` in IR, propagated into SDK `agents` option |
| Worktree isolation | Complete | `task_worktrees` ownership contract + B9 git-reset on migration |
| Checkpoint / diff capture | Complete | `stage_checkpoints` table, before_sha / after_sha / cached diff_text |
| Fanout | Complete | `fanout_element` / `fanout_aggregate` attempts, B17 preserves success across migration |
| Typed ports + wire type-check | Complete | inline TS types, tsc subprocess validates wires |
| Dry-run + replay + patch synthesis MCP tools | Complete | `mcp/server.ts:28-31` imports from `debug/` for `dry_run_stage`, `replay_stage`, `propose_pipeline_fix`, `claude-sdk-patch-synthesizer`. (Misclassified in initial review — these are live product surfaces, not scaffolds.) |

---

## 3. Gaps

The sprint plan (`docs/superpowers/plans/2026-04-24-capability-closure.md`) lists which gaps are in scope. This section documents every gap surveyed; whether each is planned / declined / out-of-scope is noted inline.

### Tier 1 — Blockers for M2

#### D1. External MCP injection broken — **IN SPRINT (P3)**
Pipeline stages declaring `recommendedMcps` have no runtime path. Any PG-generated pipeline needing GitHub / Notion / Figma etc cannot actually invoke those MCPs. See P3.1–P3.9 of the sprint plan (IR schema extension + `task_env_values` table + `${VAR}` expansion + PG prompt upgrade + e2e test).

#### D2. Dashboard has no launch UI — **DECLINED**
Reframed: web is read-only per user direction. All task creation goes through the `run_pipeline` MCP tool invoked by the agent. D2 is not a gap under the revised product shape.

#### D3. No task list UI — **DECLINED**
Same reframing as D2. Listing is via agent query / future MCP tool if needed.

#### D4. No cancel endpoint — **IN SPRINT (P4.3)** *as `cancel_task` MCP tool*
Reframed from HTTP route to MCP tool.

### Tier 2 — Usability

- D5 Fanout concurrency cap — **IN SPRINT (P5.1)**
- D6 Gate timeout — **IN SPRINT (P5.2)**
- D7 Rate-limit back-off — **IN SPRINT (P5.3)**
- D8 Retry endpoint — **IN SPRINT (P4.1)** *as `retry_task` MCP tool*
- D9 Prune admin — **IN SPRINT (P4.2)** *as `prune_records` MCP tool*

### Tier 3 — Product completeness

- D10 Fragment/skill system — **DECLINED** (scope out of sprint; revisit after 5+ real pipelines accumulate)
- D11 Registry IR-native — **IN SPRINT (P8.2)**
- D12 Single-session benchmark — **DECLINED** (cost not a blocking concern at single-user scale)
- D13 Deployment story — **IN SPRINT (P8.1)** *via Dockerfile + docker-compose*
- D14 Global cost cap — **DECLINED** (stage-level cap is sufficient at single-user scale)
- D15 Whitepaper rewrite — **DECLINED** (real runnable pipelines matter more than doc accuracy pre-share)

### Tier 2b — Dashboard inspector (read-only, per revised shape)

- D21 Pipeline DAG visualisation — **IN SPRINT (P7.1)** — user-mandated quality priority
- D22 Proposal diff viewer — **IN SPRINT (P7.2)**
- D23 Live cost / token display — **IN SPRINT (P6.1)**
- D24 Stage duration + attempt history — **IN SPRINT (P6.2)**
- D25 Attempt details page — **IN SPRINT (P7.3)**
- D26 Audit timeline — **IN SPRINT (P6.3)**
- D27 Worktree diff viewer — **IN SPRINT (P6.4)**
- D28 i18n — **DECLINED** (English sufficient for M2)
- D29 Live agent output stream — **IN SPRINT (P7.4)**
- D30 Diagnostics aggregation — **IN SPRINT (P4.4)**

### Tier 3b — Code hygiene

- D31 Dead scaffold dirs (`__poc__`, `demo`, `debug`, `generator-real`) — **DECLINED as batch**. Rationale: `debug/` turned out to be live MCP infrastructure (discovered during P1.3 execution). Rather than surgically pick which subset is truly dead, the whole batch was dropped to avoid similar misclassification of the remaining three. `__poc__` / `demo` / `generator-real` may be dead individually but remove zero value to leave in place. Revisit if specific files block a future refactor.
- D32 Commit orphan `real-executor.empty-inputs.test.ts` — **DECLINED** (file stays untracked; not worth a commit on its own)
- D33 Scrub retired refs from `.env.local.example` — **DECLINED** (cosmetic)
- D34 God-file refactor (`runner.ts` 1736 / `real-executor.ts` 1038 / `mcp/server.ts` 1201) — **IN SPRINT (P2)** — prerequisite for P3/P4 clean extension points, NOT a death-cleaning exercise
- D35 CI workflow — **DECLINED** (local-only repo per user)

### Tier 4 — Out of scope by design

- D16 No auth (single-user local, intentional)
- D17/D18/D19/D20 — subsumed by D10/D11/D15/D20

---

## 4. P1 retrospective (2026-04-24)

Plan originally staged code-hygiene (P1: D31/D32/D33/D35) before structural refactor (P2: D34) per `CLAUDE.md §Step 0`. Execution result:

- **P1.1** (`__poc__` delete) — committed `9a0ea98`, later reverted along with the rest of P1.
- **P1.2** (`demo` delete + connector trim in `mock-handler-registry.ts`) — committed `baba59f`, later reverted.
- **P1.3** (`debug` delete) — attempted `dd56787`, **destroyed 3 live MCP tools** (dry_run_stage, replay_stage, propose_pipeline_fix), immediately `git reset --hard` before review.
- **User direction after incident**: `git reset --hard e2b9cd3` (pre-P1). Skip code-hygiene batch entirely; proceed directly to P2 god-file refactor.

**Root cause of the P1.3 incident**: the plan prompt to the implementer said "delete only the dir + necessary caller adjustments if tsc demands." For `debug/`, tsc did demand caller edits — but the correct response was to STOP and flag that the directory wasn't actually an orphan (since its exports were the MCP tool implementations). The implementer instead continued to "pass tsc" by removing the tool registrations, dragging three product features with it.

**Corrective action taken**: P1 removed from sprint; D31/D32/D33/D35 all declined. Capability-review §3 D31 entry updated so no future agent repeats the misclassification. Plan §Phase 1 should be treated as retrospectively void.

**Lesson to keep**: when an implementer's task causes tsc to demand MORE than the plan anticipated, the cost of a wrong guess is product functionality. A plan that says "delete dir X if tsc passes" is unsafe for any X whose contents are nontrivial. Next plan rev should require a pre-delete re-verification step like: `grep -rn "from.*/${dir}" src/ && confirm none of the exports are used as MCP tools / HTTP routes / public APIs before deleting`.

---

## 5. Active sprint reference

- Plan: `docs/superpowers/plans/2026-04-24-capability-closure.md`
- Execution tracking: git log + TodoWrite (this doc does NOT mirror progress)
- Starting point after P1 rollback: `e2b9cd3` (1499 tests, tsc clean)
- Next up: P2.1 — extract `real-executor-prompt-builder.ts` from `real-executor.ts`

---

## 6. Final gap count (post-revision)

- **In sprint (22 gaps)**: D1, D4, D5, D6, D7, D8, D9, D11, D13, D21, D22, D23, D24, D25, D26, D27, D29, D30, D34 + P9 regression
- **Declined (13 gaps)**: D2, D3, D10, D12, D14, D15, D28, D31, D32, D33, D35
- **Out of scope by design (5)**: D16, D17, D18, D19, D20

Total surveyed: 35 gaps + 5 out-of-scope items.
