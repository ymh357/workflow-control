# Capability Closure Sprint — Done Handoff (Session 5)

> **Completed**: 2026-04-24 through 2026-04-25 (HEAD `021a195`)
> **Plan**: `docs/superpowers/plans/2026-04-24-capability-closure.md`
> **Review**: `docs/2026-04-23-capability-review.md` (§7 final status + §8 polish catalog)
> **Baseline before**: `e2b9cd3` (1499 server tests / 17 web tests)
> **State after**: 1651 server tests / 52 web tests / tsc clean both sides

## TL;DR

- **68 commits** closing **22 in-scope capability gaps** + **14 reviewer follow-ups**
- Sprint executed via `superpowers:subagent-driven-development` — every task had implementer + spec-reviewer + code-quality-reviewer
- P1 (dead-code batch) **rolled back** after P1.3 destroyed 3 live MCP tools — `debug/` was misclassified as dead scaffold. Sprint jumped straight to P2.
- **quality-first mandate on D21** (pipeline DAG) honored — reactflow + dagre + badges + live stage overlay + MiniMap coloring + ARIA + status-aware polish
- No outstanding reviewer Important/Critical issues. Remaining Minors/Suggestions are all either deferred by design (§8 of review) or architecture-scale work that needs user direction.

---

## Where HEAD is

```
main @ 021a195
working tree: clean (after ignoring .claude/scheduled_tasks.lock which is now gitignored)
```

Server: `pnpm test` from `apps/server/` → 1651 pass / 4 skip / tsc clean
Web: `pnpm test` from `apps/web/` → 52 pass / tsc clean
Docker: `docker compose up -d` boots both targets (server on 3001, web on 3000), verified 2026-04-24

---

## Phase execution log

| Phase | Gap(s) | Outcome |
|---|---|---|
| **P1** | D31/D32/D33/D35 | **ROLLED BACK** — `debug/` was live MCP infrastructure (dry_run_stage / replay_stage / propose_pipeline_fix / claude-sdk-patch-synthesizer), not dead code. P1.3 subagent destroyed 3 MCP tool registrations before `git reset --hard e2b9cd3`. All of D31/D32/D33/D35 declined. |
| **P2** | D34 god-file refactor | 8 commits. `mcp/server.ts` 1201→172 LOC, `real-executor.ts` 1044→767, `runner.ts` 1736→1418 after extracting fanout + wire-resolver. P2.4 (worktree) skipped — already lived in `runtime/worktree/` from prior session. |
| **P3** | D1 external MCP injection | 11 commits. End-to-end closure: IR schema `stage.config.mcpServers` → canonical form → `task_env_values` DB table → `run_pipeline` `envValues` param → executor `${VAR}` expansion → cleanup on termination → PG prompts emit structured form → `pipeline.ir.json` type sync → e2e regression. Reserved-name guard `__*__`. |
| **P4** | D4/D8/D9/D30 MCP tools | 7 commits. `retry_task` (reuses rerunFrom via synthesized same-version proposal) + `prune_records` (admin tool) + `cancel_task` (INTERRUPT + sticky task_finals) + `diagnostics_emitted` SSE event + `DiagnosticsPanel` UI. |
| **P5** | D5/D6/D7 reliability | 6 commits. Fanout `concurrency` cap (default 3, max 20) via worker-pool + `gate-timeout-sweeper.ts` (60s periodic tick) + rate-limit backoff (observability: `shouldPause`/`rateLimitBackoffMs` pure helpers + counter in AgentContext + `rate_limit_backoff` SSE). |
| **P6** | D23/D24/D26/D27 lightweight UI | 5 commits. Live cost/token header chips + stage duration column + expandable attempt history + hot-update audit timeline with kind badges + worktree diff viewer per attempt. |
| **P7** | D21/D22/D25/D29 heavyweight UI | 8 commits. Pipeline DAG (reactflow + dagre + custom StageNode with badges, live stageStates overlay, MiniMap nodeColor, arrowheads, quality polish pass) + proposal side-by-side diff + attempt detail page (5 tabs: Tool Calls / Messages / Thinking / Status Timeline / Usage) + agent_message_delta live stream with 10Hz throttler. |
| **P8** | D11/D13 deploy + registry | 2 commits. Dockerfile multi-stage + docker-compose (server+web targets verified bootable) + registry legacy-YAML retirement (5 pipelines deleted, 3 fragments preserved). |
| **P9** | — | Final regression pass + capability-review §7 resolution table + phase6-usage-log Session 5 entry. |
| **Polish** | 14 minor items | Tail-biased liveOutputs cap + JsonPanel hint labels + audit duration badge + executing bg override + a11y + fanout error wording + terminal-design doc resolution + registry untrack + `createMcpServer` options propagation + `query_hot_update_stats.excludeRetries` filter + explicit SubAgentDef types + diff-viewer status awareness + gitignore `.lock` + fanout drain contract test + review §8 catalog. |

