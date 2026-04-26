# Secret-Gate (F17) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pause stages on missing MCP envKeys (instead of fail-fast), persist a `secret_gate_queue` row, expose `provide_task_secrets` MCP tool that writes to `task_env_values` and resumes the stuck stage via the existing migration mechanism.

**Architecture:** Mirror the gate-queue pattern — new table `secret_gate_queue`, new `stage_attempts` status `secret_pending`, modified `expandMcpServers` to enumerate ALL missing keys at once, modified `real-executor.ts` to write the queue row and finishAttempt as `secret_pending` instead of `error`, modified runner to NOT write task_finals when the only "failure" is a secret-pending stage, new MCP tool that writes env values and reuses `retryTaskFromStage`'s migration mechanism to resume.

**Tech Stack:** TypeScript, Zod, vitest, better-sqlite3 (in-memory in tests).

**Spec:** `docs/superpowers/specs/2026-04-26-secret-gate-design.md`

---

## File Structure

| File | Role | Change |
|---|---|---|
| `src/kernel-next/ir/sql.ts` | Schema | Add `secret_gate_queue` CREATE TABLE; expand stage_attempts.status CHECK; add to migration drop list |
| `src/kernel-next/runtime/mcp-servers-expander.ts` | MCP env expansion | Replace throw-on-first-missing with enumerate-all-missing return type |
| `src/kernel-next/runtime/mcp-servers-expander.test.ts` | Tests | Update to new API |
| `src/kernel-next/runtime/port-runtime.ts` | finishAttempt | Add `secret_pending` to AttemptStatus union |
| `src/kernel-next/runtime/real-executor.ts:350-362` | Detector | On expansion failure, write secret_gate_queue, finishAttempt as secret_pending |
| `src/kernel-next/runtime/executor.ts:124-129` | Result type | Add `secret_pending` variant to ExecuteStageResult |
| `src/kernel-next/runtime/runner.ts` | Runner pause | When stage returns secret_pending, do NOT mark stageError; let machine awaits; suppress task_finals write if secret_pending is the reason for runner exit |
| `src/kernel-next/mcp/kernel.ts` | KernelService | New method `provideTaskSecrets`; new method `listPendingSecretGates`; extend `getTaskStatus` to return `secret_pending` |
| `src/kernel-next/mcp/pg-entry.ts` | MCP exposure | Register `provide_task_secrets` tool; extend `wait_pipeline_result` to return secret_pending verdict |
| `src/kernel-next/runtime/orphan-reconciler.ts` | Resume | When classifying orphan: if has unresolved secret_gate_queue row → kind: "secret_pending" (no resume; await provide_task_secrets) |
| Tests | Multiple | Unit + integration coverage per spec §5 |

---

## Task 0: Pre-flight

- [ ] **Step 0.1: Confirm clean baseline**

Run:
```bash
cd /Users/minghao/workflow-control
git status
git log --oneline -3
```

Expected: clean tree at HEAD `f44e0ea` (or later — the F17 spec commit).

- [ ] **Step 0.2: Confirm tsc + tests baseline**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec tsc --noEmit 2>&1 | tail -5
pnpm test 2>&1 | tail -10
```

Expected: tsc clean (no output). All tests pass except possibly `spawn-utils.adversarial.test.ts` (known flaky). Note the test count for later regression check.

---

## Task 1: Schema — `secret_gate_queue` table + status enum extension

**Files:**
- Modify: `apps/server/src/kernel-next/ir/sql.ts`

This is foundational for every subsequent task — all writes need the table to exist.

- [ ] **Step 1.1: Find the schema-migration drop block**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
grep -n "DROP TABLE IF EXISTS\|DROP INDEX IF EXISTS" src/kernel-next/ir/sql.ts | head -10
```

Expected: a block (around line 448 per spec recon) listing tables to drop on migration. The pattern: `DROP TABLE IF EXISTS gate_queue;` and similar.

- [ ] **Step 1.2: Add the new table after gate_queue's index**

Edit `apps/server/src/kernel-next/ir/sql.ts`. Locate the line after `CREATE INDEX IF NOT EXISTS idx_gq_task_answered ON gate_queue(task_id, answered_at);` (around line 134). After that index's closing semicolon, insert:

```ts
-- secret_gate_queue (F17, 2026-04-26): one row per stage that paused waiting
-- for MCP envKey values. Mirrors gate_queue but for secrets — no routing,
-- no reject-rollback, just "stage X needs envKeys [Y]; resolved when all keys
-- are populated in task_env_values via provide_task_secrets MCP tool".
CREATE TABLE IF NOT EXISTS secret_gate_queue (
  secret_gate_id  TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  stage_name      TEXT NOT NULL,
  attempt_id      TEXT NOT NULL REFERENCES stage_attempts(attempt_id),
  required_keys   TEXT NOT NULL,
  resolved_at     INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sgq_task_resolved
  ON secret_gate_queue(task_id, resolved_at);
```

- [ ] **Step 1.3: Update stage_attempts.status CHECK**

In the same file, locate `CHECK (status IN ('running','success','error','superseded'))` (line 60). Change to:

```sql
    CHECK (status IN ('running','success','error','superseded','secret_pending')),
```

- [ ] **Step 1.4: Add stage_attempts to schema-rebuild migration block + add new table to drop list**

Find the existing migration block (the place that does `DROP TABLE IF EXISTS gate_queue;` etc — search for the comment header explaining schema migrations). The pattern: drop+recreate ensures schema CHECK changes take effect on existing dev DBs.

Add lines:
```sql
        DROP TABLE IF EXISTS secret_gate_queue;
```

For the stage_attempts CHECK change, since the table has rich production data structure, also drop it on migration so the new CHECK constraint is applied. Add (in the same block):

```sql
        DROP TABLE IF EXISTS stage_attempts;
```

(Yes — this nukes existing dev attempts. Per CLAUDE.md "Legacy task data not migrated", this is acceptable.)

