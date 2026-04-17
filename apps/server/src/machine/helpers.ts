import { fromPromise, assign, emit } from "xstate";
import type { TaskStatus } from "../types/index.js";
import type { WorkflowContext } from "./types.js";
import type { WorkflowEmittedEvent } from "./events.js";
import { getGitHead, runCompensation } from "./git-checkpoint.js";
import { getNestedValue, flattenStages, isParallelGroup } from "../lib/config-loader.js";
import { taskLogger } from "../lib/logger.js";
import { AgentError } from "../agent/query-tracker.js";
import { stableHash } from "../lib/stable-hash.js";

// XState emit() returns an ActionFunction with 9 generic parameters that are only
// correctly inferred inside setup().createMachine(). External factory functions cannot
// participate in that inference chain, so we use a branded escape hatch that is
// narrower than `any` but still assignable to XState's internal action slots.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EmitAction = ReturnType<typeof emit<any, any, any, any, any>>;

export const MAX_STAGE_RETRIES = 2;

interface ErrorActionArgs {
  context: WorkflowContext;
  event: { type: string; error: unknown };
}

// --- Notion status (pure function) ---

export function getNotionStatusLabel(status: string, pipelineStages?: { name: string; type?: string; notion_label?: string }[] | unknown[]): string {
  const terminalMap: Record<string, string> = {
    completed: "待验收",
    blocked: "阻塞",
    cancelled: "已取消",
    error: "阻塞",
  };
  if (terminalMap[status]) return terminalMap[status];

  if (pipelineStages) {
    // Flatten parallel groups for lookup
    const flat: { name: string; type?: string; notion_label?: string }[] = [];
    const groupNames = new Set<string>();
    for (const entry of pipelineStages as any[]) {
      if (entry && typeof entry === "object" && "parallel" in entry) {
        groupNames.add(entry.parallel.name);
        for (const s of entry.parallel.stages) flat.push(s);
      } else {
        flat.push(entry);
      }
    }
    if (groupNames.has(status)) return "执行中";
    const stage = flat.find(s => s.name === status);
    if (stage?.notion_label) return stage.notion_label;
    if (stage?.type === "human_confirm") return "待确认";
  }
  return "执行中";
}

// --- Emit factories ---

export function emitStatus(status: string, message?: string): EmitAction {
  return emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
    type: "wf.status",
    taskId: context.taskId,
    status,
    message,
  }));
}

export function emitError(errorMsg: string | ((ctx: WorkflowContext) => string)): EmitAction {
  return emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
    type: "wf.error",
    taskId: context.taskId,
    error: typeof errorMsg === "function" ? errorMsg(context) : errorMsg,
  }));
}

export function emitNotionSync(): EmitAction {
  return emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => {
    const notionPath = context.config?.pipeline?.integrations?.notion_page_id_path;
    const notionPageId = notionPath ? getNestedValue(context.store, notionPath) : undefined;
    return {
      type: "wf.notionSync",
      taskId: context.taskId,
      status: context.status,
      notionPageId,
      pipelineStages: context.config?.pipeline?.stages as unknown[] | undefined,
    };
  });
}

export function emitTaskListUpdate(): EmitAction {
  return emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
    type: "wf.taskListUpdate",
    taskId: context.taskId,
  }));
}

export function emitPersistSession(): EmitAction {
  return emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
    type: "wf.persistSession",
    worktreePath: context.worktreePath,
    sessionId: getLatestSessionId(context),
  }));
}

// --- Status entry ---

export function statusEntry(stateName: string): EmitAction[] {
  return [
    assign({
      status: stateName,
      updatedAt: () => new Date().toISOString(),
    }),
    assign(({ context }: { context: WorkflowContext }) => {
      // Capture readsSnapshot for incremental diff on resume
      const stageConfig = context.config?.pipeline?.stages
        ? flattenStages(context.config.pipeline.stages).find((s) => s.name === stateName)
        : undefined;
      const reads = (stageConfig?.runtime as { reads?: Record<string, string> } | undefined)?.reads;
      let readsSnapshot: Record<string, string> | undefined;
      if (reads) {
        readsSnapshot = {};
        for (const [, rawPath] of Object.entries(reads)) {
          const storePath = rawPath.startsWith("store.") ? rawPath.slice(6) : rawPath;
          const rootKey = storePath.split(".")[0];
          if (context.store[rootKey] !== undefined) {
            readsSnapshot[rootKey] = stableHash(context.store[rootKey]);
          }
        }
      }
      return {
        stageCheckpoints: {
          ...context.stageCheckpoints,
          [stateName]: {
            gitHead: getGitHead(context.worktreePath),
            startedAt: new Date().toISOString(),
            ...(readsSnapshot ? { readsSnapshot } : {}),
          },
        },
      };
    }),
    emitNotionSync(),
    emitStatus(stateName),
    emitTaskListUpdate(),
  ];
}

