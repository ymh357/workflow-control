# Retire Legacy Engine — Stage 4a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the legacy XState engine, legacy agent stack, Edge Runner, Gemini/Codex frozen executors, legacy routes, and legacy Web pages. kernel-next becomes the only runtime engine.

**Architecture:** Seven sequential deletion batches. Each batch ends with `tsc --noEmit` clean + `vitest run` zero failures. Converter and builtin YAML are retained (Stage 4b handles them). Every batch is independently committable and revertible.

**Tech Stack:** TypeScript, Vitest, Hono (server), Next.js 15 (web).

**Spec:** `docs/superpowers/specs/2026-04-24-retire-legacy-engine-design.md`

**Baseline (pre-milestone)**: 4246 tests passed / 6 skipped / 0 failed across 288 test files. Server tsc clean, web tsc clean.

---

## Pre-flight Checklist (do once before Batch A)

- [ ] **Step 1: Snapshot current state**

Run:
```bash
cd /Users/minghao/workflow-control
git status                                 # expect clean tree
git log --oneline -5                       # note the HEAD SHA
cd apps/server && ./node_modules/.bin/vitest run 2>&1 | tail -3     # record counts
./node_modules/.bin/tsc --noEmit                                    # expect 0 errors
cd ../web && ./node_modules/.bin/tsc --noEmit                       # expect 0 errors
```

Record these baselines in a scratch note:
- HEAD SHA
- Server tests: X passed / Y skipped
- Server tsc: clean
- Web tsc: clean

- [ ] **Step 2: Confirm no active legacy tasks**

If the user runs legacy pipelines for daily work, those tasks must complete before Batch B. Task JSON files in `{data_dir}/tasks/*.json` become inert after legacy engine deletion.

Check: `ls /tmp/workflow-control-data/tasks/ 2>/dev/null | head`. If any, ask the user to either cancel or let them finish before proceeding.

- [ ] **Step 3: Read spec §4 Pre-flight once**

Ensures the risk list (Batch-specific gotchas) is in mind.

---

## Batch A — Delete legacy HTTP routes + legacy action layer

**Files deleted:**
- `apps/server/src/routes/trigger.ts` + `.test.ts` + `.adversarial.test.ts`
- `apps/server/src/routes/stream.ts` + `.test.ts` + `.adversarial.test.ts`
- `apps/server/src/routes/tasks.ts` + `.test.ts` + `.adversarial.test.ts`
- `apps/server/src/routes/confirm.ts` + `.test.ts` + `.adversarial.test.ts`
- `apps/server/src/routes/answer.ts` + `.test.ts` + `.adversarial.test.ts`
- `apps/server/src/routes/retry.ts` + `.test.ts` + `.adversarial.test.ts`
- `apps/server/src/routes/cancel.ts` + `.test.ts` + `.adversarial.test.ts`
- `apps/server/src/routes/config.ts` + `.test.ts` + `.adversarial.test.ts`
- `apps/server/src/routes/config-files.ts` + tests
- `apps/server/src/routes/config-helpers.ts` + tests
- `apps/server/src/routes/config-pipelines.ts` + tests
- `apps/server/src/routes/config-prompts.ts` + tests
- `apps/server/src/routes/config-settings.ts` + tests
- `apps/server/src/routes/registry.ts` + tests (+ `.adversarial.test.ts` if present)
- `apps/server/src/routes/action-helpers.ts` + tests
- `apps/server/src/middleware/validate.ts` (all consumers are legacy routes — confirmed via grep)
- `apps/server/src/actions/task-actions.ts` + any sibling action files in `apps/server/src/actions/`

**Files modified:**
- `apps/server/src/index.ts` — remove imports and `app.route(...)` calls for the deleted routes. Keep `kernelProposalsRoute`, `kernelGatesRoute`, `kernelTasksRoute`, `kernelNextStreamRoute`, `kernelRunRoute`. Edge routes (`edgeMcpRoute`, `buildWrapperRoute`) stay — they go in Batch E.

### Task A1: Delete the route files

- [ ] **Step 1: Confirm no kernel-next imports from these files**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server/src
grep -rn 'routes/trigger\|routes/stream\.\|routes/tasks\.\|routes/confirm\|routes/answer\|routes/retry\|routes/cancel\|routes/config\.\|routes/config-\|routes/registry\.\|routes/action-helpers' kernel-next lib sse services 2>/dev/null | grep -v test
```
Expected: zero hits (nothing outside `routes/` and `index.ts` should reference these). If any hit surfaces, record it and reassess before deleting.

- [ ] **Step 2: git rm all listed route + test files**

```bash
cd /Users/minghao/workflow-control
git rm apps/server/src/routes/trigger.ts \
       apps/server/src/routes/trigger.test.ts \
       apps/server/src/routes/trigger.adversarial.test.ts \
       apps/server/src/routes/stream.ts \
       apps/server/src/routes/stream.test.ts \
       apps/server/src/routes/stream.adversarial.test.ts \
       apps/server/src/routes/tasks.ts \
       apps/server/src/routes/tasks.test.ts \
       apps/server/src/routes/tasks.adversarial.test.ts \
       apps/server/src/routes/confirm.ts \
       apps/server/src/routes/confirm.test.ts \
       apps/server/src/routes/confirm.adversarial.test.ts \
       apps/server/src/routes/answer.ts \
       apps/server/src/routes/answer.test.ts \
       apps/server/src/routes/answer.adversarial.test.ts \
       apps/server/src/routes/retry.ts \
       apps/server/src/routes/retry.test.ts \
       apps/server/src/routes/retry.adversarial.test.ts \
       apps/server/src/routes/cancel.ts \
       apps/server/src/routes/cancel.test.ts \
       apps/server/src/routes/cancel.adversarial.test.ts \
       apps/server/src/routes/config.ts \
       apps/server/src/routes/config.test.ts \
       apps/server/src/routes/config.adversarial.test.ts \
       apps/server/src/routes/config-files.ts \
       apps/server/src/routes/config-helpers.ts \
       apps/server/src/routes/config-pipelines.ts \
       apps/server/src/routes/config-prompts.ts \
       apps/server/src/routes/config-settings.ts \
       apps/server/src/routes/registry.ts \
       apps/server/src/routes/registry.test.ts \
       apps/server/src/routes/action-helpers.ts \
  2>&1 | tail -20
