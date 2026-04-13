# Stage Git Checkpoint + Compensation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record git HEAD at stage entry and optionally reset to it on failure, enabling automatic code rollback when AI agent stages corrupt the worktree.

**Architecture:** Populate the existing unused `stageCheckpoints` field in WorkflowContext during stage entry. Add optional `compensation` config to YAML stage schema. Execute git reset/stash in the error handler's block transition. Enhance RETRY_FROM to run compensation before entering the target stage.

**Tech Stack:** Node.js child_process (execSync), YAML stage config, XState assign actions, Vitest

**Spec:** `docs/superpowers/specs/2026-04-13-workflow-event-store-design.md` (Spec B)

---

### Task 1: Add compensation field to shared types and validator

**Files:**
- Modify: `packages/shared/src/pipeline-validator.ts`

- [ ] **Step 1: Read the current file**

Read `packages/shared/src/pipeline-validator.ts` to understand the StageRuntime interface and validation logic.

- [ ] **Step 2: Add compensation to StageRuntime interface**

In `packages/shared/src/pipeline-validator.ts`, add `compensation` to the `StageRuntime` interface (around line 10-20):

```typescript
interface StageRuntime {
  engine?: string;
  system_prompt?: string;
  writes?: string[];
  reads?: Record<string, string>;
  on_reject_to?: string;
  on_approve_to?: string;
  retry?: { max_retries?: number; back_to?: string };
  exclusive_write_group?: string;
  compensation?: { strategy: "git_reset" | "git_stash" | "none" };
  [key: string]: unknown;
}
```

- [ ] **Step 3: Add validation for compensation field**

In the `validatePipelineLogic` function, inside the per-stage loop where other runtime validations happen, add validation for compensation. Find where other runtime fields are validated (search for `runtime?.retry` or similar patterns) and add nearby:

```typescript
    // Validate compensation config
    if (stage.runtime?.compensation) {
      const strategy = stage.runtime.compensation.strategy;
      if (!["git_reset", "git_stash", "none"].includes(strategy)) {
        issues.push({
          severity: "error",
          stageIndex: i,
          field: "runtime.compensation.strategy",
          message: `Invalid compensation strategy "${strategy}". Must be "git_reset", "git_stash", or "none".`,
        });
      }
      if (stage.type !== "agent" && stage.type !== "script") {
        issues.push({
          severity: "warning",
          stageIndex: i,
          field: "runtime.compensation",
          message: `Compensation is only meaningful for agent/script stages, not "${stage.type}".`,
        });
      }
    }
```

- [ ] **Step 4: Run existing validator tests**

