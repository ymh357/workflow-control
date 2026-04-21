# Retire Legacy Engine — Stage 4a Design

> **Date:** 2026-04-24
> **Status:** Draft — awaiting user approval
> **Goal-tier:** Stage 4 of the 7-stage Y-direction path to kernel-next-only.
> **Follow-up:** Stage 4b (retire converter + migrate builtin YAML to native IR) is a separate milestone, tackled after this one lands cleanly.
> **Related:**
>   - `docs/kernel-next-terminal-design.md` §1.3 (zero legacy compatibility)
>   - `docs/product-roadmap.md` §4 (瘦身清单)
>   - `CLAUDE.md` §"Frozen areas" (to be updated as part of this milestone)

## 1. Goal & Success Criteria

**Goal:** Remove the legacy XState workflow engine, the legacy agent executor stack, the Edge Runner, Gemini / Codex frozen executors, and every route / web page that consumes them. kernel-next becomes the only runtime engine in the codebase. Converter + builtin YAML retained in reduced scope (startup-only migrator) — that's Stage 4b's job.

**Success criteria:**

1. `apps/server/src/machine/` directory deleted.
2. `apps/server/src/agent/` Claude-executor legacy code deleted. `agent/gemini-executor.ts` and `agent/codex-executor.ts` deleted.
3. `apps/server/src/edge/` directory deleted; `slack-cli-bridge` was already deleted in Phase 0 and remains absent.
4. Legacy HTTP routes deleted: `trigger.ts`, `stream.ts`, `tasks.ts`, `confirm.ts`, `answer.ts`, `retry.ts`, `cancel.ts`, `config.ts`, `config-*.ts`, `registry.ts` plus their tests. Legacy route wiring removed from `apps/server/src/index.ts`.
5. Legacy web pages deleted or redirected: `apps/web/src/app/page.tsx` replaced with a minimal kernel-next-native landing page (or redirect to `/kernel-next/`); `apps/web/src/app/task/`, `apps/web/src/app/config/`, `apps/web/src/app/registry/`, `apps/web/src/app/help/` removed.
6. `apps/server/src/actions/task-actions.ts` deleted (legacy orchestration seam).
7. `apps/server/src/services/pipeline-generator.ts` (legacy pipeline-generator service, distinct from the kernel-next pipeline-generator builtin) deleted.
8. `apps/server/src/services/registry-service.ts` retained if kernel-next needs Registry plumbing; otherwise deleted. Evaluate per use.
9. `CLAUDE.md` §"Frozen areas" replaced with §"Retired" referencing this milestone.
10. `docs/product-roadmap.md` §4 瘦身清单 updated: Gemini/Codex/Edge rows change from "冷冻保留" to "retired 2026-04-24".
11. `kernel-next-terminal-design.md` Appendix A row `Edge Runner | removed` reconciled (was "Not in terminal" — now factually deleted).
12. **Server `tsc --noEmit` passes with 0 errors after all deletions.**
13. **Server `vitest run` passes with 0 failures after all legacy tests are removed alongside their subjects.** Test count drops substantially (legacy adversarial tests go with the code they test); kernel-next suite unchanged.
14. **Web `tsc --noEmit` passes.** Web `pnpm build` passes (if run in CI; otherwise manual dev-server sanity check).
15. `POST /api/kernel/tasks/run` with `{name: "hello-research-v2", seedValues: {topic: "..."}}` continues to work (sanity check the infra we proved in Stage 3 is not regressed).
16. `POST /api/kernel-next/...` routes (gates, proposals, tasks, stream, run) are the only surviving HTTP surface beyond static file / health.

## 2. Scope & Non-Goals

**In scope:**
- Six categories of deletion enumerated in §1 SC 1-8.
- Doc updates (CLAUDE.md, product-roadmap.md, kernel-next-terminal-design.md).
- `apps/server/src/index.ts` rewiring: drop legacy imports + `app.route` calls.
- One minimal replacement for `apps/web/src/app/page.tsx` — either a redirect or a placeholder kernel-next task list reading from `/api/kernel-next/tasks` (if that endpoint exists) or from SQLite-backed lineage queries. Choose whichever is zero-new-API (§5 details).

