import { assign, emit } from "xstate";
import { Parser } from "expr-eval";
import type { TokenUsage, StageTokenUsage } from "@workflow-control/shared";
import type { WorkflowContext, WorkflowEvent } from "./types.js";
import type { WorkflowEmittedEvent } from "./events.js";
import { buildTier1Context } from "../agent/context-builder.js";
import {
  statusEntry, emitStatus, emitTaskListUpdate, emitPersistSession, getLatestSessionId,
  handleStageError,
} from "./helpers.js";
import { logger, taskLogger } from "../lib/logger.js";
import type { AgentStageConfig, AgentRuntimeConfig, ScriptStageConfig, HumanGateRuntimeConfig, PipelineStageConfig, ConditionStageConfig, PipelineCallStageConfig, ForeachStageConfig, LlmDecisionStageConfig } from "../lib/config-loader.js";
import { getNestedValue } from "../lib/config-loader.js";
import { extractJSON } from "../lib/json-extractor.js";
import { getStageBuilder } from "./stage-registry.js";
import { formatVerifyFailures } from "../agent/verify-commands.js";
import { evaluateAssertions, formatAssertionFeedback } from "./assertion-evaluator.js";

type WriteDeclaration = string | { key: string; strategy?: string; summary_prompt?: string; assertions?: string[] };

const parseCache = new WeakMap<object, Record<string, unknown> | null>();

function getCachedParse(output: Record<string, any>): Record<string, unknown> | null {
  if (parseCache.has(output)) return parseCache.get(output)!;
  try {
    const parsed = extractJSON(output.resultText);
    parseCache.set(output, parsed);
    return parsed;
  } catch {
    parseCache.set(output, null);
    return null;
  }
}

/**
 * Filter store writes to only include keys declared in the stage's `writes` config.
 * Undeclared keys are logged as warnings and dropped.
 */
function filterStoreWrites(
  parsed: Record<string, unknown>,
  declaredWrites: WriteDeclaration[] | undefined,
  stageName: string,
  taskId: string,
): Record<string, unknown> {
  if (!declaredWrites || declaredWrites.length === 0) return parsed;
  const allowed = new Map<string, string>();
  for (const w of declaredWrites) {
    if (typeof w === "string") {
      allowed.set(w, "replace");
    } else {
      allowed.set(w.key, w.strategy ?? "replace");
    }
  }
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (allowed.has(key)) {
      filtered[key] = value;
    } else {
      console.warn(`[store] Stage "${stageName}" wrote undeclared key "${key}" (task ${taskId.slice(0, 8)}). Dropping.`);
    }
  }
  return filtered;
}

function buildWriteStrategies(writes: WriteDeclaration[] | undefined): Map<string, string> {
  const strategies = new Map<string, string>();
  for (const w of writes ?? []) {
    if (typeof w === "string") strategies.set(w, "replace");
    else strategies.set(w.key, w.strategy ?? "replace");
  }
  return strategies;
}

function collectAssertions(writes: WriteDeclaration[] | undefined): Map<string, string[]> {
  const assertions = new Map<string, string[]>();
  for (const w of writes ?? []) {
    if (typeof w !== "string" && w.assertions?.length) {
      assertions.set(w.key, w.assertions);
    }
  }
  return assertions;
}

function applyStoreUpdates(
  store: Record<string, any>,
  updates: Record<string, any>,
  writeStrategies: Map<string, string>,
): void {
  for (const [key, value] of Object.entries(updates)) {
    const strategy = writeStrategies.get(key) ?? "replace";
    if (strategy === "append" && Array.isArray(store[key])) {
      store[key] = [...store[key], ...(Array.isArray(value) ? value : [value])];
    } else if (strategy === "merge" && typeof store[key] === "object" && store[key] !== null && typeof value === "object" && value !== null) {
      store[key] = { ...store[key], ...value };
    } else {
      store[key] = value;
    }
  }
}

export type StateNode = Record<string, unknown>;

// --- Per-stage retry tracking helpers (parallel-safe) ---

function getStageRetryCount(context: WorkflowContext, stageName: string): number {
  return context.stageRetryCount?.[stageName] ?? context.retryCount;
}

function incrementStageRetryCount(context: WorkflowContext, stageName: string): Record<string, number> {
  const current = context.stageRetryCount ?? {};
  return { ...current, [stageName]: (current[stageName] ?? 0) + 1 };
}

function resetStageRetryCount(context: WorkflowContext, stageName: string): Record<string, number> {
  const current = context.stageRetryCount ?? {};
  const { [stageName]: _, ...rest } = current;
  return rest;
}

function getVerifyRetryCount(context: WorkflowContext, stageName: string): number {
  return context.verifyRetryCount?.[stageName] ?? 0;
}

function incrementVerifyRetryCount(context: WorkflowContext, stageName: string): Record<string, number> {
  const current = context.verifyRetryCount ?? {};
  return { ...current, [stageName]: (current[stageName] ?? 0) + 1 };
}

// XState invoke onDone event shape. `output` is typed loosely because
// different engines (agent vs script) produce different result shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface DoneEvent { type: string; output: Record<string, any>; }

function accumulateTokenUsage(existing: TokenUsage | undefined, stage: StageTokenUsage | undefined): TokenUsage | undefined {
  if (!stage) return existing;
  if (!existing) return { inputTokens: stage.inputTokens, outputTokens: stage.outputTokens, cacheReadTokens: stage.cacheReadTokens, cacheCreationTokens: stage.cacheCreationTokens, totalTokens: stage.totalTokens };
  return {
    inputTokens: existing.inputTokens + stage.inputTokens,
    outputTokens: existing.outputTokens + stage.outputTokens,
    cacheReadTokens: existing.cacheReadTokens + stage.cacheReadTokens,
    cacheCreationTokens: (existing.cacheCreationTokens ?? 0) + (stage.cacheCreationTokens ?? 0) || undefined,
    totalTokens: existing.totalTokens + stage.totalTokens,
  };
}

// --- Unified Stage Builders ---