```

Some of the listed files may not exist (e.g. `trigger.adversarial.test.ts` if the team never wrote one). Pass ignored paths through `git rm --ignore-unmatch`. Easier: split the `git rm` into per-file lines and accept that some log "did not match any files" — that's fine, move on.

- [ ] **Step 3: Also rm sibling tests and registry adversarial files if present**

```bash
cd /Users/minghao/workflow-control
git ls-files apps/server/src/routes/ | grep -E '(config-(files|helpers|pipelines|prompts|settings)|registry|action-helpers)\..*\.test\.ts' | xargs -I{} git rm {}
```

This scoops up test files matching the patterns that may exist (e.g. `config-files.test.ts`, `registry.adversarial.test.ts`).

### Task A2: Delete `middleware/validate.ts` and `actions/`

- [ ] **Step 1: Confirm no non-legacy consumer**

```bash
cd /Users/minghao/workflow-control/apps/server/src
grep -rn 'middleware/validate' . --include='*.ts' 2>/dev/null | grep -v '^\./routes/\|/test.ts:\|routes/.*\.test\.ts:' | head
```
Expected: zero hits that aren't legacy routes (already queued for deletion).

Same for actions:
```bash
grep -rn 'actions/task-actions' . --include='*.ts' 2>/dev/null | grep -v '^\./routes/\|/test.ts:' | head
```
Expected: zero.

- [ ] **Step 2: Delete**

```bash
cd /Users/minghao/workflow-control
git rm apps/server/src/middleware/validate.ts
git ls-files apps/server/src/actions/ | xargs git rm
```

If `middleware/` directory is now empty, that's fine — empty dirs aren't tracked in git. If `middleware/` has OTHER files with non-legacy consumers, leave it alone.

### Task A3: Rewire `index.ts`

- [ ] **Step 1: Read current index.ts route wiring**

Run `cat /Users/minghao/workflow-control/apps/server/src/index.ts | grep -E 'import.*routes/|app\.route'`

Expected imports to remove (lines 9-17 roughly):
```
import { triggerRoute } from "./routes/trigger.js";
import { streamRoute } from "./routes/stream.js";
import { tasksRoute } from "./routes/tasks.js";
import { confirmRoute } from "./routes/confirm.js";
import { answerRoute } from "./routes/answer.js";
import { retryRoute } from "./routes/retry.js";
import { cancelRoute } from "./routes/cancel.js";
import { configRoute } from "./routes/config.js";
import { registryRoute } from "./routes/registry.js";
```

Expected `app.route(...)` calls to remove:
```
app.route("/api", triggerRoute);
app.route("/api", streamRoute);
app.route("/api", tasksRoute);
app.route("/api", confirmRoute);
app.route("/api", answerRoute);
app.route("/api", retryRoute);
app.route("/api", cancelRoute);
app.route("/api", configRoute);
app.route("/api", registryRoute);
```

- [ ] **Step 2: Edit index.ts — remove those lines**

Use the Edit tool. For each of the 9 import lines, delete one by one (or batch with `replace_all: false` when unique). Same for the 9 `app.route(...)` calls. Leave untouched: `kernelProposalsRoute`, `kernelGatesRoute`, `kernelTasksRoute`, `kernelNextStreamRoute`, `kernelRunRoute`, and the edge routes (`edgeMcpRoute`, `buildWrapperRoute`).

Also remove any UUID validation middleware that only targeted deleted routes:
```typescript
app.use(`/api/tasks/:taskId{${UUID_REGEX}}/*`, validateTaskId);
app.use(`/api/tasks/:taskId{${UUID_REGEX}}`, validateTaskId);
app.use(`/api/stream/:taskId{${UUID_REGEX}}`, validateTaskId);
```
Remove these if their only purpose was gating the deleted routes. Also remove the `validateTaskId` import if it's now unused.

- [ ] **Step 3: Run tsc**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsc --noEmit 2>&1 | tail -20
```

Expected: 0 errors.

**Likely fallout:**
- `index.ts` still imports something that's now orphan (e.g. `validateBody` from a deleted validate.ts): tsc will flag. Remove.
- `lib/config-loader.ts` or `lib/question-manager.ts` may be imported by something ALREADY deleted in A1/A2, and tsc might flag them as unused exports. Not a real error yet — those libs get trimmed in Batch F.
- A test file imports a deleted route — tsc won't catch that (test files aren't type-checked unless wired in), but vitest will. Next step catches it.

- [ ] **Step 4: Run full vitest**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run 2>&1 | tail -10
```

Expected: 0 failures (test count drops as deleted .test.ts files vanish with their targets). If any still-present test file imports a deleted module, the import will error — delete that orphan test file.

- [ ] **Step 5: Commit**

```bash
cd /Users/minghao/workflow-control && git add -A apps/server/src && git commit -m "chore(retire-legacy): batch A — delete legacy routes + actions + validate middleware

Deletions:
- routes/{trigger,stream,tasks,confirm,answer,retry,cancel,config,config-*,registry,action-helpers}.ts + tests
- middleware/validate.ts (no non-legacy consumers)
- actions/task-actions.ts (legacy orchestration seam)
- index.ts: dropped 9 route imports + 9 app.route() calls + UUID validation middleware

