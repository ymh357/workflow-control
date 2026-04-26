# Secret-Gate Design (F17)

> Date: 2026-04-26
> Status: Design recorded, implementation pending
> Source: `docs/superpowers/plans/2026-04-25-pipeline-generator-dogfood-findings.md` Finding 17
> Triggers: web3-research dogfood Round 6 termination at `collectPrimarySources` due to `MCP_ENV_MISSING: GITHUB_TOKEN`

---

## 1. Problem

When a stage starts and its `mcpServers[*]` declarations reference an env variable not satisfied by `task_env_values` or `process.env`, the kernel currently throws `McpEnvExpansionError` which `real-executor.ts:355-360` catches and finishes the attempt as `error`. The task is then unrecoverable: no retry path can succeed (env is still missing), and the recovery-of-record is "operator restarts server with the env set, then triggers retry."

This is wrong on two axes:
1. **Data is recoverable but state is not.** The kernel knows exactly which envKeys are missing. Demanding operator intervention for a known, fixable condition turns a normal pipeline pause into a process-recycle.
2. **No analogue to gate.** Pipelines have a first-class human-pause primitive (`gate` stages → `gate_queue`). There is no equivalent for "I need a secret to proceed", forcing operators into out-of-band coordination.

---

## 2. Goal

When a stage's MCP env expansion fails, transition the stuck stage to a paused state that:

1. Records exactly what's missing (which stage, which MCP server, which envKey names)
2. Surfaces the wait via `getTaskStatus` as `secret_pending`
3. Accepts secret values via a new MCP tool `provide_task_secrets` writing directly to `task_env_values` — values never enter agent context, prompt history, or session JSONL
4. Resumes the stage automatically once all required keys are supplied

Out of scope: dashboard UI for `secret_pending` (deferred — MCP tool is sufficient for dogfood and ops). Adding an "ask LLM for missing secret" path (deliberately not — security boundary).

---

## 3. Architecture

### 3.1 New table: `secret_gate_queue`

```sql
CREATE TABLE IF NOT EXISTS secret_gate_queue (
  secret_gate_id   TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL,
  stage_name       TEXT NOT NULL,
  attempt_id       TEXT NOT NULL REFERENCES stage_attempts(attempt_id),
  required_keys    TEXT NOT NULL,                 -- JSON array of envKey names
  resolved_at      INTEGER,                       -- NULL until provide_task_secrets satisfies all keys
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sgq_task_resolved
  ON secret_gate_queue(task_id, resolved_at);
```

Rationale for a separate table over reusing `gate_queue`:
- `gate_queue.question_json` is free-form for the human-in-loop `gate` stage type. Stuffing missingKey lists in there breaks the abstraction.
- `gate_queue` has routing semantics (answers route to next stage, with optional reject-rollback). Secret resolution has no routing — the same stage simply re-runs once env is satisfied.
- Distinct table lets `getTaskStatus` and `wait_pipeline_result` query each path with a typed result, no run-time discrimination.

### 3.2 New stage_attempt status: `secret_pending`

Today: `running | success | error | superseded` (per `sql.ts:60` CHECK constraint). Add `secret_pending`.

SQL migration: SQLite cannot ALTER a CHECK constraint, requiring table-rebuild for prod DBs. For dev DBs (the only consumer of kernel-next.db today, per CLAUDE.md "kernel-next is the only engine"), a clean recreate is sufficient. The schema migration approach used elsewhere in `sql.ts` (e.g. line 448 `DROP TABLE IF EXISTS gate_queue` for an unrelated migration) is the established pattern. We follow it: drop+recreate stage_attempts is feasible because no production data exists. Plan task: write a one-line migration block analogous to the existing `DROP TABLE IF EXISTS` patterns.

Semantics:
- The attempt did NOT execute the agent (it was terminated before SDK was even constructed)
- It is paused, not failed; retry-from-error logic should not target it
- Its session_id is null; no SDK conversation occurred