---

## Architectural decisions worth remembering

### 1. Registry YAML fully retired, 3 fragments kept

`registry/packages/pipeline-generator/` + 4 others were **legacy YAML pipelines** written against the pre-kernel-next DSL. Deleted from git (P8.2). The 3 remaining entries (completion-anti-patterns, invariants-library, testing-anti-patterns) are `type: fragment` — markdown knowledge snippets the `wfctl` CLI installs under `apps/server/config/prompts/fragments/`. Those stay. Later (polish pass 89afd01) I untracked all `registry/packages/` + `registry/index.json` since `.gitignore` already marked them generated; `pnpm --filter server registry:build` regenerates 38 packages from `apps/server/config/{prompts/fragments,skills,hooks}/`.

### 2. External MCP injection — per-task plaintext env, sticky cleanup

User explicitly chose "pipeline declares `mcpServers` in IR, user supplies envValues at `run_pipeline` time, store plaintext in DB, one generation per task." Schema ` McpServerDeclSchema` has `envKeys` (required) + optional `env: {K: "${VAR}"}`. `task_env_values` table is `(task_id, key, value, created_at)` with composite PK. Cleanup fires in:
- `runner.ts` finally block (normal completion / error / interrupted)
- `orphan-reconciler.ts` two sites (terminal-class + unresolvable)
- `kernel.cancelTask` (per P4.3)

Runner's `DO UPDATE` was tightened with `WHERE task_finals.final_state != 'cancelled'` so `cancel_task`'s sticky verdict beats the runner's late finally-write.

Schema reserves `__*__` names via zod refine (the kernel-built-in MCP is `__kernel_next__` — shadowing would silently break all tool calls).

### 3. D21 pipeline DAG: user mandate honored

User said "pipeline 可视化一定要质量效果优先 (quality effect must be top priority)." Implementation:

- `@xyflow/react@^12` + `@dagrejs/dagre@^1` — LR layout
- Custom `StageNodeView` with bg by type (agent=white, gate=amber, script=purple, external=dashed gray), state-driven border (blue+pulse when executing, green done, red error)
- Executing state bg overrides type bg (polish) so color palette doesn't clash
- Badges: FANOUT / MCP×N / SUB×N
- MiniMap with `nodeColor` callback mirroring main graph palette (polish)
- Arrowheads via `defaultEdgeOptions` `markerEnd: ArrowClosed`
- Fixed node width `w-[220px]` matching dagre's NODE_W constant (polish — prevented overflow)
- `role="img" + aria-label` on container (polish — a11y)
- Test infra: `ResizeObserver` + `DOMMatrixReadOnly` shims in `apps/web/src/test-setup.ts`
- Mounted on `/kernel-next/pipelines/[name]` (static) and `/kernel-next/[taskId]` (live `stageStates` overlay)
- Route `GET /api/kernel/tasks/:taskId/ir` resolves latest-attempt version for hot-updated tasks

### 4. `retry_task` pattern borrowed from rollback

`KernelService.retryTaskFromStage` synthesizes a same-version proposal (`base_version === proposed_version`, `diagnostic_json.__kind === "retry-v1"`) then delegates to `executeMigration`. Mirrors `executeRollback`. Side-effect: each retry writes a `hot_update_events` row. `query_hot_update_stats.excludeRetries: true` filters them out (polish commit `e419227`) so proposal-churn analytics stay proposal-focused.

### 5. Web is read-only

