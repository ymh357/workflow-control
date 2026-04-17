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
import { flattenStages } from "../lib/config/types.js";
import type { PipelineConfig } from "../lib/config/types.js";

const DEFAULT_TIMEOUT_SEC = 1800;
const MAX_PIPELINE_DEPTH = 3;

// Depth counter sentinel key in initialStore. Using a store key rather than a
// dedicated WorkflowContext field avoids a cascade of type/persistence
// changes — the key is filtered out on sub-pipeline completion.
const DEPTH_STORE_KEY = "__pipeline_depth";

// Security limits for store-sourced pipelines. These pipelines are generated
// by LLMs (phase planner) and thus untrusted — treat their config as input
// data, not code. Limits protect against prompt-injection-driven escalation.
const MAX_INLINE_PROMPT_BYTES = 8 * 1024; // 8KB per prompt
const MAX_TOTAL_INLINE_PROMPTS_BYTES = 64 * 1024; // 64KB aggregate
const STORE_SOURCED_DISALLOWED_STAGE_TYPES = new Set([
  "script",    // arbitrary code execution via registered scripts
  "pipeline",  // prevents nested store-sourced pipelines
  "foreach",   // iterates a sub-pipeline, same risk as "pipeline"
]);

/**
 * Validate safety constraints for a store-sourced (LLM-generated) pipeline.
 * Throws on any violation — the call stage will surface the error to the parent.
 */
function validateStoreSourcedPipelineSafety(
  pipeline: PipelineConfig,
  parentMcps: string[],
): void {
  // Size checks on inline_prompts
  if (pipeline.inline_prompts) {
    let total = 0;
    for (const [key, content] of Object.entries(pipeline.inline_prompts)) {
      const bytes = Buffer.byteLength(content, "utf-8");
      if (bytes > MAX_INLINE_PROMPT_BYTES) {
        throw new Error(
          `Store-sourced pipeline: inline_prompts.${key} is ${bytes} bytes, exceeds limit of ${MAX_INLINE_PROMPT_BYTES} bytes`,
        );
      }
      total += bytes;
    }
    if (total > MAX_TOTAL_INLINE_PROMPTS_BYTES) {
      throw new Error(
        `Store-sourced pipeline: inline_prompts total ${total} bytes exceeds aggregate limit of ${MAX_TOTAL_INLINE_PROMPTS_BYTES} bytes`,
      );
    }
  }

  // Stage-type allowlist
  for (const stage of flattenStages(pipeline.stages)) {
    if (STORE_SOURCED_DISALLOWED_STAGE_TYPES.has(stage.type)) {
      throw new Error(
        `Store-sourced pipeline: stage "${stage.name}" uses disallowed type "${stage.type}". ` +
          `Store-sourced pipelines may only use agent/human_confirm/condition/llm_decision stages.`,
      );
    }
  }

  // MCP allowlist — children may only use MCPs the parent already trusts
  const parentMcpSet = new Set(parentMcps);
  for (const stage of flattenStages(pipeline.stages)) {
    for (const mcp of stage.mcps ?? []) {
      if (!parentMcpSet.has(mcp)) {
        throw new Error(
          `Store-sourced pipeline: stage "${stage.name}" references MCP "${mcp}" ` +
            `which is not declared by the parent pipeline. Only parent-declared MCPs are allowed.`,
        );
      }
    }
  }
}

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

  // Guard against unbounded recursive pipeline calls. Depth is tracked in the
  // parent's store via a sentinel key rather than a substring match on taskId
  // (which was fragile — stage names containing "-sub-" would inflate depth).
  const parentDepth = typeof context.store?.[DEPTH_STORE_KEY] === "number"
    ? (context.store[DEPTH_STORE_KEY] as number)
    : 0;
  if (parentDepth >= MAX_PIPELINE_DEPTH) {
    throw new Error(
      `Pipeline call depth ${parentDepth + 1} exceeds maximum (${MAX_PIPELINE_DEPTH}). Check for recursive pipeline references.`,
    );
  }
  const childDepth = parentDepth + 1;

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

    // Safety constraints — store-sourced pipelines are LLM-generated (untrusted).
    validateStoreSourcedPipelineSafety(validatedPipeline, context.config?.mcps ?? []);

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
  // Propagate depth to the child so nested pipeline calls stack correctly.
  childInitialStore[DEPTH_STORE_KEY] = childDepth;

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

    // A sub-pipeline containing only synchronous transitions (script + condition
    // stages, always-transitions, etc.) can complete within the same microtask
    // as launchTask(). XState v5's subscribe only delivers *future* snapshots,
    // so we must check the current snapshot before subscribing — otherwise the
    // promise hangs until the 1800s timeout.
    const settleFromSnapshot = (ctx: { status?: string; store?: Record<string, any>; error?: string }): boolean => {
      const status = ctx.status;
      if (status === "completed") {
        settled = true;
        clearTimeout(timeout);
        log.info({ childTaskId }, "Sub-pipeline completed");
        const updates: Record<string, any> = {};
        if (runtime.writes?.length) {
          for (const w of runtime.writes) {
            const key = typeof w === "string" ? w : w.key;
            const val = ctx.store?.[key];
            if (val !== undefined) updates[key] = val;
          }
        }
        resolve(updates);
        return true;
      }
      if (status === "error" || status === "cancelled" || status === "blocked") {
        settled = true;
        clearTimeout(timeout);
        const errMsg = ctx.error ?? `Sub-pipeline ${childTaskId} ended with status: ${status}`;
        log.error({ childTaskId, status, error: errMsg }, "Sub-pipeline failed");
        reject(new Error(errMsg));
        return true;
      }
      return false;
    };

    sub = childActor.subscribe((snap) => {
      if (settled) return;
      if (settleFromSnapshot(snap.context as any)) sub?.unsubscribe();
    });

    // After subscribing, re-check current snapshot in case the child already
    // reached a terminal state before subscribe() attached.
    const currentSnap = childActor.getSnapshot();
    if (settleFromSnapshot(currentSnap.context as any)) {
      sub?.unsubscribe();
    }
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
