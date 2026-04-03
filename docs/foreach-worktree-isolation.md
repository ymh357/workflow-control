# Foreach Worktree Isolation

## Goal

Add `isolation?: "shared" | "worktree"` to foreach stages. When `isolation: "worktree"`, each foreach item gets its own git worktree (branched from the parent branch). Sub-pipeline agents work in isolated directories with no file conflicts. After all items complete, worktree directories are cleaned up but item branches are preserved. A downstream agent stage merges/integrates the branches with full code context.

## Current Behavior

- `foreach-executor.ts` passes the parent `context.worktreePath` to every sub-pipeline via `pipeline-executor.ts:55`
- All concurrent sub-tasks write to the same directory — file conflicts when `max_concurrency > 1`
- Default `isolation` is `"shared"` (current behavior, backward compatible)

## Design

### YAML Interface

```yaml
- name: refactorFeatures
  type: foreach
  runtime:
    engine: foreach
    items: refactorPlan.featureTasks
    item_var: current_task
    pipeline_name: feature-refactor-sub
    max_concurrency: 3
    isolation: worktree          # each item gets its own worktree + branch
    auto_commit: true            # auto commit item branch on completion (default true)
    collect_to: featureResults
    item_writes:
      - refactorResult
    on_item_error: continue

- name: integrate
  type: agent
  runtime:
    engine: llm
    system_prompt: integrate
    reads:
      features: featureResults   # results include __branch per item
    writes: [integrationResult]
  # This agent merges item branches into the parent branch with full code context
```

### New Fields on `ForeachRuntimeConfig`

```typescript
// apps/server/src/lib/config/types.ts
export interface ForeachRuntimeConfig {
  engine: "foreach";
  items: string;
  item_var: string;
  max_concurrency?: number;
  pipeline_name: string;
  collect_to?: string;
  item_writes?: string[];
  on_item_error?: "fail_fast" | "continue";
  isolation?: "shared" | "worktree";    // default "shared"
  auto_commit?: boolean;                 // default true when isolation=worktree
}
```

### Execution Flow (isolation: "worktree")

For each item at index `idx`:

1. **Create temp branch**: from the parent worktree's current HEAD
2. **Create worktree**: `git worktree add -b <branch> <path> <parent-branch>`
3. **Run sub-pipeline**: pass the new worktree path + branch name to the child task
4. **On success + auto_commit**:
   - `git add -A && git commit -m "foreach item <idx>: <item_label>"` in the item worktree
   - Record `__branch` in the result
5. **On failure**: record `__error` (and `__branch` if worktree was created)
6. **After ALL items complete** (cleanup phase):
   - Remove all worktree directories (`git worktree remove --force`)
   - **Preserve all item branches** — downstream agent stage will merge them
7. **Downstream agent stage**:
   - Reads collected results with `__branch` per item
   - Merges branches into parent with full code context (can resolve conflicts intelligently)

### Files Changed

#### 1. `apps/server/src/lib/config/types.ts`
- Added `isolation`, `auto_commit` to `ForeachRuntimeConfig`

#### 2. `apps/server/src/lib/config/schema.ts`
- Added the two new optional fields to `ForeachRuntimeConfigSchema`

#### 3. `apps/server/src/lib/git.ts`
- `createWorktreeFromExisting(parentWorktreePath, branchSuffix, worktreesBase?)`:
  - Resolves the repo root via `git rev-parse --show-toplevel`
  - Creates a new branch + worktree from the parent branch HEAD
  - Returns `{ worktreePath, branchName, repoRoot }`
- `commitAll(worktreePath, message)`:
  - `git add -A && git diff --cached --quiet || git commit -m <message>`
  - Returns boolean (true if committed)
- `cleanupWorktreeOnly(repoPath, worktreePath)`:
  - `git worktree remove --force <worktreePath>`
  - Does NOT delete the branch

#### 4. `apps/server/src/agent/foreach-executor.ts`
- When `runtime.isolation === "worktree"`:
  - Validates `context.worktreePath` exists
  - Per item: creates isolated worktree, overrides `itemContext.worktreePath` and `itemContext.branch`
  - On item success + auto_commit: commits changes in item worktree
  - Includes `__branch` in each item's collected result
  - In finally block: cleans up all worktree directories (preserves branches)
- When `isolation` is `"shared"` or undefined: zero behavior change

### Edge Cases

1. **Parent has no worktreePath**: throws clear error
2. **Empty items array**: returns immediately with empty results
3. **All items fail**: cleanup still happens
4. **Partial failure with on_item_error: continue**: failed items include `__error` + `__branch`
5. **Branch naming**: `<parent-branch>-foreach-<stageName>-<idx>-<timestamp>` to avoid collisions

### Backward Compatibility

- Default `isolation` is `undefined` which means `"shared"` — all existing pipelines work unchanged
- No changes to `pipeline-executor.ts`, state machine, or XState types