Test delta: <record from Step 4>
tsc: 0 errors"
```

Fill `<record from Step 4>` with the actual pre→post counts from the vitest summary.

---

## Batch B — Delete legacy `machine/` XState engine

**Files deleted:** entire directory `apps/server/src/machine/` (~40 files incl. tests, ~4k LOC production).

**Files potentially modified:**
- `apps/server/src/sse/manager.ts` — legacy SSE, audit and delete if no non-legacy consumer
- `apps/server/src/lib/config-loader.ts` — may be referenced from kernel-next or converter; audit
- `apps/server/src/lib/question-manager.ts` — same

### Task B1: Pre-deletion audit

- [ ] **Step 1: Confirm kernel-next is clean of machine/ imports**

```bash
cd /Users/minghao/workflow-control/apps/server/src
grep -rn 'from "\.\.\/machine\|from "\.\.\/\.\.\/machine' . --include='*.ts' 2>/dev/null
```

Expected: zero hits. If any remain, they're vestigial and need deletion BEFORE Batch B.

- [ ] **Step 2: Audit `sse/manager.ts`**

```bash
cd /Users/minghao/workflow-control/apps/server/src
grep -rn 'sse/manager' . --include='*.ts' 2>/dev/null | head
```

Classify each remaining consumer: is it legacy (deletable with machine/) or kernel-next (must stay working)? If the only consumers are inside `machine/` itself, `sse/manager.ts` goes with Batch B. If anything in `kernel-next/` or `sse/` has consumers beyond kernel-next's own `broadcaster.ts`, keep it — flag for Batch F review.

- [ ] **Step 3: Audit `lib/config-loader.ts` and `lib/question-manager.ts`**

```bash
grep -rn 'lib/config-loader' . --include='*.ts' 2>/dev/null | head
grep -rn 'lib/question-manager' . --include='*.ts' 2>/dev/null | head
```

Note consumers that aren't themselves legacy. These will need to stay until Batch F if they serve kernel-next (unlikely but verify).

### Task B2: Delete machine/

- [ ] **Step 1: git rm the directory**

```bash
cd /Users/minghao/workflow-control
git rm -r apps/server/src/machine/
```

- [ ] **Step 2: Conditional delete sse/manager.ts**

If Task B1 Step 2 showed zero remaining consumers after Batch A + machine/ deletion (which is likely), delete:

```bash
cd /Users/minghao/workflow-control
git rm apps/server/src/sse/manager.ts
git ls-files apps/server/src/sse/ | grep -v 'kernel-next'
# If there are other non-kernel-next files in sse/ that only machine/ used, rm them too.
```

Be conservative. If you're not sure a file is orphan, skip it and Batch F picks it up.

- [ ] **Step 3: tsc + vitest**

```bash
cd /Users/minghao/workflow-control/apps/server
./node_modules/.bin/tsc --noEmit 2>&1 | tail -20
./node_modules/.bin/vitest run 2>&1 | tail -10
```

Expected: 0 errors, 0 failures. If tsc complains about imports from `machine/` that Batch A missed, find and delete those orphan files (likely in `services/` or `lib/`).

- [ ] **Step 4: Commit**

```bash
cd /Users/minghao/workflow-control && git add -A apps/server/src && git commit -m "chore(retire-legacy): batch B — delete machine/ XState engine

Deletions:
- apps/server/src/machine/ (entire directory, ~40 files)
- sse/manager.ts (legacy SSE; if deleted)

Test delta: <record>
tsc: 0 errors"
```

---

## Batch C — Delete legacy `agent/` Claude executor stack

**Files deleted in `apps/server/src/agent/`** (retaining gemini-executor / codex-executor for Batch D):

- `agent-executor.ts` + `.test.ts` + `.adversarial.test.ts`
- `async-queue.ts` + `.test.ts`
- `context-builder.ts` + `.test.ts` + `.baseline.test.ts` + `.schema.test.ts` + `.adversarial.test.ts` + `.3.6-measurement.test.ts`
- `decision-runner.ts` + `.test.ts`
- `executor.ts` + `.test.ts` + `.adversarial.test.ts`
- `executor-hooks.ts` + `.test.ts` + `.adversarial.test.ts`
- `foreach-executor.ts` + `.test.ts`
- `output-schema.ts` + `.test.ts` + `.adversarial.test.ts`
- `phase-planner-prompt.ts` + `.test.ts`
- `pipeline-executor.ts` + `.test.ts` + `pipeline-executor-store-source.test.ts`
- `prompt-builder.ts` + `.test.ts` + `.adversarial.test.ts`
- `prompts.ts` + `.test.ts` + `.adversarial.test.ts`
- `query-options-builder.ts` + `.test.ts` + `.adversarial.test.ts`
- `query-tracker.ts` + `.test.ts` + `.adversarial.test.ts`
- `red-flag-detector.ts`
- `schema-renderer.ts` + `.test.ts`
- `semantic-summary-cache.ts` + `.test.ts`
- `semantic-summary.ts` + `.test.ts`
- `session-manager-registry.ts` + `.test.ts`
- `session-manager.ts` + `.test.ts` + `.integration.test.ts`
- `session-persister.ts` + `.test.ts` + `.adversarial.test.ts`
- `stage-config.ts`
- `stage-executor.ts` + `.test.ts` + `.adversarial.test.ts`
- `step-hints.ts` + `.test.ts` + `.adversarial.test.ts`
- `stream-processor.ts` + `.test.ts` + `.adversarial.test.ts`
- `verify-commands.ts`

### Task C1: Pre-deletion audit

- [ ] **Step 1: Confirm no kernel-next agent/ imports**

```bash
cd /Users/minghao/workflow-control/apps/server/src
grep -rn 'from "\.\./agent\|from "\.\./\.\./agent\|from "\.\/agent' kernel-next lib sse services routes --include='*.ts' 2>/dev/null | grep -v test | head
```

Expected: zero hits from `kernel-next/`. If any, they're vestigial and STOP — those need separate cleanup before Batch C.

- [ ] **Step 2: Confirm gemini/codex are present (go in Batch D)**

```bash
ls apps/server/src/agent/gemini-executor.ts apps/server/src/agent/codex-executor.ts 2>&1
```

Expected: both exist. They are NOT deleted in this batch.

### Task C2: Delete the listed files

- [ ] **Step 1: Use git ls-files + grep to avoid typos**

```bash
cd /Users/minghao/workflow-control
git ls-files apps/server/src/agent/ | grep -vE 'gemini-executor|codex-executor' | xargs git rm
```

This deletes everything in `agent/` except gemini and codex. Verify the list of removed files contains no unexpected survivor.

- [ ] **Step 2: tsc**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsc --noEmit 2>&1 | tail -30
```