Run: `cd /Users/minghao/workflow-control && npx vitest run packages/shared/src/pipeline-validator.test.ts`
Expected: All existing tests pass (our change only adds new validation, doesn't break existing)

- [ ] **Step 5: Type check**

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/pipeline-validator.ts
git commit -m "feat: add compensation config to stage runtime schema"
```

---

### Task 2: Record git HEAD in stageCheckpoints on stage entry

**Files:**
- Modify: `apps/server/src/machine/helpers.ts` (modify `statusEntry` function)
- Create: `apps/server/src/machine/git-checkpoint.ts` (helper to get git HEAD safely)
- Create: `apps/server/src/machine/git-checkpoint.test.ts`

- [ ] **Step 1: Write the test file for git-checkpoint**

```typescript
// apps/server/src/machine/git-checkpoint.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { getGitHead } from "./git-checkpoint.js";

describe("getGitHead", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `git-cp-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(testDir, { recursive: true });
    execSync("git init && git commit --allow-empty -m init", { cwd: testDir, stdio: "pipe" });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("returns 40-char git SHA for valid repo", () => {
    const head = getGitHead(testDir);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns undefined for non-existent path", () => {
    expect(getGitHead("/tmp/does-not-exist-" + Date.now())).toBeUndefined();
  });

  it("returns undefined for non-git directory", () => {
    const nonGit = join(tmpdir(), `non-git-${Date.now()}`);
    mkdirSync(nonGit, { recursive: true });
    expect(getGitHead(nonGit)).toBeUndefined();
    try { rmSync(nonGit, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("returns undefined when path is undefined", () => {
    expect(getGitHead(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/machine/git-checkpoint.test.ts`
Expected: FAIL -- module `./git-checkpoint.js` does not exist

- [ ] **Step 3: Create git-checkpoint module**

```typescript
// apps/server/src/machine/git-checkpoint.ts
import { execSync } from "node:child_process";

export function getGitHead(worktreePath: string | undefined): string | undefined {
  if (!worktreePath) return undefined;
  try {
    return execSync("git rev-parse HEAD", { cwd: worktreePath, stdio: "pipe" }).toString().trim();
  } catch {
    return undefined;
  }
}

export function runCompensation(
  strategy: string,
  gitHead: string | undefined,
  worktreePath: string | undefined,
): { success: boolean; error?: string } {
  if (!worktreePath || !gitHead) return { success: false, error: "missing worktreePath or gitHead" };
  try {
    if (strategy === "git_reset") {
      execSync(`git reset --hard ${gitHead}`, { cwd: worktreePath, stdio: "pipe" });
    } else if (strategy === "git_stash") {
      execSync("git stash", { cwd: worktreePath, stdio: "pipe" });
    } else {
      return { success: false, error: `unknown strategy: ${strategy}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Add compensation tests**

Append to the same test file `apps/server/src/machine/git-checkpoint.test.ts`:

```typescript
import { runCompensation } from "./git-checkpoint.js";

describe("runCompensation", () => {
  let testDir: string;
  let initialHead: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `git-comp-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(testDir, { recursive: true });
    execSync("git init && git commit --allow-empty -m init", { cwd: testDir, stdio: "pipe" });
    initialHead = execSync("git rev-parse HEAD", { cwd: testDir, stdio: "pipe" }).toString().trim();
    // Make a second commit
    execSync("git commit --allow-empty -m second", { cwd: testDir, stdio: "pipe" });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("git_reset restores to specified commit", () => {
    const result = runCompensation("git_reset", initialHead, testDir);
    expect(result.success).toBe(true);
    const currentHead = execSync("git rev-parse HEAD", { cwd: testDir, stdio: "pipe" }).toString().trim();
    expect(currentHead).toBe(initialHead);
  });

  it("git_stash succeeds without error", () => {
    const result = runCompensation("git_stash", initialHead, testDir);
    expect(result.success).toBe(true);
  });

  it("returns error for missing worktreePath", () => {
    const result = runCompensation("git_reset", initialHead, undefined);
    expect(result.success).toBe(false);
  });

  it("returns error for missing gitHead", () => {
    const result = runCompensation("git_reset", undefined, testDir);
    expect(result.success).toBe(false);
  });

  it("returns error for unknown strategy", () => {
    const result = runCompensation("unknown", initialHead, testDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("unknown strategy");
  });
});
```

- [ ] **Step 5: Run all tests**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/machine/git-checkpoint.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 6: Type check**

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/machine/git-checkpoint.ts apps/server/src/machine/git-checkpoint.test.ts
git commit -m "feat: add git HEAD capture and compensation helpers"
```

---

### Task 3: Wire stageCheckpoints into stage entry actions

**Files:**
- Modify: `apps/server/src/machine/helpers.ts` (modify `statusEntry` function)

- [ ] **Step 1: Read the current statusEntry function**

Read `apps/server/src/machine/helpers.ts` lines 102-114 to see the current `statusEntry` function.

- [ ] **Step 2: Modify statusEntry to record git HEAD**

Add import at top of `helpers.ts`:

```typescript
import { getGitHead } from "./git-checkpoint.js";
```

Modify the `statusEntry` function (around line 104) to add git HEAD recording:

```typescript
export function statusEntry(stateName: string): EmitAction[] {
  return [
    assign({
      status: stateName,
      updatedAt: () => new Date().toISOString(),
    }),
    assign(({ context }: { context: WorkflowContext }) => ({
      stageCheckpoints: {
        ...context.stageCheckpoints,
        [stateName]: {
          gitHead: getGitHead(context.worktreePath),
          startedAt: new Date().toISOString(),
        },
      },
    })),
    emitNotionSync(),
    emitStatus(stateName),
    emitTaskListUpdate(),
  ];
}
```

- [ ] **Step 3: Run related tests**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/__integration__/side-effects.test.ts src/__integration__/task-lifecycle.test.ts`
Expected: All existing tests pass

- [ ] **Step 4: Type check**

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/machine/helpers.ts
git commit -m "feat: record git HEAD in stageCheckpoints on stage entry"
```

---

### Task 4: Execute compensation on stage failure (block path)

**Files:**
- Modify: `apps/server/src/machine/helpers.ts` (modify `handleStageError` block path)

- [ ] **Step 1: Read handleStageError block path**

Read `apps/server/src/machine/helpers.ts` lines 234-251 -- the final block transition in handleStageError.

- [ ] **Step 2: Add compensation execution before the block transition actions**

Add import if not already present:

```typescript
import { getGitHead, runCompensation } from "./git-checkpoint.js";
```

In `handleStageError`, modify the final block transition (the `{ target: blockedTarget, actions: [...] }` block starting around line 234). Add a compensation action at the beginning of the actions array:

The current block actions start with:
```typescript
    {
      target: blockedTarget,
      actions: [
        assign(({ event }: ErrorActionArgs) => {
```

Change to:
```typescript
    {
      target: blockedTarget,
      actions: [
        ({ context }: { context: WorkflowContext }) => {
          const stageConfig = context.config?.pipeline?.stages
            ? (flattenStages(context.config.pipeline.stages) as any[]).find((s: any) => s.name === stateName)
            : undefined;
          const compensation = stageConfig?.runtime?.compensation;
          if (compensation?.strategy && compensation.strategy !== "none") {
            const meta = context.stageCheckpoints?.[stateName] as { gitHead?: string } | undefined;
            const result = runCompensation(compensation.strategy, meta?.gitHead, context.worktreePath);
            if (result.success) {
              taskLogger(context.taskId).info({ stage: stateName, strategy: compensation.strategy }, "compensation executed successfully");
            } else {
              taskLogger(context.taskId).warn({ stage: stateName, error: result.error }, "compensation failed (non-blocking)");
            }
          }
        },
        assign(({ event }: ErrorActionArgs) => {
```

Note: You need to add imports for `flattenStages` and `taskLogger` if they are not already imported in helpers.ts. Check what's already imported.

- [ ] **Step 3: Run related tests**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/__integration__/retry-lifecycle.test.ts src/__integration__/task-lifecycle.test.ts`
Expected: All existing tests pass

- [ ] **Step 4: Type check**

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/machine/helpers.ts
git commit -m "feat: execute git compensation on stage failure block path"
```

---

### Task 5: Enhance RETRY_FROM to run compensation before retry

**Files:**
- Modify: `apps/server/src/machine/machine.ts`

- [ ] **Step 1: Read the RETRY_FROM handler**

Read `apps/server/src/machine/machine.ts` lines 244-270 to see the current RETRY_FROM handler.

- [ ] **Step 2: Add compensation to RETRY_FROM actions**

In the RETRY_FROM handler, inside the `actions: assign(...)` block, add a compensation action BEFORE the assign. The current structure for each retryable stage is:

```typescript
{
  target: childToGroup.get(s) ?? s,
  guard: ({ event }) => event.fromStage === s,
  actions: assign(({ context }) => { ... }),
}
```

Change `actions` from a single assign to an array:

```typescript
{
  target: childToGroup.get(s) ?? s,
  guard: ({ event }: { event: { type: "RETRY_FROM"; fromStage: string } }) => event.fromStage === s,
  actions: [
    ({ context }: { context: WorkflowContext }) => {
      const stageConfig = context.config?.pipeline?.stages
        ? (flattenStages(context.config.pipeline.stages) as any[]).find((st: any) => st.name === s)
        : undefined;
      const compensation = stageConfig?.runtime?.compensation;
      if (compensation?.strategy && compensation.strategy !== "none") {
        const meta = context.stageCheckpoints?.[s] as { gitHead?: string } | undefined;
        if (meta?.gitHead) {
          const result = runCompensation(compensation.strategy, meta.gitHead, context.worktreePath);
          taskLogger(context.taskId).info({ stage: s, strategy: compensation.strategy, success: result.success }, "RETRY_FROM compensation");
        }
      }
    },
    assign(({ context }: { context: WorkflowContext }) => {
      // ... existing assign logic unchanged ...
    }),
  ],
}
```

Add imports at top of machine.ts:

```typescript
import { runCompensation } from "./git-checkpoint.js";
```

(`flattenStages` and `taskLogger` should already be imported in machine.ts -- verify before adding.)

- [ ] **Step 3: Run related tests**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/__integration__/retry-lifecycle.test.ts src/__integration__/task-lifecycle.test.ts`
Expected: All existing tests pass

- [ ] **Step 4: Type check**

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/machine/machine.ts
git commit -m "feat: run compensation before RETRY_FROM enters target stage"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run`
Expected: All tests pass (same pre-existing failures only)

- [ ] **Step 2: Type check**

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 3: Verify stageCheckpoints are populated**

Search the codebase to confirm `stageCheckpoints` is being written in the statusEntry function and the field exists in the WorkflowContext type definition.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: stage git checkpoint + compensation - complete

Records git HEAD at stage entry in stageCheckpoints context field.
Optional compensation config in YAML:
  compensation:
    strategy: git_reset | git_stash | none

Compensation runs automatically on:
- Stage failure (block transition)
- RETRY_FROM targeting a stage with compensation

Best-effort: git failures are logged but never block error handling."
```