// --- Session ID helper ---

export function getLatestSessionId(context: WorkflowContext): string | undefined {
  const ids = context.stageSessionIds;
  if (!ids) return undefined;

  if (context.config?.pipeline?.stages) {
    const stages = flattenStages(context.config.pipeline.stages);
    for (let i = stages.length - 1; i >= 0; i--) {
      if (ids[stages[i].name]) return ids[stages[i].name];
    }
  }

  let latest: string | undefined;
  for (const key of Object.keys(ids)) {
    if (ids[key]) latest = ids[key];
  }
  return latest;
}

// --- Error handler ---

export interface StageRetryConfig {
  max_retries?: number;
  max_attempts?: number;
  back_to?: string;
}

export function handleStageError(stateName: string, retryConfig?: StageRetryConfig, opts?: { blockedTarget?: string; statePrefix?: string }) {
  const blockedTarget = opts?.blockedTarget ?? "blocked";
  // When inside a parallel group, back_to targets external states and need absolute references
  const prefix = opts?.statePrefix ?? "";
  return [
    {
      target: blockedTarget,
      guard: ({ context }: { context: WorkflowContext }) => {
        const isInterrupted = context.errorCode === "interrupted";
        if (isInterrupted) {
          taskLogger(context.taskId, "machine:error").info({ stage: stateName, error: context.error }, "Guard matched: Interruption detected, skipping retry");
        }
        return isInterrupted;
      },
      actions: ({ context }: { context: WorkflowContext }) => {
        taskLogger(context.taskId).info({ stage: stateName }, "Redirecting to blocked due to interruption");
      }
    },
    {
      target: stateName,
      // reenter: true forces XState to exit and re-enter the state, restarting the invoked actor.
      // Without this, XState v5 treats self-transitions as internal (no re-entry), so the actor never restarts.
      reenter: true,
      guard: ({ context, event }: { context: WorkflowContext; event: { error: unknown } }) => {
        // Agent reported an explicit error status (quota exhausted, auth failure, etc.) — retrying won't help
        if (event.error instanceof AgentError && event.error.agentStatus === "error") {
          taskLogger(context.taskId, "machine:error").info({ stage: stateName, agentStatus: event.error.agentStatus }, "Terminal agent error, skipping retry");
          return false;
        }
        const maxAttempts = retryConfig?.max_attempts ?? MAX_STAGE_RETRIES;
        const canRetry = context.retryCount < maxAttempts;
        taskLogger(context.taskId, "machine:error").info({ stage: stateName, retryCount: context.retryCount, canRetry }, "Error caught in stage");
        return canRetry;
      },
      actions: [
        assign(({ context, event }: ErrorActionArgs) => {
          const errorMsg = event.error instanceof Error ? event.error.message : String(event.error);
          const sessionId = context.stageSessionIds?.[stateName];
          // Strip any existing "[Prior attempt failed: ...]" prefix so cumulative
          // retries across different retry kinds don't produce nested prefixes.
          const prev = context.resumeInfo?.feedback;
          const stripped = prev?.replace(/^\[Prior attempt failed: [^\]]*\]\s*\n\n/, "");
          const priorFeedback = stripped
            ? `[Prior attempt failed: ${stripped.slice(0, 300)}]\n\n`
            : "";
          return {
            retryCount: context.retryCount + 1,
            scratchPad: [...(context.scratchPad ?? [])],
            resumeInfo: sessionId
              ? { sessionId, feedback: `${priorFeedback}Previous attempt failed with error: ${errorMsg.slice(0, 1500)}. Please inspect the current state and fix the issue.` }
              : undefined,
          };
        }),
        ({ event, context }: ErrorActionArgs) => {
          const errorMsg = event.error instanceof Error ? event.error.message : String(event.error);
          taskLogger(context.taskId).warn({ stage: stateName, retryCount: context.retryCount, error: errorMsg, hasResume: !!context.resumeInfo }, "stage failed, retrying");
        },
        emit(({ event, context }: ErrorActionArgs): WorkflowEmittedEvent => {
          const errorMsg = event.error instanceof Error ? event.error.message : String(event.error);
          return {
            type: "wf.status",
            taskId: context.taskId,
            status: context.status,
            message: `Retrying ${stateName} (attempt ${context.retryCount}): ${errorMsg.slice(0, 100)}`,
          };
        }),
      ],
    },
    ...(retryConfig?.back_to ? [{
      target: prefix ? `${prefix}.${retryConfig.back_to}` : retryConfig.back_to,
      guard: ({ context }: { context: WorkflowContext }) => {
        const loopCount = context.qaRetryCount ?? 0;
        const maxLoops = retryConfig!.max_retries ?? 2;
        return loopCount < maxLoops;
      },
      actions: [
        assign(({ event, context }: ErrorActionArgs) => {
          const errorMsg = event.error instanceof Error ? event.error.message : String(event.error);
          const targetSessionId = context.stageSessionIds?.[retryConfig!.back_to!];
          return {
            error: errorMsg,
            lastStage: stateName,
            retryCount: 0,
            qaRetryCount: (context.qaRetryCount ?? 0) + 1,
            scratchPad: [...(context.scratchPad ?? [])],
            resumeInfo: targetSessionId
              ? { sessionId: targetSessionId, feedback: `Stage "${stateName}" failed after retries: ${errorMsg.slice(0, 1500)}. Please fix the underlying issue.` }
              : undefined,
          };
        }),
        ({ context }: { context: WorkflowContext }) => {
          taskLogger(context.taskId).warn({ stage: stateName, backTo: retryConfig!.back_to, qaRetryCount: context.qaRetryCount }, `Routing to ${retryConfig!.back_to} after retries exhausted`);
        },
        emit(({ context }: { context: WorkflowContext }): WorkflowEmittedEvent => ({
          type: "wf.status",
          taskId: context.taskId,
          status: context.status,
          message: `${stateName} failed, routing back to ${retryConfig!.back_to} (loop ${context.qaRetryCount}/${retryConfig!.max_retries ?? 2})`,
        })),
      ],
    }] : []),
    {
      target: blockedTarget,
      actions: [
        // Compensation runs inside assign() because failure records must be written to context.
        // runCompensation() is sync with a 5s timeout — acceptable here since this only
        // executes on the terminal blocked path after all retries are exhausted.
        assign(({ event, context }: ErrorActionArgs) => {
          const errorMsg = event.error instanceof Error ? event.error.message : String(event.error);

          let compensationFailures = context.compensationFailures;
          const pipeline = context.config?.pipeline;
          if (pipeline) {
            const allStages = pipeline.stages.flatMap((entry: any) =>
              entry.parallel ? entry.parallel.stages : [entry]
            );
            const stageConfig = allStages.find((s: any) => s.name === stateName);
            const compensation = stageConfig?.runtime?.compensation;
            if (compensation?.strategy && compensation.strategy !== "none") {
              const meta = context.stageCheckpoints?.[stateName];
              const result = runCompensation(compensation.strategy, meta?.gitHead, context.worktreePath);
              if (result.success) {
                taskLogger(context.taskId).info({ stage: stateName, strategy: compensation.strategy }, "compensation executed");
              } else {
                taskLogger(context.taskId).warn({ stage: stateName, error: result.error }, "compensation failed (non-blocking)");
                compensationFailures = [
                  ...(context.compensationFailures ?? []),
                  { stage: stateName, strategy: compensation.strategy, error: result.error ?? "unknown", timestamp: new Date().toISOString() },
                ];
              }
            }
          }

          return {
            error: errorMsg,
            lastStage: stateName,
            scratchPad: [...(context.scratchPad ?? [])],
            compensationFailures,
          };
        }),
        emit(({ event, context }: ErrorActionArgs): WorkflowEmittedEvent => {
          const errorMsg = event.error instanceof Error ? event.error.message : String(event.error);
          return { type: "wf.error", taskId: context.taskId, error: errorMsg };
        }),
        emit(({ event, context }: ErrorActionArgs): WorkflowEmittedEvent => {
          const errorMsg = event.error instanceof Error ? event.error.message : String(event.error);
          return { type: "wf.slackBlocked", taskId: context.taskId, stage: stateName, error: errorMsg };
        }),
      ],
    },
  ];
}

// --- Logged actor wrapper ---

export function loggedActor<T, I extends { taskId: string }>(stage: string, fn: (input: I) => Promise<T>) {
  return fromPromise<T, I>(async ({ input }) => {
    try { return await fn(input); }
    catch (err) { taskLogger(input.taskId, stage).error({ err }, "actor threw"); throw err; }
  });
}
