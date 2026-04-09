// Executor for Foreach stages — iterates over a store array and calls a sub-pipeline per item.

import { taskLogger } from "../lib/logger.js";
import type { WorkflowContext } from "../machine/types.js";
import type { ForeachRuntimeConfig } from "../lib/config-loader.js";
import { getNestedValue } from "../lib/config-loader.js";
import { runPipelineCall } from "./pipeline-executor.js";
import type { PipelineCallRuntimeConfig } from "../lib/config-loader.js";
import { getAllWorkflows, sendEvent } from "../machine/actor-registry.js";
import { cancelTask } from "./query-tracker.js";
import {
  createWorktreeFromExisting,
  commitAll,
  cleanupWorktreeOnly,
  getDiffStat,
} from "../lib/git.js";

export interface ForeachInput {
  taskId: string;
  stageName: string;
  context: WorkflowContext;
  runtime: ForeachRuntimeConfig;
}

interface ItemWorktreeInfo {
  worktreePath: string;
  branchName: string;
  repoRoot: string;
}

async function runWithConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  abortSignal?: { aborted: boolean },
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < tasks.length && !abortSignal?.aborted) {
      const index = nextIndex++;
      results[index] = await tasks[index]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

/**
 * Runs a foreach stage: iterates over a store array, spawning a sub-pipeline per item.
 *
 * When isolation is "worktree", each item gets its own git worktree + branch.
 * After all items complete, worktree directories are cleaned up but branches are
 * preserved. The collected results include `__branch` for each item so that a
 * downstream agent stage can merge/integrate them with full context.
 *
 * Returns store updates (the collected results array under collect_to).
 */
export async function runForeach(
  _taskId: string,
  input: ForeachInput,
): Promise<Record<string, any>> {
  const { taskId: parentTaskId, stageName, context, runtime } = input;
  const log = taskLogger(parentTaskId);

  // Resolve items array from store
  // Strip "store." prefix if present (YAML convention uses store.xxx for consistency with condition expressions)
  const itemsPath = runtime.items.startsWith("store.") ? runtime.items.slice(6) : runtime.items;
  const items = getNestedValue(context.store, itemsPath);
  if (!Array.isArray(items)) {
    throw new Error(`Foreach stage "${stageName}": items path "${runtime.items}" must resolve to an array (got ${typeof items})`);
  }

  if (items.length === 0) {
    log.info({ stageName }, "Foreach: empty items array, returning immediately");
    if (runtime.collect_to) {
      const collectKey = runtime.collect_to.startsWith("store.") ? runtime.collect_to.slice(6) : runtime.collect_to;
      return { [collectKey]: [] };
    }
    return {};
  }

  const useWorktreeIsolation = runtime.isolation === "worktree";

  if (useWorktreeIsolation && !context.worktreePath) {
    throw new Error(
      `Foreach stage "${stageName}": worktree isolation requires a parent worktree — ensure a git_worktree stage runs before this foreach`,
    );
  }

  log.info(
    { stageName, itemCount: items.length, pipelineName: runtime.pipeline_name, isolation: runtime.isolation ?? "shared" },
    "Starting foreach iteration",
  );

  const maxConcurrency = runtime.max_concurrency ?? 1;
  const onItemError = runtime.on_item_error ?? "fail_fast";
  const abortSignal = { aborted: false };
  const autoCommit = runtime.auto_commit !== false;
  const timestamp = Date.now();

  // Track worktree info for cleanup
  const itemWorktrees: (ItemWorktreeInfo | null)[] = new Array(items.length).fill(null);

  // Build sub-task factory for each item
  const itemTasks = items.map((item, idx) => async (): Promise<Record<string, any>> => {
    const subStageName = `${stageName}-item-${idx}`;

    // Pass parent reads + item_var into sub-pipeline so child initial store
    // contains both the foreach item and any parent store data the sub-pipeline needs.
    const subReads: Record<string, string> = { ...(runtime.reads ?? {}) };
    subReads[runtime.item_var] = runtime.item_var;

    const callRuntime: PipelineCallRuntimeConfig = {
      engine: "pipeline",
      pipeline_name: runtime.pipeline_name,
      reads: subReads,
      writes: runtime.item_writes,
      timeout_sec: undefined,
    };

    // Build a context copy with the item injected into the store
    const itemLabel = typeof item === "string" ? item : JSON.stringify(item).slice(0, 200);
    const itemContext: WorkflowContext = {
      ...context,
      taskText: context.taskText
        ? `${context.taskText} [foreach item ${idx}: ${itemLabel}]`
        : `Foreach item ${idx}: ${itemLabel}`,
      foreachMeta: { itemVar: runtime.item_var, parentTaskId, itemIndex: idx },
      store: {
        ...context.store,
        [runtime.item_var]: item,
      },
    };

    // If worktree isolation, create an isolated worktree for this item
    if (useWorktreeIsolation) {
      const branchSuffix = `foreach-${stageName}-${idx}-${timestamp}`;
      try {
        const wt = await createWorktreeFromExisting(context.worktreePath!, branchSuffix);
        itemWorktrees[idx] = {
          worktreePath: wt.worktreePath,
          branchName: wt.branchName,
          repoRoot: wt.repoRoot,
        };
        itemContext.worktreePath = wt.worktreePath;
        itemContext.branch = wt.branchName;
        log.info({ stageName, idx, branchName: wt.branchName, worktreePath: wt.worktreePath }, "Created item worktree");
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error({ stageName, idx, error: errMsg }, "Failed to create item worktree");
        if (onItemError === "fail_fast") {
          abortSignal.aborted = true;
          throw err;
        }
        return { __error: `worktree creation failed: ${errMsg}` };
      }
    }

    try {
      const result = await runPipelineCall("", {
        taskId: parentTaskId,
        stageName: subStageName,
        context: itemContext,
        runtime: callRuntime,
      });

      // Auto-commit in item worktree on success
      let diffInfo: { filesChanged: string[]; diffStat: string } | undefined;
      if (useWorktreeIsolation && autoCommit && itemWorktrees[idx]) {
        const itemLabel = typeof item === "string" ? item : `item-${idx}`;
        const committed = await commitAll(
          itemWorktrees[idx]!.worktreePath,
          `foreach item ${idx}: ${itemLabel}`,
        );
        log.info({ stageName, idx, committed }, "Auto-commit in item worktree");

        // Capture diff info for downstream merge agents
        if (committed && context.branch) {
          try {
            diffInfo = await getDiffStat(itemWorktrees[idx]!.worktreePath, context.branch);
          } catch (err) {
            log.warn({ stageName, idx, err: err instanceof Error ? err.message : String(err) }, "Failed to capture diff info");
          }
        }
      }

      // Pick only item_writes fields
      if (runtime.item_writes?.length) {
        const picked: Record<string, any> = {};
        for (const key of runtime.item_writes) {
          if (result[key] !== undefined) picked[key] = result[key];
        }
        if (useWorktreeIsolation && itemWorktrees[idx]) {
          picked.__branch = itemWorktrees[idx]!.branchName;
          if (diffInfo) {
            picked.__filesChanged = diffInfo.filesChanged;
            picked.__diffStat = diffInfo.diffStat;
          }
        }
        return picked;
      }
      const out: Record<string, any> = { ...result };
      if (useWorktreeIsolation && itemWorktrees[idx]) {
        out.__branch = itemWorktrees[idx]!.branchName;
        if (diffInfo) {
          out.__filesChanged = diffInfo.filesChanged;
          out.__diffStat = diffInfo.diffStat;
        }
      }
      return out;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn({ stageName, idx, error: errMsg }, "Foreach item failed");
      if (onItemError === "fail_fast") {
        abortSignal.aborted = true;
        throw err;
      }
      const errResult: Record<string, any> = { __error: errMsg };
      if (useWorktreeIsolation && itemWorktrees[idx]) {
        errResult.__branch = itemWorktrees[idx]!.branchName;
      }
      return errResult;
    }
  });

  let collectedResults: Record<string, any>[];
  try {
    collectedResults = await runWithConcurrencyLimit(itemTasks, maxConcurrency, abortSignal);
  } finally {
    // Cleanup worktree directories but preserve branches —
    // downstream agent stages will merge/integrate them with full context
    if (useWorktreeIsolation) {
      for (const wt of itemWorktrees) {
        if (!wt) continue;
        try {
          await cleanupWorktreeOnly(wt.repoRoot, wt.worktreePath);
        } catch (err) {
          log.warn({ err, branch: wt.branchName }, "Failed to remove item worktree");
        }
      }
    }
  }

  // Cleanup: cancel any sub-tasks that are still running or blocked.
  // This handles cases where items timed out (on_item_error: continue) but the
  // sub-task actor was left dangling in running/blocked state.
  cleanupDanglingSubTasks(parentTaskId, stageName, log);

  log.info({ stageName, itemCount: items.length }, "Foreach iteration complete");

  // Detect file overlap between items for downstream merge agents
  if (useWorktreeIsolation) {
    const itemFiles: string[][] = collectedResults.map(
      (r) => (r.__filesChanged as string[] | undefined) ?? [],
    );
    for (let i = 0; i < collectedResults.length; i++) {
      const overlaps: { item: number; files: string[] }[] = [];
      for (let j = 0; j < collectedResults.length; j++) {
        if (i === j) continue;
        const shared = itemFiles[i].filter((f) => itemFiles[j].includes(f));
        if (shared.length > 0) overlaps.push({ item: j, files: shared });
      }
      if (overlaps.length > 0) {
        collectedResults[i].__conflictRisk = true;
        collectedResults[i].__overlapsWithItems = overlaps;
      }
    }
  }

  if (runtime.collect_to) {
    // Strip "store." prefix if present
    const collectKey = runtime.collect_to.startsWith("store.") ? runtime.collect_to.slice(6) : runtime.collect_to;
    return { [collectKey]: collectedResults };
  }
  return {};
}

/**
 * Best-effort cleanup of sub-tasks spawned by this foreach that are still in a
 * non-terminal state (running, blocked, etc.). Matches sub-task IDs by the
 * convention used in pipeline-executor: `{parentTaskId}-sub-{stageName}-item-{idx}-{timestamp}`.
 */
function cleanupDanglingSubTasks(
  parentTaskId: string,
  stageName: string,
  log: ReturnType<typeof taskLogger>,
): void {
  const prefix = `${parentTaskId}-sub-${stageName}-item-`;
  const terminalStates = new Set(["completed", "error", "cancelled"]);
  let cleaned = 0;

  for (const [taskId, actor] of getAllWorkflows()) {
    if (!taskId.startsWith(prefix)) continue;
    const status = actor.getSnapshot().context?.status;
    if (status && !terminalStates.has(status)) {
      try {
        sendEvent(taskId, { type: "CANCEL" });
        cancelTask(taskId);
        cleaned++;
      } catch (err) {
        log.warn({ taskId, err: err instanceof Error ? err.message : String(err) }, "Failed to cancel dangling sub-task");
      }
    }
  }

  if (cleaned > 0) {
    log.info({ stageName, cleaned }, "Cleaned up dangling sub-tasks");
  }
}