User rule: "所有写操作用工具就行 不在web操作 (all write ops via tools, not in web)". D2/D3 (launch form, task list UI) **declined** from sprint. All mutations go through MCP tools:
- `run_pipeline` (new task)
- `retry_task` (D8)
- `cancel_task` (D4)
- `prune_records` (D9)
- `submit_pipeline`, `answer_gate`, propose/approve/reject, migrate/rollback — all pre-existing

Web shows but never writes.

---

## Known open items (deferred, NOT broken)

None of these are blocking correctness. All documented in `capability-review.md` §8.

| Item | Why deferred |
|---|---|
| **P4.2 dryRun child-row projection** | Needs `countAttemptsToDelete` rework to compute child-table deltions without executing. Low value vs effort. |
| **P4.1 synthetic-proposal cleanup** | Each `retry_task` / `rollback` leaves an approved proposal row. Same pattern as `executeRollback`. Would need a dedicated audit-cleanup job. Not a correctness bug. |
| **P3.6 prepare-in-loop in sweeper** | Micro-optimization; sweeper sees <5 rows per tick at single-user scale. |
| **P7.1 animate edges out of `__external__`** | Cosmetic. Edges into executing targets already animate — that's the direction users care about. |
| **CI workflow (D35)** | User declined — local-only repo. |
| **i18n (D28)** | English sufficient for M2. `next-intl` installed but unused. |
| **Whitepaper rewrite (D15)** | Real runnable pipelines > doc polish at M2. |
| **Registry curation (D11)** | Listed as "future P8.2.x" in registry/README; needs real IR-native pipelines to curate. |

---

## What to tackle next session

### High-value and user-blocked (not autonomous)

1. **Real-world dogfood** — Sprint closed but D1 (external MCP injection) has only seen mock/e2e unit tests. Next logical step is a real `pnpm dev` + PG-generated pipeline using github/notion MCP. Needs live `.env.local` + Anthropic API spend. Not autonomous-safe.

2. **Deployment target choice (post-D13)** — Dockerfile works but image bundles devDeps (~500MB). If shipping to brew/DigitalOcean/Vercel/etc., next iteration is image trimming + health-check wiring. User decision on target first.

3. **Friend invitation (M2 trigger)** — technical side of M2 is complete. Social side is "pick someone, share the repo or Docker image, collect feedback." User action.

### Autonomous-friendly if user wants

- **Global cost cap (D14)** — daily budget ledger table; runner checks before each agent stage. Declined from sprint but low-complexity (~3-4h) if user changes stance.
- **PG fragment library (D10)** — small, focused. Start with 2-3 hand-curated fragments for common patterns.
- **Rate-limit active backoff (D7 step 2)** — current P5.3 is observability-only. Active backoff needs `stream-pump.send` to become async (non-trivial refactor).

### Don't bother

- More dashboard polish — §8 of review lists what was deferred with reasoning. Further changes without user direction would be ceremonial.
- Chasing 100% test coverage — current 1651/52 is dense where it matters.
- Another refactor round on `runner.ts` — it's 1418 LOC and the remaining mass is cohesive orchestration core; further splits trade clarity for indirection.

---

## Files to re-read if new session starts cold

Priority order:

1. `CLAUDE.md` (repo root) — ground rules especially §Hard invariants + §Retired areas
2. `docs/2026-04-23-capability-review.md` — living doc, §7 shows which D-numbers landed where, §8 catalogs polish follow-ups
3. `docs/superpowers/plans/2026-04-24-capability-closure.md` — the sprint plan (task-by-task breakdown)
4. `docs/phase6-usage-log.md` §Session 5 — narrative of how the sprint ran
5. `apps/server/src/kernel-next/ir/schema.ts` — IR is the canonical shape; P3 + P5 extended it (mcpServers, fanout concurrency, gate timeout)
6. `apps/server/src/kernel-next/runtime/runner.ts` — main orchestration loop; understand the try/finally at task_finals writeback
7. `apps/web/src/components/pipeline-graph.tsx` + `apps/web/src/lib/ir-to-flow.ts` — D21 quality-first work; the user's explicit priority piece

## Useful commands