Expected: 0 errors. Likely fallout:
- Some file in `lib/` or `services/` imports a deleted agent module. If it's a legacy-only file, delete it (it belongs in Batch F anyway — just pull its deletion forward). If it's kernel-next-reachable, something is wrong; STOP and report.

- [ ] **Step 3: vitest**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run 2>&1 | tail -10
```

Expected: 0 failures. Test count drops further.

- [ ] **Step 4: Commit**

```bash
cd /Users/minghao/workflow-control && git add -A apps/server/src && git commit -m "chore(retire-legacy): batch C — delete legacy Claude agent stack

Deletions:
- apps/server/src/agent/ (everything except gemini-executor + codex-executor)
  ~28 production modules + tests

Test delta: <record>
tsc: 0 errors"
```

---

## Batch D — Delete Gemini + Codex executors

**Files deleted:**
- `apps/server/src/agent/gemini-executor.ts` + `.test.ts` + `.adversarial.test.ts`
- `apps/server/src/agent/codex-executor.ts` + `.test.ts`
- `apps/server/src/agent/` directory itself (should be empty after these)

**Files modified:**
- `apps/server/src/setup.ts` (or equivalent preflight check file) — remove gemini/codex binary checks if present

### Task D1: Delete gemini + codex

- [ ] **Step 1: git rm**

```bash
cd /Users/minghao/workflow-control
git rm apps/server/src/agent/gemini-executor.ts \
       apps/server/src/agent/gemini-executor.test.ts \
       apps/server/src/agent/gemini-executor.adversarial.test.ts \
       apps/server/src/agent/codex-executor.ts \
       apps/server/src/agent/codex-executor.test.ts
```

Use `--ignore-unmatch` if any adversarial test doesn't exist:

```bash
cd /Users/minghao/workflow-control
git rm --ignore-unmatch apps/server/src/agent/gemini-executor.adversarial.test.ts apps/server/src/agent/codex-executor.adversarial.test.ts
```

- [ ] **Step 2: Confirm agent/ is empty**

```bash
ls apps/server/src/agent/ 2>/dev/null || echo "agent/ removed"
```

Should be empty OR report "No such file or directory" (depending on whether git tracks empty dirs — it doesn't, so after all files are removed the dir effectively vanishes from git but may still exist on disk as empty).

Clean up on disk:
```bash
rmdir /Users/minghao/workflow-control/apps/server/src/agent 2>/dev/null || true
```

### Task D2: Update preflight

- [ ] **Step 1: Read setup.ts preflight**

```bash
cat /Users/minghao/workflow-control/apps/server/src/setup.ts | head -50
```

Look for entries referencing `gemini`, `codex`, `Gemini Executable`, `Codex Executable`.

- [ ] **Step 2: Remove them**

Edit setup.ts: delete the gemini/codex preflight check lines. Keep Claude executable check.

- [ ] **Step 3: tsc + vitest**

```bash
cd /Users/minghao/workflow-control/apps/server
./node_modules/.bin/tsc --noEmit 2>&1 | tail -10
./node_modules/.bin/vitest run 2>&1 | tail -5
```

Expected: 0 errors, 0 failures.

- [ ] **Step 4: Commit**

```bash
cd /Users/minghao/workflow-control && git add -A apps/server/src && git commit -m "chore(retire-legacy): batch D — delete Gemini + Codex executors

Deletions:
- apps/server/src/agent/{gemini,codex}-executor.ts + tests
- apps/server/src/agent/ directory (now empty)

Edits:
- setup.ts preflight: drop gemini/codex binary checks

Test delta: <record>
tsc: 0 errors"
```

---

## Batch E — Delete Edge Runner

**Files deleted:**
- `apps/server/src/edge/` directory (21 files, 2741 LOC production)

**Files modified:**
- `apps/server/src/index.ts` — drop edge route wiring

### Task E1: Delete edge/

- [ ] **Step 1: Confirm no kernel-next imports from edge**

```bash
cd /Users/minghao/workflow-control/apps/server/src
grep -rn 'from "\.\./edge\|from "\.\./\.\./edge\|from "\.\/edge' kernel-next lib sse services routes --include='*.ts' 2>/dev/null | grep -v test | head
```

Expected: zero hits. Edge is self-contained; only `index.ts` references it.

- [ ] **Step 2: git rm the directory**

```bash
cd /Users/minghao/workflow-control
git rm -r apps/server/src/edge/
```

### Task E2: Rewire index.ts

- [ ] **Step 1: Read current edge wiring**

```bash
grep -n 'edgeMcpRoute\|buildWrapperRoute\|edge/' /Users/minghao/workflow-control/apps/server/src/index.ts
```

Expected (roughly):
```
import { edgeMcpRoute } from "./edge/route.js";
import { buildWrapperRoute } from "./edge/wrapper-api.js";
app.route("/mcp", edgeMcpRoute);
app.route("/api/edge", buildWrapperRoute());
```

- [ ] **Step 2: Remove those lines**

Edit index.ts: delete the 2 imports and 2 `app.route(...)` calls. Also remove any middleware or CORS entries that referenced `/api/edge` or `/mcp` specifically.

- [ ] **Step 3: tsc + vitest**

```bash
cd /Users/minghao/workflow-control/apps/server
./node_modules/.bin/tsc --noEmit 2>&1 | tail -10
./node_modules/.bin/vitest run 2>&1 | tail -5
```

Expected: 0 errors, 0 failures.

- [ ] **Step 4: Commit**

```bash
cd /Users/minghao/workflow-control && git add -A apps/server/src && git commit -m "chore(retire-legacy): batch E — delete Edge Runner