**Out of scope (deferred):**
- Converter retirement and builtin YAML → native IR migration → Stage 4b.
- New kernel-next-native Web dashboard with pipeline editor / task detail UI → future milestone.
- Registry cross-machine sharing — Registry itself is already deferred in kernel-next-design §2.4; `services/registry-service.ts` evaluated per use (see §5.4).
- Execution Record sidecar → Stage 6.
- Any new MCP tools or kernel features.

**Non-goals (explicit rejections):**
- **NOT** keeping `edge/` frozen. CLAUDE.md §"Frozen areas" is updated because the frozen policy assumed "core stabilizes, then revisit". Core is stable. Revisit = delete.
- **NOT** preserving legacy task data in `{data_dir}/tasks/*.json`. kernel-next-design §1.3 mandates "zero historical compatibility": old tasks die with the engine. Document this in CLAUDE.md update so the user knows. If the user has in-flight legacy tasks they care about, they run them to completion before this milestone lands.
- **NOT** re-implementing legacy routes as thin kernel-next adapters. Routes with semantically-equivalent kernel-next counterparts (`/api/tasks/*` → `/api/kernel/tasks/*`) just go away; consumers switch.
- **NOT** migrating the Next.js Web app itself away from Next. The kernel-next page at `/app/kernel-next/[taskId]/page.tsx` stays.

## 3. Architectural Justification (why delete vs freeze)

kernel-next-terminal-design §1.3 is explicit:

> "The legacy kernel exists only as a control group. When kernel-next surpasses it, it is deleted outright — no migration of old tasks."

And:

> "Zero historical compatibility debt."

CLAUDE.md §"Frozen areas" was written at a time when kernel-next was not proven. As of this milestone, kernel-next has:
- All three stage primitives executing real Claude SDK calls (Stage 2 probe-03)
- pipeline_versions + prompt_contents + pipeline_prompt_refs content-addressed (Stage 1)
- `run_pipeline` MCP tool uniform entry (Stage 3)
- Hot-update IRPatch + migrate-task implemented
- Gate reject runtime rollback
- 4246 tests passing, tsc clean

The frozen policy now prevents code-base clarity gains with no offsetting benefit. Every grep, refactor, and mental model pays the tax of `agent/` / `machine/` / `edge/` sitting alongside kernel-next, often shadowing names and confusing intent.

Decision: delete. Update CLAUDE.md's frozen policy, which is itself a design decision owned by the same product owner.

## 4. Pre-flight: What's at Risk

Before any deletion, three risk classes:

**4.1 Legacy test coverage that verifies kernel-next indirectly.**

Some tests in `agent/`, `machine/` exercise shared modules (e.g. `lib/`, `sse/manager.ts`) that ALSO have kernel-next consumers. Deleting those tests may expose under-covered kernel-next code paths. Mitigation: run `vitest run src/kernel-next src/routes` after each batch, ensure counts stable.

**4.2 `services/registry-service.ts` and Registry plumbing.**

