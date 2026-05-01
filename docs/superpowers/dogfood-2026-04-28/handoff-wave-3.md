# Wave 3 Handoff — c12+ review fixes (validator / compiler / canonical / codegen hardening)

**Date**: 2026-05-01
**Branch**: main (8 commits ahead of Wave 1 closing point)
**Source spec**: `docs/superpowers/specs/2026-04-30-full-codebase-review.md`
**Predecessor**: `docs/superpowers/dogfood-2026-04-28/handoff-wave-1.md`

Wave 3 cleared 6 hardening bugs across IR canonical hashing, validator,
compiler, codegen, and inline-script-executor. Smaller blast radius than
Wave 1, mostly mechanical edits with clear correctness wins. No P0
findings remain unaddressed; everything below is a bounded improvement
to existing-but-flawed code paths.

---

## Commit chain

| SHA | Title |
|---|---|
| `8637b59` | `fix(compiler+validator)`: multi-target reject rollback + wireFromStage hardening (Bug 28 / 29) |
| `2b92b82` | `fix(ir+codegen+script-compile)`: drift detection / type injection guard / single allowlist / option sort (Bug 30 / 31 / 32 / 34) |

Two commits, six bugs.

---

## Bug-by-bug summary

### Bug 28 — multi-target reject is rollback
**File**: `apps/server/src/kernel-next/compiler/ir-to-machine.ts:499-540`,
`apps/server/src/kernel-next/mcp/kernel.ts:1383-1402`,
`apps/server/src/kernel-next/sse/types.ts`,
`apps/server/src/kernel-next/runtime/runner.ts`,
`apps/server/src/kernel-next/validator/structural.ts:281-340` (new
diagnostic).

**Symptom**: `rejectRollbackMap` entry construction had
`if (typeof target !== "string") continue` in the BFS loop. The
validator allowed `routes: { reject: [a, b] }` (multi-target syntax)
but the compiler treated those routes as forward — even when both
targets were transitive ancestors of the gate. Result: runtime never
observed `GATE_REJECTED` for legitimate multi-target rollbacks; the
rebuilt actor never re-entered the rejected gate; the pipeline marched
forward through the rejected branch.

**Fix**:
- `RejectRollback.targetStage: string` → `targetStages: string[]`
  (always normalised to an array).
- BFS-downstream now runs on every target; rollback fires when ALL
  targets are ancestors. `affectedStages` is the union across targets.
- `AnswerGateResult.rejected.targetStage`,
  `MachineEvent.GATE_REJECTED.targetStage`, runner verdict `toStage`,
  and SSE `StageRolledBackData.toStage` widened to `string | string[]`.
  Single-target path preserves the string shape so existing callers
  comparing with `===` see no behavioural change.
- New validator diagnostic `GATE_ROLLBACK_MIXED_TARGETS` rejects
  answers whose targets are partially ancestors and partially not —
  the compiler can't classify those coherently, so the LLM gets a
  clear "regenerate the route" signal instead of silently degenerated
  forward semantics.

**Tests added**: 5 (compiler: multi-target rollback + multi-target
forward; validator: all-ancestor / all-forward accept paths +
mixed-semantics reject path).

---

### Bug 29 — wireFromStage consistent use
**Files**: `apps/server/src/kernel-next/compiler/ir-to-machine.ts:200-211,471-481`,
`apps/server/src/kernel-next/mcp/kernel.ts:1198-1206`,
`apps/server/src/kernel-next/builtin-scripts/validate-and-repair-ir.ts:312-330,447-460`.

**Symptom**: Five sites used `if (w.from.source !== "stage") continue`
to filter wire BFS adjacency. The discriminated-union narrowing makes
this correct for Zod-preprocessed IRs, but raw IR fixtures or
mid-repair IRs (where `from.source` is unset) get silently dropped
from BFS, producing wrong adjacency for both forward and reverse
graph computations.

**Fix**: Replaced direct comparisons with `wireFromStage()` /
`isStageSourcedWire()` helpers from `ir/wire-helpers.ts`, which treat
unset source as stage (matches the schema preprocess contract).

---

### Bug 30 — INSERT OR IGNORE drift
**File**: `apps/server/src/kernel-next/ir/sql.ts:530-642`.

**Symptom**: `insertPipelineVersion` used `INSERT OR IGNORE` on
`pipeline_versions`, `stages`, `ports`, AND `wires`. When a `version_hash`
row already existed, the parent INSERT was silently skipped — and so
were the child inserts. Correct in the happy path (versionHash is a
content hash, so existing rows match), but invisibly wrong when the
normalised child rows had drifted from `ir_json` (partial prior
write, FK manipulation, schema migration mishap).

**Fix**: Branch explicitly. New version → end-to-end plain INSERT.
Existing version → assert `COUNT(*)` of stages/ports/wires matches the
IR shape; mismatch throws inside the transaction and rolls back. Drift
becomes loud rather than silent.

**Tests added**: 1 (delete one wire row, attempt re-insert, expect
`drift` error).

---

### Bug 31 — PortIR.type code injection
**File**: `apps/server/src/kernel-next/codegen/emit-ts.ts:1-130`.

**Symptom**: `emit-ts` inlined `${p.type}` verbatim into the emitted
TS source for stage `Inputs` / `Outputs` / `__external__.Outputs`
interfaces. An LLM-emitted type like
`"string; }; export const x = <RCE>; namespace n { interface X { y"`
would close the interface body and inject arbitrary top-level
declarations. The emitted source is then persisted in
`pipeline_versions.ts_source` and shipped to tsc.

**Fix**: New `assertSafePortType` runs before each inline:
- Whitelist character class to TS type-expression syntax
  (`A-Z a-z 0-9 _.,;<>[](){}?|&:'\"!` plus whitespace).