export function buildAgentState(
  nextTarget: string,
  _prevAgentTarget: string,
  stage: AgentStageConfig,
  opts?: { blockedTarget?: string; statePrefix?: string },
): StateNode {
  const stateName = stage.name;
  const { runtime } = stage;
  const statePrefix = opts?.statePrefix ?? "";

  return {
    entry: statusEntry(stateName),
    invoke: {
      src: stage.execution_mode === "edge" || stage.execution_mode === "any" ? "runEdgeAgent" : "runAgent",
      input: ({ context }: { context: WorkflowContext }) => {
        // For parallel children, merge own staged writes into store view
        const effectiveStore = opts?.statePrefix
          ? { ...context.store, ...(context.parallelStagedWrites?.[stateName] ?? {}) }
          : context.store;
        const effectiveContext = opts?.statePrefix ? { ...context, store: effectiveStore } : context;
        const stepsPath = runtime.enabled_steps_path;
        const enabledSteps = stepsPath ? getNestedValue(effectiveContext.store, stepsPath) : undefined;
        return {
          taskId: context.taskId,
          stageName: stateName,
          worktreePath: context.worktreePath ?? "",
          tier1Context: buildTier1Context(effectiveContext, runtime, runtime.tier1_max_tokens, stateName),
          enabledSteps,
          attempt: context.retryCount,
          resumeInfo: context.resumeInfo,
          interactive: stage.interactive,
          runtime,
          context: effectiveContext,
        };
      },
      onDone: [
        // Guard: retry if stage expects writes but output is empty or unparseable
        {
          guard: ({ event, context }: { event: { output: { resultText: string } }; context: WorkflowContext }) => {
            if ((runtime.writes?.length ?? 0) === 0) return false;
            if (getStageRetryCount(context, stateName) >= 2) return false;
            if (!event.output.resultText) return true;
            const parsed = getCachedParse(event.output);
            if (!parsed) return true;
            const writeKeys = runtime.writes!.map((w: WriteDeclaration) => typeof w === "string" ? w : w.key);
            return !writeKeys.every((field: string) => parsed[field] !== undefined);
          },
          target: stateName,
          reenter: true,
          actions: [
            assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
              const sessionId = event.output?.sessionId ?? context.stageSessionIds?.[stateName];
              const writeKeys = runtime.writes!.map((w: WriteDeclaration) => typeof w === "string" ? w : w.key);
              const priorFeedback = context.resumeInfo?.feedback
                ? `[Prior attempt failed: ${context.resumeInfo.feedback.slice(0, 300)}]\n\n`
                : "";
              return {
                retryCount: context.retryCount + 1,
                stageRetryCount: incrementStageRetryCount(context, stateName),
                totalCostUsd: (context.totalCostUsd ?? 0) + (event.output?.costUsd ?? 0),
                totalTokenUsage: accumulateTokenUsage(context.totalTokenUsage, event.output?.tokenUsage),
                stageTokenUsages: event.output?.tokenUsage ? { ...context.stageTokenUsages, [stateName]: event.output.tokenUsage } : context.stageTokenUsages,
                stageSessionIds: { ...context.stageSessionIds, [stateName]: event.output?.sessionId ?? context.stageSessionIds?.[stateName] },
                stageCwds: { ...context.stageCwds, ...(event.output?.cwd ? { [stateName]: event.output.cwd } : {}) },
                resumeInfo: sessionId
                  ? { sessionId, feedback: `${priorFeedback}Your previous output was missing the required JSON fields (expected: ${writeKeys.join(", ")}). You MUST output the required JSON object before finishing. Do NOT explain — just output the JSON now.` }
                  : undefined,
              };
            }),
            ({ context }: { context: WorkflowContext }) => {
              taskLogger(context.taskId).warn({ stage: stateName, retryCount: context.retryCount }, "Output missing required fields, retrying with resume");
            },
            emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
              type: "wf.status",
              taskId: context.taskId,
              status: context.status,
              message: `${stateName}: output missing required fields, retrying (attempt ${context.retryCount})`,
            })),
          ],
        },
        // Guard: retry if assertions fail
        {
          guard: ({ event, context }: { event: { output: { resultText: string } }; context: WorkflowContext }) => {
            const assertionMap = collectAssertions(runtime.writes);
            if (assertionMap.size === 0) return false;
            if (getStageRetryCount(context, stateName) >= 2) return false;
            const parsed = getCachedParse(event.output);
            if (!parsed) return false;
            for (const [key, assertions] of assertionMap) {
              const failures = evaluateAssertions(key, parsed[key], assertions);
              if (failures.length > 0) return true;
            }
            return false;
          },
          target: stateName,
          reenter: true,
          actions: [
            assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
              const sessionId = event.output?.sessionId ?? context.stageSessionIds?.[stateName];
              const parsed = getCachedParse(event.output);
              const assertionMap = collectAssertions(runtime.writes);
              const allFailures: { key: string; assertion: string; passed: boolean }[] = [];
              for (const [key, assertions] of assertionMap) {
                allFailures.push(...evaluateAssertions(key, parsed?.[key], assertions));
              }
              const priorFeedback = context.resumeInfo?.feedback
                ? `[Prior attempt failed: ${context.resumeInfo.feedback.slice(0, 300)}]\n\n`
                : "";
              return {
                retryCount: context.retryCount + 1,
                stageRetryCount: incrementStageRetryCount(context, stateName),
                totalCostUsd: (context.totalCostUsd ?? 0) + (event.output?.costUsd ?? 0),
                totalTokenUsage: accumulateTokenUsage(context.totalTokenUsage, event.output?.tokenUsage),
                stageTokenUsages: event.output?.tokenUsage ? { ...context.stageTokenUsages, [stateName]: event.output.tokenUsage } : context.stageTokenUsages,
                stageSessionIds: { ...context.stageSessionIds, [stateName]: event.output?.sessionId ?? context.stageSessionIds?.[stateName] },
                stageCwds: { ...context.stageCwds, ...(event.output?.cwd ? { [stateName]: event.output.cwd } : {}) },
                resumeInfo: sessionId
                  ? { sessionId, feedback: `${priorFeedback}${formatAssertionFeedback(allFailures)}` }
                  : undefined,
              };
            }),
            ({ context }: { context: WorkflowContext }) => {
              taskLogger(context.taskId).warn({ stage: stateName, retryCount: context.retryCount }, "Output failed quality assertions, retrying");
            },
            emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
              type: "wf.status",
              taskId: context.taskId,
              status: context.status,
              message: `${stateName}: output failed quality assertions, retrying (attempt ${context.retryCount})`,
            })),
          ],
        },
        // Guard: block if retries exhausted and output still missing
        // When back_to is configured, defer to QA feedback loop unless it's also exhausted
        {
          guard: ({ event, context }: { event: { output: { resultText: string } }; context: WorkflowContext }) => {
            if ((runtime.writes?.length ?? 0) === 0) return false;
            if (runtime.retry?.back_to) {
              const loopCount = context.qaRetryCount ?? 0;
              if (loopCount < (runtime.retry.max_retries ?? 2)) return false;
            }
            if (!event.output.resultText) return true;
            const parsed = getCachedParse(event.output);
            if (!parsed) return true;
            const writeKeys = runtime.writes!.map((w: WriteDeclaration) => typeof w === "string" ? w : w.key);
            return !writeKeys.every((field: string) => parsed[field] !== undefined);
          },
          target: opts?.blockedTarget ?? "blocked",
          actions: [
            assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
              const text = event.output?.resultText;
              const writeKeys = runtime.writes!.map((w: WriteDeclaration) => typeof w === "string" ? w : w.key);
              const msg = !text
                ? `Stage "${stateName}" completed but produced no output. The agent may have failed silently.`
                : `Stage "${stateName}" output could not be parsed or is missing required fields (expected: ${writeKeys.join(", ")}).`;
              return {
                error: msg,
                lastStage: stateName,
                totalCostUsd: (context.totalCostUsd ?? 0) + (event.output?.costUsd ?? 0),
                totalTokenUsage: accumulateTokenUsage(context.totalTokenUsage, event.output?.tokenUsage),
                stageTokenUsages: event.output?.tokenUsage ? { ...context.stageTokenUsages, [stateName]: event.output.tokenUsage } : context.stageTokenUsages,
              };
            }),
            ({ context }: { context: WorkflowContext }) => {
              taskLogger(context.taskId).error({ stage: stateName }, context.error ?? "Empty output");
            },
            emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
              type: "wf.error",
              taskId: context.taskId,
              error: context.error ?? "Empty output",
            })),
          ],
        },
        // Logical failure guard: QA back_to routing
        ...(runtime.retry?.back_to ? [{
          guard: ({ event, context }: { event: { output: { resultText: string } }; context: WorkflowContext }) => {
            const retryConf = runtime.retry!;
            const loopCount = context.qaRetryCount ?? 0;
            if (loopCount >= (retryConf.max_retries ?? 2)) return false;
            const parsed = getCachedParse(event.output);
            if (!parsed) return false;
            return (runtime.writes ?? []).some((w: WriteDeclaration) => {
              const field = typeof w === "string" ? w : w.key;
              const val = parsed[field] as Record<string, unknown> | undefined;
              return val && typeof val === "object" && (val as Record<string, unknown>).passed === false;
            });
          },
          target: statePrefix ? `${statePrefix}.${runtime.retry.back_to}` : runtime.retry.back_to,
          actions: [
            assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
              let store = context.store ?? {};
              if (runtime.writes?.length && event.output?.resultText) {
                const parsed = getCachedParse(event.output);
                if (parsed) {
                  const writeStrategies = buildWriteStrategies(runtime.writes);
                  const updates: Record<string, any> = {};
                  for (const w of runtime.writes) {
                    const field = typeof w === "string" ? w : w.key;
                    if (parsed[field] !== undefined) updates[field] = parsed[field];
                  }
                  applyStoreUpdates(store, updates, writeStrategies);
                }
              }
              const backTo = runtime.retry!.back_to!;
              const targetSessionId = context.stageSessionIds?.[backTo];
              let feedback = `Stage "${stateName}" found errors:\n\n`;
              const parsedFeedback = event.output?.resultText ? getCachedParse(event.output) : null;
              if (parsedFeedback) {
                for (const w of runtime.writes ?? []) {
                  const field = typeof w === "string" ? w : w.key;
                  const val = parsedFeedback[field] as Record<string, unknown> | undefined;
                  const blockers = val?.blockers as string[] | undefined;
                  if (blockers?.length) {
                    feedback += blockers.join("\n\n");
                  }
                }
              }
              const priorFeedbackQa = context.resumeInfo?.feedback
                ? `[Prior attempt failed: ${context.resumeInfo.feedback.slice(0, 300)}]\n\n`
                : "";
              return {
                store,
                qaRetryCount: (context.qaRetryCount ?? 0) + 1,
                retryCount: 0,
                resumeInfo: targetSessionId ? { sessionId: targetSessionId, feedback: priorFeedbackQa + feedback } : undefined,
                totalCostUsd: (context.totalCostUsd ?? 0) + (event.output?.costUsd ?? 0),
                totalTokenUsage: accumulateTokenUsage(context.totalTokenUsage, event.output?.tokenUsage),
                stageTokenUsages: event.output?.tokenUsage ? { ...context.stageTokenUsages, [stateName]: event.output.tokenUsage } : context.stageTokenUsages,
                stageSessionIds: { ...context.stageSessionIds, [stateName]: event.output?.sessionId ?? context.stageSessionIds?.[stateName] },
                stageCwds: { ...context.stageCwds, ...(event.output?.cwd ? { [stateName]: event.output.cwd } : {}) },
              };
            }),
            ({ context }: { context: WorkflowContext }) => {
              const backTo = runtime.retry!.back_to!;
              taskLogger(context.taskId).info({ stage: stateName, backTo, qaRetryCount: context.qaRetryCount }, `Logical failure detected, routing back to ${backTo}`);
            },
            emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => {
              const backTo = runtime.retry!.back_to!;
              return {
                type: "wf.status",
                taskId: context.taskId,
                status: backTo,
                message: `${stateName} found issues, routing back to ${backTo} (loop ${context.qaRetryCount}/${runtime.retry!.max_retries ?? 2})`,
              };
            }),
            emitTaskListUpdate(),
          ],
        }] : []),
        // Verify failure + retries exhausted -> blocked
        {
          guard: ({ context, event }: { context: WorkflowContext; event: DoneEvent }) => {
            if (!(event.output as any)?.verifyFailed) return false;
            const maxVerifyRetries = (stage as any).verify_max_retries ?? 2;
            return getVerifyRetryCount(context, stateName) >= maxVerifyRetries;
          },
          target: opts?.blockedTarget ?? "blocked",
          actions: [
            assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
              const output = event.output as any;
              return {
                error: `Verification failed after max retries. ${formatVerifyFailures(output.verifyResults ?? []).slice(0, 500)}`,
                lastStage: stateName,
                totalCostUsd: (context.totalCostUsd ?? 0) + (event.output?.costUsd ?? 0),
                totalTokenUsage: accumulateTokenUsage(context.totalTokenUsage, event.output?.tokenUsage),
                stageTokenUsages: event.output?.tokenUsage ? { ...context.stageTokenUsages, [stateName]: event.output.tokenUsage } : context.stageTokenUsages,
              };
            }),
            ({ context }: { context: WorkflowContext }) => {
              taskLogger(context.taskId).error({ stage: stateName }, context.error ?? "Verification failed after max retries");
            },
            emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
              type: "wf.error",
              taskId: context.taskId,
              error: context.error ?? "Verification failed after max retries",
            })),
          ],
        },
        // Verify failure + retries remaining -> re-enter stage
        {
          guard: ({ event }: { event: DoneEvent }) => {
            return !!(event.output as any)?.verifyFailed;
          },
          target: stateName,
          reenter: true,
          actions: [
            assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
              const output = event.output as any;
              const failureDetail = formatVerifyFailures(output.verifyResults ?? []);
              const priorFeedback = context.resumeInfo?.feedback
                ? `[Prior attempt failed: ${context.resumeInfo.feedback.slice(0, 300)}]\n\n`
                : "";
              return {
                verifyRetryCount: incrementVerifyRetryCount(context, stateName),
                totalCostUsd: (context.totalCostUsd ?? 0) + (event.output?.costUsd ?? 0),
                totalTokenUsage: accumulateTokenUsage(context.totalTokenUsage, event.output?.tokenUsage),
                stageTokenUsages: event.output?.tokenUsage ? { ...context.stageTokenUsages, [stateName]: event.output.tokenUsage } : context.stageTokenUsages,
                stageSessionIds: { ...context.stageSessionIds, [stateName]: event.output?.sessionId ?? context.stageSessionIds?.[stateName] },
                stageCwds: { ...context.stageCwds, ...(event.output?.cwd ? { [stateName]: event.output.cwd } : {}) },
                resumeInfo: output.sessionId
                  ? {
                      sessionId: output.sessionId,
                      feedback: `${priorFeedback}VERIFICATION FAILED. Your changes did not pass the required verification commands. Fix the issues and try again.\n\nFailures:\n${failureDetail}`,
                    }
                  : undefined,
              };
            }),
            ({ context }: { context: WorkflowContext }) => {
              taskLogger(context.taskId).warn({ stage: stateName, retryCount: getStageRetryCount(context, stateName) }, "Verify commands failed, retrying stage");
            },
            emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
              type: "wf.status",
              taskId: context.taskId,
              status: context.status,
              message: `${stateName}: verification failed, retrying (attempt ${getStageRetryCount(context, stateName)})`,
            })),
          ],
        },
        // Normal path: process output and advance
        {
          target: nextTarget,
          actions: [
            assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
              let store = context.store ?? {};
              let parallelStagedWrites = context.parallelStagedWrites;
              if (runtime.writes?.length && event.output?.resultText) {
                const parsed = getCachedParse(event.output);
                if (parsed) {
                  const writeStrategies = buildWriteStrategies(runtime.writes);
                  const updates: Record<string, any> = {};
                  for (const w of runtime.writes) {
                    const field = typeof w === "string" ? w : w.key;
                    if (parsed[field] !== undefined) updates[field] = parsed[field];
                  }
                  if (Object.keys(updates).length) {
                    if (opts?.statePrefix) {
                      // Inside parallel group: buffer writes for atomic commit
                      parallelStagedWrites = {
                        ...context.parallelStagedWrites,
                        [stateName]: { ...(context.parallelStagedWrites?.[stateName] ?? {}), ...updates },
                      };
                    } else {
                      applyStoreUpdates(store, updates, writeStrategies);
                      // Generate compact summary for large store values
                      for (const [field, value] of Object.entries(updates)) {
                        if (typeof value !== "object" || value === null) continue;
                        const keys = Object.keys(value);
                        if (keys.length < 5) continue;
                        const serialized = JSON.stringify(value);
                        if (serialized.length > 8000) {
                          const summaryFields = keys.slice(0, 10).join(", ");
                          store[`${field}.__summary`] = `[${typeof value}] ${summaryFields} (${serialized.length} chars)`;
                        }
                      }
                    }
                  }
                } else {
                  taskLogger(context.taskId).error({ stage: stateName }, "Failed to parse agent output for writes");
                }
              }
              return {
                ...(opts?.statePrefix ? { parallelStagedWrites } : { store }),
                retryCount: 0,
                stageRetryCount: resetStageRetryCount(context, stateName),
                ...(runtime.retry?.back_to ? { qaRetryCount: 0 } : {}),
                resumeInfo: undefined,
                scratchPad: context.scratchPad ?? [],
                totalCostUsd: (context.totalCostUsd ?? 0) + (event.output?.costUsd ?? 0),
                totalTokenUsage: accumulateTokenUsage(context.totalTokenUsage, event.output?.tokenUsage),
                stageTokenUsages: event.output?.tokenUsage ? { ...context.stageTokenUsages, [stateName]: event.output.tokenUsage } : context.stageTokenUsages,
                stageSessionIds: { ...context.stageSessionIds, [stateName]: event.output?.sessionId ?? context.stageSessionIds?.[stateName] },
                stageCwds: { ...context.stageCwds, ...(event.output?.cwd ? { [stateName]: event.output.cwd } : {}) },
                completedStages: [...(context.completedStages ?? []), stateName],
                executionHistory: [...(context.executionHistory ?? []), { stage: stateName, action: "completed" as const, timestamp: new Date().toISOString() }],
              };
            }),
            // Fire-and-forget: generate semantic summaries for writes with summary_prompt
            // Only for non-parallel paths (parallel children's writes are staged, not in store yet)
            ({ context }: { context: WorkflowContext }) => {
              if (opts?.statePrefix) return;
              const writes = runtime.writes ?? [];
              for (const w of writes) {
                if (typeof w === "object" && w.summary_prompt) {
                  const key = w.key;
                  const value = context.store[key];
                  if (value === undefined) continue;
                  Promise.all([
                    import("../agent/semantic-summary.js"),
                    import("../agent/semantic-summary-cache.js"),
                  ]).then(([{ generateSemanticSummary }, { setCachedSummary }]) => {
                    generateSemanticSummary(context.taskId, key, value, w.summary_prompt!).then((summary) => {
                      if (summary) {
                        setCachedSummary(context.taskId, key, summary);
                      }
                    }).catch(() => {});
                  }).catch(() => {});
                }
              }
            },
            emit(({ event, context }: { event: DoneEvent; context: WorkflowContext }): WorkflowEmittedEvent => ({
              type: "wf.costUpdate",
              taskId: context.taskId,
              totalCostUsd: context.totalCostUsd ?? 0,
              stageCostUsd: event.output?.costUsd ?? 0,
              stageTokenUsage: event.output?.tokenUsage,
            })),
            emitTaskListUpdate(),
            ...(stage.on_complete?.notify ? [
              emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => {
                const titlePath = context.config?.pipeline?.display?.title_path;
                const title = (titlePath ? getNestedValue(context.store, titlePath) : undefined) ?? context.taskId;
                return {
                  type: "wf.slackStageComplete",
                  taskId: context.taskId,
                  title,
                  templateName: stage.on_complete!.notify!,
                };
              }),
              emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
                type: "wf.status",
                taskId: context.taskId,
                status: nextTarget,
                message: `${stateName} complete.`,
              })),
            ] : []),
            emitPersistSession(),
          ],
        },
      ],
      onError: handleStageError(stateName, runtime.retry, opts),
    },
  };
}

