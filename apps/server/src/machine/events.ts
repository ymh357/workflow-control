import type { StageTokenUsage } from "@workflow-control/shared";

export type WorkflowEmittedEvent =
  | { type: "wf.status"; taskId: string; status: string; message?: string }
  | { type: "wf.error"; taskId: string; error: string }
  | { type: "wf.costUpdate"; taskId: string; totalCostUsd: number; stageCostUsd: number; stageTokenUsage?: StageTokenUsage }
  | { type: "wf.streamClose"; taskId: string }
  | { type: "wf.notionSync"; taskId: string; status: string; notionPageId?: string; pipelineStages?: unknown[] }
  | { type: "wf.stageBlocked"; taskId: string; stage: string; error: string }
  | { type: "wf.taskListUpdate"; taskId: string }
  | { type: "wf.persistSession"; worktreePath?: string; sessionId?: string }
  | { type: "wf.cancelAgent"; taskId: string }
  | { type: "wf.cancelQuestions"; taskId: string }
  | { type: "wf.worktreeCleanup"; taskId: string; worktreePath: string };
