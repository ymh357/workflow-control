import { setup, assign, emit } from "xstate";
import type { WorkflowContext, WorkflowEvent } from "./types.js";
import type { WorkflowEmittedEvent } from "./events.js";
import { runAgent, runScript, runAgentSingleSession } from "../agent/executor.js";
import { runEdgeAgent } from "../edge/actor.js";
import { runPipelineCall } from "../agent/pipeline-executor.js";
import { runForeach } from "../agent/foreach-executor.js";
import { runLlmDecision } from "../agent/decision-runner.js";
import { type PipelineConfig, type AgentRuntimeConfig, type ScriptRuntimeConfig, type PipelineCallRuntimeConfig, type ForeachRuntimeConfig, type LlmDecisionRuntimeConfig, getNestedValue, isParallelGroup, flattenStages } from "../lib/config-loader.js";
import {
  statusEntry, emitStatus, emitNotionSync, emitTaskListUpdate, emitPersistSession, loggedActor,
} from "./helpers.js";
import { buildPipelineStates, derivePipelineLists } from "./pipeline-builder.js";
import { taskLogger } from "../lib/logger.js";
import { runCompensation } from "./git-checkpoint.js";

export const workflowSetup = setup({
  types: {
    context: {} as WorkflowContext,
    events: {} as WorkflowEvent,
    emitted: {} as WorkflowEmittedEvent,
  },
  actors: {
    runAgent: loggedActor("agent", (input: { taskId: string; stageName: string; worktreePath: string; tier1Context: string; enabledSteps?: string[]; attempt: number; resumeInfo?: { sessionId: string; feedback?: string; sync?: boolean }; interactive?: boolean; runtime: AgentRuntimeConfig; context?: WorkflowContext }) =>
      runAgent(input.taskId, input)),
    runScript: loggedActor("script", (input: { taskId: string; stageName: string; context: WorkflowContext; runtime: ScriptRuntimeConfig }) =>
      runScript(input.taskId, input)),
    runEdgeAgent: loggedActor("edge-agent", (input: { taskId: string; stageName: string; worktreePath: string; tier1Context: string; enabledSteps?: string[]; attempt: number; resumeInfo?: { sessionId: string; feedback?: string; sync?: boolean }; runtime: AgentRuntimeConfig; context?: WorkflowContext }) =>
      runEdgeAgent(input.taskId, input)),
    runAgentSingleSession: loggedActor("agent-single", (input: { taskId: string; stageName: string; worktreePath: string; tier1Context: string; enabledSteps?: string[]; attempt: number; resumeInfo?: { sessionId: string; feedback?: string; sync?: boolean }; interactive?: boolean; runtime: AgentRuntimeConfig; context?: WorkflowContext; parallelGroup?: { name: string; stages: any[] } }) =>
      runAgentSingleSession(input.taskId, input)),
    runPipelineCall: loggedActor("pipeline-call", (input: { taskId: string; stageName: string; context: WorkflowContext; runtime: PipelineCallRuntimeConfig }) =>
      runPipelineCall(input.taskId, input)),
    runForeach: loggedActor("foreach", (input: { taskId: string; stageName: string; context: WorkflowContext; runtime: ForeachRuntimeConfig }) =>
      runForeach(input.taskId, input)),
    runLlmDecision: loggedActor("llm-decision", (input: { taskId: string; stageName: string; context: WorkflowContext; runtime: LlmDecisionRuntimeConfig }) =>
      runLlmDecision(input.taskId, input)),
  },
});

