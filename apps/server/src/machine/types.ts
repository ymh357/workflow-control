import type { PipelineConfig, FragmentMeta, SandboxConfig } from "../lib/config-loader.js";
import type { TokenUsage, StageTokenUsage } from "@workflow-control/shared";

export interface StageCheckpoint {
  gitHead?: string;
  startedAt: string;
  readsSnapshot?: Record<string, string>;
}

export interface ScratchPadEntry {
  stage: string;
  timestamp: string;
  category: string;
  content: string;
}

export interface WorkflowContext {
  taskId: string;
  taskText?: string;
  explicitRepoName?: string;
  status: string;
  updatedAt?: string;
  retryCount: number;
  qaRetryCount: number;
  stageRetryCount?: Record<string, number>;
  verifyRetryCount?: Record<string, number>;
  extensionCount?: Record<string, number>;
  taskToken?: string;
  lastStage?: string;
  error?: string;
  errorCode?: "interrupted" | "timeout" | "agent_error";
  branch?: string;
  worktreePath?: string;
  store: Record<string, any>;
  scratchPad?: ScratchPadEntry[];
  totalCostUsd?: number;
  totalTokenUsage?: TokenUsage;
  stageTokenUsages?: Record<string, StageTokenUsage>;
  stageSessionIds: Record<string, string>;
  stageCwds?: Record<string, string>;
  stageCheckpoints?: Record<string, StageCheckpoint>;
  parallelDone?: Record<string, string[]>;
  completedStages?: string[];
  skippedStages?: string[];
  executionHistory?: Array<{ stage: string; action: "completed" | "skipped"; timestamp: string }>;
  foreachMeta?: { itemVar: string; parentTaskId: string; itemIndex: number };
  rejectIntoGroup?: { group: string; stage: string };
  parallelStagedWrites?: Record<string, Record<string, unknown>>;
  compensationFailures?: Array<{ stage: string; strategy: string; error: string; timestamp: string }>;
  resumeInfo?: { sessionId: string; feedback?: string; sync?: boolean };
  config?: {
    pipelineName: string;
    pipeline: PipelineConfig;
    prompts: {
      system: Record<string, string>;
      fragments: Record<string, string>;
      fragmentMeta?: Record<string, FragmentMeta>;
      globalConstraints: string;
      globalClaudeMd: string;
      globalGeminiMd: string;
      globalCodexMd: string;
    };
    skills: string[];
    mcps: string[];
    sandbox?: SandboxConfig;
    agent?: { default_engine?: string; claude_model?: string; gemini_model?: string; codex_model?: string };
  };
}

export type WorkflowEvent =
  | { type: "START_ANALYSIS"; taskId: string; taskText?: string; repoName?: string; config?: WorkflowContext["config"]; initialStore?: Record<string, any>; worktreePath?: string; branch?: string }
  | { type: "LAUNCH" }
  | { type: "INTERRUPT"; reason?: string }
  | { type: "UPDATE_CONFIG"; config: WorkflowContext["config"] }
  | { type: "CONFIRM"; repoName?: string }
  | { type: "REJECT"; reason?: string; targetStage?: string }
  | { type: "REJECT_WITH_FEEDBACK"; feedback: string; targetStage?: string }
  | { type: "RETRY" }
  | { type: "RETRY_FROM"; fromStage: string }
  | { type: "SYNC_RETRY"; sessionId: string }
  | { type: "CANCEL" }
  | { type: "RESUME" }
  | { type: "PERSIST_SESSION_ID"; stageName: string; sessionId: string }
  | { type: "APPEND_SCRATCH_PAD"; entry: ScratchPadEntry };

/** Terminal workflow states — no further stage transitions will occur. */
export const TERMINAL_STATES = new Set(["completed", "error", "cancelled"]);
