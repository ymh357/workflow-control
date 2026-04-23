# Workflow Control: Capability Review

> **Date**: 2026-04-23
> **Author**: Session 4 autonomous audit
> **Scope**: End-to-end capability inventory of the kernel-next implementation as of commit `e51831e`.
> **Purpose**: Ground subsequent roadmap decisions in an honest map of what works, what is missing, and why.

---

## 1. Methodology

Walked the "end user: idea → running pipeline → operating it" path and for each step cross-referenced against:

- `src/kernel-next/` source tree (runtime / mcp / hot-update / validator / sse / ir)
- `src/routes/` HTTP surface
- `apps/web/src/app/kernel-next/` dashboard
- `apps/server/config/mcps/registry.yaml` (legacy MCP registry)
- `docs/product-roadmap.md` original goals
- `docs/kernel-next-terminal-design.md` terminal spec and `§11.3 Known deferred items`
- Git history of deleted modules (`git show` on retired paths per `CLAUDE.md §Retired areas`)

Investigated before claiming any gap. All presence/absence claims are grep-verified against current source.

---

## 2. What works (capabilities delivered)

| Capability | State | Evidence |
|---|---|---|
| Pipeline IR schema | Complete | `ir/schema.ts` zod schema, content-hashed `pipeline_versions` table |
| Submit-time validation | Complete | structural + DAG + `store_schema` + `validateTypes` (tsc) |
| AI-authored pipelines | Basic complete | PG 100% success on simple (5/5 real end-to-end); complex-with-MCP generated-and-DB-registered but not run (run #28) |
| Hot-update full path | Complete | propose / approve / reject / migrate / rollback / audit all on HTTP |
| Crash recovery | Complete | PID-lock + `bootResumability` + SDK session resume with mid-stage `session_id` flush |
| Observability (backend) | Complete | SSE stream, lineage queries, `agent_execution_details` + `script_execution_details` sidecars, compact events, monotonic SSE seq |
| Per-stage cost cap | Partial | `maxBudgetUsd` threaded to SDK; no global cap |
| 4 builtin pipelines | Complete dogfood | smoke-test + tech-research-collector + tech-research-writer + pipeline-generator |
| Sub-agent support | Complete | `SubAgentDefSchema` in IR, propagated into SDK options |
| Worktree isolation | Complete | `task_worktrees` ownership contract + B9 git-reset on migration |
| Checkpoint / diff capture | Complete | `stage_checkpoints` table, before_sha / after_sha / cached diff_text |
| Fanout | Complete | `fanout_element` / `fanout_aggregate` attempts, B17 full preserves success elements across migration |
| Typed ports + wire type-check | Complete | inline TS types, tsc validates wire compatibility |

---

## 3. Gaps (missing or incomplete capabilities)

### Tier 1 — Blockers for M2 (friends cannot use)

#### D1. External MCP injection is fully broken
**Symptom**: any PG-generated pipeline that needs GitHub / Notion / Figma / Linear / Gitlab / PulseMCP cannot actually run — runtime has no way to attach the third-party MCP server to the SDK call.

**Evidence**:
- `real-executor.ts:309` injects only `__kernel_next__` (the in-process kernel MCP). No merge of stage-declared MCPs.
- `AgentStageSchema.config` in `ir/schema.ts` has no `mcps` field. PG's analysis stage outputs `recommendedMcps: string[]` but that port is never wired into a stage.config.mcps. It's a documentation artifact.
- `persistResult.mcpsNeedingKeys` port is declared but PG's persist prompt doesn't teach the agent to populate it.
- `apps/server/config/mcps/registry.yaml` is still on disk with 7 third-party MCP definitions (notion / figma / context7 / pulsemcp / linear / gitlab / github), with `${ENV_VAR}` interpolation. But kernel-next doesn't read it. `CLAUDE.md` line 57 confirms: "preflight no longer checks `config/pipelines/` or MCP registry".
- Legacy `lib/config/mcp.ts` (deleted 2026-04-24, commit `cfc1f13`) had `loadMcpRegistry()` + `buildMcpFromRegistry()` doing exactly this and it worked. The module was retired without a replacement in kernel-next.

**Impact**: run #28 generated the `GitHub PR Security Review` pipeline successfully, but the generated pipeline's `fetchDiff` stage has no runtime path to actually invoke the GitHub MCP. The gap is silent — submit and validation pass, execution fails with "tool not found" or the agent hallucinates around the missing MCP.

**Why it was deferred**: design spec `§9.4` explicitly called `disallowedTools / skills / mcpServers` pass-through "YAGNI — not in this plan" (see `2026-04-22-converter-extension-pipeline-generator.md:13`). It was intentional scope cut, but the product is not usable without it.

**Fix shape** (referred to as **Debt U** going forward):
1. Port `loadMcpRegistry` / `buildMcpFromRegistry` from the deleted legacy module into `kernel-next/runtime/mcp-registry.ts`.
2. Add `mcps?: string[]` to `AgentStageConfig` in `ir/schema.ts`.
3. In `real-executor.ts` options assembly, look up each `stage.config.mcps[i]` in the registry and merge into `mcpServers` under its natural name (e.g. `mcp__github__`).
4. Update PG's `genSkeleton.md` prompt to wire `recommendedMcps` → `stage.config.mcps`.
5. PG's `persist.md` prompt should populate `mcpsNeedingKeys` from analysis output so the wait_pipeline_result consumer can surface missing env-var warnings.

Estimated 4-6 h autonomous with TDD.

---

#### D2. Dashboard has no "launch task" UI
**Symptom**: friend opens `http://localhost:3000`, sees plain-text instructions to call curl, leaves.

**Evidence**:
- `apps/web/src/app/page.tsx` is 23 lines of description text. No form, no buttons.
- `apps/web/src/app/kernel-next/pipelines/page.tsx` (86 LOC) lists registered pipelines but has no `run` button.
- No `seedValues` form renderer anywhere in the web tree.

**Impact**: the only way for a non-developer user to run a pipeline is to write `curl -X POST http://localhost:3001/api/kernel/tasks/run -d '{"name":"...","seedValues":{...}}'`. M2 friends cannot.

**Fix shape**:
- `/kernel-next/pipelines/[name]` page: render a form driven by `ir.externalInputs[]`. Each input renders a type-appropriate editor (string → textarea, number → number input, object → JSON editor).
- POST to `/api/kernel/tasks/run` and redirect to `/kernel-next/[taskId]`.

Estimated 3-4 h autonomous.

---

#### D3. No task list API + UI
**Symptom**: the only way to find a running task is to remember its taskId from the POST response.

**Evidence**:
- No `GET /api/kernel/tasks` route in `src/routes/kernel-tasks.ts`.
- Dashboard has no "your tasks" page. Root `page.tsx` doesn't link to any task index.

**Impact**: friend forgets taskId = task is lost from their UI. Task management impossible.

**Fix shape**:
- `GET /api/kernel/tasks?status=running|completed|failed&limit=50` reading from `stage_attempts` + `task_finals` join.
- New `/kernel-next/tasks` dashboard page listing recent tasks with status, pipeline name, created_at, current stage, cost.

Estimated 3-4 h autonomous.

---

#### D4. No HTTP cancel/abort endpoint
**Symptom**: once a task is running there is no way to stop it short of killing the server (and reconciler will resume it).

**Evidence**:
- Searched `src/routes/` for `cancel` / `abort` / `interrupt` in a task context — only `kernel-proposals-stream.ts` uses `cancel()` for SSE stream termination, not task cancellation.
- Orchestrator's `INTERRUPT` event exists for migration but there's no user-facing trigger.

**Impact**: bad seedValues or runaway cost = cannot stop until budget or turn cap fires. May spend $$$ on a mistake.

**Fix shape**:
- `POST /api/kernel/tasks/:taskId/cancel` that sends `INTERRUPT` via taskRegistry dispatcher, writes `task_finals.final_state='cancelled'`.
- Dashboard task view adds a cancel button.

Estimated 2-3 h autonomous.

---

### Tier 2 — Usability gaps, not blockers

#### D5. Fanout concurrency cap unimplemented
**Evidence**: Terminal design `§11.3 Appendix C`: "Fanout concurrency cap default: how many fanout instances run concurrently by default? Policy-level setting; need real-world sizing." Searched `src/kernel-next/` for `concurrencyCap` / `parallelLimit` — zero hits.

**Impact**: a PG-generated fanout pipeline with N elements launches N parallel Claude sessions. Triggers Anthropic rate limits. Unbounded cost parallelism.

**Fix shape**: add `config.fanout.concurrency?: number` (default e.g. 3), enforce via a counting semaphore in `orchestrateFanoutStage`.

Estimated 2-3 h.

---

#### D6. Gate has no timeout
**Evidence**: searched for `gateTimeout` / `gate.*timeout` in kernel-next — no enforcement code. Gates wait on `gate_queue.answer IS NULL` forever.

**Impact**: user forgets to answer a gate; task becomes zombie; occupies mental overhead.

**Fix shape**: `config.gate.timeout_minutes?` on gate stage; reconciler or dedicated scheduler sweeps `gate_queue` older than timeout and sets `task_finals = cancelled` with reason `gate_timeout`.

Estimated 2-3 h.

---

#### D7. Rate-limit signal is telemetry-only
**Evidence**: `agent-machine.ts:129` has `RATE_LIMIT_SIGNAL`. Handler is `{}` no-op at 3 states (line 278, 297, 345). SDK `rate_limit_event` is translated but dropped.

**Impact**: API near rate limit = pipeline errors out instead of backing off. In a 3-parallel PG run test (this session), if we hit 80% utilization the stages would flake.

**Fix shape**: on `RATE_LIMIT_SIGNAL` with high utilization (>0.9), pause the stage (schedule retry with exponential backoff). Publish SSE event so dashboard can show "throttled by API".

Estimated 3-4 h with TDD.

---

#### D8. No task retry endpoint
**Evidence**: searched `src/routes/` — no retry route. Retrying requires starting a new task, losing prior context.

**Impact**: transient failure (network blip mid-genSkeleton) = user manually restarts from scratch.

**Fix shape**: `POST /api/kernel/tasks/:taskId/retry` that reuses the same `taskId` but opens new attempts from the first non-success stage. Reuses hot-update's `rerunFrom` logic (already implemented).

Estimated 2-3 h.

---

#### D9. No prune/cleanup HTTP endpoint
**Evidence**: `src/cli/prune-kernel-records.ts` exists but is CLI-only.

**Impact**: DB grows unbounded. Long-running server eventually has GBs of stage_attempts + tool_calls_json.

**Fix shape**: `POST /api/kernel/admin/prune?older_than_days=30` calling the same pruning logic.

Estimated 1-2 h.

---

### Tier 3 — Product-completeness gaps

#### D10. Fragment / skill system absent
**Evidence**: `promptResolver` is trivial (`promptRef → content` verbatim). No 6-tier layering (global constraints / project rules / knowledge fragments / stage / output schema / step prompts) from legacy architecture.

`kernel-next-terminal-design.md §2.3` classifies fragments as **userland**, not kernel. But no userland resolver is provided, so the feature doesn't exist.

**Impact**: every PG-generated pipeline's prompts are standalone. No shared TypeScript / React conventions, no cross-pipeline invariants, no reusable domain knowledge. Each pipeline reinvents rules.

**Fix shape** (bigger scope):
- Terminal spec says userland — so the fix is: build a userland prompt assembler that accepts a fragment registry + rules, wire it into `promptResolver`. Could be shipped as a separate package or a built-in kernel option.

Estimated 8-12 h; design decision first.

---

#### D11. Registry system disconnected from kernel-next
**Evidence**: `registry/packages/` still has YAML-format pipeline definitions. Kernel-next reads only `pipeline.ir.json` (IR-native). Cross-user sharing is dead until a new IR-native registry protocol is designed.

**Impact**: friend-to-friend pipeline sharing requires manual IR JSON copy-paste and `POST /api/kernel/proposals`. Registry's purpose unfulfilled.

**Fix shape**: scope decision first — "drop registry" / "IR-native rewrite" / "YAML→IR adapter on install". Terminal design `§11.3` parks this as deferred.

---

#### D12. Single-session decision unmade
**Evidence**: `docs/product-roadmap.md §4` line 105 marks the benchmark TODO. No benchmark has been run. Current architecture is pure multi-session.

**Impact**: token cost vs legacy not quantified. B12 (single-session hot-update semantics) blocked.

**Fix shape**: run N pipelines in multi-session mode, measure per-stage token I/O, compare against the 3-5x legacy reference point. If within 1.5x, commit to multi-session-only; else plan single-session restoration.

Estimated 1-2 h to run benchmark + write decision memo.

---

#### D13. Deployment is undocumented
**Evidence**: README (newly rewritten this session) documents `pnpm install + pnpm dev`. No Dockerfile, no installer script, no brew formula, no systemd unit.

**Impact**: friend must `git clone + pnpm install + cp .env + pnpm dev + keep terminal open`. Every restart manual. No production-shape deployment.

**Fix shape depends on target**:
- Docker: 2-3 h for Dockerfile + docker-compose.
- brew: 4-6 h packaging + CI release workflow.
- Installer script: 1-2 h.

---

#### D14. No global cost cap
**Evidence**: only `stage.maxBudgetUsd` exists. No "whole-server doesn't exceed $X/day" hard stop.

**Impact**: runaway prompt / infinite-retry loop could rack up $100s before a human notices.

**Fix shape**: daily budget ledger (SQLite table); runner checks before starting each agent stage; hard refuse if over cap.

Estimated 3-4 h.

---

#### D15. Architecture whitepaper is pre-kernel-next
**Evidence**: `docs/architecture-whitepaper.md` + `-zh.md` describe XState + YAML + engine-agnostic architecture that was retired in Stage 4a/4b.

**Impact**: the product's self-description is wrong. Hard to pitch to a friend.

**Fix shape**: rewrite against current kernel-next reality. Large doc, 4-8 h autonomous.

---

### Tier 4 — Out of scope by design

#### D16. No auth — intentional per §1.3 (single-user local). Server binds to `0.0.0.0` by default? Verify: defaults to localhost.
#### D17. No fragment sharing protocol — subsumed by D10/D11.
#### D18. Registry $WORKTREE_PATH placeholders — subsumed by D11.
#### D19. Whitepaper — D15.
#### D20. PG quality on fanout / sub-pipeline / multi-gate — not benchmarked (noted in run #28 handoff).

---

## 4. Priority recommendations

### If goal = M2 (friend can use)
Ship in this order: **D2 + D3 + D1** together (dashboard launch form + task list + MCP injection). None of the three alone unblocks M2. All three = minimum viable shareable product.

Follow with **D8 retry + D4 cancel HTTP** for basic task management.

Then **D13 deploy** (pick a target: Docker / brew / installer).

Then **D7 rate-limit back-off + D6 gate timeout** for long-running reliability.

Approximate total: **20-30 h autonomous work** to unblock M2.

### If goal = cost stability
- **D12 single-session benchmark + decision** (1-2 h)
- **D14 global budget cap** (3-4 h)

### If goal = production reliability
- **D5 fanout cap** (2-3 h)
- **D9 prune HTTP + cron** (1-2 h)
- **D7 rate limit** (3-4 h)

### If goal = architecture story
- **D15 whitepaper rewrite** (4-8 h)

---

## 5. Autonomous vs non-autonomous

**Autonomous (I can just do)**: D1, D2, D3, D4, D5, D6, D7, D8, D9, D10 (if userland design decided), D12 (benchmark), D14, D15.

**Half-autonomous (needs your decision on target)**: D11 (drop vs rewrite registry), D13 (Docker vs brew vs installer).

**Not autonomous**:
- Friend invitations (M2 trigger).
- Friend feedback collection.
- Setting "acceptable token cost threshold" in D12 (I can report the numbers; the accept/reject call is yours).

---

## 6. Honest final assessment

The kernel-next architecture is **complete on the kernel side**. All A/B roadmap items landed. Hot-update works end-to-end (including reject and rollback both verified this session). PG generates valid simple pipelines at 100% reliability.

The gaps cluster in three shapes:

1. **External-MCP path never built** (D1) — the biggest single block; legacy had it, kernel-next shed it and nobody re-added.
2. **Dashboard is a curl replacement, not a product** (D2 + D3 + D4 + D8) — usable only by its author.
3. **No friend-ready deployment story** (D13) — nobody can `install and go`.

Each is tractable and small-to-medium sized. None require another architectural round. A focused 2-3-day autonomous sprint on D1 + D2 + D3 would plausibly move M2 from 0 to "friend actually uses it for something" territory.

---

## 7. What to do with this document

- Reference in next session handoff: `docs/2026-04-23-capability-review.md`.
- Any gap resolved updates this file's Gaps table with a link to the resolving commit.
- New gaps discovered during implementation append under the existing tier.
- Re-review after every 3-5 gaps closed to reconfirm priority ordering.
