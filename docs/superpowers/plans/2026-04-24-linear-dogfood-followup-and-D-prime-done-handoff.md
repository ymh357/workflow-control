# Linear dogfood fallout + D' script-stage closure — done handoff

**Date:** 2026-04-24
**Branch:** main
**Base:** `0c5df0b` (previous capability-closure handoff)
**Head:** `258dac9`
**Commits this session:** 11

---

## 1. TL;DR

Started from a real Linear-task dogfood (user launched pipeline-generator
over HTTP MCP, asked it to build a Figma-pull-to-local pipeline). The
dogfood exposed three layers of problems:

1. **Web UX**: dashboard was unusable against the dark body — broken
   styling, unreachable task list, blank historical tasks.
2. **Runtime bugs**: gate-blocked tasks were silently force-completed
   by the boot-time orphan reconciler.
3. **Product-level defect**: pipeline-generator was hardwired to emit
   only `agent` stages, so pure I/O pipelines (Figma fetch + write_file)
   burned tokens on every run and produced nondeterministic output.

This session fixed all three, plus a smaller set of MCP / analysis
prompt gaps that surfaced along the way. The biggest piece is the D'
"safe inline scripts for AI-generated pipelines" program (described
in §4 below), which lands in 4 sub-phases and is production-ready.

**Tests**: 1669 → 1732 (+63 net) across 11 commits. tsc clean after
every commit. Web 52/52, chrome-devtools e2e verified.

---

## 2. Commit ledger (oldest → newest)

| SHA | Scope | Gist |
|-----|-------|------|
| `7b15640` | web | Dark theme + historical-data hydration for kernel-next dashboard. E2E-1..6. |
| `1aa7ad6` | mcp/runtime | Capability-closure sprint: HTTP /mcp route, wait_for_task_event, MCP preflight, PortIR.description, GateAnswerOption, gate feedback port (A). |
| `7d831fd` | runtime | `orphan-reconciler`: unanswered gate is NOT skippable (BUG-1 fix; see §3.1). |
| `d4a0243` | pipeline-generator | analysis.md: preserve caller-supplied identifier names, document optional + default semantics. |
| `c7b813a` | mcp | `describe_pipeline` tool — external agents can discover ports before read_port. |
| `cac7717` | kernel-next | D'-1: builtin script registry (9 atoms), composite executor wiring, submit-time moduleId check. |
| `31ee43e` | kernel-next | D'-2: in-process tsc compiler + import whitelist scanner. Infra-only. |
| `34a948b` | kernel-next | D'-3 prep: `ScriptStage.config` → discriminated union on `source: "registry" \| "inline"`. All existing fixtures and callers migrated. |
| `6d66b52` | kernel-next | D'-3 core: submit async, contract-check (Layer 3), inline executor skeleton. 38 files touched for async propagation. |
| `3b3de88` | kernel-next | D'-3 finish: runtime dispatch (Composite → inline delegate), CommonJS + `new Function` evaluator, pipeline-generator prompt uplift. |
| `258dac9` | pipeline-generator | D'-4: script error recovery patterns (retry spec / review gate / plain failure) in analysis prompt. |

---

## 3. Runtime bugs fixed

### 3.1 BUG-1 — orphan-reconciler advances resume past unanswered gate

**Symptom** (from dogfood): external session launches pipeline-generator,
gate opens, caller approves, task silently marked `completed` with
`task_finals.detail = recovered_no_finals_row`. Second attempt same
symptom. User had to `retry_task --fromStage genSkeleton` twice to
recover.

**Root cause**: `runtime/orphan-reconciler.ts::isSkippable` returned
`true` for every gate stage unconditionally. On boot scan, a task
stuck on an unanswered gate satisfied:

- upstream stages: `success`
- gate: `gate_queue.answer IS NULL`
- post-gate stages: no attempt rows