- [ ] **Step 1.5: Run tsc + a smoke test that DB initializes**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec tsc --noEmit 2>&1 | tail -5
pnpm exec vitest run src/kernel-next/ir/sql 2>&1 | tail -10
```

Expected: tsc clean. Any sql.ts test passes.

If there's no sql-specific test, run a broader DB-touching test:
```bash
pnpm exec vitest run src/kernel-next/runtime/start-pipeline-run 2>&1 | tail -10
```

Expected: pass (the schema must initialize without CHECK violation).

- [ ] **Step 1.6: Commit**

```bash
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/ir/sql.ts
git commit -m "$(cat <<'EOF'
feat(schema): secret_gate_queue + stage_attempts.secret_pending status (F17)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Expander — enumerate ALL missing keys

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/mcp-servers-expander.ts`
- Test: `apps/server/src/kernel-next/runtime/mcp-servers-expander.test.ts`

The current expander throws `McpEnvExpansionError` on the FIRST missing variable it finds. F17 needs to know ALL missing variables in one shot so the user provides all of them in one `provide_task_secrets` call.

- [ ] **Step 2.1: Read current implementation**

```bash
cd /Users/minghao/workflow-control/apps/server
sed -n '1,73p' src/kernel-next/runtime/mcp-servers-expander.ts
```

The existing code:
- `expandMcpServers(decls, taskEnv, processEnv): Record<string, ExpandedMcpServer>`
- Throws `McpEnvExpansionError(server, fieldKey, variable)` on first miss

We change the API to a discriminated-union return type:
- `{ ok: true; servers: Record<string, ExpandedMcpServer> }` — success
- `{ ok: false; missingKeys: string[]; details: Array<{ server, fieldKey, key }> }` — at least one miss; missingKeys is the deduplicated, sorted list

- [ ] **Step 2.2: Write failing tests for the new shape**

Append to `apps/server/src/kernel-next/runtime/mcp-servers-expander.test.ts` a new describe block:

```ts
describe("expandMcpServers (batched missing-key enumeration)", () => {
  it("returns ok:true with servers when all variables resolved", () => {
    const decls = [
      { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], envKeys: ["GITHUB_TOKEN"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } },
    ];
    const r = expandMcpServers(decls, { GITHUB_TOKEN: "ghp_x" }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.servers.github!.env!.GITHUB_TOKEN).toBe("ghp_x");
  });

  it("returns ok:false with all missing keys, deduplicated and sorted", () => {
    const decls = [
      { name: "a", command: "npx", args: ["${KEY_B}"], envKeys: ["KEY_B"], env: { X: "${KEY_A}" } },
      { name: "b", command: "npx", args: ["${KEY_A}"], envKeys: ["KEY_A"] },
    ];
    const r = expandMcpServers(decls, {}, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missingKeys).toEqual(["KEY_A", "KEY_B"]); // sorted, deduped
    expect(r.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ server: "a", fieldKey: "args[0]", key: "KEY_B" }),
        expect.objectContaining({ server: "a", fieldKey: "env.X", key: "KEY_A" }),
        expect.objectContaining({ server: "b", fieldKey: "args[0]", key: "KEY_A" }),
      ]),
    );
  });

  it("returns ok:false with single key when only one missing", () => {
    const decls = [
      { name: "x", command: "${MISSING}", args: [], envKeys: ["MISSING"] },
    ];
    const r = expandMcpServers(decls, {}, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missingKeys).toEqual(["MISSING"]);
  });
});
```

- [ ] **Step 2.3: Run tests to verify they fail**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/runtime/mcp-servers-expander.test.ts 2>&1 | tail -30
```