/**
 * Script Engine: Executes automated scripts (Notion, Git, PR, etc.)
 */
export function buildScriptState(
  nextTarget: string,
  _prevAgentTarget: string,
  stage: ScriptStageConfig,
  opts?: { blockedTarget?: string; statePrefix?: string },
): StateNode {
  const stateName = stage.name;
  const { runtime } = stage;

  return {
    entry: statusEntry(stateName),
    invoke: {
      src: "runScript",
      input: ({ context }: { context: WorkflowContext }) => ({
        taskId: context.taskId,
        stageName: stateName,
        context,
        runtime,
      }),
      onDone: {
        target: nextTarget,
        actions: [
          assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
            let store = context.store ?? {};
            const output = event.output;

            if (runtime.writes?.length && output !== undefined) {
              const writeStrategies = buildWriteStrategies(runtime.writes);
              if (typeof output === "object" && output !== null && !Array.isArray(output)) {
                const updates: Record<string, any> = {};
                for (const w of runtime.writes) {
                  const field = typeof w === "string" ? w : w.key;
                  if ((output as Record<string, any>)[field] !== undefined) updates[field] = (output as Record<string, any>)[field];
                }
                if (Object.keys(updates).length) applyStoreUpdates(store, updates, writeStrategies);
              } else if (runtime.writes.length === 1) {
                const singleKey = typeof runtime.writes[0] === "string" ? runtime.writes[0] : runtime.writes[0].key;
                applyStoreUpdates(store, { [singleKey]: output }, writeStrategies);
              }
            }

            return {
              store,
              retryCount: 0,
              stageRetryCount: resetStageRetryCount(context, stateName),
              branch: store.branch ?? context.branch,
              worktreePath: store.worktreePath?.worktreePath ?? store.worktreePath ?? context.worktreePath,
              completedStages: [...(context.completedStages ?? []), stateName],
              executionHistory: [...(context.executionHistory ?? []), { stage: stateName, action: "completed" as const, timestamp: new Date().toISOString() }],
            };
          }),
          emitPersistSession(),
        ],
      },
      onError: handleStageError(stateName, runtime.retry, opts),
    },
  };
}

