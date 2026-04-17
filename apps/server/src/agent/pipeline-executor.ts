// Executor for Pipeline Call stages — creates a sub-task and waits for it to complete.

import { createTaskDraft, launchTask, getWorkflow, sendEvent } from "../machine/actor-registry.js";
import { cancelTask } from "./query-tracker.js";
import { taskLogger } from "../lib/logger.js";
import type { WorkflowContext } from "../machine/types.js";
import type { PipelineCallRuntimeConfig } from "../lib/config-loader.js";
import { getNestedValue } from "../lib/config-loader.js";
import { validatePipelineConfig } from "../lib/config/schema.js";
import { validatePipelineLogic, getValidationErrors } from "@workflow-control/shared";
import { buildInlinePipelineConfig } from "../machine/inline-pipeline-config.js";
import type { PipelineConfig } from "../lib/config/types.js";

const DEFAULT_TIMEOUT_SEC = 1800;
const MAX_PIPELINE_DEPTH = 3;

export interface PipelineCallInput {
  taskId: string;
  stageName: string;
  context: WorkflowContext;
  runtime: PipelineCallRuntimeConfig;
}

/**
 * Runs a sub-pipeline as an independent sub-task and waits for completion.
 * Returns an object of store updates to merge into the parent store.
 */
export async function runPipelineCall(
  _taskId: string,
  input: PipelineCallInput,
): Promise<Record<string, any>> {
  const { taskId: parentTaskId, stageName, context, runtime } = input;
  const log = taskLogger(parentTaskId);

  // Guard against unbounded recursive pipeline calls
  const depth = (parentTaskId.match(/-sub-/g) ?? []).length;
  if (depth >= MAX_PIPELINE_DEPTH) {
    throw new Error(`Pipeline call depth ${depth + 1} exceeds maximum (${MAX_PIPELINE_DEPTH}). Check for recursive pipeline references.`);
  }

  // Resolve pipeline: from filesystem config or from parent store
  let resolvedPipelineName: string | undefined = runtime.pipeline_name;
  let inlineConfig: NonNullable<WorkflowContext["config"]> | undefined;

  if (runtime.pipeline_source !== "store" && !runtime.pipeline_name) {
    throw new Error(`Pipeline call in "${stageName}" requires pipeline_name (or pipeline_source: "store" with pipeline_key)`);
  }

  if (runtime.pipeline_source === "store") {
    const pipelineKey = runtime.pipeline_key;
    if (!pipelineKey) {
      throw new Error(`Pipeline call in "${stageName}" has pipeline_source: "store" but no pipeline_key`);
    }
    const pipelineDef = getNestedValue(context.store, pipelineKey);
    if (!pipelineDef || typeof pipelineDef !== "object") {
      throw new Error(`Store key "${pipelineKey}" does not contain a valid pipeline definition`);
    }

    // Validate the store-sourced pipeline definition
    const validation = validatePipelineConfig(pipelineDef);
    if (!validation.success) {
      const errMsg = validation.errors?.issues?.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Store-sourced pipeline "${pipelineKey}" failed schema validation: ${errMsg}`);
    }
    const validatedPipeline = validation.data as PipelineConfig;

    const logicIssues = validatePipelineLogic(
      validatedPipeline.stages as any,
      undefined,
      undefined,
      undefined,
      (validatedPipeline as any).store_schema,
    );
    const logicErrors = getValidationErrors(logicIssues);
    if (logicErrors.length > 0) {
      const errMsg = logicErrors.map((e) => `${e.field ? `[${e.field}] ` : ""}${e.message}`).join("; ");
      throw new Error(`Store-sourced pipeline "${pipelineKey}" failed logical validation: ${errMsg}`);
    }

    inlineConfig = buildInlinePipelineConfig(validatedPipeline, context.config);
    resolvedPipelineName = validatedPipeline.name;
    log.info({ pipelineKey, name: resolvedPipelineName }, "Resolved store-sourced pipeline definition");
  }

  // Build child initial store from reads mapping
  const childInitialStore: Record<string, any> = {};
  if (runtime.reads) {
    for (const [childKey, rawPath] of Object.entries(runtime.reads)) {
      // Strip "store." prefix if present (YAML convention uses store.xxx for consistency with condition expressions)
      const parentPath = rawPath.startsWith("store.") ? rawPath.slice(6) : rawPath;
      const value = getNestedValue(context.store, parentPath);
      if (value !== undefined) {
        childInitialStore[childKey] = value;
      }
    }
  }

  const childTaskId = `${parentTaskId}-sub-${stageName}-${Date.now()}`;
  const timeoutMs = (runtime.timeout_sec ?? DEFAULT_TIMEOUT_SEC) * 1000;

  log.info({ childTaskId, stageName, pipelineName: resolvedPipelineName ?? runtime.pipeline_name }, "Launching sub-pipeline");

  // Inherit edge execution mode from parent so sub-pipeline's agent stages
  // create edge slots that the edge runner can pick up and execute.
  const isParentEdge = context.config?.pipeline?.default_execution_mode === "edge";

  createTaskDraft(
    childTaskId,
    undefined,
    resolvedPipelineName ?? runtime.pipeline_name,
    context.taskText,
    {
      initialStore: childInitialStore,
      worktreePath: context.worktreePath,
      branch: context.branch,
      edge: isParentEdge,
      inlineConfig,
    },
  );
  launchTask(childTaskId);

  // Wait for child completion via subscription (replaces polling)
  const storeUpdates = await new Promise<Record<string, any>>((resolve, reject) => {
    let sub: { unsubscribe(): void } | undefined;
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      sub?.unsubscribe();
      log.warn({ childTaskId }, "Sub-pipeline timed out, cancelling child task");
      cancelChildTask(childTaskId, log);
      reject(new Error(`Sub-pipeline ${childTaskId} timed out after ${runtime.timeout_sec ?? DEFAULT_TIMEOUT_SEC}s`));
    }, timeoutMs);

    const childActor = getWorkflow(childTaskId);
    if (!childActor) {
      clearTimeout(timeout);
      reject(new Error(`Sub-pipeline actor ${childTaskId} disappeared unexpectedly`));
      return;
    }

    sub = childActor.subscribe((snap) => {
      if (settled) return;
      const status = snap.context.status;

      if (status === "completed") {
        settled = true;
        clearTimeout(timeout);
        sub?.unsubscribe();
        log.info({ childTaskId }, "Sub-pipeline completed");
        const updates: Record<string, any> = {};
        if (runtime.writes?.length) {
          for (const w of runtime.writes) {
            const key = typeof w === "string" ? w : w.key;
            if (snap.context.store[key] !== undefined) {
              updates[key] = snap.context.store[key];
            }
          }
        }
        resolve(updates);
      } else if (status === "error" || status === "cancelled" || status === "blocked") {
        settled = true;
        clearTimeout(timeout);
        sub?.unsubscribe();
        const errMsg = snap.context.error ?? `Sub-pipeline ${childTaskId} ended with status: ${status}`;
        log.error({ childTaskId, status, error: errMsg }, "Sub-pipeline failed");
        reject(new Error(errMsg));
      }
    });
  });

  return storeUpdates;
}

/**
 * Best-effort cancel a child sub-task. Sends CANCEL event and kills the agent process.
 * Failures are logged but never propagated — this is cleanup code.
 */
function cancelChildTask(childTaskId: string, log: ReturnType<typeof taskLogger>): void {
  try {
    sendEvent(childTaskId, { type: "CANCEL" });
    cancelTask(childTaskId);
  } catch (err) {
    log.warn({ childTaskId, err: err instanceof Error ? err.message : String(err) }, "Failed to cancel child task (best-effort)");
  }
}