Deletions:
- apps/server/src/edge/ (21 files, 2741 LOC)

Edits:
- index.ts: dropped edgeMcpRoute + buildWrapperRoute wiring

Test delta: <record>
tsc: 0 errors"
```

---

## Batch F — Delete legacy services + orphan lib helpers + unused builtin pipelines

**Files deleted:**
- `apps/server/src/services/pipeline-generator.ts` — legacy pipeline-generator service (distinct from `builtin-pipelines/pipeline-generator/` — that's the kernel-next YAML builtin, kept)
- `apps/server/src/services/registry-service.ts` — ONLY if zero kernel-next consumers (audit first)
- `apps/server/src/lib/config-loader.ts` — likely orphan after A-E
- `apps/server/src/lib/config/` directory — likely orphan
- `apps/server/src/lib/question-manager.ts` — likely orphan
- `apps/server/src/lib/error-response.ts` — audit; kernel-next uses different diagnostic shapes
- `apps/server/src/__integration__/`, `apps/server/src/__audit__/`, `apps/server/src/__regression__/` — if any contain legacy-only test fixtures

Unused builtin pipelines (legacy YAML that never gets seeded into kernel-next, per spec §2 SC 3):

- `apps/server/src/builtin-pipelines/web3-research-writer/` — sub-pipeline without injected_context, not in the seeded four
- Any builtin pipeline NOT in `{smoke-test, tech-research-collector, tech-research-writer, pipeline-generator}`

### Task F1: Audit each candidate for deletion

- [ ] **Step 1: Audit script**

Run this combined audit:

```bash
cd /Users/minghao/workflow-control/apps/server/src
for target in services/pipeline-generator services/registry-service lib/config-loader lib/config lib/question-manager lib/error-response; do
  echo "=== ${target} ==="
  grep -rn "from \".*${target}" . --include='*.ts' 2>/dev/null | grep -v test | head
done
```

Read each section. Classify:
- **Delete**: only imported by already-deleted files (A/B/C/D/E) or by its own tests → safe to delete
- **Keep**: imported by kernel-next/, routes/kernel-*, or sse/kernel-next* → leave alone
- **Orphan imports**: the grep should be empty after A-E

- [ ] **Step 2: Audit builtin-pipelines/**

```bash
ls /Users/minghao/workflow-control/apps/server/src/builtin-pipelines/
```

Kept four (per spec): `smoke-test`, `tech-research-collector`, `tech-research-writer`, `pipeline-generator`. Anything else is deletable in this batch.

- [ ] **Step 3: Audit `__integration__` / `__audit__` / `__regression__` directories**

```bash
ls apps/server/src/__integration__/ apps/server/src/__audit__/ apps/server/src/__regression__/ 2>/dev/null
```

For each directory that exists, read one test file to understand its scope. If it targets legacy engine specifically (machine/agent routes), delete. If it has kernel-next relevance, keep.

### Task F2: Delete confirmed orphans

- [ ] **Step 1: Delete services**

```bash
cd /Users/minghao/workflow-control
# Always delete the legacy pipeline-generator service:
git rm apps/server/src/services/pipeline-generator.ts
# Delete registry-service only if audit showed zero kernel-next consumers:
# (If audit showed keepers, skip this line.)
git rm --ignore-unmatch apps/server/src/services/registry-service.ts
```

- [ ] **Step 2: Delete orphan lib files**

Per audit results. Example if all four are orphans:

```bash
cd /Users/minghao/workflow-control
git rm apps/server/src/lib/config-loader.ts
git rm -r apps/server/src/lib/config
git rm apps/server/src/lib/question-manager.ts
git rm apps/server/src/lib/error-response.ts
```

Use `--ignore-unmatch` per file if unsure. Only delete what the audit confirmed orphan.

- [ ] **Step 3: Delete unused builtin pipelines**

```bash
cd /Users/minghao/workflow-control
# Example — delete any builtin-pipelines subdir that isn't in the kept four:
git rm -r apps/server/src/builtin-pipelines/web3-research-writer/ 2>/dev/null || true
```

If more unused pipelines surface from Step 2 audit, delete each with its own `git rm -r`.

- [ ] **Step 4: Delete legacy integration / audit / regression directories**

Per audit results. Example:

```bash
cd /Users/minghao/workflow-control
# If __integration__ contains only legacy tests:
git rm -r apps/server/src/__integration__/
# If __audit__ and __regression__ similar:
git rm -r apps/server/src/__audit__/
git rm -r apps/server/src/__regression__/
```

Skip directories whose audit showed kernel-next relevance.

### Task F3: tsc + vitest clean pass

- [ ] **Step 1: tsc**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsc --noEmit 2>&1 | tail -20
```

Likely fallout: some remaining file still imports a deleted lib module. Find and delete (or keep the lib module if the consumer is a legitimate kernel-next user).

- [ ] **Step 2: vitest**

```bash
./node_modules/.bin/vitest run 2>&1 | tail -10
```

Expected: 0 failures. Test count continues dropping.

- [ ] **Step 3: Run the stage-3-probe sanity equivalent**

Without starting the dev server, verify kernel-next + routes tests still green in isolation:

```bash
./node_modules/.bin/vitest run src/kernel-next src/routes 2>&1 | tail -5
```

Expected: all pass. This is the kernel-next-specific invariant gate.

- [ ] **Step 4: Commit**

```bash
cd /Users/minghao/workflow-control && git add -A apps/server/src && git commit -m "chore(retire-legacy): batch F — delete legacy services + orphan lib + unused builtins

Deletions (per audit):
- services/pipeline-generator.ts (legacy service)
- services/registry-service.ts (if orphan)
- lib/{config-loader,question-manager,error-response}.ts + lib/config/ (if orphan)
- __integration__/, __audit__/, __regression__/ (if legacy-only)
- builtin-pipelines/ non-kept pipelines (e.g. web3-research-writer)

Test delta: <record>
tsc: 0 errors"
```

---

## Batch G — Delete legacy Web pages + replace root

**Files deleted in `apps/web/src/`**:
- `app/task/[id]/page.tsx` + `page.test.tsx`
- `app/task/[id]/` directory
- `app/config/page.tsx` + any nested files
- `app/config/` directory
- `app/registry/` directory
- `app/help/` directory
- `components/config/` directory
- `components/config-workbench.tsx`
- `components/pipeline-editor.tsx` (if exists)
- `components/pipeline-builder.tsx` (if exists)
- Any other `components/*.tsx` that only legacy pages consumed (audit)

**Files modified in `apps/web/src/`**:
- `app/page.tsx` — replaced with a redirect to `/kernel-next`
- Next.js middleware file (if one exists) — remove rewrites targeting deleted pages
- `next.config.*` — remove any page-specific configuration

### Task G1: Audit component dependencies

- [ ] **Step 1: List legacy-page imports**

```bash
cd /Users/minghao/workflow-control/apps/web/src
grep -rn 'from "\.\./components\|from "\.\./\.\./components\|from "@\/components' app/{task,config,registry,help,page.tsx} 2>/dev/null | sort -u | head -40
```

Compile the full list of components imported by legacy pages.

- [ ] **Step 2: Cross-check which of those components are ALSO used by kernel-next**

For each component found in Step 1:

```bash
grep -rn "COMPONENT_NAME" app/kernel-next components/ --include='*.tsx' 2>/dev/null | head
```

Replace `COMPONENT_NAME` with the actual component (e.g. `cost-summary`, `confirm-panel`). If only legacy pages use it, it's deletable. If kernel-next uses it too, keep.

Record the keep / delete classification.

### Task G2: Replace root page

- [ ] **Step 1: Check if `/api/kernel-next/tasks` listing endpoint exists**

```bash
grep -n 'kernel-next/tasks\b' /Users/minghao/workflow-control/apps/server/src/routes/kernel-*.ts | head
```

If there's a GET endpoint that lists recent tasks → use Option A (redirect to a tasks list). Otherwise → use Option B (static placeholder).

- [ ] **Step 2: Replace `apps/web/src/app/page.tsx` with Option B (simplest, always works)**

Write this content to `apps/web/src/app/page.tsx`:

```tsx
"use client";

export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "640px", margin: "0 auto" }}>
      <h1 style={{ marginBottom: "1rem" }}>workflow-control (kernel-next)</h1>
      <p style={{ lineHeight: 1.6 }}>
        This server runs kernel-next pipelines. Start a task via the MCP tool{" "}
        <code>run_pipeline</code> or{" "}
        <code>POST /api/kernel/tasks/run</code>.
      </p>
      <p style={{ lineHeight: 1.6 }}>
        Live task views are at{" "}
        <code>/kernel-next/&lt;taskId&gt;</code>.
      </p>
      <p style={{ lineHeight: 1.6, fontSize: "0.9rem", color: "#666" }}>
        See{" "}
        <a href="https://github.com/ymh357/workflow-control">docs</a> for more.
      </p>
    </main>
  );
}
```

This doesn't call any API — stays green no matter what.

- [ ] **Step 3: Delete `apps/web/src/app/page.test.tsx`** if it exists (it was testing the old dashboard)

```bash
cd /Users/minghao/workflow-control
git rm --ignore-unmatch apps/web/src/app/page.test.tsx
```

### Task G3: Delete legacy page directories

- [ ] **Step 1: Delete**

```bash
cd /Users/minghao/workflow-control
git rm -r apps/web/src/app/task/ 2>/dev/null || true
git rm -r apps/web/src/app/config/ 2>/dev/null || true
git rm -r apps/web/src/app/registry/ 2>/dev/null || true
git rm -r apps/web/src/app/help/ 2>/dev/null || true
```

- [ ] **Step 2: Delete legacy-only components (per Task G1 audit)**

```bash
cd /Users/minghao/workflow-control
git rm -r apps/web/src/components/config/ 2>/dev/null || true
git rm --ignore-unmatch apps/web/src/components/config-workbench.tsx
# Add any other legacy-only components:
# git rm --ignore-unmatch apps/web/src/components/pipeline-editor.tsx
# git rm --ignore-unmatch apps/web/src/components/pipeline-builder.tsx
```

Pick per audit. If in doubt, keep — a component gets auto-deleted in a future web-cleanup if nothing imports it.

### Task G4: Clear Next.js build cache + verify

- [ ] **Step 1: Clear .next cache**

```bash
rm -rf /Users/minghao/workflow-control/apps/web/.next
```

Prevents stale manifest errors from cached references to deleted pages.

- [ ] **Step 2: Web tsc**

```bash
cd /Users/minghao/workflow-control/apps/web && ./node_modules/.bin/tsc --noEmit 2>&1 | tail -20
```

Expected: 0 errors. If there are import errors from components referencing deleted legacy pages/hooks, chase them down (either the importer is itself legacy and should be deleted, or the component needs an import fix).