- Reject newlines, carriage returns, comment markers (`//`, `/*`,
  `*/`), `=`, backticks.
- Require balanced `{}`, `[]`, `()`, `<>` brackets.
- Length capped at 4096 chars.

Invariant: every persisted port type is a valid TS type expression
that cannot escape its surrounding `interface { ... }` body.

**Tests added**: 8 (six rejection cases + two acceptance cases for
complex object/array and discriminated union types).

---

### Bug 32 — RUNTIME_REQUIRE_ALLOWLIST single source
**Files**: `apps/server/src/kernel-next/runtime/inline-script-executor.ts`,
`apps/server/src/kernel-next/script-compile/contract-check.ts`,
NEW: `apps/server/src/kernel-next/script-compile/runtime-require-allowlist.ts`.

**Symptom**: Two parallel hand-copied `RUNTIME_REQUIRE_ALLOWLIST`
constants in two files. Drift was inevitable: adding a module to one
file but not the other meant either:
  - contract passes but runtime rejects the inline script's
    `require()` call (wasted submit cycle), or
  - runtime allows a require that the contract test forbade (security
    posture inversion).

**Fix**: Extracted to a new module
`script-compile/runtime-require-allowlist.ts` as the single source of
truth, with a `RUNTIME_REQUIRE_ALLOWLIST_VERSION` constant for
audit-log detectability of future policy bumps. Both call sites now
import the shared Set.

---

### Bug 34 — gate question.options sort
**File**: `apps/server/src/kernel-next/ir/canonical.ts:60-90`.

**Symptom**: `canonicalizeGateConfig` left `cfg.question.options[]`
order untouched. Routing keys are looked up by `value` (not index),
so reordering the answer choices is purely presentational — yet it
bumped `version_hash`, breaking optimistic locking, dedup, and
hot-update for purely cosmetic edits.

**Fix**: Sort `options[]` by `value` before canonicalising. Defensive
optional-chain on `cfg.question` for legacy/test fixtures that bypass
schema validation. Pre-fix fixtures already in sorted order keep
their hash; out-of-order fixtures see a one-time hash bump (the right
outcome — those hashes were always incoherent).

**Tests added**: 2 (permutation hashes equal; sorted output preserves
descriptions).

---

## State at handoff

```
Test files     249 passed |  3 skipped (252)
Tests        2311 passed | 24 skipped (2335)
Type-check   clean (tsc --noEmit, 0 errors)
Branch       main, 8 commits ahead of Wave 1 closing point
Working tree clean (2 pre-existing untracked test files):
  - apps/server/src/kernel-next/mcp/invoke-exact-write-port.test.ts
  - apps/server/src/kernel-next/mcp/write-port-simple-test.test.ts
```

Wave 1 baseline: 2295 pass + 24 skip + 0 fail.
Wave 3 delta: **+16 regression tests, 0 new failures**.

---

## New diagnostic codes

| Code | When |
|---|---|
| `GATE_ROLLBACK_MIXED_TARGETS` | Multi-target answer with mixed ancestor/non-ancestor targets — compiler can't classify coherently. |

---

## Carried forward to future waves

The remaining work from `2026-04-30-full-codebase-review.md` is
unchanged from the Wave 1 handoff's "next steps" section. Order
suggestion (smallest blast radius first):

### Wave 4 — Web UX fixes (~1 week)
- **Bug 63** `app/kernel-next/[taskId]/page.tsx:673-714` — gate-context
  fetch self-aborting loop (`gateContexts` in deps).
- **Bug 65** `components/secret-gate-panel.tsx:52-57` — 5s polling
  continues forever after panel returns null.
- **Bug 67** `app/kernel-next/[taskId]/page.tsx:181,786` —
  `eventCountRef.current` rendered in JSX but is a ref → stale render.
- Web-side `TaskStatus` type widening to include `secret_pending`
  (server already emits it; Bug 64 server side is fixed in Wave 1).

### Wave 2 — Cross-cutting themes (~3-4 weeks total)
**Theme 1** — superseded / terminal `task_finals` not respected
across query paths (~5-8 sites). Risk: cancelled tasks resurface as
"running" / "secret_pending" / "gated" because heartbeat queries don't
filter on `task_finals NOT EXISTS`. Audit every `stage_attempts`
query in `KernelService` + helpers.

**Theme 2** — multi-statement DB transactions. Introduce a
`withTransaction()` helper. Apply to `provide_task_secrets`,
`propose`, `cancel`, gate-timeout-sweeper, worktree allocator,
graceful-shutdown, checkpoint writer. Each currently does N writes
without a guard; partial failure leaves orphaned state.

**Theme 3** — orphan reconciler extension to walk all lifetime
tables: `task_env_values`, `task_worktrees`, `stage_checkpoints`,
`secret_gate_queue`, fanout_element rows. Currently only covers
`stage_attempts` + `gate_queue`.

### Wave 5 — P2/P3 cleanup (deferred indefinitely)
The latent / fragility findings in the spec's P2 / P3 sections.
Worth an audit pass when there's spare cycles, not blocking real
operation.

---

## Recommended next step

**Wave 4 (web UX)** is the smallest remaining bucket and has direct
user-visible impact. Wave 2 themes are larger and more diffuse —
appropriate when there's an explicit half-week to dedicate to each
theme.

Resting here is again a legitimate stopping point: every P0 + every
mechanically-fixable P1 in the validator/compiler/canonical/codegen
layer is now hardened. The remaining work is all in the runtime
(Wave 2) or the web frontend (Wave 4), where the cost-benefit ratio
of "do it now" vs. "do it during a focused half-week sprint" is more
nuanced.