`classifyOrphan` iterated topologically; since the gate was
"skippable", `firstPending` advanced past it to a post-gate stage.
`bootResumability` resumed from there. Runner rebuilt: it had no
`gateAuthorizedTargets` for the post-gate stage (gate never answered),
so the post-gate stage sat in `waiting` forever. If every remaining
stage happened to be a skippable gate, classification returned
`terminal` and the task was force-completed without ever running
the gated work.

**Fix**: `isSkippable` now takes the set of answered-gate stage names
(`gate_queue WHERE answer IS NOT NULL`). Gates become skippable only
after they have been answered. Unanswered gates participate in
`firstPending` selection → resume points at the gate itself, runner
re-enters the gate's `executing` substate, re-emits `gate_opened` SSE.

Two regression tests in `orphan-reconciler.test.ts`:

- unanswered gate → `resumeFrom: "gate1"` (was `"after"`)
- answered gate → `resumeFrom: "after"` (unchanged)

**Known residual (not fixed)**: `DEFAULT_RUN_TIMEOUT_MS` (30min) still
includes gate wait time. A gate that takes >30min to answer will now
honestly be reported as `failed/timeout` instead of silently
force-completed. Fixing the timer to pause during gate wait is
deferred as a follow-up — the failure mode is now observable and
retry-able, which is the minimum correctness bar.

### 3.2 X1 — external Claude couldn't discover port names

**Symptom**: external session called `read_port(stage="analyzing", port="pipelineDesign")`
and got `port not found`. Same for `query_lineage`.

**Root cause**: "pipelineDesign" is prose shorthand in analysis.md
for the collective of ports analyzing emits (pipelineName, pipelineId,
stageContracts, …). It is NOT an actual port. External callers had
no MCP-level way to discover the real port names and were forced
to guess.