- [ ] **Step 3: Web build (optional but recommended)**

```bash
cd /Users/minghao/workflow-control/apps/web && pnpm build 2>&1 | tail -40
```

If this fails with runtime errors on routes (e.g. middleware trying to rewrite a deleted path), fix the referenced config.

Skip if `pnpm build` is too slow; dev server sanity is enough for a local-only tool per CLAUDE.md.

### Task G5: Commit

- [ ] **Step 1: git add + commit**

```bash
cd /Users/minghao/workflow-control && git add -A apps/web/src && git commit -m "chore(retire-legacy): batch G — delete legacy web pages, minimal root

Deletions:
- apps/web/src/app/{task,config,registry,help}/
- apps/web/src/components/config/ + config-workbench.tsx (+ any legacy-only)
- apps/web/src/app/page.test.tsx (obsolete)

Modifications:
- apps/web/src/app/page.tsx replaced with minimal kernel-next landing page

Web tsc: 0 errors
Web build: <record or 'skipped'>"
```

---

## Batch H — Docs update + handoff

**Files modified:**
- `CLAUDE.md`
- `docs/product-roadmap.md`
- `docs/kernel-next-terminal-design.md`

**Files created:**
- `docs/superpowers/plans/2026-04-24-retire-legacy-engine-done-handoff.md`

### Task H1: CLAUDE.md update

- [ ] **Step 1: Read current CLAUDE.md frozen section**

```bash
grep -n 'Frozen\|冻结\|frozen' /Users/minghao/workflow-control/CLAUDE.md | head
```

- [ ] **Step 2: Replace the §"Frozen areas" block**

Find the block starting with:
```
## Frozen areas — do not extend
```

Replace its contents with (keep the same H2 heading or rename to "Retired areas"):