/**
 * Human Gate Engine: Handles user confirmation and routing
 */
export function buildHumanGateState(
  nextTarget: string,
  prevAgentTarget: string,
  stage: HumanGateRuntimeConfig & { name: string; notify?: { type: "slack"; template: string } },
  childToGroup?: Map<string, string>,
): StateNode {
  const stateName = stage.name;

  const notifyTemplate = stage.notify?.type === "slack" ? stage.notify.template : "approval-needed";

  // Resolve reject target: if on_reject_to points to a parallel child, route to the group
  const rawRejectTo = stage.on_reject_to;
  const rejectToGroup = rawRejectTo ? childToGroup?.get(rawRejectTo) : undefined;
  const resolvedRejectTarget = rejectToGroup ?? rawRejectTo;

  // For REJECT_WITH_FEEDBACK: only override prevAgentTarget when on_reject_to targets a
  // parallel child stage (selective re-run). Otherwise keep prevAgentTarget — on_reject_to
  // may point to "error" or other non-agent states that don't support resume.
  const feedbackTarget = rejectToGroup ? rejectToGroup : prevAgentTarget;

  // Build rejectIntoGroup from event targetStage (user choice) or config on_reject_to (default)
  function resolveRejectIntoGroup(event: WorkflowEvent): Record<string, unknown> {
    const ts = (event as { targetStage?: string }).targetStage;
    const effectiveStage = ts || rawRejectTo;
    if (!effectiveStage) return {};
    const group = childToGroup?.get(effectiveStage);
    if (!group) return {};
    return { rejectIntoGroup: { group, stage: effectiveStage } };
  }

  // Resolve sessionId for feedback resume — use the targeted child stage if available
  function resolveFeedbackSessionId(event: WorkflowEvent, context: WorkflowContext): string | undefined {
    const ts = (event as { targetStage?: string }).targetStage;
    const effectiveStage = ts || (rejectToGroup ? rawRejectTo! : null);
    if (effectiveStage) return context.stageSessionIds[effectiveStage];
    return context.stageSessionIds[prevAgentTarget];
  }

  return {
    entry: [
      ...statusEntry(stateName),
      emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
        type: "wf.slackGate",
        taskId: context.taskId,
        stageName: stateName,
        template: notifyTemplate,
      })),
    ],
    on: {
      CONFIRM: {
        target: stage.on_approve_to ?? nextTarget,
        actions: [
          assign(({ event, context }: { event: WorkflowEvent; context: WorkflowContext }) => {
            const repoOverride = (event as { repoName?: string }).repoName;
            return {
              retryCount: 0,
              ...(repoOverride ? { explicitRepoName: repoOverride } : {}),
              completedStages: [...(context.completedStages ?? []), stateName],
              executionHistory: [...(context.executionHistory ?? []), { stage: stateName, action: "completed" as const, timestamp: new Date().toISOString() }],
            };
          }),
        ],
      },
      REJECT: {
        target: resolvedRejectTarget ?? "error",
        actions: [
          assign(({ event }: { event: WorkflowEvent }) => ({
            error: (event as { reason?: string }).reason ?? "Rejected by user",
            ...resolveRejectIntoGroup(event),
          })),
          emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
            type: "wf.error",
            taskId: context.taskId,
            error: context.error ?? "Rejected by user",
          })),
        ],
      },
      REJECT_WITH_FEEDBACK: [
        {
          target: feedbackTarget,
          guard: ({ context }: { context: WorkflowContext }) => (context.qaRetryCount ?? 0) < (stage.max_feedback_loops ?? 5),
          actions: [
            assign(({ event, context }: { event: WorkflowEvent; context: WorkflowContext }) => {
              const feedback = (event as { feedback?: string }).feedback || "Please review and fix the issues.";
              const sessionId = resolveFeedbackSessionId(event, context);
              return {
                retryCount: 0,
                qaRetryCount: (context.qaRetryCount ?? 0) + 1,
                resumeInfo: sessionId ? { sessionId, feedback } : undefined,
                ...resolveRejectIntoGroup(event),
              };
            }),
          ],
        },
        {
          target: resolvedRejectTarget ?? "error",
          actions: [
            assign({ error: `Feedback loop limit reached (max ${stage.max_feedback_loops ?? 5} iterations)` }),
            emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
              type: "wf.error",
              taskId: context.taskId,
              error: "Feedback loop limit reached",
            })),
          ],
        },
      ],
    },
  };
}