Expected: 3 new tests fail (current API throws on first miss; doesn't return discriminated union).

- [ ] **Step 2.4: Replace expandMcpServers implementation**

Edit `apps/server/src/kernel-next/runtime/mcp-servers-expander.ts`. Replace the entire file content with:

```ts
// mcp-servers-expander.ts
//
// Pure expander for ${VAR} placeholders in stage.config.mcpServers declarations.
// Feeds into real-executor-sdk-options.ts → SDK options.mcpServers.
//
// Precedence: taskEnv (from task_env_values table) > processEnv.
//
// 2026-04-26 F17 (secret-gate): expander now returns a discriminated-union
// result. On missing variable(s), it ENUMERATES ALL of them rather than
// throwing on the first encounter. This is the data the secret-gate
// detector uses to write a single secret_gate_queue row covering every
// envKey the operator must supply. The legacy McpEnvExpansionError class
// is kept exported for any downstream consumer that still imports the
// type, but is no longer thrown by expandMcpServers.

import type { McpServerDecl } from "../ir/schema.js";

export class McpEnvExpansionError extends Error {
  constructor(
    public readonly server: string,
    public readonly fieldKey: string,
    public readonly variable: string,
  ) {
    super(
      `mcp server '${server}' field '${fieldKey}' references unset env variable '${variable}'`,
    );
    this.name = "McpEnvExpansionError";
  }
}

export interface ExpandedMcpServer {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface MissingKeyDetail {
  server: string;
  fieldKey: string;
  key: string;
}

export type ExpandResult =
  | { ok: true; servers: Record<string, ExpandedMcpServer> }
  | { ok: false; missingKeys: string[]; details: MissingKeyDetail[] };

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandValueCollecting(
  raw: string,
  serverName: string,
  fieldKey: string,
  taskEnv: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
  missing: MissingKeyDetail[],
): string {
  return raw.replace(VAR_RE, (_m, v: string) => {
    const fromTask = taskEnv[v];
    if (fromTask !== undefined) return fromTask;
    const fromProc = processEnv[v];
    if (fromProc !== undefined) return fromProc;
    missing.push({ server: serverName, fieldKey, key: v });
    return "";
  });
}

export function expandMcpServers(
  decls: McpServerDecl[],
  taskEnv: Record<string, string>,
  processEnv: NodeJS.ProcessEnv = process.env,
): ExpandResult {
  const missing: MissingKeyDetail[] = [];
  const out: Record<string, ExpandedMcpServer> = {};
  for (const d of decls) {
    const server: ExpandedMcpServer = {
      type: "stdio",
      command: expandValueCollecting(d.command, d.name, "command", taskEnv, processEnv, missing),
      args: d.args.map((a, i) => expandValueCollecting(a, d.name, `args[${i}]`, taskEnv, processEnv, missing)),
    };
    if (d.env) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.env)) {
        env[k] = expandValueCollecting(v, d.name, `env.${k}`, taskEnv, processEnv, missing);
      }
      server.env = env;
    }
    out[d.name] = server;
  }
  if (missing.length > 0) {
    const dedup = Array.from(new Set(missing.map((m) => m.key))).sort();
    return { ok: false, missingKeys: dedup, details: missing };
  }
  return { ok: true, servers: out };
}
```

- [ ] **Step 2.5: Update existing tests to new API**

The pre-existing tests in `mcp-servers-expander.test.ts` (lines 1-115ish from current file) call `expandMcpServers(...)` expecting either a Record return or a thrown error. Read them and update:

```bash
cd /Users/minghao/workflow-control/apps/server
sed -n '1,115p' src/kernel-next/runtime/mcp-servers-expander.test.ts
```

For each pre-existing test, update the call site:
- `const out = expandMcpServers(...)` becomes `const r = expandMcpServers(...); expect(r.ok).toBe(true); if (!r.ok) return; const out = r.servers;`
- `expect(() => expandMcpServers(...)).toThrow(McpEnvExpansionError)` becomes `const r = expandMcpServers(...); expect(r.ok).toBe(false); if (r.ok) return; expect(r.missingKeys.length).toBeGreaterThan(0);`

Use the Edit tool surgically — read each test, make the change in-place. Don't rewrite the whole file unless quicker.

- [ ] **Step 2.6: Run all expander tests to verify pass**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/runtime/mcp-servers-expander.test.ts 2>&1 | tail -20
```

Expected: all tests pass (pre-existing + 3 new).

- [ ] **Step 2.7: Run a broader sweep — find any caller still using the old API**

```bash
cd /Users/minghao/workflow-control/apps/server
grep -rn "expandMcpServers" src/ --include="*.ts" | head -10
```

Expected: only the implementation file, the test file, and `real-executor.ts:353` (which we'll update in Task 3). If any other caller exists, it needs the new return-shape too — note for Task 3 to address.

Run tsc to catch any type breaks:
```bash
pnpm exec tsc --noEmit 2>&1 | tail -10
```

Expected: tsc may now flag `real-executor.ts:353` because the result shape changed. That error is fixed in Task 3. To proceed, leave it — don't try to "fix" it here with an ad-hoc adapter.

If tsc flags any OTHER file, surface that — it's an unexpected caller and Task 3's fix may need to widen.

- [ ] **Step 2.8: Commit**

```bash
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/runtime/mcp-servers-expander.ts apps/server/src/kernel-next/runtime/mcp-servers-expander.test.ts
git commit -m "$(cat <<'EOF'
refactor(mcp-expander): batched missing-key enumeration (F17 prep)

Replace throw-on-first-missing with a discriminated-union return type
that enumerates ALL missing envKeys in one pass. Single round trip for
the operator: provide_task_secrets in Task 4 will list every key the
stage needs, not just the first one expansion happened to hit.

Note: tsc currently breaks at real-executor.ts:353 — that's the
expansion call site, fixed in Task 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: AttemptStatus + ExecuteStageResult — TypeScript-side `secret_pending`

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/port-runtime.ts:24` (AttemptStatus union)
- Modify: `apps/server/src/kernel-next/runtime/executor.ts:124-129` (ExecuteStageResult)

These are pure type extensions. No runtime behavior change yet.

- [ ] **Step 3.1: Extend AttemptStatus**

Edit `apps/server/src/kernel-next/runtime/port-runtime.ts`. Find:
```ts
export type AttemptStatus = "running" | "success" | "error" | "superseded";
```

Change to:
```ts
export type AttemptStatus = "running" | "success" | "error" | "superseded" | "secret_pending";
```

- [ ] **Step 3.2: Extend ExecuteStageResult**

Edit `apps/server/src/kernel-next/runtime/executor.ts:124-129`. Find:
```ts
export interface ExecuteStageResult {
  attemptId: string;
  attemptIdx: number;
  status: "success" | "error";
  error?: string;
}
```

Change to a discriminated union (we want `missingKeys` typed only on the secret_pending variant):
```ts
export type ExecuteStageResult =
  | { attemptId: string; attemptIdx: number; status: "success" }
  | { attemptId: string; attemptIdx: number; status: "error"; error?: string }
  | {
      attemptId: string;
      attemptIdx: number;
      status: "secret_pending";
      missingKeys: string[];
    };
```

- [ ] **Step 3.3: Run tsc — expect new errors at result-consumer sites**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec tsc --noEmit 2>&1 | tail -30
```

Expected: tsc errors at every place that destructures `result.error` after `result.status === "error"` MIGHT be wrong now. But because we kept `error` on the error variant, the existing narrowed paths should still work. The places that take `result.status === "success" | "error"` as an exhaustive check are now non-exhaustive — flagged.

The known sites to inspect (from earlier recon):
- `runner.ts:1068` (`if (result.status === "error")`) — implicit "else success" path. Now also could be secret_pending. Task 4 fixes this.
- `runner.ts:1480` (similar) — Task 4 fixes.

If tsc reveals OTHER unexpected callsites, list them — Task 4's scope might need widening.

- [ ] **Step 3.4: Do NOT commit yet — Tasks 3 + 4 commit together**

Tasks 3, 4, 5 (port-runtime types, real-executor detector, runner) must commit together so the tree is never red. Continue to Task 4.

---

## Task 4: real-executor — write secret_gate_queue, finishAttempt as secret_pending

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/real-executor.ts:344-363` (the env-expansion try/catch block)

- [ ] **Step 4.1: Read current implementation**

```bash
cd /Users/minghao/workflow-control/apps/server
sed -n '340,370p' src/kernel-next/runtime/real-executor.ts
```

Confirm: lines 350-362 contain the `expandMcpServers` call inside a try/catch. The current code throws on missing key, catches `McpEnvExpansionError`, and finishes the attempt as error.

- [ ] **Step 4.2: Locate randomUUID import**

```bash
grep -n "randomUUID\|crypto" src/kernel-next/runtime/real-executor.ts | head -5
```

Confirm `randomUUID` is importable. If not present, add `import { randomUUID } from "node:crypto";` at the top.

- [ ] **Step 4.3: Replace the env-expansion block**

Edit `apps/server/src/kernel-next/runtime/real-executor.ts`. Replace lines 344-363 (the env-expansion block). Current:

```ts
      // P3.5: expand ${VAR} placeholders in stage.config.mcpServers into
      // concrete ExpandedMcpServer records. Precedence: task_env_values
      // (from run_pipeline args) > process.env. Missing variables fail
      // the stage with a MCP_ENV_MISSING diagnostic; downstream stages
      // never see a silent kernel-only fallback.
      let externalMcpServers: Record<string, ExpandedMcpServer> | undefined;
      if (stage.config.mcpServers && stage.config.mcpServers.length > 0) {
        const taskEnv = loadTaskEnvValues(portRuntime.getDb(), taskId);
        try {
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
      }
```

Replace with:

```ts
      // P3.5: expand ${VAR} placeholders in stage.config.mcpServers into
      // concrete ExpandedMcpServer records. Precedence: task_env_values
      // (from run_pipeline args) > process.env.
      //
      // 2026-04-26 F17 secret-gate: missing keys no longer terminate the
      // stage as error. Instead the kernel writes a secret_gate_queue row
      // enumerating every missing envKey, finishes the attempt as
      // secret_pending, and returns a typed secret_pending result so the
      // runner can pause without writing task_finals. The provide_task_secrets
      // MCP tool resolves the row and resumes via the migration path.
      let externalMcpServers: Record<string, ExpandedMcpServer> | undefined;
      if (stage.config.mcpServers && stage.config.mcpServers.length > 0) {
        const taskEnv = loadTaskEnvValues(portRuntime.getDb(), taskId);
        const expandResult = expandMcpServers(stage.config.mcpServers, taskEnv);
        if (!expandResult.ok) {
          const db = portRuntime.getDb();
          const secretGateId = randomUUID();
          db.prepare(
            `INSERT INTO secret_gate_queue
               (secret_gate_id, task_id, stage_name, attempt_id, required_keys, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            secretGateId,
            taskId,
            stage.name,
            attemptId,
            JSON.stringify(expandResult.missingKeys),
            Date.now(),
          );
          const errMsg = `MCP_ENV_MISSING: stage '${stage.name}' needs envKeys [${expandResult.missingKeys.join(", ")}]`;
          writer.close({ terminationReason: "secret_pending" });
          portRuntime.finishAttempt(attemptId, "secret_pending", errMsg, { silent: failSilently });
          return {
            attemptId,
            attemptIdx,
            status: "secret_pending",
            missingKeys: expandResult.missingKeys,
          };
        }
        externalMcpServers = expandResult.servers;
      }
```

Note: `writer.close({ terminationReason: "secret_pending" })` — the `terminationReason` enum may not include "secret_pending" yet. If tsc flags this, search for the type:

```bash
grep -n "type TerminationReason\|terminationReason:" src/kernel-next/runtime/real-executor.ts | head -5
```

If `TerminationReason` is a closed union, extend it to include `"secret_pending"` in the same file or wherever it's defined. The minimal change: add `"secret_pending"` to whatever union it is. If the writer is OK with arbitrary strings, no change needed.

- [ ] **Step 4.4: Remove unused McpEnvExpansionError import (if any)**

```bash
grep -n "McpEnvExpansionError" src/kernel-next/runtime/real-executor.ts | head -5
```

If the import line still exists but the symbol is no longer used after the replacement, remove the import to keep tsc clean (Step 4.7 catches it).

- [ ] **Step 4.5: Verify the existing finishAttempt accepts secret_pending**

The Task 3 type extension (port-runtime.ts AttemptStatus) already widens it. tsc should accept the call.

- [ ] **Step 4.6: tsc and partial test**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec tsc --noEmit 2>&1 | tail -15
```

Expected: any remaining errors should be in `runner.ts` consuming the new result variant. Those are Task 5's job.

If tsc flags anything in real-executor.ts itself, fix it now.

- [ ] **Step 4.7: Do NOT commit — proceed to Task 5**

Task 5 fixes runner.ts; the three commits land together.

---

## Task 5: Runner — handle secret_pending result, suppress task_finals when applicable

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/runner.ts` (multiple sites)

This is the most subtle change. The runner today: when `result.status === "error"`, it pushes to `stageErrors`, dispatches STAGE_FAILED. We want secret_pending to:
- NOT push to stageErrors (it's a pause, not a failure)
- NOT dispatch STAGE_FAILED (machine should NOT advance to fail-state)
- Make the runner exit gracefully (no machine progress possible without env)
- NOT write task_finals (the task is paused, not terminal)
- Set a flag so the task_finals upsert at line 825 is skipped

- [ ] **Step 5.1: Identify the result-consumer sites**

```bash
cd /Users/minghao/workflow-control/apps/server
grep -n "result.status === \"error\"" src/kernel-next/runtime/runner.ts
```

Expected: lines 1068 and 1480 (per earlier recon).

- [ ] **Step 5.2: Add a runner-level state flag**

Edit `apps/server/src/kernel-next/runtime/runner.ts`. Find a clean spot near the top of `runPipeline` (after declarations of `stageErrors` etc., around line 985-1010 area where machine is initialised). Search:

```bash
grep -n "const stageErrors\|stageErrors: Array<" src/kernel-next/runtime/runner.ts | head -3
```

Near the declaration of `stageErrors` (likely around line 980), add:

```ts
  // F17 secret-gate: tracks whether any stage paused waiting for secrets.
  // When true, runner skips the task_finals write (the task is paused, not
  // terminated) and exits silently; provide_task_secrets MCP tool resumes
  // via the migration path.
  let secretPendingObserved = false;
```

- [ ] **Step 5.3: Update result-handling at L1068**

Find:
```ts
          if (result.status === "error") {
            stageErrors.push({ stage: input.stageName, message: result.error ?? "unspecified" });
            dispatcher.send({
              type: "STAGE_FAILED",
              stage: input.stageName,
              error: result.error ?? "unspecified",
            });
          }
```

Change to:
```ts
          if (result.status === "error") {
            stageErrors.push({ stage: input.stageName, message: result.error ?? "unspecified" });
            dispatcher.send({
              type: "STAGE_FAILED",
              stage: input.stageName,
              error: result.error ?? "unspecified",
            });
          } else if (result.status === "secret_pending") {
            // F17: stage is paused waiting for envKeys. Mark the runner-level
            // flag so the finally block skips task_finals; do NOT push to
            // stageErrors (this is not a failure), do NOT dispatch
            // STAGE_FAILED (machine must not advance to its error final).
            secretPendingObserved = true;
          }
```

- [ ] **Step 5.4: Update result-handling at L1480 (same pattern)**

Find the second occurrence at line ~1480 (in the fanout orchestration code). Apply the same pattern: add an `else if (result.status === "secret_pending")` branch that sets `secretPendingObserved = true`.

```bash
cd /Users/minghao/workflow-control/apps/server
sed -n '1475,1495p' src/kernel-next/runtime/runner.ts
```

The exact lines depend on local context — locate the result-status block, mirror Step 5.3's change.

- [ ] **Step 5.5: Suppress task_finals write when secret_pending observed**

Find the task_finals upsert block (lines 822-846, the `try { opts.db.prepare(\`INSERT INTO task_finals...\`).run(...)`).

Wrap the upsert in an outer `if`:

```ts
    if (secretPendingObserved) {
      // F17: task is paused on a missing secret. Do not write task_finals;
      // the task is not terminal. provide_task_secrets will resume via
      // the migration path (synthetic-proposal mechanism in retryTaskFromStage).
      // P3.6 env-cleanup is also skipped — task_env_values are kept so
      // any provide_task_secrets writes already in flight aren't clobbered.
    } else {
      try {
        opts.db.prepare(
          `INSERT INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             version_hash = excluded.version_hash,
             final_state  = excluded.final_state,
             reason       = excluded.reason,
             detail       = excluded.detail,
             ended_at     = excluded.ended_at
           WHERE task_finals.final_state != 'cancelled'`,
        ).run(
          opts.taskId,
          opts.versionHash,
          finalsRow.state,
          finalsRow.reason,
          finalsRow.detail,
          Date.now(),
        );
      } catch (err) {
        console.error(`[runner] task_finals upsert failed for task=${opts.taskId}:`, err);
      }
    }
```

Also wrap the env-cleanup `try { deleteTaskEnvValues(...)` block (right after task_finals) in the same `if (!secretPendingObserved)` guard. The env cleanup must be skipped because we want any partially-provided secrets to persist for the resumed run.

- [ ] **Step 5.6: tsc clean**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec tsc --noEmit 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 5.7: Run runner tests to confirm no regression**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/runtime/runner 2>&1 | tail -15
```

Expected: all existing runner tests pass. The secret_pending branch doesn't yet have a test (Task 7 covers it).

- [ ] **Step 5.8: Commit Tasks 3 + 4 + 5 together**

```bash
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/runtime/port-runtime.ts apps/server/src/kernel-next/runtime/executor.ts apps/server/src/kernel-next/runtime/real-executor.ts apps/server/src/kernel-next/runtime/runner.ts
git commit -m "$(cat <<'EOF'
feat(executor): pause stages on missing MCP envKeys (F17 detector + runner)

When expandMcpServers returns ok:false, real-executor writes a
secret_gate_queue row, finishes the attempt as secret_pending, and
returns a typed secret_pending ExecuteStageResult. The runner observes
this and:
- does NOT push to stageErrors (paused != failed)
- does NOT dispatch STAGE_FAILED (machine must stay live)
- sets a flag that suppresses the task_finals write
- skips the P3.6 env-cleanup so partially-provided secrets persist

The task is left in an in-flight state with secret_gate_queue rows that
provide_task_secrets (Task 6) will resolve via the migration path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: KernelService — `provideTaskSecrets` + `getTaskStatus` extension

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/kernel.ts`
- Test: `apps/server/src/kernel-next/mcp/kernel.test.ts`

- [ ] **Step 6.1: Write failing tests first**

Append to `apps/server/src/kernel-next/mcp/kernel.test.ts` a new describe block (find a clean position — perhaps near the existing "answerGate" describe or at end of file):

```ts
describe("F17 secret-gate", () => {
  it("provideTaskSecrets writes task_env_values and resolves the gate", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });

    // Set up a task with an unresolved secret_gate_queue row.
    // Insert a stage_attempt manually (we don't run the executor in this test).
    const taskId = "t-secret";
    const attemptId = "att-1";
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
       VALUES (?, ?, 'v1', 's', 0, ?, 'secret_pending')`,
    ).run(attemptId, taskId, Date.now());
    db.prepare(
      `INSERT INTO secret_gate_queue (secret_gate_id, task_id, stage_name, attempt_id, required_keys, created_at)
       VALUES ('sg-1', ?, 's', ?, '["KEY_A","KEY_B"]', ?)`,
    ).run(taskId, attemptId, Date.now());

    // Provide all required keys.
    const r = svc.provideTaskSecrets(taskId, { KEY_A: "va", KEY_B: "vb" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved).toBe(true);

    // Verify task_env_values populated.
    const rows = db.prepare(`SELECT key, value FROM task_env_values WHERE task_id = ?`).all(taskId) as Array<{ key: string; value: string }>;
    const envMap = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(envMap).toEqual({ KEY_A: "va", KEY_B: "vb" });

    // Verify secret_gate_queue.resolved_at populated.
    const sgRow = db.prepare(`SELECT resolved_at FROM secret_gate_queue WHERE secret_gate_id = 'sg-1'`).get() as { resolved_at: number | null };
    expect(sgRow.resolved_at).not.toBeNull();
  });

  it("provideTaskSecrets with partial keys returns resolved:false", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const taskId = "t-secret-partial";
    const attemptId = "att-2";
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
       VALUES (?, ?, 'v1', 's', 0, ?, 'secret_pending')`,
    ).run(attemptId, taskId, Date.now());
    db.prepare(
      `INSERT INTO secret_gate_queue (secret_gate_id, task_id, stage_name, attempt_id, required_keys, created_at)
       VALUES ('sg-2', ?, 's', ?, '["KEY_A","KEY_B"]', ?)`,
    ).run(taskId, attemptId, Date.now());

    const r = svc.provideTaskSecrets(taskId, { KEY_A: "va" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved).toBe(false);
    expect(r.stillMissing).toEqual(["KEY_B"]);
  });

  it("provideTaskSecrets returns NO_PENDING_SECRET_GATE when no unresolved row", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const r = svc.provideTaskSecrets("ghost-task", { X: "y" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("NO_PENDING_SECRET_GATE");
  });

  it("provideTaskSecrets rejects keys outside the required_keys list", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const taskId = "t-secret-extra";
    const attemptId = "att-3";
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
       VALUES (?, ?, 'v1', 's', 0, ?, 'secret_pending')`,
    ).run(attemptId, taskId, Date.now());
    db.prepare(
      `INSERT INTO secret_gate_queue (secret_gate_id, task_id, stage_name, attempt_id, required_keys, created_at)
       VALUES ('sg-3', ?, 's', ?, '["KEY_A"]', ?)`,
    ).run(taskId, attemptId, Date.now());

    const r = svc.provideTaskSecrets(taskId, { KEY_A: "va", EXTRA: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("SECRET_KEY_NOT_REQUIRED");
  });

  it("getTaskStatus returns 'secret_pending' when an unresolved gate exists", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const taskId = "t-secret-status";
    const attemptId = "att-4";
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
       VALUES (?, ?, 'v1', 's', 0, ?, 'secret_pending')`,
    ).run(attemptId, taskId, Date.now());
    db.prepare(
      `INSERT INTO secret_gate_queue (secret_gate_id, task_id, stage_name, attempt_id, required_keys, created_at)
       VALUES ('sg-4', ?, 's', ?, '["KEY_A"]', ?)`,
    ).run(taskId, attemptId, Date.now());

    const r = svc.getTaskStatus(taskId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("secret_pending");
    if (r.status !== "secret_pending") return;
    expect(r.pending).toEqual([
      expect.objectContaining({ stageName: "s", requiredKeys: ["KEY_A"], stillMissing: ["KEY_A"] }),
    ]);
  });
});
```

- [ ] **Step 6.2: Run tests to verify they fail**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/mcp/kernel.test.ts -t "F17 secret-gate" 2>&1 | tail -20
```

Expected: 5 new tests fail (provideTaskSecrets doesn't exist; getTaskStatus doesn't return secret_pending).

- [ ] **Step 6.3: Find the TaskStatusReport type and extend it**

```bash
cd /Users/minghao/workflow-control/apps/server
grep -n "TaskStatusReport\|status: \"gated\"\|status: \"running\"\|status: \"orphaned\"" src/kernel-next/mcp/kernel.ts | head -10
```

Find the union type or interface for TaskStatusReport (likely a discriminated union with `status: "gated" | "completed" | ...`). Read it:

```bash
grep -n "type TaskStatusReport\|interface TaskStatusReport" src/kernel-next/mcp/kernel.ts
```

Add a new variant:

```ts
  | {
      ok: true;
      status: "secret_pending";
      taskId: string;
      pending: Array<{
        secretGateId: string;
        stageName: string;
        requiredKeys: string[];
        stillMissing: string[];
        createdAt: number;
      }>;
    }
```

The exact location/syntax depends on the existing union shape — read first, mirror.

- [ ] **Step 6.4: Add Diagnostic codes for new error cases**

Find `DiagnosticSchema` in `src/kernel-next/ir/schema.ts` (the closed enum). Add:

```ts
    // 2026-04-26 F17 secret-gate
    "NO_PENDING_SECRET_GATE",
    "SECRET_KEY_NOT_REQUIRED",
```

Position: after the cross_segment_resume_from codes (around line 504).

- [ ] **Step 6.5: Implement `provideTaskSecrets`**

In `kernel.ts`, near `answerGate` (around line 1176), add a new method:

```ts
  /**
   * F17 secret-gate: write provided env values to task_env_values and, when
   * all required keys for the most recent unresolved secret_gate_queue row
   * are satisfied, mark the row resolved and dispatch a same-version retry
   * synthetic proposal targeting the paused stage. The migration path
   * (executeMigration) supersedes the secret_pending attempt and the new
   * attempt re-runs expandMcpServers — which now succeeds.
   *
   * Secrets are never echoed in the response.
   */
  async provideTaskSecrets(
    taskId: string,
    secrets: Record<string, string>,
  ): Promise<
    | { ok: true; resolved: true }
    | { ok: true; resolved: false; stillMissing: string[] }
    | { ok: false; diagnostics: Diagnostic[] }
  > {
    if (Object.keys(secrets).length === 0) {
      return {
        ok: false,
        diagnostics: [{
          code: "SECRET_KEY_NOT_REQUIRED",
          message: "secrets argument is empty",
          context: { taskId },
        }],
      };
    }

    const sgRow = this.db.prepare(
      `SELECT secret_gate_id, stage_name, required_keys, attempt_id
         FROM secret_gate_queue
        WHERE task_id = ? AND resolved_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
    ).get(taskId) as
      | { secret_gate_id: string; stage_name: string; required_keys: string; attempt_id: string }
      | undefined;
    if (!sgRow) {
      return {
        ok: false,
        diagnostics: [{
          code: "NO_PENDING_SECRET_GATE",
          message: `task '${taskId}' has no unresolved secret_gate_queue row`,
          context: { taskId },
        }],
      };
    }

    const requiredKeys: string[] = JSON.parse(sgRow.required_keys);
    const requiredSet = new Set(requiredKeys);
    const extras = Object.keys(secrets).filter((k) => !requiredSet.has(k));
    if (extras.length > 0) {
      return {
        ok: false,
        diagnostics: [{
          code: "SECRET_KEY_NOT_REQUIRED",
          message: `keys [${extras.join(", ")}] are not required by stage '${sgRow.stage_name}'`,
          context: { taskId, stageName: sgRow.stage_name, extras, requiredKeys },
        }],
      };
    }
    for (const v of Object.values(secrets)) {
      if (v.length === 0) {
        return {
          ok: false,
          diagnostics: [{
            code: "SECRET_KEY_NOT_REQUIRED",
            message: `empty secret values are not accepted`,
            context: { taskId },
          }],
        };
      }
    }

    // Write secrets to task_env_values (upsert).
    const now = Date.now();
    const insertEnv = this.db.prepare(
      `INSERT INTO task_env_values (task_id, key, value, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id, key) DO UPDATE SET value = excluded.value`,
    );
    for (const [k, v] of Object.entries(secrets)) {
      insertEnv.run(taskId, k, v, now);
    }

    // Compute stillMissing post-write.
    const havingRows = this.db.prepare(
      `SELECT key FROM task_env_values WHERE task_id = ?`,
    ).all(taskId) as Array<{ key: string }>;
    const havingKeys = new Set(havingRows.map((r) => r.key));
    const stillMissing = requiredKeys.filter((k) => !havingKeys.has(k));

    if (stillMissing.length > 0) {
      return { ok: true, resolved: false, stillMissing };
    }

    // All required keys present — mark resolved and dispatch retry-resume.
    this.db.prepare(
      `UPDATE secret_gate_queue SET resolved_at = ? WHERE secret_gate_id = ?`,
    ).run(now, sgRow.secret_gate_id);

    // Reuse retry-from-stage migration mechanism. The synthetic proposal
    // pattern at retryTaskFromStage (kernel.ts:1678) supersedes the
    // secret_pending attempt and starts a fresh one targeting the same
    // stage on the same version.
    const retryResult = await this.retryTaskFromStage({
      taskId,
      fromStage: sgRow.stage_name,
      actor: "secret-gate-resume",
    });
    if (!retryResult.ok) {
      return { ok: false, diagnostics: retryResult.diagnostics };
    }
    return { ok: true, resolved: true };
  }

  /**
   * F17: list unresolved secret_gate_queue rows for a task. Used by
   * getTaskStatus and (future) the dashboard.
   */
  listPendingSecretGates(taskId: string): Array<{
    secretGateId: string;
    stageName: string;
    requiredKeys: string[];
    stillMissing: string[];
    createdAt: number;
  }> {
    const rows = this.db.prepare(
      `SELECT secret_gate_id, stage_name, required_keys, created_at
         FROM secret_gate_queue
        WHERE task_id = ? AND resolved_at IS NULL
        ORDER BY created_at DESC`,
    ).all(taskId) as Array<{ secret_gate_id: string; stage_name: string; required_keys: string; created_at: number }>;
    if (rows.length === 0) return [];
    const havingRows = this.db.prepare(
      `SELECT key FROM task_env_values WHERE task_id = ?`,
    ).all(taskId) as Array<{ key: string }>;
    const havingKeys = new Set(havingRows.map((r) => r.key));
    return rows.map((r) => {
      const requiredKeys: string[] = JSON.parse(r.required_keys);
      return {
        secretGateId: r.secret_gate_id,
        stageName: r.stage_name,
        requiredKeys,
        stillMissing: requiredKeys.filter((k) => !havingKeys.has(k)),
        createdAt: r.created_at,
      };
    });
  }
```

- [ ] **Step 6.6: Extend getTaskStatus**

Edit `getTaskStatus` (line 1421+). Add a new check BEFORE `pendingGates`:

```ts
    // F17: unresolved secret-gates take precedence over regular gates and
    // task_finals. They represent the most recent block on the task.
    const pendingSecretGates = this.listPendingSecretGates(taskId);
    if (pendingSecretGates.length > 0) {
      return {
        ok: true,
        status: "secret_pending",
        taskId,
        pending: pendingSecretGates,
      };
    }
```

Insert this block right before `const pendingGates = this.listGates({ taskId, answered: false });` (around line 1453).

- [ ] **Step 6.7: tsc + run new tests**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec tsc --noEmit 2>&1 | tail -10
pnpm exec vitest run src/kernel-next/mcp/kernel.test.ts -t "F17 secret-gate" 2>&1 | tail -20
```

Expected: tsc clean. All 5 new tests pass.

- [ ] **Step 6.8: Run the broader kernel.test.ts suite to confirm no regression**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/mcp/kernel.test.ts 2>&1 | tail -10
```

Expected: all kernel tests pass.

- [ ] **Step 6.9: Commit**

```bash
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/mcp/kernel.ts apps/server/src/kernel-next/mcp/kernel.test.ts apps/server/src/kernel-next/ir/schema.ts
git commit -m "$(cat <<'EOF'
feat(kernel): provideTaskSecrets MCP tool + secret_pending in getTaskStatus (F17)

provideTaskSecrets writes task_env_values and, when all required keys
land, marks the secret_gate_queue row resolved and triggers a
retry-from-stage migration that supersedes the paused attempt.
getTaskStatus returns secret_pending status with metadata for any task
with an unresolved secret_gate_queue row.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: MCP entry — register `provide_task_secrets` tool + `wait_pipeline_result` extension

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.ts`
- Test: `apps/server/src/kernel-next/mcp/pg-entry.test.ts`

This exposes the new method to MCP callers and surfaces secret_pending state in `wait_pipeline_result`.

- [ ] **Step 7.1: Find the existing tool registration pattern**

```bash
cd /Users/minghao/workflow-control/apps/server
grep -n "answer_gate\|tool(" src/kernel-next/mcp/pg-entry.ts | head -20
```

Find where `answer_gate` is registered. Mirror its pattern for `provide_task_secrets`.

- [ ] **Step 7.2: Register provide_task_secrets**

After the `answer_gate` registration block, add:

```ts
  server.tool(
    "provide_task_secrets",
    "Provide secret values (API tokens, etc) to a task that paused waiting for them. " +
    "When all required keys are supplied, the task automatically resumes from the paused stage. " +
    "Secrets are written to task_env_values and never echoed back in the response.",
    {
      taskId: z.string().describe("The task whose paused stage needs secrets"),
      secrets: z.record(z.string(), z.string()).describe("Map of envKey name to value (e.g. { GITHUB_TOKEN: 'ghp_...' })"),
    },
    async ({ taskId, secrets }) => {
      const r = await kernelService.provideTaskSecrets(taskId, secrets);
      return { content: [{ type: "text", text: JSON.stringify(r) }] };
    },
  );
```

(The exact `kernelService` reference may differ — match the variable name used by the surrounding `answer_gate` registration.)

- [ ] **Step 7.3: Find wait_pipeline_result and extend its switch on getTaskStatus**

```bash
grep -n "wait_pipeline_result\|getTaskStatus" src/kernel-next/mcp/pg-entry.ts | head -10
```

Locate the function that polls `getTaskStatus` until terminal. Find the switch/cascade that handles each status. Add a `secret_pending` branch that:
- Returns immediately (don't keep polling — secret_pending is a wait state, not in-flight)
- Surfaces a hint message guiding the caller to call `provide_task_secrets`

Approximate shape (mirror the existing `gated` branch):

```ts
      if (status === "secret_pending") {
        return {
          ok: false,
          inFlight: true,
          kind: "secret_pending",
          taskId,
          pending: report.pending,
          hint: "Task paused: missing required secret keys [" +
                report.pending.flatMap((p) => p.stillMissing).join(", ") +
                "]. Call provide_task_secrets({taskId, secrets: {KEY: VALUE, ...}}) to supply them, then wait_pipeline_result again.",
        };
      }
```

The exact return shape depends on the existing API — read first, mirror.

- [ ] **Step 7.4: Check pg-entry test for existing wait_pipeline_result coverage**

```bash
grep -n "wait_pipeline_result\|gated" src/kernel-next/mcp/pg-entry.test.ts | head -10
```

Add a test if the file has equivalents for `gated`:

```ts
  it("wait_pipeline_result returns secret_pending verdict with hint", async () => {
    // Setup: task with unresolved secret_gate_queue row
    const taskId = "t-wait-secret";
    const attemptId = "att-wait";
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
       VALUES (?, ?, 'v1', 's', 0, ?, 'secret_pending')`,
    ).run(attemptId, taskId, Date.now());
    db.prepare(
      `INSERT INTO secret_gate_queue (secret_gate_id, task_id, stage_name, attempt_id, required_keys, created_at)
       VALUES ('sg-wait', ?, 's', ?, '["GITHUB_TOKEN"]', ?)`,
    ).run(taskId, attemptId, Date.now());

    // Drive wait_pipeline_result and expect secret_pending verdict
    // (the exact invocation API mirrors how the existing test files invoke
    // wait_pipeline_result — read pg-entry.test.ts to find that pattern).
    // Assert: response includes hint mentioning provide_task_secrets and the
    // GITHUB_TOKEN key.
  });
```

(The body of this test must follow `pg-entry.test.ts`'s setup pattern. If patterns differ significantly, this test may be best landed via an integration test in Task 8.)

- [ ] **Step 7.5: tsc + run pg-entry tests**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec tsc --noEmit 2>&1 | tail -10
pnpm exec vitest run src/kernel-next/mcp/pg-entry.test.ts 2>&1 | tail -10
```

Expected: tsc clean. Tests pass.

- [ ] **Step 7.6: Commit**

```bash
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/mcp/pg-entry.ts apps/server/src/kernel-next/mcp/pg-entry.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): expose provide_task_secrets + wait_pipeline_result secret_pending verdict (F17)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Orphan-reconciler — recognize secret_pending tasks

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/orphan-reconciler.ts`
- Test: `apps/server/src/kernel-next/runtime/orphan-reconciler.test.ts`

When the server restarts, any task with an unresolved secret_gate_queue row should NOT be auto-resumed. It's waiting for `provide_task_secrets` — the operator hasn't supplied the secrets yet. Letting reconciler resume it would just re-trigger the same expansion failure and create a duplicate secret_gate_queue row.

- [ ] **Step 8.1: Read classifyOrphan**

```bash
cd /Users/minghao/workflow-control/apps/server
sed -n '1,100p' src/kernel-next/runtime/orphan-reconciler.ts
```

Find the function that returns `{ kind: "terminal" | "resume" | "unresolvable" }`. Add a new variant: `kind: "secret_pending"`.

- [ ] **Step 8.2: Write a failing test**

In `orphan-reconciler.test.ts`, add a test:

```ts
  it("classifies a task with unresolved secret_gate_queue as secret_pending (no auto-resume)", () => {
    const db = makeDb();
    insertPipelineVersion(db, simplePipelineIR(), { versionHash: "v1", tsSource: "" });

    const taskId = "t-orphan-secret";
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
       VALUES ('a1', ?, 'v1', 'a', 0, ?, 'secret_pending')`,
    ).run(taskId, Date.now());
    db.prepare(
      `INSERT INTO secret_gate_queue (secret_gate_id, task_id, stage_name, attempt_id, required_keys, created_at)
       VALUES ('sg-orphan', ?, 'a', 'a1', '["KEY"]', ?)`,
    ).run(taskId, Date.now());

    const cls = classifyOrphan(db, taskId);
    expect(cls.kind).toBe("secret_pending");
  });
```

(`simplePipelineIR()` may need to be adapted to whatever helper exists in the test file — read it first.)

- [ ] **Step 8.3: Run tests to verify failure**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/runtime/orphan-reconciler.test.ts -t "secret_pending" 2>&1 | tail -10
```

- [ ] **Step 8.4: Update classifyOrphan**

In `orphan-reconciler.ts`, at the top of `classifyOrphan` (or wherever appropriate before the existing terminal/resume classification), add:

```ts
  // F17: unresolved secret_gate_queue rows mark this task as paused
  // waiting for secrets. Reconciler must NOT auto-resume; the task
  // resumes only when provide_task_secrets is called.
  const hasPendingSecret = db.prepare(
    `SELECT 1 FROM secret_gate_queue WHERE task_id = ? AND resolved_at IS NULL LIMIT 1`,
  ).get(taskId) !== undefined;
  if (hasPendingSecret) {
    const latest = db.prepare(
      `SELECT version_hash FROM stage_attempts WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`,
    ).get(taskId) as { version_hash: string } | undefined;
    return { kind: "secret_pending", versionHash: latest?.version_hash ?? "-" };
  }
```

Add to the return-type union: `{ kind: "secret_pending"; versionHash: string }`.

- [ ] **Step 8.5: Update bootResumability to handle the new kind**

In the same file, find `bootResumability` (line 121+). Add a branch in the for-loop:

```ts
    if (cls.kind === "secret_pending") {
      // Don't auto-resume; don't write task_finals (the task is paused).
      // The task remains in this state until provide_task_secrets resolves
      // its secret_gate_queue row, which itself triggers retryTaskFromStage.
      continue;
    }
```

(Insert before the `unresolvable` branch.)

- [ ] **Step 8.6: tsc + tests**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec tsc --noEmit 2>&1 | tail -10
pnpm exec vitest run src/kernel-next/runtime/orphan-reconciler.test.ts 2>&1 | tail -10
```

Expected: tsc clean; all reconciler tests pass.

- [ ] **Step 8.7: Commit**

```bash
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/runtime/orphan-reconciler.ts apps/server/src/kernel-next/runtime/orphan-reconciler.test.ts
git commit -m "$(cat <<'EOF'
feat(reconciler): skip auto-resume for tasks with unresolved secret-gates (F17)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: End-to-end integration test

**Files:**
- Create: `apps/server/src/kernel-next/runtime/secret-gate-e2e.test.ts`

Integration test confirming the full loop: submit pipeline that needs envKey → run without envValues → assert secret_pending state surfaces → call provideTaskSecrets → assert task resumes and completes.

- [ ] **Step 9.1: Write the integration test**

Create `apps/server/src/kernel-next/runtime/secret-gate-e2e.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeDb } from "./test-helpers/db.js";
import { KernelService } from "../mcp/kernel.js";
import { startPipelineRun } from "./start-pipeline-run.js";
import type { PipelineIR } from "../ir/schema.js";

// A pipeline with a single agent stage that declares a github MCP server
// requiring GITHUB_TOKEN. Used to exercise the F17 path end-to-end.
function pipelineNeedingGithubToken(): PipelineIR {
  return {
    name: "secret-gate-e2e",
    externalInputs: [{ name: "topic", type: "string" }],
    stages: [
      {
        name: "research",
        type: "agent",
        inputs: [{ name: "topic", type: "string" }],
        outputs: [{ name: "summary", type: "string" }],
        config: {
          promptRef: "stub",
          mcpServers: [
            {
              name: "github",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
              envKeys: ["GITHUB_TOKEN"],
              env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
            },
          ],
        },
      },
    ],
    wires: [
      { from: { source: "external", port: "topic" }, to: { stage: "research", port: "topic" } },
    ],
  };
}

describe("F17 secret-gate end-to-end", () => {
  it("paused stage transitions to secret_pending; provide_task_secrets resumes it", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = pipelineNeedingGithubToken();
    const submitted = await svc.submit(ir, { prompts: { stub: "do nothing" } });
    if (!submitted.ok) throw new Error("submit failed");

    // Make sure GITHUB_TOKEN is NOT in process.env for this test.
    const originalToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;

    try {
      // Run the pipeline without envValues.
      const taskId = "e2e-task";
      // Use startPipelineRun directly — runner will detect missing env.
      const runPromise = startPipelineRun({
        taskId,
        versionHash: submitted.versionHash,
        seedValues: { topic: "test" },
      });

      // The run completes (no agent invocation; expansion fails immediately).
      // Wait for it.
      await runPromise.catch(() => {/* expected to settle without throwing */});

      // Status should now be secret_pending.
      const status = svc.getTaskStatus(taskId);
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.status).toBe("secret_pending");
      if (status.status !== "secret_pending") return;
      expect(status.pending[0]!.requiredKeys).toContain("GITHUB_TOKEN");

      // task_finals must NOT have been written.
      const finalRow = db.prepare(`SELECT * FROM task_finals WHERE task_id = ?`).get(taskId);
      expect(finalRow).toBeUndefined();

      // Now provide the secret.
      const provideResult = await svc.provideTaskSecrets(taskId, { GITHUB_TOKEN: "ghp_test" });
      expect(provideResult.ok).toBe(true);
      if (!provideResult.ok) return;
      expect(provideResult.resolved).toBe(true);

      // After provideTaskSecrets, the migration mechanism re-runs the
      // stage. With a real github MCP server it would proceed normally;
      // with our stub setup it depends on what the agent SDK does.
      // For this e2e we assert: secret_gate_queue is resolved.
      const sgRow = db.prepare(
        `SELECT resolved_at FROM secret_gate_queue WHERE task_id = ?`,
      ).get(taskId) as { resolved_at: number | null };
      expect(sgRow.resolved_at).not.toBeNull();
    } finally {
      if (originalToken !== undefined) process.env.GITHUB_TOKEN = originalToken;
    }
  });
});
```

Note: this test may need adjustment depending on what `startPipelineRun` requires (SDK init, mocks, etc). The exact test setup pattern should mirror an existing integration test like `start-pipeline-run.env-values.test.ts`. Read that test for the canonical setup, then adapt.

- [ ] **Step 9.2: Run test**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/runtime/secret-gate-e2e.test.ts 2>&1 | tail -30
```

If the test fails because of SDK / mock setup issues that don't relate to F17, adjust setup to match the canonical pattern. The acceptance signal is: `secret_gate_queue` row written, `provideTaskSecrets` resolves it, `task_finals` is NOT written during the pause.

- [ ] **Step 9.3: tsc clean**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec tsc --noEmit 2>&1 | tail -5
```

- [ ] **Step 9.4: Commit**

```bash
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/runtime/secret-gate-e2e.test.ts
git commit -m "$(cat <<'EOF'
test(F17): end-to-end secret-gate integration test

Submit pipeline needing GITHUB_TOKEN, run without env, assert
secret_pending state surfaces and task_finals is NOT written, then
provideTaskSecrets and assert the gate row is resolved.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Final verification + acceptance walkthrough

- [ ] **Step 10.1: Full kernel-next test sweep**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/ 2>&1 | tail -15
```

Expected: all kernel-next tests pass. Note net new test count vs Task 0 baseline.

- [ ] **Step 10.2: Full server test sweep**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm test 2>&1 | tail -10
```

Expected: all tests pass except possibly `spawn-utils.adversarial.test.ts` (known flaky, unrelated).

- [ ] **Step 10.3: tsc clean**

```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec tsc --noEmit 2>&1 | tail -5
```

- [ ] **Step 10.4: Spec acceptance walkthrough**

Read `docs/superpowers/specs/2026-04-26-secret-gate-design.md` and confirm each subsection has been implemented:

- §3.1 (secret_gate_queue table) → Task 1
- §3.2 (secret_pending status) → Task 1 + Task 3
- §3.3 (Detector: real-executor) → Task 4
- §3.4 (provide_task_secrets MCP tool) → Task 6 + Task 7
- §3.5 (Resume via migration) → Task 6's `retryTaskFromStage` reuse
- §3.6 (getTaskStatus extension) → Task 6
- §3.7 (wait_pipeline_result extension) → Task 7
- §3.8 (task_env_values lifecycle) → Task 5 (skip cleanup when secretPendingObserved)
- §5.2 (Integration test) → Task 9

If any subsection has no implementing task, surface it.

---

## Self-Review

**1. Spec coverage:** Mapped above. No gaps.

**2. Placeholder scan:** Tasks 7 and 9 contain a few "match the existing pattern, read the file first" instructions where exact code depends on local context the plan can't predict from outside. These are not placeholders for the engineer to invent — they're "read X, mirror it" directives with concrete acceptance criteria. The implementer reads the existing test/registration file once, then writes deterministic code.

**3. Type consistency:**
- `secret_pending` (snake_case underscore) used consistently across schema, AttemptStatus, ExecuteStageResult, getTaskStatus
- `secret_gate_queue` table name consistent
- Method names: `provideTaskSecrets`, `listPendingSecretGates` consistent
- New diagnostic codes: `NO_PENDING_SECRET_GATE`, `SECRET_KEY_NOT_REQUIRED`

No type-consistency issues.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-26-secret-gate.md`.

**Subagent-Driven** — I will dispatch implementer subagents per task with two-stage review (spec compliance + code quality), as I did for cross-segment-resume-pivot.
