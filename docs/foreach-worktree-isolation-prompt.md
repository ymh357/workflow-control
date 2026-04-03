# Prompt: Implement Foreach Worktree Isolation

Read the spec at `docs/foreach-worktree-isolation.md` first, then implement it.

## Summary

Add `isolation?: "shared" | "worktree"` to foreach stages. When `isolation: "worktree"`, each foreach item gets its own git worktree branched from the parent. Agents work in isolation. After all items complete, worktree directories are cleaned up but item branches are preserved. A downstream agent stage merges/integrates the branches with full code context.

## Implementation Order

1. **Types + Schema** — Add `isolation`, `auto_commit` to `ForeachRuntimeConfig` in `apps/server/src/lib/config/types.ts` and `ForeachRuntimeConfigSchema` in `apps/server/src/lib/config/schema.ts`

2. **Git helpers** — Add functions to `apps/server/src/lib/git.ts`:
   - `createWorktreeFromExisting(parentWorktreePath, branchSuffix, worktreesBase?)` — resolves repo root via `git rev-parse --show-toplevel`, creates branch + worktree, returns `{ worktreePath, branchName, repoRoot }`
   - `commitAll(worktreePath, message)` — git add -A + commit if there are changes, returns boolean
   - `cleanupWorktreeOnly(repoPath, worktreePath)` — remove worktree directory only, preserve branch

3. **Foreach executor** — Modify `apps/server/src/agent/foreach-executor.ts`:
   - When `runtime.isolation === "worktree"`: before each item, create isolated worktree; override `itemContext.worktreePath` and `itemContext.branch`; after item success, auto-commit; include `__branch` in results; in finally block, cleanup worktree directories (preserve branches)
   - When `isolation` is `"shared"` or undefined: zero behavior change

4. **Tests** — Add tests covering: worktree creation per item, auto-commit, cleanup on failure, default "shared" backward compat, schema validation of new fields.

## Key Constraints

- **Backward compatible**: default isolation is "shared", existing pipelines unchanged
- **No changes to**: `pipeline-executor.ts`, state machine, XState types, `machine/types.ts`
- **No merge in foreach**: branches are preserved for downstream agent stages to merge with full context
- **Cleanup is critical**: worktree directories must be cleaned up in a finally block, even on errors
- **Branch naming**: `<parent-branch>-foreach-<stageName>-<idx>-<timestamp>` to avoid collisions
- **Empty items**: return immediately, no worktrees created
- **No worktreePath on parent**: throw clear error if `isolation: "worktree"` but `context.worktreePath` is empty

## Verification

After implementation:
1. `cd apps/server && npx tsc --noEmit` — zero new errors
2. `cd apps/server && npx vitest run` — all tests pass including new ones
3. The new fields are accepted by pipeline YAML validation
4. Existing foreach tests still pass (backward compat)