/**
 * Recursively sanitize store values for safe use in expr-eval expressions.
 * Primitives, plain objects, and arrays are preserved (to support nested
 * property access like `store.config.items`). Functions are excluded.
 */
function sanitizeExprVars(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "function") return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeExprVars);
  if (typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeExprVars(v);
      if (sanitized !== undefined) safe[k] = sanitized;
    }
    return safe;
  }
  return undefined;
}

/**
 * Condition Stage: Evaluates expression branches and transitions to the matching target.
 * Uses XState `always` (eventless transitions) — no invoke required.
 */
export function buildConditionState(
  _nextTarget: string,
  _prevAgentTarget: string,
  stage: ConditionStageConfig,
  opts?: { blockedTarget?: string },
): StateNode {
  const stateName = stage.name;
  const { runtime } = stage;
  const parser = new Parser();

  const allBranchTargets = runtime.branches.map((b) => b.to);

  const transitions = runtime.branches.map((branch) => {
    const skippedTargets = allBranchTargets.filter((t) => t !== branch.to);
    const trackingAction = assign(({ context }: { context: WorkflowContext }) => {
      const existingSkipped = new Set(context.skippedStages ?? []);
      const newSkipped = skippedTargets.filter((t) => !existingSkipped.has(t));
      return {
        completedStages: [...(context.completedStages ?? []), stateName],
        skippedStages: [...(context.skippedStages ?? []), ...newSkipped],
        executionHistory: [
          ...(context.executionHistory ?? []),
          { stage: stateName, action: "completed" as const, timestamp: new Date().toISOString() },
          ...newSkipped.map((t) => ({ stage: t, action: "skipped" as const, timestamp: new Date().toISOString() })),
        ],
      };
    });

    if (branch.default) {
      return { target: branch.to, actions: [trackingAction] };
    }
    return {
      guard: ({ context }: { context: WorkflowContext }) => {
        try {
          const expr = parser.parse(branch.when!);
          const safeStore = sanitizeExprVars(context.store);
          // expr-eval supports booleans at runtime but its type defs don't include boolean in Value
          return !!expr.evaluate({
            store: safeStore,
            contains: (arr: unknown, val: unknown) => Array.isArray(arr) && arr.includes(val),
            hasAny: (arr: unknown, ...vals: unknown[]) => Array.isArray(arr) && vals.some((v) => arr.includes(v)),
          } as Record<string, any>);
        } catch (err) {
          taskLogger(context.taskId).warn({ stage: stateName, when: branch.when, err }, "Condition branch expression evaluation failed");
          return false;
        }
      },
      target: branch.to,
      actions: [trackingAction],
    };
  });

  // If no default branch defined, add a fallback to blocked
  const hasDefault = runtime.branches.some((b) => b.default);
  if (!hasDefault) {
    transitions.push({
      target: opts?.blockedTarget ?? "blocked",
      actions: [assign(({ context }: { context: WorkflowContext }) => {
        const existingSkipped = new Set(context.skippedStages ?? []);
        const newSkipped = allBranchTargets.filter((t) => !existingSkipped.has(t));
        return {
          completedStages: [...(context.completedStages ?? []), stateName],
          skippedStages: [...(context.skippedStages ?? []), ...newSkipped],
          executionHistory: [
            ...(context.executionHistory ?? []),
            { stage: stateName, action: "completed" as const, timestamp: new Date().toISOString() },
            ...newSkipped.map((t) => ({ stage: t, action: "skipped" as const, timestamp: new Date().toISOString() })),
          ],
        };
      })],
    });
  }

  return {
    entry: statusEntry(stateName),
    always: transitions,
  };
}