`secret_pending` attempts do NOT contribute to:
- error-stage detection in `retryTaskFromStage` (won't auto-pick a `secret_pending` attempt as the failed-stage to retry from)
- segment-resume Phase 1 lookups (status filter is `success | running` — `secret_pending` is excluded already)
- task_finals: a task with all stages either `success` or `secret_pending` is **not** terminal, period.

### 3.3 Detector — modify `real-executor.ts:350-362`

Current:
```ts
externalMcpServers = expandMcpServers(stage.config.mcpServers, taskEnv);
} catch (e) {
  if (e instanceof McpEnvExpansionError) {
    const errMsg = `MCP_ENV_MISSING: server '${e.server}' field '${e.fieldKey}' references unset env variable '${e.variable}'`;
    writer.close({ terminationReason: "error" });
    portRuntime.finishAttempt(attemptId, "error", errMsg, { silent: failSilently });
    return { attemptId, attemptIdx, status: "error", error: errMsg };
  }
  throw e;
}
```

Replacement:
- `expandMcpServers` is enhanced to surface ALL missing variables (not just the first), returning a structured result:
  ```ts
  type ExpandResult =
    | { ok: true; servers: Record<string, ExpandedMcpServer> }
    | { ok: false; missingKeys: string[]; perKey: Array<{ server, field, key }> };
  ```
- On `ok: false`, the executor:
  1. Writes a `secret_gate_queue` row (attempt_id, missingKeys)
  2. Closes writer with new termination reason `"secret_pending"`
  3. Calls `portRuntime.finishAttempt(attemptId, "secret_pending", "MCP_ENV_MISSING: " + missingKeys.join(","), { silent: false })`
  4. Returns `{ attemptId, attemptIdx, status: "secret_pending", missingKeys }`
- The runner's outer state machine sees `secret_pending` and stops scheduling further stages on this task — same wait-and-pause pattern as gate.

The `"all missing keys" enumeration` matters: a stage may declare two MCP servers with two different missing keys. Reporting only the first means the user supplies key 1, the stage runs, fails again on key 2, the user supplies key 2. Two round trips. Surfacing all keys at once: one round trip.

### 3.4 New MCP tool: `provide_task_secrets`

```ts
provide_task_secrets(taskId: string, secrets: Record<string, string>): Result
```

Validation:
- `taskId` must have a non-resolved row in `secret_gate_queue`
- `secrets` keys must be a (non-empty) subset of the latest unresolved row's `required_keys`
- No empty-string values

Behavior:
1. INSERT (or UPSERT) each `(taskId, key, value)` into `task_env_values`
2. Check whether `task_env_values` now satisfies all `required_keys` for the unresolved row
3. If yes:
   - Mark `secret_gate_queue.resolved_at = now`
   - Synthesize an approved same-version proposal targeting the stage in `secret_gate_queue.stage_name` (mechanism identical to `retryTaskFromStage` synthetic-proposal pattern, `kernel.ts:1678+`). The migration path will create a fresh attempt and supersede the prior `secret_pending` one.
   - Return `{ ok: true, resolved: true }`
4. If no (partial):
   - Return `{ ok: true, resolved: false, stillMissing: [...] }` — caller can submit more

The tool **never echoes secret values** — return shape is keys-only metadata.

### 3.5 Resume mechanism

When `provide_task_secrets` resolves all keys, the secret-pending stage attempt is `superseded` by the new attempt (the migration path handles this — same as retry from error). The new attempt re-runs `expandMcpServers` with the now-populated `task_env_values`, succeeds, and the agent executes normally.

Reuse here is non-negotiable: `retryTaskFromStage`'s migration mechanism is already proven for "fresh attempt from named stage on same version". A separate code path would duplicate transaction handling, supersede semantics, lineage tracking. The synthetic-proposal pattern at `kernel.ts:1678` is the seam to reuse.

### 3.6 `getTaskStatus` extension

Resolution order (extension to `kernel.ts:1429-1490`):

1. **Pending secret_gate (new):** if `secret_gate_queue` has any unresolved row for taskId → `secret_pending`, with metadata `{ stageName, requiredKeys, resolvedKeys: [...] }`
2. Pending gate(s) → `gated`
3. task_finals row → final_state
4. No stage_attempts → `not_found`
5. Latest status `running` → `running`
6. Otherwise → `orphaned`

Order matters: a task can technically have both a pending secret-gate and a pending human-gate if a previous stage was gated and the current stage hits a missing secret. Surface secret_pending first because it's the more recent block — and human-gate resolution requires the operator anyway, which gives them a chance to also provide the secret in the same out-of-band turn.

### 3.7 `wait_pipeline_result` extension

When `getTaskStatus` returns `secret_pending`, `wait_pipeline_result` returns a typed in-flight verdict (analogous to the existing `gated` verdict), with hint:
> "Task paused: missing required secret keys [GITHUB_TOKEN, ...]. Call provide_task_secrets({taskId, secrets: {KEY: VALUE, ...}}) to supply them, then wait_pipeline_result again."

### 3.8 task_env_values lifecycle

Currently: populated at task creation, deleted on task termination (P3.6). Secret-gate path adds a write source: `provide_task_secrets`. The cleanup path doesn't change — values still get wiped on terminal state — but a paused-then-resumed task keeps its secret values until natural termination.

---

## 4. Trust and security boundaries

- Agent prompts NEVER see secret values. Confirmed by:
  - `provide_task_secrets` is an MCP tool the operator (human or upper-layer agent) calls, not something the executing pipeline can self-call to read its own secrets
  - `task_env_values` is read only by `expandMcpServers` (substituting into MCP server command lines passed to the SDK as opaque config)
  - Errors mention envKey **names**, never values; error messages from `McpEnvExpansionError` already follow this convention
- The new tool's response shape includes `keys-only` lists, never values — even for the "stillMissing" partial case
- Conversation JSONL never sees secrets. The pre-existing rule (CLAUDE.md "Secret handling") holds: secrets enter only via env / `envValues` / `provide_task_secrets`, never via chat
- DB-resident secrets in `task_env_values` are plaintext and the user accepts that risk by virtue of using the kernel — same trust model as existing `task_env_values` from `run_pipeline`'s `envValues`. No new attack surface.

---

## 5. Validation and rollout

### 5.1 Unit tests
- `expandMcpServers`: now-batched missing-key detection. Old single-error API replaced — `McpEnvExpansionError` removed in favor of `ExpandResult` discriminated union. Update existing tests in `mcp-servers-expander.test.ts`.
- `secret_gate_queue` schema migration is purely additive.
- `provide_task_secrets` covers: unknown taskId, no pending row, partial provide, full provide, idempotent re-call after resolve, value-echo prevention.

### 5.2 Integration test
- End-to-end: submit a pipeline with an MCP envKey, run without `envValues` → assert `secret_pending` state surfaces. Call `provide_task_secrets` → assert task resumes and completes (use a stub MCP server that succeeds when its env is set).

### 5.3 Regression
- All multi-mode pipelines unaffected (no envKeys → no secret-gate).
- Existing single-mode pipelines unaffected (smoke-test, pr-description-generator have no MCP envKeys).
- web3-research pipeline becomes runnable end-to-end after this lands.

### 5.4 No breaking changes
- IR schema unchanged
- pipeline-generator unchanged (it already emits envKeys correctly)
- Existing `run_pipeline` callers unaffected (those that pass `envValues` continue to work; those that don't now get `secret_pending` instead of `error`)

---

## 6. Implementation surface (for the plan)

| Component | Files | Effort |
|---|---|---|
| Schema migration | `apps/server/src/kernel-next/ir/sql.ts` (new table + status check expansion) | XS |
| Expander API change | `apps/server/src/kernel-next/runtime/mcp-servers-expander.ts` + `.test.ts` | S |
| Detector wire-up | `apps/server/src/kernel-next/runtime/real-executor.ts:350-362` | S |
| Status enum + writer | `apps/server/src/kernel-next/runtime/port-runtime.ts` (or wherever `finishAttempt` lives — it accepts a status string today; need to allow `secret_pending`) | S |
| Runner pause logic | `apps/server/src/kernel-next/runtime/runner.ts` — when attempt returns `secret_pending`, pipeline pauses (similar to gate) | M |
| `provide_task_secrets` tool | `apps/server/src/kernel-next/mcp/kernel.ts` (new method on KernelService) + `mcp/pg-entry.ts` (MCP exposure) | M |
| `getTaskStatus` extension | `apps/server/src/kernel-next/mcp/kernel.ts:1421` | XS |
| `wait_pipeline_result` extension | `apps/server/src/kernel-next/mcp/pg-entry.ts` | XS |
| Tests | unit + integration per §5 | M |

Estimated total: 1-2 focused days. No subsystem boundaries broken; mostly additive.

---

## 7. Open questions (resolved here, recorded for plan)

**Q1: Should `secret_pending` rows be cleaned up on task termination?**
A: Yes. P3.6 already deletes `task_env_values` on terminal state. Add `secret_gate_queue` to the same cleanup. (A `secret_pending` task that's then cancelled forgets the keys it was waiting for — correct, because the task is gone.)

**Q2: What if the operator calls `provide_task_secrets` twice with same keys?**
A: The second call is a no-op for already-set keys. Re-supplying overwrites — newer value wins. This matches `task_env_values`'s upsert semantics.

**Q3: What about secrets set in `process.env` but absent in `task_env_values`?**
A: `expandMcpServers` already prefers `task_env_values > process.env` (per existing code). If `process.env` has the value, the expansion succeeds; secret-gate never triggers. So the "set GITHUB_TOKEN at server start, then run" workflow continues to bypass secret-gate cleanly. The new path is for the case where the operator forgot or couldn't restart.

**Q4: What if `provide_task_secrets` is called for a task with no pending secret-gate?**
A: Return `{ ok: false, code: "NO_PENDING_SECRET_GATE" }`. Same shape as `answerGate` for nonexistent gates.

**Q5: What if a stage hits a different `MCP_ENV_MISSING` after secrets are provided (e.g. a multi-step server now needs another key)?**
A: A new `secret_gate_queue` row gets created on the new attempt. The cycle repeats: provide → resolve → resume → potentially-pause-again. No special handling needed; each cycle is independent.

---

## 8. Why we're doing this now

Web3-research dogfood is blocked here. Round 6 ended on this exact failure mode. Without secret-gate, every pipeline with an MCP envKey is one missed `envValues` away from being unrecoverable. F17 unblocks the dogfood loop — which is the next step the user explicitly authorized — and removes the only "operator must restart server" failure mode for the kernel.