export function createWorkflowMachine(pipeline: PipelineConfig) {
  if (!pipeline.stages.length) {
    throw new Error("Pipeline must have at least one stage");
  }

  const pipelineStates = buildPipelineStates(pipeline);
  const { retryable, resumable } = derivePipelineLists(pipeline);
  const firstEntry = pipeline.stages[0];
  const firstStage = isParallelGroup(firstEntry) ? firstEntry.parallel.name : firstEntry.name;

  // Build child stage → group name mapping for RETRY/RESUME routing
  const childToGroup = new Map<string, string>();
  for (const entry of pipeline.stages) {
    if (isParallelGroup(entry)) {
      for (const s of entry.parallel.stages) {
        childToGroup.set(s.name, entry.parallel.name);
      }
    }
  }

  return workflowSetup.createMachine({
    id: "workflow",
    initial: "idle",
    context: {
      taskId: "",
      status: "idle",
      retryCount: 0,
      qaRetryCount: 0,
      stageRetryCount: {},
      stageSessionIds: {},
      store: {},
      scratchPad: [],
    },
    on: {
      CANCEL: {
        target: ".cancelled",
        guard: ({ context }) => context.status !== "cancelled",
        actions: [
          assign(({ context }) => ({
            lastStage: context.status === "blocked" ? (context.lastStage ?? context.status) : context.status,
            updatedAt: new Date().toISOString(),
          })),
          emit(({ context }): WorkflowEmittedEvent => ({
            type: "wf.cancelAgent",
            taskId: context.taskId,
          })),
        ],
      },
      INTERRUPT: {
        target: ".blocked",
        guard: ({ context }) => {
          const isGuardMatch = !["idle", "completed", "error", "cancelled", "blocked"].includes(context.status);
          taskLogger(context.taskId, "machine").info({ status: context.status, isGuardMatch }, "Top-level INTERRUPT event received");
          return isGuardMatch;
        },
        actions: [
          assign(({ context, event }) => ({
            lastStage: context.status,
            error: ("reason" in event ? (event as { reason?: string }).reason : undefined) || "Interrupted by user",
            errorCode: "interrupted" as const,
            updatedAt: new Date().toISOString(),
          })),
          emit(({ context }): WorkflowEmittedEvent => ({
            type: "wf.cancelAgent",
            taskId: context.taskId,
          })),
          ({ context }) => {
            taskLogger(context.taskId).info({ from: context.status, error: context.error }, "Transitioning to blocked due to INTERRUPT event");
          },
        ],
      },
      UPDATE_CONFIG: {
        actions: [
          ({ context }) => { taskLogger(context.taskId).info("Processing UPDATE_CONFIG event..."); },
          assign({
            config: ({ context, event }) => {
              if (!context.config) return context.config;
              return {
                ...context.config,
                ...("config" in event ? (event as { config: Partial<NonNullable<WorkflowContext["config"]>> }).config : {}),
              };
            },
            updatedAt: () => new Date().toISOString(),
          }),
          ({ context }) => { taskLogger(context.taskId).info("Task configuration UPDATED successfully"); }
        ]
      },
    },
    states: {
      idle: {
        on: {
          START_ANALYSIS: {
            actions: assign(({ event }) => ({
              taskId: event.taskId,
              taskText: event.taskText,
              explicitRepoName: event.repoName,
              updatedAt: new Date().toISOString(),
              retryCount: 0,
              qaRetryCount: 0,
              stageRetryCount: {},
              config: event.config,
              ...(event.initialStore ? { store: event.initialStore } : {}),
              ...(event.worktreePath ? { worktreePath: event.worktreePath } : {}),
              ...(event.branch ? { branch: event.branch } : {}),
            })),
          },
          LAUNCH: {
            target: firstStage,
          },
        },
      },

      ...pipelineStates,

      completed: {
        type: "final",
        entry: [
          assign({ status: "completed" as const }),
          emitNotionSync(),
          emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => {
            const summaryPath = pipeline.display?.completion_summary_path;
            const summary = summaryPath ? getNestedValue(context.store, summaryPath) : undefined;
            return {
              type: "wf.status",
              taskId: context.taskId,
              status: "completed",
              message: `Deliverable: ${summary ?? "(none)"}. Workflow complete.`,
            };
          }),
          emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
            type: "wf.streamClose",
            taskId: context.taskId,
          })),
          emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
            type: "wf.cancelQuestions",
            taskId: context.taskId,
          })),
          emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => {
            const summaryPath = pipeline.display?.completion_summary_path;
            const summary = summaryPath ? getNestedValue(context.store, summaryPath) : undefined;
            return {
              type: "wf.slackCompleted",
              taskId: context.taskId,
              deliverable: summary ?? "",
            };
          }),
          emitTaskListUpdate(),
          emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
            type: "wf.worktreeCleanup",
            taskId: context.taskId,
            worktreePath: context.worktreePath ?? "",
          })),
        ],
      },

      error: {
        type: "final",
        entry: [
          assign({ status: "error" as const }),
          emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
            type: "wf.streamClose",
            taskId: context.taskId,
          })),
          emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
            type: "wf.cancelQuestions",
            taskId: context.taskId,
          })),
          emitNotionSync(),
          emitTaskListUpdate(),
        ],
      },

      blocked: {
        entry: [
          ...statusEntry("blocked"),
          emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
            type: "wf.status",
            taskId: context.taskId,
            status: "blocked",
            message: `Blocked at ${context.lastStage}: ${context.error}`,
          })),
        ],
        on: {
          RETRY: [
            ...(retryable.map((s) => ({
              target: childToGroup.get(s) ?? s,
              guard: ({ context }: { context: WorkflowContext }) => context.lastStage === s,
              actions: assign(({ context }: { context: WorkflowContext }) => {
                const sessionId = context.stageSessionIds[s];
                return {
                  retryCount: 0, error: undefined, errorCode: undefined,
                  qaRetryCount: 0,
                  stageRetryCount: {},
                  resumeInfo: sessionId ? { sessionId, feedback: "The system or user triggered a retry. Please inspect the current state and attempt to resolve any previous issues." } : undefined,
                };
              }),
            })) as any[]),
            {
              actions: [
                ({ context }) => {
                  taskLogger(context.taskId).error({ lastStage: context.lastStage }, "RETRY: unknown lastStage");
                },
                emit(({ context }): WorkflowEmittedEvent => ({
                  type: "wf.error",
                  taskId: context.taskId,
                  error: `Cannot retry from stage "${context.lastStage}". Stage is not retryable.`,
                })),
              ],
            },
          ],
          RETRY_FROM: [
            ...(retryable.map((s) => ({
              target: childToGroup.get(s) ?? s,
              guard: ({ event }: { event: { type: "RETRY_FROM"; fromStage: string } }) => event.fromStage === s,
              actions: [
                ({ context }: { context: WorkflowContext }) => {
                  const pipeline = context.config?.pipeline;
                  if (!pipeline) return;
                  const allStages = pipeline.stages.flatMap((entry: any) =>
                    entry.parallel ? entry.parallel.stages : [entry]
                  );
                  const stageConfig = allStages.find((st: any) => st.name === s);
                  const compensation = stageConfig?.runtime?.compensation;
                  if (compensation?.strategy && compensation.strategy !== "none") {
                    const meta = context.stageCheckpoints?.[s];
                    if (meta?.gitHead) {
                      const result = runCompensation(compensation.strategy, meta.gitHead, context.worktreePath);
                      taskLogger(context.taskId).info(
                        { stage: s, strategy: compensation.strategy, success: result.success },
                        "RETRY_FROM compensation"
                      );
                    }
                  }
                },
                assign(({ context }: { context: WorkflowContext }) => {
                  const sessionId = context.stageSessionIds[s];
                  const resetCounts = { ...(context.stageRetryCount ?? {}) };
                  // Reset target stage and all stages after it
                  const allStages = context.config?.pipeline?.stages
                    ? flattenStages(context.config.pipeline.stages).map(st => st.name)
                    : [];
                  const targetIdx = allStages.indexOf(s);
                  if (targetIdx >= 0) {
                    for (let i = targetIdx; i < allStages.length; i++) {
                      delete resetCounts[allStages[i]];
                    }
                  }
                  return {
                    retryCount: 0, error: undefined, errorCode: undefined,
                    qaRetryCount: 0,
                    stageRetryCount: resetCounts,
                    verifyRetryCount: {},
                    lastStage: s,
                    resumeInfo: sessionId ? { sessionId, feedback: `User requested retry from stage "${s}". Please inspect the current state and attempt to resolve any previous issues.` } : undefined,
                  };
                }),
              ],
            })) as any[]),
            {
              actions: [
                ({ context, event }) => {
                  taskLogger(context.taskId).error({ fromStage: (event as any).fromStage }, "RETRY_FROM: unknown or non-retryable stage");
                },
                emit(({ context, event }): WorkflowEmittedEvent => ({
                  type: "wf.error",
                  taskId: context.taskId,
                  error: `Cannot retry from stage "${(event as any).fromStage}". Stage is not retryable or does not exist.`,
                })),
              ],
            },
          ],
          SYNC_RETRY: [
            ...(retryable.map((s) => ({
              target: childToGroup.get(s) ?? s,
              guard: ({ context }: { context: WorkflowContext }) => context.lastStage === s,
              actions: assign(({ event }: { event: { sessionId: string } }) => ({
                retryCount: 0, error: undefined, errorCode: undefined,
                qaRetryCount: 0,
                stageRetryCount: {},
                resumeInfo: { sessionId: event.sessionId, sync: true },
              })),
            })) as any[]),
          ],
        },
      },

      cancelled: {
        entry: [
          ...statusEntry("cancelled"),
          emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
            type: "wf.status",
            taskId: context.taskId,
            status: "cancelled",
            message: "Task cancelled by user.",
          })),
          emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
            type: "wf.cancelQuestions",
            taskId: context.taskId,
          })),
          emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
            type: "wf.slackCancelled",
            taskId: context.taskId,
          })),
        ],
        on: {
          RESUME: [
            ...(resumable.map((s) => ({
              target: childToGroup.get(s) ?? s,
              guard: ({ context }: { context: WorkflowContext }) => context.lastStage === s,
              actions: assign(({ context }: { context: WorkflowContext }) => {
                const sessionId = context.stageSessionIds[s];
                return {
                  retryCount: 0, error: undefined, errorCode: undefined,
                  qaRetryCount: 0,
                  stageRetryCount: {},
                  resumeInfo: sessionId ? { sessionId, feedback: "Task was cancelled and is now being resumed. Please inspect the current state and continue from where you left off." } : undefined,
                };
              }),
            })) as any[]),
            {
              actions: [
                ({ context }) => {
                  taskLogger(context.taskId).error({ lastStage: context.lastStage }, "RESUME: unknown lastStage");
                },
                emit(({ context }): WorkflowEmittedEvent => ({
                  type: "wf.error",
                  taskId: context.taskId,
                  error: `Cannot resume from stage "${context.lastStage}". Stage is not resumable.`,
                })),
              ],
            },
          ],
        },
      },
    },
  });
}