/**
 * Pipeline Call Stage: Invokes a sub-pipeline as an independent sub-task.
 */
export function buildPipelineCallState(
  nextTarget: string,
  _prevAgentTarget: string,
  stage: PipelineCallStageConfig,
  opts?: { blockedTarget?: string },
): StateNode {
  const stateName = stage.name;
  const { runtime } = stage;

  return {
    entry: statusEntry(stateName),
    invoke: {
      src: "runPipelineCall",
      input: ({ context }: { context: WorkflowContext }) => ({
        taskId: context.taskId,
        stageName: stateName,
        context,
        runtime,
      }),
      onDone: {
        target: nextTarget,
        actions: [
          assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
            const raw = event.output ?? {};
            const updates = filterStoreWrites(raw, runtime.writes, stateName, context.taskId);
            const store = { ...context.store };
            const writeStrategies = buildWriteStrategies(runtime.writes);
            applyStoreUpdates(store, updates, writeStrategies);
            return {
              store,
              retryCount: 0,
              stageRetryCount: resetStageRetryCount(context, stateName),
              completedStages: [...(context.completedStages ?? []), stateName],
              executionHistory: [...(context.executionHistory ?? []), { stage: stateName, action: "completed" as const, timestamp: new Date().toISOString() }],
            };
          }),
          emitPersistSession(),
        ],
      },
      onError: handleStageError(stateName, undefined, opts),
    },
  };
}