```bash
# full test matrix (both workspaces)
cd apps/server && pnpm test          # 1651 pass
cd apps/web && pnpm test             # 52 pass

# type-check (required per CLAUDE-personal §4)
cd apps/server && npx tsc --noEmit
cd apps/web && npx tsc --noEmit

# server dev (needs .env.local with CLAUDE_PATH + REPOS_BASE_PATH etc)
cd apps/server && pnpm dev           # :3001

# web dashboard
cd apps/web && pnpm dev              # :3004 (dev) or :3000 (start)

# Docker
docker compose up -d                 # server :3001 + web :3000, data in ./data/
docker compose logs -f server
docker compose down

# registry rebuild (local-only artifacts, gitignored)
pnpm --filter server registry:build

# admin
pnpm --filter server prune-kernel-records  # or via prune_records MCP tool
```

---

## End-state directory snapshot (apps/server/src/kernel-next/)

```
ir/
  schema.ts              # +McpServerDeclSchema, +FanoutSpec.concurrency, +GateStage.timeout_minutes, +TaskStatus 'cancelled', +3 new Diagnostic codes
  canonical.ts           # mcpServers hash inclusion
  sql.ts                 # +task_env_values table, task_finals CHECK accepts 'cancelled'
runtime/
  runner.ts              # 1418 LOC (was 1736); WHERE !='cancelled' on final upsert; deleteTaskEnvValues on finalization
  runner-fanout.ts       # NEW worker-pool + concurrency cap
  runner-wire-resolver.ts  # NEW extracted
  real-executor.ts       # 767 LOC (was 1044)
  real-executor-prompt-builder.ts   # NEW extracted
  real-executor-sdk-options.ts      # NEW extracted, +externalMcpServers arg
  mcp-servers-expander.ts           # NEW pure ${VAR} expander + McpEnvExpansionError
  task-env-values.ts                # NEW store/load/delete
  gate-timeout-sweeper.ts           # NEW opt-in periodic cancel
  agent-message-delta.ts            # NEW 10Hz throttler (D29)
  rate-limit-backoff.ts             # NEW pure helpers (D7)
  task-cost-aggregator.ts           # NEW cost summing (D23)
  agent-machine.ts       # +consecutiveRateLimitSignals counter action
  orphan-reconciler.ts   # deleteTaskEnvValues on terminal finalization paths
  # deleted during sprint: nothing new. debug/ was NOT removed — it's live MCP infra.
mcp/
  server.ts              # 172 LOC aggregator (was 1201), propagates ALL options to nested createMcpServer
  tool-types.ts          # NEW shared ToolDef + ToolsDeps
  tool-helpers.ts        # NEW jsonResponse + errorResponse
  tools/
    pipeline.ts  task.ts  gate.ts  hot-update.ts  ports.ts  pg.ts  debug.ts  admin.ts   # all NEW (P2.3 split)
  kernel.ts              # +cancelTask, +retryTaskFromStage, widened TaskStatus

hot-update/
  stats.ts               # +excludeRetries filter (P4.1 follow-up)
```

---

## Lessons for future sessions

1. **Plan assumptions are hypotheses.** P1.3 shipped an implementer against "delete debug/ as dead code"; `debug/` turned out to be live MCP infrastructure. Cost: 1 commit → reset → full P1 declined. Mitigation going forward: before deleting ANY non-trivial directory, grep for imports AND cross-check against registered tool/route surfaces.
2. **IR schema extensions cascade.** Each D-gap that touched the IR (D1, D5, D6) required: schema.ts + canonical.ts + sql.ts (if new table) + runtime consumer + PG prompt + pipeline.ir.json fixture sync + e2e test. Skipping any one produces silent runtime errors.
3. **Reviewer Minors compound.** Individually trivial, collectively they were 14 commits of real UX polish the user explicitly mandated (D21). Budget ~10% of sprint time for a dedicated polish pass.
4. **Sticky state beats last-writer-wins.** For any cross-thread/cross-path terminal signal (cancel, error, user-approved), use `WHERE current_state != target_state` on the DO UPDATE to make the intended verdict stick. Saved D4's correctness.
5. **Subagent-Driven works if you curate context.** 68 commits over the sprint; implementer subagents drifted < 5 times and each drift was caught by spec-review or code-review before merge. The review gate IS the productive coordination layer — don't skip it to save tokens.