**Fix**: new `describe_pipeline` MCP tool. Accepts taskId (resolved
to the latest stage_attempt's versionHash) OR versionHash (exact).
Returns the pipeline schema — stages, inputs, outputs, wires,
externalInputs — so the caller can see exactly which ports exist
before calling read_port. Gate stages get a synthetic
`__gate_feedback__` output in the described shape (the runner emits
that port at answer time without declaring it in IR.outputs; without
synthesis, external callers would have no way to know it's readable).

Added to EXTERNAL_TOOLS + 6 new tests.

### 3.3 X2 — analyzing attempt 1 wrongly marked superseded

**Diagnosed, not a standalone bug**: analyzing was in `running` status
when BUG-1 force-completed the task. `reconcileRunningAttempts`
(graceful-shutdown helper) flipped every `running` row to `superseded`.
This was a side-effect of BUG-1, not a defect in `retry_task` or the
reconcile logic itself. BUG-1 fix dissolves this symptom.

---

## 4. D' — AI-generated scripts with multi-layer safety (the major work)

### 4.1 Problem statement

Pipeline-generator's `analysis.md` line 10 previously said:

> Kernel-next currently has no user-authored scripts in scope; do not
> propose new script stages unless the task is built around an existing
> known script. For this pipeline-generator's outputs, assume
> agent-only unless the user explicitly demands deterministic
> processing.

Consequence for Figma dogfood: the generated pipeline's two stages
(`fetchFigmaFile`, `persistToFilesystem`) were both `agent`. Pure I/O
operations ran through the LLM — every execution burned tokens, the
output format drifted between runs, and retries couldn't be
deterministic.

Four candidate solutions (A / B / C / D) were evaluated against
product goals (local, single-user, AI-written pipelines). See
conversation §D' — Tradeoff discussion. The user picked "D prime":
multi-layer safety around AI-authored scripts, WITHOUT a runtime
sandbox (judged over-engineering for the local single-user threat
model — Claude Code's Bash tool is already strictly more powerful
than any inline TS script the AI could produce).

### 4.2 D'-1 — Builtin script registry + Composite wiring

New directory `apps/server/src/kernel-next/builtin-scripts/` with
9 deterministic I/O atoms AI pipelines can reference by name:

| moduleId | purpose |
|----------|---------|
| `http_fetch` | GET with optional header `${VAR}` expansion |
| `http_request` | arbitrary method, auto-JSON body |
| `read_file` | UTF-8 read |
| `write_file` | UTF-8 write + mkdir -p parent; returns absolute path |
| `path_expand` | `~` → $HOME + resolve absolute |
| `path_join` | node:path.join over a string[] |
| `json_parse` | JSON.parse |
| `json_stringify` | JSON.stringify with optional indent |
| `env_resolve` | ctx.env[key] with optional default |

Runtime wiring:

- `startPipelineRun` now instantiates
  `CompositeStageExecutor({ agent: Real, script: ScriptStageExecutor })`
  (replacing bare `RealStageExecutor`). Pipelines can mix agent +
  script stages on the live path.
- `ScriptModuleContext` gains a new `env: Readonly<Record<string, string>>`
  field populated from `task_env_values` so scripts resolve
  `${API_TOKEN}` without reaching into `process.env`.

Submit-time validation:

- New diagnostic `SCRIPT_MODULE_NOT_REGISTERED`.
- `createKernelMcp` defaults `allowedScriptModuleIds` to
  `BUILTIN_SCRIPT_IDS`. Any ScriptStage whose `moduleId` is unknown
  fails submit before running.

23 new tests. AI still can't author inline scripts after D'-1 — that
comes in D'-3; analysis.md still forbids new script stages during
this checkpoint.

### 4.3 D'-2 — Compile + import-whitelist infrastructure

Pure-function helpers in `apps/server/src/kernel-next/script-compile/`.
No runtime wiring yet.

- `compile-inline-script.ts` — run TypeScript's in-process Program
  against a single inline source under `strict: true`. Ambient
  `ScriptModule` interface declared so the compiler enforces
  default-export shape. Emits JS on success; CompileDiagnostic[] on
  failure with line/column mapped to the user's source. ~500ms cold,
  ~50-100ms warm.
- `scan-imports.ts` — AST traversal covering 7 import forms (plain,
  re-export, import-equals-require, static-arg dynamic import(),
  require() literal, etc.). Dynamic calls with non-string args are
  surfaced separately as `dynamicImports[]`.
- `NODE_IMPORT_WHITELIST` — 9 node stdlib modules (fs/promises, path,
  crypto, url, buffer, os, util, stream/promises, zlib). Everything
  else (third-party, `node:child_process`, `node:fs` sync, `node:vm`,
  relative imports) is off-whitelist.

Key security decision documented in-code: the boundary is the import
whitelist, NOT "deny @types/node". Types are present so scripts can
type-check correctly; the whitelist rejects imports of dangerous
modules at submit time before the JS ever runs.

38 new tests.

### 4.4 D'-3 — Inline scripts runnable end-to-end (the biggest piece)

Four sub-steps, three commits.

**Schema refactor** (`34a948b`):

`ScriptStage.config` is now a discriminated union on `source`:

```ts
config:
  | { source: "registry"; moduleId: string;                                 retry?: RetrySpec }
  | { source: "inline";   moduleSource: string; sampleInputs: Record<string, unknown>; retry?: RetrySpec }
```

- `moduleSource` bounded at 64KB (hard cap).
- `sampleInputs` is mandatory for the inline variant — drives the
  submit-time contract test.
- StageIRSchema-level zod preprocess normalises legacy config (no
  `source`, has `moduleId`) → `source: "registry"`. Every existing
  fixture and production callsite (`diff.ts`, `describe_pipeline`,
  validator, executor) was updated to narrow before touching
  variant-specific fields.
- New `StageDiffChanges.scriptSource` (variant swap) +
  `moduleSource` (inline body diff) for hot-update dashboards.
- `describe_pipeline` returns `{ source, moduleSourceBytes }` for
  inline stages rather than echoing the full TS source.

**Core + async propagation** (`6d66b52`):

- `script-compile/contract-check.ts` — Layer 3 orchestrator. For
  every inline ScriptStage at submit time: whitelist scan → tsc
  compile → invoke with `sampleInputs` (5s timeout) → verify return
  is an object containing every declared output port name.
- `runtime/inline-script-executor.ts` — runtime counterpart. On
  first invoke per (versionHash, stage) compiles + loads the module;
  subsequent invocations reuse a per-composite cache.
- `KernelService.submit` is now async. 38 files touched for `await`
  propagation: every production + test caller + helper functions
  that used to be sync but called submit() → Promise<T>. describe/
  it/beforeEach/beforeAll blocks wrapped in async so they can await
  seed helpers. `submit_pipeline` MCP tool handler awaits.
- `ScriptTerminationReason` enum gains `"compile_error"`.
- 9 new diagnostic codes (SCRIPT_COMPILE_ERROR,
  SCRIPT_IMPORT_NOT_WHITELISTED, SCRIPT_DYNAMIC_IMPORT_FORBIDDEN,
  SCRIPT_SAMPLE_INPUT_MISSING, SCRIPT_SAMPLE_INPUT_UNEXPECTED,
  SCRIPT_IMPORT_ERROR, SCRIPT_CONTRACT_THROW, SCRIPT_CONTRACT_BAD_RETURN,
  SCRIPT_CONTRACT_MISSING_OUTPUT).

**Finish: dispatch + evaluator + prompt uplift** (`3b3de88`):

- `CompositeStageExecutor.options.inlineScript` — new optional
  delegate. Composite dispatches script stages by `config.source`.
  `startPipelineRun` instantiates both delegates.
- Module evaluator switched from `await import(data: URL)` to
  `new Function("module", "exports", "require", js)` on CommonJS
  output. Rationale: vitest's module transformer rewrites bare
  `await import(url)` through its resolver, which chokes on data:
  URLs. Function-wrapped evaluation sidesteps the transformer and
  also gives the kernel full control over what `require` resolves
  (restricted to the same 9-module whitelist — belt-and-braces
  second line against IR tampering between submit and run).
- Pipeline-generator prompt uplift:
  - analysis.md §kernel-next primer documents both script forms
    with a builtin-id table.
  - New §Script stages section with registry + inline patterns,
    allowed-import list, `ScriptModule` shape, and a "prefer script
    over agent for pure I/O / pure transform" heuristic.
  - StageContract gains `scriptSource`, `scriptModuleId`,
    `moduleSource`, `sampleInputs`, `retry` fields.
  - gen-skeleton.md translation map emits the right config shape
    based on `contract.scriptSource`; sample inputs and source are
    forwarded verbatim into the final IR.
  - The old "do not propose new script stages" rule is removed.

6 end-to-end tests confirm happy path (compile → import → run →
port_values written) AND each of the 4 Layer-3 diagnostics fires on
its own failure path.

### 4.5 D'-4 — Script error recovery patterns in prompt

Runtime already has all machinery for script failure recovery — the
retry spec on ScriptStage.config was built years ago, and gate stages
with `__gate_feedback__` wiring exist for human-in-loop review. What
was missing was AI guidance on WHEN to use each pattern.

New §Script error recovery in analysis.md documents three:

1. **retry spec** on the script's config (transient failures: rate
   limit, network blip). Runner re-invokes up to maxRetries.
2. **Review gate after the script** — declare `errors: string[]`
   output, route through a gate, wire `__gate_feedback__` back to
   the upstream regenerator. Right pattern when the script does a
   sensitive transform whose output needs vetting.
3. **Let the failure propagate** — for short pipelines where a
   script failure means the task should fail and be retried from
   scratch by the caller.

Prompt explicitly tells the AI NOT to wrap every script in a review
gate (defeats the "scripts are cheap, fast, deterministic"
proposition). gen-skeleton.md forwards `retry` from StageContract
into ScriptStage.config.

No runtime change. Existing `retry-debug.test` covers the underlying
mechanism.

---

## 5. What still needs doing

### 5.1 Known residuals

- **BUG-2 (wall-clock timer includes gate wait)** — documented but
  not fixed. Symptom: gate >30min → `failed/timeout`. Current
  behaviour is honest (user sees the failure) so the minimum
  correctness bar is met, but "pause timer during gate wait" remains
  the principled fix.
- **X3a (pipeline-generator still emits some agent stages where
  scripts would be better)** — partially addressed. analysis.md now
  has strong guidance to prefer script over agent for pure I/O.
  Real effectiveness can only be verified by running pipeline-generator
  again on a known-I/O task (Figma, GitHub API, etc.) and checking
  that the resulting IR uses scripts. **Recommended dogfood**: re-run
  the Figma-pull-to-local task from this session's start and compare
  the new output against the agent-heavy version.
- **Untracked scratch `.mjs` files** under `apps/server/` (38 of
  them, names like `write-port-test.mjs`, `check-attempts.mjs`, etc.)
  left by previous dogfood runs. None reference each other; none
  imported by production code. `.gitignore` already covers `.dogfood/`
  but not these. Delete or add a pattern.

### 5.2 D'-follow-ups worth considering (not required)

- **D'-3 inline script cache invalidation**: `InlineScriptStageExecutor`
  caches compiled modules by `(versionHash, stageName)`. A hot-update
  that changes `moduleSource` yields a new versionHash, so the cache
  key changes — safe. But a resume from a prior versionHash on the
  same runner instance would hit the old cached module. Not a
  correctness bug (the version fixed the source) but worth a note.
- **Contract test fidelity**: `sampleInputs` realism is advised in
  prompt but not enforced. AI could pass `{ raw: "" }` and trivially
  pass a script that does nothing interesting. Future: require
  sampleInputs to exercise every declared branch (measure via code
  coverage), or randomised property testing. Out of scope for this
  round.
- **Per-builtin-script metrics**: would be nice to know which
  builtin moduleIds get used the most. No current instrumentation.

### 5.3 Process hygiene

- `CLAUDE.md §Retired areas` may want a short entry referring to
  builtin-scripts/ as the replacement for the script-stage gap (it
  previously said "no user-authored scripts in scope"). Current
  text doesn't yet reflect that inline scripts are supported.

---

## 6. File inventory (new + materially changed)

### New files

- `apps/server/src/kernel-next/builtin-scripts/index.ts` + `.test.ts`
- `apps/server/src/kernel-next/script-compile/compile-inline-script.ts` + `.test.ts`
- `apps/server/src/kernel-next/script-compile/scan-imports.ts` + `.test.ts`
- `apps/server/src/kernel-next/script-compile/contract-check.ts`
- `apps/server/src/kernel-next/runtime/inline-script-executor.ts` + `.test.ts`
- `apps/server/src/routes/kernel-mcp.ts` (HTTP /mcp — from the earlier capability-closure commit `1aa7ad6`, not this session's D' work but part of the same push)
- `apps/server/src/routes/kernel-task-list.ts`
- `apps/server/src/routes/kernel-task-ports.ts`
- `apps/server/src/kernel-next/runtime/mcp-remote-preflight.ts` + `.test.ts`
- `apps/server/src/kernel-next/runtime/real-executor.empty-inputs.test.ts`
- `apps/web/src/app/kernel-next/page.tsx` (the missing task-list page)

### Substantially changed

- `apps/server/src/kernel-next/ir/schema.ts` — ScriptStage union + 10 new diagnostic codes
- `apps/server/src/kernel-next/mcp/kernel.ts` — async submit + contract integration + allowedScriptModuleIds
- `apps/server/src/kernel-next/mcp/server.ts` — BUILTIN_SCRIPT_IDS default + describe_pipeline surface
- `apps/server/src/kernel-next/mcp/tools/pipeline.ts` — describe_pipeline tool + async submit handler
- `apps/server/src/kernel-next/runtime/script-executor.ts` — inline variant rejection (routes to InlineScript delegate)
- `apps/server/src/kernel-next/runtime/composite-executor.ts` — dispatch by config.source for scripts
- `apps/server/src/kernel-next/runtime/start-pipeline-run.ts` — Composite wiring with both script executors
- `apps/server/src/kernel-next/runtime/script-module-resolver.ts` — ctx.env field
- `apps/server/src/kernel-next/runtime/script-execution-record-types.ts` — compile_error termination reason
- `apps/server/src/kernel-next/runtime/orphan-reconciler.ts` — BUG-1 fix
- `apps/server/src/kernel-next/validator/structural.ts` — SCRIPT_MODULE_NOT_REGISTERED + registry-only narrowing
- `apps/server/src/kernel-next/hot-update/diff.ts` + `types.ts` — scriptSource/moduleSource diff fields
- `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md` — ~8KB of new prose (both script forms, recovery patterns, preserve-names rule, optional+default rule)
- `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/gen-skeleton.md` — ScriptStage translation for both variants + retry forwarding
- All kernel-next/web/\*: dark theme migration (E2E 1-6)

---

## 7. Numbers

| Metric | Start | End | Δ |
|--------|-------|-----|---|
| Server tests passing | 1669 | 1732 | +63 |
| Web tests passing | 52 | 52 | 0 |
| tsc errors (server) | 0 | 0 | - |
| tsc errors (web) | 0 | 0 | - |
| New MCP tools | 0 | 2 | describe_pipeline, wait_for_task_event (the latter shipped in `1aa7ad6`) |
| New script primitives available to AI | 0 | 9 registry + unbounded inline | - |
| Pipeline-generator prompt size | ~11KB | ~19KB | +8KB |

---

## 8. Risk / watchlist for next session

1. **First real pipeline-generator run using scripts**: the prompt
   changes landed but the proof that AI follows the new rules is in
   the next dogfood. Re-run the Figma task and inspect the IR.
2. **Submit latency on inline-script-heavy pipelines**: each inline
   stage adds compile (~100ms warm) + contract test (~50ms typical).
   A 5-inline-script pipeline adds ~750ms to submit. If submit
   becomes a bottleneck (unlikely), see D'-3 self-review notes for
   where a compile cache could live.
3. **Async submit ripple**: 38 files touched mechanically.
   Regressions would surface as sync call sites still treating
   `submit()` as sync — tsc caught all of them at this session's
   end, but watch for any downstream plugin / extension code that
   imports KernelService directly.
4. **BUG-2 residual**: next time a user parks a gate for >30min,
   the task will be `failed/timeout` not `completed`. Behaviour is
   correct but may surprise someone used to the old silent-complete
   symptom.

---

## 9. Session metadata

Branch `main` — 11 commits landed during the D' session itself. A
brief follow-up session (2026-04-24 late) cleared the two residuals
that *could* be resolved without human-in-loop: BUG-2 and scratch
cleanup. See §10 for that addendum.

No force-pushes. No destructive git operations. `.dogfood/` ignored; scratch `.mjs` files left as-is
(user judgement call).

---

## 10. Follow-up addendum (2026-04-24 late)

Short session, two parallel tracks. Neither required architectural
decisions — both were already scoped in §6/§7 of this doc.

### 10.1 BUG-2 closed — `35f5768`

**Symptom recap.** Per-task wall-clock timeout (`timeoutMs`) was a
single `setTimeout(fn, timeoutMs)` fired at run start; human think
time on a gate counted toward it, so a 40-minute human answer on a
30-minute-timeout pipeline always failed with `reason=timeout` even
when actual agent work was seconds.

**Fix approach.** Option B variant — budget pause/resume inside
`runner.ts` only, **zero cross-module signalling**.

- `runner.ts` (run scope): `remainingBudgetMs`, `activeSinceMs`,
  `gateInFlight`, `activeTimer` (nullable).
- `pauseBudget()`: clear timer, debit `Date.now() - activeSinceMs`
  from `remainingBudgetMs` (floor 0).
- `resumeBudget()`: rearm `setTimeout` with `remainingBudgetMs`,
  reset `activeSinceMs`.
- XState snapshot callback: count `running[stage] === "executing"
  && stage.type === "gate"` each tick; on 0 → ≥1 transition
  pause, on ≥1 → 0 resume.

Why this over agent Option A (pause/resume on gate create/answer in
`gate.ts`): gate.ts lives at the MCP boundary; the dispatcher
signal already travels through `taskRegistry`, but re-reading it
from the runner would require either (a) exposing a new registry
surface for "gate answered" events or (b) polling. The snapshot
callback is the one place that already observes gate substate
transitions with zero delay — we piggyback on it.

**Regression test.** `runtime/gate-wall-clock-pause.test.ts`
  - **Positive**: gate held 900ms under `timeoutMs=400`,
    fast stages → `completed/natural`.
  - **Negative control**: entry handler sleeps 600ms under
    `timeoutMs=200`, no gate ever opens → `failed/timeout`.
    Proves the fix isn't over-eagerly pausing on *any* delay.

Existing tests untouched and green: `task-finals`, `gate-timeout-sweeper`,
`gate-resume-downstream`, `gate-race-downstream`. Full `runtime/` suite
65 files / 438 tests passing; `tsc --noEmit` clean.

**Watchlist update.** §7 item 4 ("BUG-2 residual") now reverses: the
task will **complete naturally** on a long gate wait, not time out.
If anyone has a pipeline that relied on the old timeout-kills-stuck-gate
behaviour, the opt-in per-gate deadline (`gate-timeout-sweeper`, already
shipped) is the intended knob — it's independent and unchanged.

### 10.2 Scratch cleanup

Deleted 97 untracked `.mjs` + `test-stage-s.ts` debug scripts from
`apps/server/` root (all were one-shot SQLite-peeking utilities from
earlier sessions — `all-in-one*`, `check-*`, `invoke-*`, `setup-*`,
`write-*`, `verify-*`, etc.). None were tracked, so the tree is now
clean with no commit required — an empty commit for untracked-file
deletes would have polluted history.

`real-executor.empty-inputs.test.ts` was already tracked in commit
`a56c148` from an earlier session; the session-start git-status
snapshot marking it untracked was stale.

### 10.3 Remaining residual

Only **X3a re-dogfood** remains, and it is inherently human-in-loop
(pick a task, observe whether the AI now elects script stages given
the new prompt). Next session's owner drives it; this session
closed every non-human-in-loop item.

---

## 11. Follow-up commit ledger

| SHA | Message | Notes |
|------|---------|-------|
| `35f5768` | fix(runner): pause wall-clock budget during gate wait (BUG-2) | +4 LOC state, +2 helpers in runner.ts, +238 LOC regression test |


---

## 12. X3a re-dogfood verification — D' validated end-to-end

**Date:** 2026-04-25
**Task:** `49472689-4875-4246-bb27-40f15c42730b`
**Pipeline:** pipeline-generator, versionHash `dd9dc45...`

Fed the generator a Figma-pull-to-local description (caller supplies
figmaFileKey, figmaAccessToken, outputPath; pipeline's job is pure I/O
— HTTP GET + write file). Same class of task as the original failing
dogfood that motivated D'.

### 12.1 Analyzing stage output — AI chose scripts

Key ports read via MCP:

- `assumptions[2]`: *"No MCP servers are required — all I/O is handled
  by registry and inline script stages using the global fetch and
  node:fs/promises builtins."*
- `recommendedMcps`: `[]` (matches — no agent stages, so no MCP surfaces)
- `usesFanout`: `false`
- `usesSubPipelines`: `false`
- `estimatedStageCount`: `3`

### 12.2 genSkeleton IR — the ground truth

Read `genSkeleton.ir` via MCP (complete output, not truncated):

Three stages, **all `type: "script"`, all `config.source: "inline"`**:

| # | Stage | Scripts referenced | Config highlights |
|---|-------|-------------------|-------------------|
| 1 | `fetchFigma` | global `fetch` | `retry: { maxRetries: 2 }` — D'-4 error recovery pattern |
| 2 | `resolveOutputPath` | `import * as os`, `import * as path` — whitelisted | handles `~` expansion inline |
| 3 | `persistOutput` | `import * as fs`, `import * as path` — whitelisted | `mkdirSync({recursive}) + writeFileSync` |

Every stage carries `sampleInputs` (the D'-3 compile-time contract)
covering all declared input ports. Every `moduleSource` is concise
(<1KB each), uses only the whitelisted `node:fs` / `node:os` / `node:path`
modules or global `fetch`. The wiring is correct (external inputs flow
in; responseBody + resolvedPath flow into persistOutput).

### 12.3 Pattern the prompt successfully taught

- **Deterministic I/O → script, not agent.** Zero agent stages for
  what's fundamentally "call HTTP, parse, write file".
- **Inline where bespoke, registry not needed.** The three atoms
  don't match the registered builtins exactly (needs tilde expansion;
  needs arbitrary URL; needs text body passthrough), so the AI
  correctly chose inline over wrapping in registry calls.
- **Retry where API fails are recoverable.** `fetchFigma` has the
  only retry spec — the other two stages are deterministic given
  their inputs.
- **sampleInputs are realistic.** E.g. `figmaFileKey: "abc123XYZ"`,
  `figmaAccessToken: "figd_PLACEHOLDER"` (plausible Figma token
  format, not a placeholder like `"test"`).

### 12.4 D' program closure

| Sub-phase | Status |
|-----------|--------|
| D'-1 builtin registry + Composite wiring | Shipped (commit `cac7717`) |
| D'-2 compile + import whitelist | Shipped (commit `31ee43e`) |
| D'-3 inline stages runnable end-to-end | Shipped (commits `34a948b`, `6d66b52`, `3b3de88`) |
| D'-4 error recovery prompt patterns | Shipped (commit `258dac9`) |
| **X3a dogfood verification** | **✅ Verified 2026-04-25** |

The entire D' program — "safe AI-generated scripts without worker
sandbox" — is now proven end-to-end against a real request. Prompt
uplift made the AI shift from token-burning agent stages to
deterministic inline scripts for a pure-I/O workload.

### 12.5 Residual (out of scope for D')

The task itself terminated `failed` during the `persisting` stage
(pipeline-generator's own tail, which writes the generated pipeline
into the kernel registry). genSkeleton completed and its `ir` port
is complete; the failure is downstream of X3a's evaluation point.
Not investigated here — a tail-stage defect in the generator pipeline,
separate from D' correctness. Left for a future session if it recurs.

### 12.6 Known side-finding: some analyzing ports never written

During this dogfood, `read_port` correctly reported "port not found"
for analyzing's `stageDesign` / `stageContracts` / `dataFlowSummary`
/ `summary` / `description` / `targetRepoName` — all the
"large-content-prose" ports. Smaller ports (everything listed in
§12.1) wrote fine. Root cause: the Claude session driving `analyzing`
stopped emitting `write_port` calls for the heaviest-content ports,
likely a length-driven truncation somewhere in the SDK → runtime path.
This is **not** a D' regression (D' doesn't touch analyzing's prompt
or the agent-output pathway), and X3a's conclusion stands on the
ports that did land. Tracking separately if it recurs.

