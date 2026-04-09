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
import { taskLogger } from "../lib/logger.js";
import type { AgentStageConfig, AgentRuntimeConfig, ScriptStageConfig, HumanGateRuntimeConfig, PipelineStageConfig, ConditionStageConfig, PipelineCallStageConfig, ForeachStageConfig } from "../lib/config-loader.js";
import { getNestedValue } from "../lib/config-loader.js";
import { extractJSON } from "../lib/json-extractor.js";
import { getStageBuilder } from "./stage-registry.js";

/**
 * Filter store writes to only include keys declared in the stage's `writes` config.
 * Undeclared keys are logged as warnings and dropped.
 */
function filterStoreWrites(
  parsed: Record<string, unknown>,
  declaredWrites: string[] | undefined,
  stageName: string,
  taskId: string,
): Record<string, unknown> {
  if (!declaredWrites || declaredWrites.length === 0) return parsed;
  const allowed = new Set(declaredWrites);
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
        const stepsPath = runtime.enabled_steps_path;
        const enabledSteps = stepsPath ? getNestedValue(context.store, stepsPath) : undefined;
        return {
          taskId: context.taskId,
          stageName: stateName,
          worktreePath: context.worktreePath ?? "",
          tier1Context: buildTier1Context(context),
          enabledSteps,
          attempt: context.retryCount,
          resumeInfo: context.resumeInfo,
          interactive: stage.interactive,
          runtime,
          context,
        };
      },
      onDone: [
        // Guard: retry if stage expects writes but output is empty or unparseable
        {
          guard: ({ event, context }: { event: { output: { resultText: string } }; context: WorkflowContext }) => {
            if ((runtime.writes?.length ?? 0) === 0) return false;
            if (getStageRetryCount(context, stateName) >= 2) return false;
            const text = event.output.resultText;
            if (!text) return true;
            try {
              const parsed = extractJSON(text);
              return !runtime.writes!.every((field) => parsed[field] !== undefined);
            } catch {
              return true;
            }
          },
          target: stateName,
          reenter: true,
          actions: [
            assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
              const sessionId = event.output?.sessionId ?? context.stageSessionIds?.[stateName];
              return {
                retryCount: context.retryCount + 1,
                stageRetryCount: incrementStageRetryCount(context, stateName),
                totalCostUsd: (context.totalCostUsd ?? 0) + (event.output?.costUsd ?? 0),
                totalTokenUsage: accumulateTokenUsage(context.totalTokenUsage, event.output?.tokenUsage),
                stageTokenUsages: event.output?.tokenUsage ? { ...context.stageTokenUsages, [stateName]: event.output.tokenUsage } : context.stageTokenUsages,
                stageSessionIds: { ...context.stageSessionIds, [stateName]: event.output?.sessionId ?? context.stageSessionIds?.[stateName] },
                stageCwds: { ...context.stageCwds, ...(event.output?.cwd ? { [stateName]: event.output.cwd } : {}) },
                resumeInfo: sessionId
                  ? { sessionId, feedback: `Your previous output was missing the required JSON fields (expected: ${runtime.writes!.join(", ")}). You MUST output the required JSON object before finishing. Do NOT explain — just output the JSON now.` }
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
        // Guard: block if retries exhausted and output still missing
        // When back_to is configured, defer to QA feedback loop unless it's also exhausted
        {
          guard: ({ event, context }: { event: { output: { resultText: string } }; context: WorkflowContext }) => {
            if ((runtime.writes?.length ?? 0) === 0) return false;
            if (runtime.retry?.back_to) {
              const loopCount = context.qaRetryCount ?? 0;
              if (loopCount < (runtime.retry.max_retries ?? 2)) return false;
            }
            const text = event.output.resultText;
            if (!text) return true;
            try {
              const parsed = extractJSON(text);
              return !runtime.writes!.every((field) => parsed[field] !== undefined);
            } catch {
              return true;
            }
          },
          target: opts?.blockedTarget ?? "blocked",
          actions: [
            assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
              const text = event.output?.resultText;
              const msg = !text
                ? `Stage "${stateName}" completed but produced no output. The agent may have failed silently.`
                : `Stage "${stateName}" output could not be parsed or is missing required fields (expected: ${runtime.writes!.join(", ")}).`;
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
            try {
              const parsed = extractJSON(event.output.resultText);
              return (runtime.writes ?? []).some((field: string) => {
                const val = parsed[field] as Record<string, unknown> | undefined;
                return val && typeof val === "object" && (val as Record<string, unknown>).passed === false;
              });
            } catch { return false; }
          },
          target: statePrefix ? `${statePrefix}.${runtime.retry.back_to}` : runtime.retry.back_to,
          actions: [
            assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
              let store = context.store ?? {};
              if (runtime.writes?.length && event.output?.resultText) {
                try {
                  const parsed = extractJSON(event.output.resultText);
                  for (const field of runtime.writes) {
                    if (parsed[field] !== undefined) store = { ...store, [field]: parsed[field] };
                  }
                } catch { /* stored what we could */ }
              }
              const backTo = runtime.retry!.back_to!;
              const targetSessionId = context.stageSessionIds?.[backTo];
              let feedback = `Stage "${stateName}" found errors:\n\n`;
              try {
                const parsed = extractJSON(event.output.resultText);
                for (const field of runtime.writes ?? []) {
                  const val = parsed[field] as Record<string, unknown> | undefined;
                  const blockers = val?.blockers as string[] | undefined;
                  if (blockers?.length) {
                    feedback += blockers.join("\n\n");
                  }
                }
              } catch { /* best-effort feedback */ }
              return {
                store,
                qaRetryCount: (context.qaRetryCount ?? 0) + 1,
                retryCount: 0,
                resumeInfo: targetSessionId ? { sessionId: targetSessionId, feedback } : undefined,
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
            const retries = getStageRetryCount(context, stateName);
            return retries >= 2;
          },
          target: opts?.blockedTarget ?? "blocked",
          actions: [
            assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
              const output = event.output as any;
              return {
                error: `Verification failed after max retries. ${output.resultText?.split?.("__VERIFY_FAILED__")?.[1]?.slice(0, 500) ?? ""}`,
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
              const failureDetail = output.resultText?.split?.("__VERIFY_FAILED__")?.[1] ?? "unknown";
              return {
                stageRetryCount: incrementStageRetryCount(context, stateName),
                totalCostUsd: (context.totalCostUsd ?? 0) + (event.output?.costUsd ?? 0),
                totalTokenUsage: accumulateTokenUsage(context.totalTokenUsage, event.output?.tokenUsage),
                stageTokenUsages: event.output?.tokenUsage ? { ...context.stageTokenUsages, [stateName]: event.output.tokenUsage } : context.stageTokenUsages,
                stageSessionIds: { ...context.stageSessionIds, [stateName]: event.output?.sessionId ?? context.stageSessionIds?.[stateName] },
                stageCwds: { ...context.stageCwds, ...(event.output?.cwd ? { [stateName]: event.output.cwd } : {}) },
                resumeInfo: output.sessionId
                  ? {
                      sessionId: output.sessionId,
                      feedback: `VERIFICATION FAILED. Your changes did not pass the required verification commands. Fix the issues and try again.\n\nFailures:\n${failureDetail}`,
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
              if (runtime.writes?.length && event.output?.resultText) {
                try {
                  const parsed = extractJSON(event.output.resultText);
                  const updates: Record<string, any> = {};
                  for (const field of runtime.writes) {
                    if (parsed[field] !== undefined) updates[field] = parsed[field];
                  }
                  if (Object.keys(updates).length) {
                    store = { ...store, ...updates };
                    // Generate compact summary for large store values
                    for (const [field, value] of Object.entries(updates)) {
                      // Cheap heuristic: only compute summary for potentially large objects
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
                } catch (err) {
                  taskLogger(context.taskId).error({ err, stage: stateName }, "Failed to parse agent output for writes");
                }
              }
              return {
                store,
                retryCount: 0,
                stageRetryCount: resetStageRetryCount(context, stateName),
                ...(runtime.retry?.back_to ? { qaRetryCount: 0 } : {}),
                resumeInfo: undefined,
                totalCostUsd: (context.totalCostUsd ?? 0) + (event.output?.costUsd ?? 0),
                totalTokenUsage: accumulateTokenUsage(context.totalTokenUsage, event.output?.tokenUsage),
                stageTokenUsages: event.output?.tokenUsage ? { ...context.stageTokenUsages, [stateName]: event.output.tokenUsage } : context.stageTokenUsages,
                stageSessionIds: { ...context.stageSessionIds, [stateName]: event.output?.sessionId ?? context.stageSessionIds?.[stateName] },
                stageCwds: { ...context.stageCwds, ...(event.output?.cwd ? { [stateName]: event.output.cwd } : {}) },
              };
            }),
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
              if (typeof output === "object" && output !== null && !Array.isArray(output)) {
                const updates: Record<string, any> = {};
                for (const field of runtime.writes) {
                  if (output[field] !== undefined) updates[field] = output[field];
                }
                if (Object.keys(updates).length) store = { ...store, ...updates };
              } else if (runtime.writes.length === 1) {
                store = { ...store, [runtime.writes[0]]: output };
              }
            }

            return {
              store,
              retryCount: 0,
              stageRetryCount: resetStageRetryCount(context, stateName),
              branch: store.branch ?? context.branch,
              worktreePath: store.worktreePath?.worktreePath ?? store.worktreePath ?? context.worktreePath,
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
          assign(({ event }: { event: WorkflowEvent }) => {
            const repoOverride = (event as { repoName?: string }).repoName;
            return {
              retryCount: 0,
              ...(repoOverride ? { explicitRepoName: repoOverride } : {}),
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

  const transitions = runtime.branches.map((branch) => {
    if (branch.default) {
      return { target: branch.to };
    }
    return {
      guard: ({ context }: { context: WorkflowContext }) => {
        try {
          const expr = parser.parse(branch.when!);
          const safeStore = sanitizeExprVars(context.store);
          // expr-eval supports booleans at runtime but its type defs don't include boolean in Value
          return !!expr.evaluate({ store: safeStore } as Record<string, any>);
        } catch (err) {
          taskLogger(context.taskId).warn({ stage: stateName, when: branch.when, err }, "Condition branch expression evaluation failed");
          return false;
        }
      },
      target: branch.to,
    };
  });

  // If no default branch defined, add a fallback to blocked
  const hasDefault = runtime.branches.some((b) => b.default);
  if (!hasDefault) {
    transitions.push({ target: opts?.blockedTarget ?? "blocked" });
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
            return {
              store: { ...context.store, ...updates },
              retryCount: 0,
              stageRetryCount: resetStageRetryCount(context, stateName),
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
        console.warn(
          `[parallel-isolation] Stage "${childStage.name}" in parallel group "${group.name}" has no "reads" declaration. ` +
          `In parallel execution, undeclared store access leads to race conditions. ` +
          `Add explicit reads to ensure deterministic context injection.`
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
          return {
            retryCount: 0,
            stageRetryCount: {},
            resumeInfo: undefined,
            parallelDone: Object.keys(restParallelDone).length > 0 ? restParallelDone : undefined,
          };
        }),
        emitTaskListUpdate(),
        emitPersistSession(),
      ],
    },
  };
}