/**
 * Foreach Stage: Iterates over an array in store, spawning a sub-pipeline per item.
 */
export function buildForeachState(
  nextTarget: string,
  _prevAgentTarget: string,
  stage: ForeachStageConfig,
  opts?: { blockedTarget?: string },
): StateNode {
  const stateName = stage.name;
  const { runtime } = stage;

  return {
    entry: statusEntry(stateName),
    invoke: {
      src: "runForeach",
      input: ({ context }: { context: WorkflowContext }) => ({
        taskId: context.taskId,
        stageName: stateName,
        context,
        runtime,
      }),
      onDone: {
        target: nextTarget,
        actions: [
          assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
            const raw = event.output ?? {};
            const declaredWrites = runtime.collect_to ? [runtime.collect_to] : undefined;
            const updates = filterStoreWrites(raw, declaredWrites, stateName, context.taskId);
            return {
              store: { ...context.store, ...updates },
              retryCount: 0,
              stageRetryCount: resetStageRetryCount(context, stateName),
              completedStages: [...(context.completedStages ?? []), stateName],
              executionHistory: [...(context.executionHistory ?? []), { stage: stateName, action: "completed" as const, timestamp: new Date().toISOString() }],
            };
          }),
          emitPersistSession(),
        ],
      },
      onError: handleStageError(stateName, undefined, opts),
    },
  };
}

/**
 * LLM Decision Stage: Invokes an LLM to choose which branch to take.
 * Similar to condition stage but uses runtime LLM evaluation instead of static expressions.
 */
export function buildLlmDecisionState(
  _nextTarget: string,
  _prevAgentTarget: string,
  stage: LlmDecisionStageConfig,
  opts?: { blockedTarget?: string },
): StateNode {
  const stateName = stage.name;
  const { runtime } = stage;
  const allGotoTargets = runtime.choices.map((c) => c.goto);

  return {
    entry: statusEntry(stateName),
    invoke: {
      src: "runLlmDecision",
      input: ({ context }: { context: WorkflowContext }) => ({
        taskId: context.taskId,
        stageName: stateName,
        context,
        runtime,
      }),
      onDone: [
        ...runtime.choices.map((choice) => ({
          target: choice.goto,
          guard: ({ event }: { event: { output: { choiceId: string; goto: string } } }) =>
            event.output.choiceId === choice.id,
          actions: [
            assign(({ context }: { context: WorkflowContext }) => {
              const skippedTargets = allGotoTargets.filter((t) => t !== choice.goto);
              const existingSkipped = new Set(context.skippedStages ?? []);
              const newSkipped = skippedTargets.filter((t) => !existingSkipped.has(t));
              return {
                completedStages: [...(context.completedStages ?? []), stateName],
                skippedStages: [...(context.skippedStages ?? []), ...newSkipped],
                executionHistory: [
                  ...(context.executionHistory ?? []),
                  { stage: stateName, action: "completed" as const, timestamp: new Date().toISOString() },
                  ...newSkipped.map((t) => ({ stage: t, action: "skipped" as const, timestamp: new Date().toISOString() })),
                ],
              };
            }),
          ],
        })),
        // Fallback: LLM returned unknown choiceId
        {
          target: opts?.blockedTarget ?? "blocked",
          actions: [
            assign(({ event }: { event: DoneEvent }) => ({
              error: `LLM decision "${stateName}" returned unknown choiceId: "${(event.output as Record<string, unknown>)?.choiceId ?? "undefined"}"`,
              lastStage: stateName,
            })),
          ],
        },
      ],
      onError: {
        target: opts?.blockedTarget ?? "blocked",
        actions: [
          assign(({ event }: { event: { error: unknown } }) => ({
            error: event.error instanceof Error ? event.error.message : String(event.error),
            lastStage: stateName,
          })),
        ],
      },
    },
  };
}