Registry is mentioned in kernel-next-design §2.4 as deferred-but-kept. `services/registry-service.ts` may be importable from future kernel-next Registry features. Mitigation: read the file once, decide keep-or-delete based on whether it imports legacy engine types (if it does = delete; if it's a standalone helper = keep).

**4.3 Routes middleware (`middleware/validate.ts`) may be used by both legacy and kernel-next.**

Mitigation: grep its consumers; keep if kernel-next uses it, adjust imports if only legacy uses it.

**4.4 `lib/config-loader.ts`, `lib/config/*.ts`, `lib/question-manager.ts`, `lib/error-response.ts`.**

Deep-legacy utility libs that task-actions / config-* routes use. kernel-next may or may not consume. Audit per-file.

**4.5 `sse/manager.ts` (legacy SSE) vs `kernel-next/sse/*` (kernel-next SSE).**

Two SSE implementations coexist. Legacy routes use `sse/manager.ts`. Delete legacy SSE manager when the last legacy route is gone.

## 5. Removal Batches

Work is divided into 7 independent, sequentially-committable batches. Each batch ends with tests green + tsc clean or it's rolled back. Estimated 3-5 working days total.

### 5.1 Batch A — Delete legacy routes + index wiring + legacy task-actions

Deletions:
- `routes/trigger.ts` + tests
- `routes/stream.ts` + tests
- `routes/tasks.ts` + tests
- `routes/confirm.ts` + tests
- `routes/answer.ts` + tests
- `routes/retry.ts` + tests
- `routes/cancel.ts` + tests
- `routes/config.ts` + tests
- `routes/config-files.ts`, `routes/config-helpers.ts`, `routes/config-pipelines.ts`, `routes/config-prompts.ts`, `routes/config-settings.ts` + tests
- `routes/registry.ts` + tests
- `routes/action-helpers.ts` + tests (orphan once all consumers gone)
- `middleware/validate.ts` (if only legacy routes used it — audit first)
- `actions/task-actions.ts` + any adjacent action files

Edits:
- `apps/server/src/index.ts`: remove `triggerRoute`, `streamRoute`, `tasksRoute`, `confirmRoute`, `answerRoute`, `retryRoute`, `cancelRoute`, `configRoute`, `registryRoute` imports and `app.route(...)` calls. Keep `kernelProposalsRoute`, `kernelGatesRoute`, `kernelTasksRoute`, `kernelNextStreamRoute`, `kernelRunRoute`, `edgeMcpRoute`, `buildWrapperRoute()` (the last two go in Batch E).

Post-conditions:
- `grep -r "routes/trigger\|routes/stream\.\|routes/tasks\.\|routes/confirm\|routes/answer\|routes/retry\|routes/cancel\|routes/config\.\|routes/config-\|routes/registry" apps/server/src` returns zero hits
- `server tsc` passes; `vitest run` passes (minus all legacy-route test count)

### 5.2 Batch B — Delete legacy machine/

Deletions:
- `apps/server/src/machine/` directory entirely (~4k LOC across 40 files incl. tests)

Edits:
- Audit any remaining imports from `machine/` in kernel-next, sse, or lib. Grep `from "../machine"` and `from "../../machine"` across `apps/server/src`. Expect zero hits after Batch A; if any survive, they're vestigial and removed.
- `apps/server/src/sse/manager.ts` — if this is the legacy SSE manager and has zero remaining consumers after Batch A, delete it. kernel-next SSE is `kernel-next/sse/*`.

Post-conditions: no `machine/` directory, `server tsc` + `vitest run` green.

### 5.3 Batch C — Delete legacy agent/ (Claude legacy executor + sessions)

Deletions (all of these are legacy Claude engine or its support):
- `agent/agent-executor.ts`
- `agent/async-queue.ts`
- `agent/context-builder.ts` + its measurement/schema/baseline/adversarial tests
- `agent/decision-runner.ts`
- `agent/executor.ts` + tests
- `agent/executor-hooks.ts`
- `agent/foreach-executor.ts` + tests
- `agent/output-schema.ts` + tests
- `agent/phase-planner-prompt.ts` + tests
- `agent/pipeline-executor.ts` + tests (includes `pipeline-executor-store-source.test.ts`)
- `agent/prompt-builder.ts` + tests
- `agent/prompts.ts` + tests
- `agent/query-options-builder.ts` + tests
- `agent/query-tracker.ts` + tests
- `agent/red-flag-detector.ts`
- `agent/schema-renderer.ts` + tests
- `agent/semantic-summary-cache.ts` + tests
- `agent/semantic-summary.ts` + tests
- `agent/session-manager-registry.ts` + tests
- `agent/session-manager.ts` + tests + integration tests
- `agent/session-persister.ts` + tests
- `agent/stage-config.ts`
- `agent/stage-executor.ts` + tests
- `agent/step-hints.ts` + tests
- `agent/stream-processor.ts` + tests
- `agent/verify-commands.ts`

Retained in agent/ temporarily for Batch D:
- `agent/gemini-executor.ts` + tests
- `agent/codex-executor.ts` + tests

Post-conditions: tsc + vitest green; kernel-next lives without any import from `agent/` of the deleted set.

### 5.4 Batch D — Delete Gemini + Codex executors

Deletions:
- `agent/gemini-executor.ts` + `gemini-executor.test.ts` + `gemini-executor.adversarial.test.ts`
- `agent/codex-executor.ts` + `codex-executor.test.ts`
- `agent/` directory itself (should now be empty) — remove directory

Edits:
- `preflight` checks in `apps/server/src/setup.ts` or equivalent that look for `gemini` / `codex` binaries: simplify to only check Claude executable.

Post-conditions: `ls agent/` returns no such file or directory. CLAUDE.md update queued.

### 5.5 Batch E — Delete Edge Runner

Deletions:
- `apps/server/src/edge/` directory (21 files, 2741 LOC)

Edits:
- `apps/server/src/index.ts`: remove `edgeMcpRoute` import + `app.route("/mcp", edgeMcpRoute)` and `buildWrapperRoute` import + `app.route("/api/edge", buildWrapperRoute())` calls.

Post-conditions: `ls apps/server/src/edge/` returns no such directory.

### 5.6 Batch F — Delete legacy services + lib orphans + legacy builtins

Deletions:
- `services/pipeline-generator.ts` (legacy pipeline-generator service distinct from the kernel-next builtin at `builtin-pipelines/pipeline-generator/pipeline.yaml`)
- `services/registry-service.ts` — keep only if imports survive after Batch A–E. Audit: `grep -rn 'from "../services/registry-service"' apps/server/src`. If zero hits, delete. If kernel-next imports it, keep.
- `lib/config-loader.ts`, `lib/config/*.ts` if orphan
- `lib/question-manager.ts` if orphan
- `lib/error-response.ts` if orphan (kernel-next uses different diagnostic shapes)
- Any `__integration__` / `__audit__` / `__regression__` directories in `apps/server/src` whose tests targeted legacy engine specifically (keep any kernel-next-relevant ones)
- `builtin-pipelines/linear-dev-cycle/` — legacy pipeline not in the 4-pipeline Stage-2 scope, not loaded anywhere. Grep confirms unused.
- `builtin-pipelines/pr-security-performance-review/` — same logic, if present
- `builtin-pipelines/plan-then-execute/`, `tech-debt-weekly-cleanup/`, `web3-tech-research/` (if present) — any legacy pipelines NOT in the kept four (smoke-test / tech-research-collector / tech-research-writer / pipeline-generator)

Edits to preflight / startup:
- `setup.ts` preflight — drop `repos-base` / `worktrees-base` if these are legacy concepts. Keep kernel-next relevant ones.

Post-conditions: grep across `apps/server/src` for `services/pipeline-generator`, `actions/task-actions`, `lib/config-loader` (if deleted) returns zero.

### 5.7 Batch G — Delete legacy Web pages + replace root

Deletions in `apps/web/src/`:
- `app/task/[id]/page.tsx` + test
- `app/config/page.tsx` + related components
- `app/registry/page.tsx` (if exists) + related components
- `app/help/page.tsx` (if exists)
- `components/config/` directory
- `components/config-workbench.tsx`
- Any other `components/*.tsx` that only legacy pages consumed

Replacement for `apps/web/src/app/page.tsx`:

One of two options — the minimal one wins:

**Option A (redirect)**:
```tsx
"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
export default function Home() {
  const router = useRouter();
  useEffect(() => { router.replace("/kernel-next"); }, [router]);
  return null;
}
```
Plus create `apps/web/src/app/kernel-next/page.tsx` that lists recent tasks by querying `/api/kernel/tasks` (if such an index endpoint exists — check) or just renders a help message pointing at `/kernel-next/<taskId>`.

**Option B (static placeholder)**: root page becomes a single-screen static info page: "workflow-control kernel-next — use MCP run_pipeline or POST /api/kernel/tasks/run; live task views at /kernel-next/<taskId>". No dynamic data.

Choose Option A if a tasks-index endpoint exists; else B.

Edits to `apps/web/next.config.*`, `apps/web/src/middleware.ts` (if exists): drop any rewrites targeting deleted pages.

Post-conditions: `pnpm --filter web build` passes. `web tsc --noEmit` passes.

### 5.8 Batch H — Docs update

Edits:
- `CLAUDE.md`: §"Frozen areas" → §"Retired (2026-04-24)" listing deleted directories. Note: "kernel-next is the only engine. Legacy tasks in `{data_dir}/tasks/*.json` are not migrated; run to completion before upgrading past this milestone."
- `docs/product-roadmap.md`:
  - §4 瘦身清单: update rows for Gemini / Codex / Edge Runner / Slack Bridge / legacy dashboard — mark retired with date
  - Add a modest revision entry at the bottom
- `docs/kernel-next-terminal-design.md`:
  - Appendix A: the `Edge Runner | removed | Not in terminal` row — optionally add date note
  - Appendix B: confirm "Historical task migration" and "Backwards-compatible YAML schema evolution" stay as "Explicitly out of scope"
- Add a new handoff doc: `docs/superpowers/plans/2026-04-24-retire-legacy-engine-done-handoff.md` (created at milestone end; enumerates what was deleted, final test count, any surprises)

Post-conditions: docs reflect reality.

## 6. Testing Strategy

Each batch ends with:

```bash
cd /Users/minghao/workflow-control/apps/server
./node_modules/.bin/tsc --noEmit            # 0 errors
./node_modules/.bin/vitest run                # 0 failures
./node_modules/.bin/vitest run src/kernel-next src/routes   # ensure kernel-next invariants
```

After Batch G (web pages):

```bash
cd /Users/minghao/workflow-control/apps/web
./node_modules/.bin/tsc --noEmit            # 0 errors
# Optional: pnpm build — slower but catches Next.js runtime errors
```

**Test count bookkeeping**: each batch's commit message records pre/post counts so regression can be attributed. Expected trajectory: ~4246 tests → ~2500 tests (legacy test files delete alongside their subjects).

**No new tests** in this milestone. All deletions. Adding tests while deleting the only copies creates noise.

## 7. Commit Discipline

Each batch = one commit (or a small series within the batch if a single commit would be unwieldy). Commit message format:

```
chore(retire-legacy): batch X — <subject>

Deletions:
- <path 1>
- <path 2>
- ...

Test delta: N → M (-K)
tsc: 0 errors
```

Commits are independent — any batch can be reverted without cascading.

## 8. Risks & Mitigations

**8.1 Hidden live import from kernel-next to legacy.**

Our earlier grep (`grep "from \"../../agent/\|from \"../agent/\|..."` in kernel-next) found zero hits — kernel-next is clean. But test files might still transitively depend on legacy utility libs (`lib/config-loader`, `lib/question-manager`). Mitigation: tsc after each batch catches them immediately.

**8.2 Legacy SSE manager shared with something.**

`sse/manager.ts` may be imported by logger or by kernel-next's dashboard bridge. Grep before deletion in Batch B's cleanup.

**8.3 User has live legacy tasks in `{data_dir}/tasks/`.**

kernel-next-design §1.3 says "legacy tasks are not ported; they stop running when legacy kernel is deleted". Document this boldly in CLAUDE.md update. If the user is currently running legacy pipelines for daily work, STOP and migrate them to kernel-next first.

**Action required from user**: confirm no active legacy tasks before Batch B lands. After Batch B, legacy task JSON files become inert data.

**8.4 Next.js static/manifest import caching.**

Web build may hold onto deleted pages in `.next/`. Mitigation: `rm -rf apps/web/.next` between batches that touch `apps/web`.

**8.5 Converter and builtin YAML retained but legacy-adjacent.**

Converter lives in `kernel-next/converter/`, so it survives the `agent/` and `machine/` deletions. `seedLegacyPipelineByName` in `routes/kernel-run.ts` keeps it functional. This is by design of Stage 4a. Stage 4b finishes the retirement.

## 9. Non-Negotiables Check

- ✅ Kernel executor-agnostic — unchanged (we're deleting non-kernel layers).
- ✅ IR cannot encode policy — unchanged.
- ✅ MCP surface physical separation — unchanged.
- ✅ Lineage synchronous — unchanged.
- ✅ Hot-update never silently migrates — unchanged.
- ✅ No mutable global state — unchanged.
- ✅ **Zero legacy compatibility** — this milestone MAKES GOOD on it. Old task JSON is not ported (§8.3 documented).

## 10. Self-Review Checklist

- [ ] Every deletion in §5 has a concrete file path or directory
- [ ] Each batch is standalone-committable + tsc/vitest clean
- [ ] CLAUDE.md §"Frozen areas" replaced in Batch H
- [ ] Converter + builtin YAML left untouched (Stage 4b deferred)
- [ ] kernel-next test suite unchanged in counts + content
- [ ] Web root page replaced (not just deleted — would break Next.js build otherwise)
- [ ] Handoff doc created at milestone end
