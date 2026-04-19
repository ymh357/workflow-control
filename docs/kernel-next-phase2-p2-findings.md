# kernel-next Phase 2 P2 Findings

**Date**: 2026-04-19
**Scope**: Wire `propose_pipeline_change` to a human-approval surface.
REST-only in this phase; UI is deferred (see §Scope decisions).
**Ships**: kernel approveProposal/rejectProposal → MCP tool trio →
REST `/api/kernel/proposals*` → end-to-end acceptance.

## TL;DR

- The AI-authored change loop is closed end-to-end at the API layer.
  External actors (AI via MCP, humans via REST/curl) can propose, list,
  approve, and reject pipeline patches against the kernel-next IR store.
- **Approve does not migrate running tasks**. This is an explicit P2
  scope decision aligned with `kernel-next-design.md` §13: migration is
  Phase 2 P3+ work. The invariant is tested directly
  (`diamond-proposal.test.ts` "running task and proposal review are on
  disjoint data paths").
- **UI is deferred**. Rationale in §Scope decisions.
- Total new code: ~380 LOC + ~360 LOC tests across 5 files. Full
  regression: 3844 passed, 0 regressions.

## Scope decisions (before implementation)

Three questions surfaced at the start of P2. Decisions below are the
ones driving this phase's scope.

### Q1: SSE broadcast channel for proposals?

- **Options**: (A) dedicated global SSE, (B) piggyback on per-task SSE,
  (C) polling only.
- **Chosen: C**. Proposals do not semantically bind to any task (an
  external AI may propose without a running task). Building a new global
  broadcaster for an author-only, single-user system is premature; the
  real payoff is after P3's migration/impact analysis, where diff viewer
  and live cost estimation become useful. Until then, `GET
  /api/kernel/proposals?status=pending` in a loop is sufficient.

### Q2: Does approve migrate running tasks?

- **Chosen: No**. Approve only flips `pipeline_proposals.status =
  'approved'`. Running tasks remain bound to their
  `stage_attempts.version_hash`. New tasks may reference the approved
  `proposedVersion` explicitly. This matches
  `kernel-next-design.md` §2.2 ("AI can propose, 100% goes to confirm
  queue, no auto-apply") and §13 (migration is a Phase 2+ concern).

### Q3: Web UI scope?

- **Chosen: Deferred**. A minimal list page with approve/reject buttons
  would be ~1-2 days and throws away once P3 introduces migration
  impact analysis — the real UI will be a diff viewer with cost
  estimation, not a list. Author testing via `curl` + DB inspection is
  sufficient for the single-user spike. Revisit after P3.

Net P2 scope reduction: from 3-5 days (original plan) to ~2 days
actually spent.

## Implementation map

| Phase | File(s) | Change |
| ----- | ------- | ------ |
| P2.1 kernel | `apps/server/src/kernel-next/mcp/kernel.ts` | + `approveProposal` / `rejectProposal` / `listProposals` (resolveProposal private core) + `ProposalStatus` / `ProposalRow` / `ApprovalResult` types |
| P2.1 kernel | `apps/server/src/kernel-next/ir/schema.ts` | Diagnostic code set extended with `PROPOSAL_NOT_FOUND` / `PROPOSAL_ALREADY_RESOLVED` |
| P2.1 kernel | `apps/server/src/kernel-next/mcp/kernel.test.ts` | +5 tests: approve, reject+reason, not-found, already-resolved, list ordering+filter |
| P2.2 MCP | `apps/server/src/kernel-next/mcp/server.ts` | +3 tools: `list_proposals`, `approve_proposal`, `reject_proposal` |
| P2.2 MCP | `apps/server/src/kernel-next/mcp/server.test.ts` | "7 tools" → "10 tools" assertion + 2 end-to-end lifecycle tests |
| P2.3 REST | `apps/server/src/lib/kernel-next-db.ts` | New file: singleton DB `{data_dir}/kernel-next.db` + `__setKernelNextDbForTest` |
| P2.3 REST | `apps/server/src/routes/kernel-proposals.ts` | New file: GET `/api/kernel/proposals`, POST `/:id/approve`, POST `/:id/reject` |
| P2.3 REST | `apps/server/src/routes/kernel-proposals.test.ts` | 10 route-level tests |
| P2.3 REST | `apps/server/src/index.ts` | Mount `kernelProposalsRoute` |
| P2.4 accept | `apps/server/src/kernel-next/demo/diamond-proposal.test.ts` | 2 end-to-end scenarios |

## State machine for proposals

```
                 ┌───────────────┐
                 │   (nothing)   │
                 └───────┬───────┘
                 propose │ validate + persist new version
                         ▼
                 ┌───────────────┐
         ┌───────│    pending    │────────┐
         │       └───────────────┘        │
 approve │                                │ reject
         ▼                                ▼
 ┌───────────────┐              ┌───────────────┐
 │   approved    │              │   rejected    │
 └───────────────┘              └───────────────┘
        │                                │
        └────── terminal (409 on second) ┘
```

- `approved` / `rejected` are terminal. Attempting to re-approve or
  re-reject returns `PROPOSAL_ALREADY_RESOLVED` → HTTP 409.
- Unknown `proposalId` returns `PROPOSAL_NOT_FOUND` → HTTP 404.
- `reject(reason?)` persists the reason to `diagnostic_json` as
  `{"reason": "..."}`. `approve` never writes diagnostic_json.

## End-to-end acceptance (`diamond-proposal.test.ts`)

### Scenario 1 — full cycle

1. Submit baseline V1 (diamond IR: A → {B, C} → D).
2. Run T1 on V1. Terminates `completed`, `D.final = "B:10|C:10"`.
3. Propose V1 → V2 with `remove_stage: D` patch (structural change —
   the kind that must be human-approved).
4. `GET /api/kernel/proposals?status=pending` returns one entry with the
   expected base/proposed version hashes.
5. `POST /api/kernel/proposals/:id/approve` → 200 +
   `{ok:true, status:"approved"}`.
6. `GET ?status=pending` → 0 entries. `GET ?status=approved` → 1 entry.
7. Launch T2 using the V2 IR (fetched by hash round-trip). Only
   handlers A/B/C needed (D removed, wires cascade-dropped by patch).
   Runs successfully; `D.final` port does not exist in the value map.
8. T1's lineage on V1 is unchanged: 4 `stage_attempts` rows, `D.final`
   still `"B:10|C:10"`. Approve did **not** rewrite history.
9. Second approve → 409 + `PROPOSAL_ALREADY_RESOLVED`.

### Scenario 2 — disjoint data paths invariant

- Launch T1 and call approve concurrently.
- Await both.
- Assert T1 completes and `stage_attempts.version_hash` for every T1
  row equals V1, never V2.

This directly tests the design claim that proposal approval (writing
`pipeline_proposals`) and runtime execution (writing `stage_attempts` /
`port_values`) are on disjoint data paths that cannot interfere.

## Validation

- `npx tsc --noEmit`: clean
- `npx vitest run`: **3844 passed + 5 skipped** (baseline 3825 →
  +17 tests this phase; 2 unrelated tests now present in diamond-real
  count as 2 more new tests vs baseline record)
- `npx eslint`: not configured at project level; kernel-next files use
  inline disables for explicit-any in MCP handler parameter types.

## Implementation pitfalls encountered

### `Request` does not auto-set `content-length`

Initial reject-route body gating checked `content-length > 0`. WHATWG
`Request` leaves `content-length` null even for non-empty bodies, so
"no reason" and "with reason" both hit the empty-body branch and the
three malformed-JSON / unknown-field / reason tests failed.

**Fix**: read `c.req.text()` and branch on `raw.trim().length > 0`.
Covered by the three tests that originally regressed.

### `ApprovalResult` diagnostic code whitelist

`Diagnostic.code` is a closed Zod enum. Adding new error codes
(`PROPOSAL_NOT_FOUND`, `PROPOSAL_ALREADY_RESOLVED`) required extending
the enum in `ir/schema.ts` in the same commit. `tsc` caught this
immediately; the tests would not have (they assert on `.code` values
as strings).

## What's deliberately NOT in P2

The next architectural questions are explicitly deferred. When picked
up they belong in a dedicated phase because each is structurally
invasive:

- **Migration of running tasks** (P3). Requires XState snapshot
  rebuild, graceful session interrupt, worktree reset to checkpoint,
  per-stage retry-from logic, audit rows. `kernel-next-design.md` §13
  already lays out the shape.
- **Structural vs prompt-only classification (safe range, B3/B4 in
  product-roadmap.md §7.2)**. All patches currently require manual
  approve. Auto-approve in a safe range needs a diff classifier.
- **`rollback_hot_update`** (B20). Requires the migration path first.
- **`hot_update_events` audit table** (B21). Pair with migration.
- **Web UI**. Deferred until diff viewer + migration impact analysis
  exist — see §Scope decisions Q3.
- **Optimistic lock on propose itself**. `propose` currently accepts
  any `currentVersion` that exists, but does not check it is the
  *latest* version for that pipeline name. Multiple concurrent AI
  authors could propose off a stale V1 while V2 was just approved. For
  single-user spike this is fine; B14 addresses it formally.

## Recommended next session

**Phase 2 P3 — in-flight task migration proof of concept**. Take the
V1 → V2 patch from P2 and attempt to migrate T1 mid-flight instead of
letting it finish on V1. This is where every hard problem lives:
worktree reset, session interruption, staged writes in parallel
groups, retry-from-checkpoint semantics. Probably 2-3 weeks of
iteration. Must begin with a design doc — the P2 sketch above is not
sufficient.

## Artifacts

- Code commit: (to be made after this doc is reviewed)
- Test file: `apps/server/src/kernel-next/demo/diamond-proposal.test.ts`
- MCP tool test: `apps/server/src/kernel-next/mcp/server.test.ts`
  (`proposal lifecycle` + `reject_proposal persists reason and blocks
  second approve`)
- REST test: `apps/server/src/routes/kernel-proposals.test.ts`
- Kernel-layer test: `apps/server/src/kernel-next/mcp/kernel.test.ts`
  (5 new proposal state-machine tests)