/**
 * Parallel Group: Runs multiple stages concurrently using XState parallel state.
 * All child regions must reach their final state before onDone triggers.
 */
export function buildParallelGroupState(
  group: { name: string; stages: PipelineStageConfig[] },
  nextTarget: string,
  prevAgentTarget: string,
): StateNode {
  for (const childStage of group.stages) {
    if (childStage.type === "agent" && childStage.runtime) {
      const runtime = childStage.runtime as AgentRuntimeConfig;
      if (!runtime.reads || Object.keys(runtime.reads).length === 0) {
        logger.warn(
          { stage: childStage.name, group: group.name },
          `Parallel stage "${childStage.name}" in group "${group.name}" has no "reads" declaration — undeclared store access may cause race conditions`
        );
      }
    }
  }

  const groupName = group.name;
  const regions: Record<string, StateNode> = {};
  const stageOpts = { blockedTarget: "#workflow.blocked", statePrefix: "#workflow" };

  for (const stage of group.stages) {
    const builder = getStageBuilder(stage);
    if (!builder) continue;

    const runningState = `__run_${stage.name}`;
    const doneState = `__done_${stage.name}`;

    regions[stage.name] = {
      initial: stage.name,
      states: {
        [stage.name]: {
          always: [
            {
              guard: ({ context }: { context: WorkflowContext }) => {
                const done = context.parallelDone?.[groupName] ?? [];
                return done.includes(stage.name);
              },
              target: doneState,
            },
            { target: runningState },
          ],
        },
        [runningState]: builder(doneState, prevAgentTarget, stage, stageOpts),
        [doneState]: {
          type: "final",
          entry: [
            assign(({ context }: { context: WorkflowContext }) => ({
              parallelDone: {
                ...context.parallelDone,
                [groupName]: [...new Set([...(context.parallelDone?.[groupName] ?? []), stage.name])],
              },
            })),
          ],
        },
      },
    };
  }

  const allChildNames = group.stages.map(s => s.name);

  return {
    type: "parallel",
    entry: [
      assign(({ context }: { context: WorkflowContext }) => {
        const reject = context.rejectIntoGroup;
        if (reject && reject.group === groupName) {
          // Selective re-run: mark all children except the reject target as already done
          const skipChildren = allChildNames.filter(n => n !== reject.stage);
          return {
            status: groupName,
            parallelDone: { ...context.parallelDone, [groupName]: skipChildren },
            rejectIntoGroup: undefined,
          };
        }
        // Normal entry / RETRY / RESUME: leave parallelDone as-is.
        // - First entry: parallelDone[group] doesn't exist yet → all children run.
        // - RETRY from blocked: parallelDone[group] has completed children → only failed ones re-run.
        // - After onDone (retry back_to): onDone already cleared parallelDone[group] → all children run.
        return { status: groupName, rejectIntoGroup: undefined };
      }),
      emitStatus(groupName),
      emitTaskListUpdate(),
    ],
    states: regions,
    onDone: {
      target: nextTarget,
      actions: [
        assign(({ context }: { context: WorkflowContext }) => {
          const { [groupName]: _, ...restParallelDone } = context.parallelDone ?? {};

          // Commit all staged writes from child stages
          const newStore = { ...context.store };
          const staged = context.parallelStagedWrites ?? {};
          const allChildWriteDecls = group.stages.flatMap(s => {
            const rt = s.runtime as Record<string, any> | undefined;
            return (rt?.writes ?? []) as WriteDeclaration[];
          });
          const writeStrategies = buildWriteStrategies(allChildWriteDecls);

          for (const childStage of group.stages) {
            const childUpdates = staged[childStage.name];
            if (childUpdates) {
              applyStoreUpdates(newStore, childUpdates, writeStrategies);
            }
          }

          // Generate mechanical summaries for large committed values
          for (const childStage of group.stages) {
            const childUpdates = staged[childStage.name];
            if (!childUpdates) continue;
            for (const [field, value] of Object.entries(childUpdates)) {
              if (typeof value !== "object" || value === null) continue;
              const keys = Object.keys(value);
              if (keys.length < 5) continue;
              const serialized = JSON.stringify(value);
              if (serialized.length > 8000) {
                const summaryFields = keys.slice(0, 10).join(", ");
                newStore[`${field}.__summary`] = `[${typeof value}] ${summaryFields} (${serialized.length} chars)`;
              }
            }
          }

          // Clean up staged writes for all children in this group
          const newStaged = { ...staged };
          for (const s of group.stages) {
            delete newStaged[s.name];
          }

          return {
            store: newStore,
            retryCount: 0,
            stageRetryCount: {},
            resumeInfo: undefined,
            parallelDone: Object.keys(restParallelDone).length > 0 ? restParallelDone : undefined,
            parallelStagedWrites: Object.keys(newStaged).length > 0 ? newStaged : undefined,
          };
        }),
        // Fire-and-forget: generate semantic summaries for parallel group committed writes
        ({ context }: { context: WorkflowContext }) => {
          for (const childStage of group.stages) {
            const rt = childStage.runtime as Record<string, any> | undefined;
            const writes = (rt?.writes ?? []) as WriteDeclaration[];
            for (const w of writes) {
              if (typeof w === "object" && w.summary_prompt) {
                const key = w.key;
                const value = context.store[key];
                if (value === undefined) continue;
                Promise.all([
                  import("../agent/semantic-summary.js"),
                  import("../agent/semantic-summary-cache.js"),
                ]).then(([{ generateSemanticSummary }, { setCachedSummary }]) => {
                  generateSemanticSummary(context.taskId, key, value, w.summary_prompt!).then((summary) => {
                    if (summary) {
                      setCachedSummary(context.taskId, key, summary);
                    }
                  }).catch(() => {});
                }).catch(() => {});
              }
            }
          }
        },
        emitTaskListUpdate(),
        emitPersistSession(),
      ],
    },
  };
}