```
## Retired areas (deleted 2026-04-24)

The following modules were deleted as part of Stage 4a of the kernel-next migration:

- `apps/server/src/edge/` — Edge Runner
- `apps/server/src/agent/gemini-executor.ts` — Gemini engine
- `apps/server/src/agent/codex-executor.ts` — Codex engine
- `apps/server/src/agent/` (entire directory) — legacy Claude executor stack
- `apps/server/src/machine/` — legacy XState workflow engine
- Legacy routes under `apps/server/src/routes/` (trigger, stream, tasks, confirm, answer, retry, cancel, config*, registry)
- Legacy Next.js pages under `apps/web/src/app/` (task/[id], config, registry, help)

**Legacy task data not migrated.** Task JSON files under `{data_dir}/tasks/*.json` produced by the legacy engine are inert after this milestone. Per `docs/kernel-next-terminal-design.md §1.3`, zero historical compatibility.

**kernel-next is the only engine.** All new pipelines go through:
- MCP tool `run_pipeline` (primary)
- HTTP `POST /api/kernel/tasks/run` (dashboard entry)

Converter (`kernel-next/converter/`) and the four seeded builtin YAMLs (`builtin-pipelines/{smoke-test,tech-research-collector,tech-research-writer,pipeline-generator}/`) are retained; Stage 4b migrates them to native IR.
```

- [ ] **Step 3: Verify the rest of CLAUDE.md is consistent**

Scan CLAUDE.md for any other references to Gemini / Codex / Edge / "冻结" that need removal or update. Also check the "Primary engine" section — it already says Claude is primary, but may reference Gemini/Codex as coexisting; update to Claude-only.

### Task H2: product-roadmap.md update

- [ ] **Step 1: Read §4 瘦身清单**

```bash
sed -n '95,110p' /Users/minghao/workflow-control/docs/product-roadmap.md
```

- [ ] **Step 2: Update the table**

For rows `Gemini 引擎`, `Codex 引擎`, `Edge Runner`, `Slack Bridge`, `白皮书（zh + en）`:
- Change "冷冻保留" → "已退役 2026-04-24"
- Keep `Registry / 发布系统` row (still valid)
- Keep `Single-session 模式` row BUT note: single-session was a legacy-engine concept (PreCompact hooks, tier1 re-injection). kernel-next-design §2.5 defaults to multi-session. Mark `Single-session 模式` as "已退役 2026-04-24" because kernel-next doesn't port it.

- [ ] **Step 3: Add修订历史 entry**

At the bottom of `docs/product-roadmap.md`, under `## 修订历史`:

```markdown
| 2026-04-24 | 1.2 | Stage 4a 完成：legacy engine + Edge Runner + Gemini/Codex + 相关路由和 Web 页面退役。kernel-next 成为唯一引擎。|
```

### Task H3: kernel-next-terminal-design.md update

- [ ] **Step 1: Read Appendix A row for Edge Runner**

```bash
grep -n 'Edge Runner' /Users/minghao/workflow-control/docs/kernel-next-terminal-design.md
```

- [ ] **Step 2: Add a date note to the Edge Runner row**

Change the Edge Runner row in Appendix A from:
```
| Edge Runner | **removed** | Not in terminal |
```
to:
```
| Edge Runner | **removed** | Not in terminal. Deleted 2026-04-24 (Stage 4a). |
```

Same for Gemini / Codex row:
```
| Gemini / Codex engines | **removed from kernel** | Future `agent` subtypes possible, but not designed. Deleted 2026-04-24. |
```

### Task H4: Create done-handoff

- [ ] **Step 1: Write handoff doc**

Create `docs/superpowers/plans/2026-04-24-retire-legacy-engine-done-handoff.md`:

```markdown
# Stage 4a — Retire Legacy Engine — Completion Handoff

Date: 2026-04-24
Branch: main

## Milestone results

- Legacy XState workflow engine deleted: `apps/server/src/machine/`
- Legacy Claude agent stack deleted: `apps/server/src/agent/*.ts`
- Gemini + Codex executors deleted (moved from frozen → retired)
- Edge Runner deleted: `apps/server/src/edge/`
- Legacy HTTP routes deleted: 9 route files + middleware + action layer
- Legacy Next.js pages deleted + root replaced with minimal landing page
- Legacy service helpers (lib/config-loader, lib/question-manager, etc.) deleted per audit
- Unused builtin pipelines deleted (web3-research-writer if present)
- CLAUDE.md, product-roadmap.md, kernel-next-terminal-design.md updated

## Not in scope

- Converter `kernel-next/converter/` retained — Stage 4b
- Builtin YAMLs (`builtin-pipelines/{smoke-test,tech-research-collector,tech-research-writer,pipeline-generator}/`) retained
- Execution Record sidecar — Stage 6
- New kernel-next-native Web dashboard — future milestone

## Test deltas

| Phase | Files | Tests passed |
|---|---|---|
| Baseline (pre) | 288 | 4246 |
| After Batch A (routes + actions) | TBD | TBD |
| After Batch B (machine/) | TBD | TBD |
| After Batch C (agent/) | TBD | TBD |
| After Batch D (gemini+codex) | TBD | TBD |
| After Batch E (edge/) | TBD | TBD |
| After Batch F (services+lib) | TBD | TBD |
| After Batch G (web) | TBD | TBD |
| Final | TBD | TBD |

(Fill each row from each batch's commit message. Replace TBD with actuals.)

## Key commits

| Batch | SHA | Subject |
|---|---|---|
| A | TBD | delete legacy routes + actions |
| B | TBD | delete machine/ |
| C | TBD | delete legacy Claude agent stack |
| D | TBD | delete Gemini + Codex |
| E | TBD | delete Edge Runner |
| F | TBD | delete services + lib orphans |
| G | TBD | delete legacy web pages |
| H | TBD | docs update |

Fill SHAs from git log after each batch lands.

## Follow-ups

- Stage 4b: migrate builtin YAMLs to native IR + delete converter
- Stage 6: Execution Record sidecar
- Future: kernel-next-native Web dashboard
```

Replace TBD values as batches complete.

- [ ] **Step 2: Commit all doc changes together**

```bash
cd /Users/minghao/workflow-control && git add CLAUDE.md docs/product-roadmap.md docs/kernel-next-terminal-design.md docs/superpowers/plans/2026-04-24-retire-legacy-engine-done-handoff.md && git commit -m "docs(retire-legacy): batch H — CLAUDE.md + roadmap + design + handoff

- CLAUDE.md: Frozen areas → Retired (2026-04-24)
- product-roadmap.md §4: mark Gemini/Codex/Edge/Slack/Single-session retired
- kernel-next-terminal-design.md Appendix A: date-stamp Edge + Gemini/Codex rows
- Create done-handoff doc with test deltas + commit SHAs"
```

---

## Batch I — Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full server test suite**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run 2>&1 | tail -5
```

Record counts. Expected: substantially lower than 4246 (roughly 2500 remaining, depending on how many kernel-next + shared tests survived).

- [ ] **Step 2: Server tsc**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Web tsc**

```bash
cd /Users/minghao/workflow-control/apps/web && ./node_modules/.bin/tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Grep for legacy-engine residuals**

```bash
cd /Users/minghao/workflow-control/apps/server/src
grep -rn 'from "\.\./machine\|from "\.\./agent\|from "\.\./edge\|actions/task-actions\|services/pipeline-generator\|sse/manager' . --include='*.ts' 2>/dev/null
```

Expected: zero hits. Any hit means a batch missed a cleanup.

- [ ] **Step 5: Kernel-next smoke via API**

Start dev server and issue a GET to `/api/kernel/tasks/run-ai-generated-01/status` (the stage-3 probe task). Expected: 200 with a valid status JSON (or 404 if the task rolled out of the DB; also acceptable).

Skip if too time-intensive for verification — the real E2E proof is Stage 3's work already.

- [ ] **Step 6: Fill in handoff doc**

Update `docs/superpowers/plans/2026-04-24-retire-legacy-engine-done-handoff.md` with actual test deltas and commit SHAs from `git log --oneline`.

- [ ] **Step 7: Final commit**

```bash
cd /Users/minghao/workflow-control && git add docs/superpowers/plans/2026-04-24-retire-legacy-engine-done-handoff.md && git commit -m "docs(retire-legacy): batch I — handoff filled with actuals"
```

---

## Self-Review

**1. Spec coverage:**

| Spec §1 SC | Batch |
|---|---|
| SC 1 delete machine/ | Batch B |
| SC 2 delete agent/*.ts + gemini/codex | Batches C, D |
| SC 3 delete edge/ | Batch E |
| SC 4 delete legacy routes + unwire index.ts | Batch A |
| SC 5 delete web pages + replace root | Batch G |
| SC 6 delete task-actions.ts | Batch A |
| SC 7 delete services/pipeline-generator.ts | Batch F |
| SC 8 evaluate services/registry-service.ts | Batch F (Task F1 audit) |
| SC 9 CLAUDE.md update | Batch H |
| SC 10 roadmap update | Batch H |
| SC 11 kernel-next-design update | Batch H |
| SC 12 server tsc 0 | Every batch + Batch I |
| SC 13 server vitest 0 failures | Every batch + Batch I |
| SC 14 web tsc + build | Batch G + Batch I |
| SC 15 hello-research-v2 sanity | Batch I Step 5 |
| SC 16 only kernel-* routes survive | Batch A + Batch I Step 4 |

**2. Placeholder scan:** zero "TBD", "TODO", "implement later" in the plan body. Handoff doc has explicit "TBD" placeholders that get filled by Batch I — acceptable because they're data-to-be-recorded, not process placeholders.

**3. Type consistency:** no types defined in this plan (all deletions). The only new code is the Web root page replacement (Task G2 Step 2), which is self-contained.
