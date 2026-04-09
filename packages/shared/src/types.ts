// --- Token Usage ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens?: number; // Claude only
  totalTokens: number;
}

export interface ModelTokenUsage extends TokenUsage {
  modelName: string;
  costUsd?: number;
}

export interface StageTokenUsage extends TokenUsage {
  modelBreakdown?: ModelTokenUsage[];
}

// --- Task Status (matches XState states) ---

export type TaskStatus = "idle" | "blocked" | "cancelled" | "completed" | "error" | (string & {});

// --- Task ---

export interface Task {
  id: string;
  taskText?: string;
  status: string;
  currentStage?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  branch?: string;
  worktreePath?: string;
  store: Record<string, any>;
  error?: string;
}

// --- SSE Messages ---

export type SSEMessageType =
  | "status"
  | "stage_change"
  | "stage_cwd"
  | "agent_text"
  | "agent_tool_use"
  | "agent_thinking"
  | "agent_tool_result"
  | "agent_progress"
  | "result"
  | "question"
  | "question_timeout_warning"
  | "cost_update"
  | "error"
  | "user_message"
  | "agent_red_flag";

export interface SSEMessage {
  type: SSEMessageType;
  taskId: string;
  timestamp: string;
  data: unknown;
}

export interface SSEStatusMessage extends SSEMessage {
  type: "status";
  data: { status: TaskStatus; message?: string };
}

export interface SSEStageChangeMessage extends SSEMessage {
  type: "stage_change";
  data: { stage: string; previousStage?: string };
}

export interface SSEAgentTextMessage extends SSEMessage {
  type: "agent_text";
  data: { text: string };
}

export interface SSEAgentToolUseMessage extends SSEMessage {
  type: "agent_tool_use";
  data: { toolName: string; input: Record<string, unknown> };
}

export interface SSEResultMessage extends SSEMessage {
  type: "result";
  data: { result: unknown; costUsd: number; durationMs: number; sessionId?: string; tokenUsage?: StageTokenUsage };
}

export interface SSEQuestionMessage extends SSEMessage {
  type: "question";
  data: {
    questionId: string;
    question: string;
    options?: string[];
  };
}

export interface SSEErrorMessage extends SSEMessage {
  type: "error";
  data: { error: string };
}

export interface SSEAgentThinkingMessage extends SSEMessage {
  type: "agent_thinking";
  data: { text: string };
}

export interface SSEAgentToolResultMessage extends SSEMessage {
  type: "agent_tool_result";
  data: { text: string };
}

export interface SSEAgentProgressMessage extends SSEMessage {
  type: "agent_progress";
  data: { toolCallCount: number; phase: string };
}

export interface SSECostUpdateMessage extends SSEMessage {
  type: "cost_update";
  data: { totalCostUsd: number; stageCostUsd?: number; stageTokenUsage?: StageTokenUsage };
}

export interface SSEQuestionTimeoutWarningMessage extends SSEMessage {
  type: "question_timeout_warning";
  data: { remainingMs: number };
}

export interface SSEUserMessageMessage extends SSEMessage {
  type: "user_message";
  data: { text: string };
}

export interface SSERedFlagMessage extends SSEMessage {
  type: "agent_red_flag";
  data: {
    flags: Array<{
      category: string;
      description: string;
      matched: string;
    }>;
  };
}

// --- Task Summary (used by task list SSE) ---

export interface TaskSummary {
  id: string;
  taskText?: string;
  status: string;
  currentStage?: string;
  sessionId?: string;
  branch?: string;
  error?: string;
  totalCostUsd: number;
  store: Record<string, unknown>;
  displayTitle: string;
  updatedAt: string;
  pendingQuestion?: boolean;
}

export interface FailedRestoreSummary {
  id: string;
  reason: string;
}

// --- Task Detail (used by task detail endpoint) ---

export interface TaskDetail {
  id: string;
  taskText?: string;
  status: string;
  updatedAt?: string;
  currentStage?: string;
  sessionId?: string;
  branch?: string;
  worktreePath?: string;
  error?: string;
  retryCount?: number;
  stageSessionIds?: Record<string, string>;
  stageCwds?: Record<string, string>;
  pendingQuestion?: { questionId: string; question: string; options?: string[] };
  totalCostUsd: number;
  totalTokenUsage?: TokenUsage;
  stageTokenUsages?: Record<string, StageTokenUsage>;
  config?: unknown;
  store: Record<string, unknown>;
  pipelineSchema?: unknown[];
  displayTitle: string;
  completionSummary?: string;
}

// --- Task List SSE Events ---

export type TaskListSSEEvent =
  | { type: "task_list_init"; tasks: TaskSummary[]; failedRestores?: FailedRestoreSummary[] }
  | { type: "task_updated"; task: TaskSummary }
  | { type: "task_removed"; taskId: string };

// --- API Request/Response ---

export interface CreateTaskRequest {
  taskText: string;
  repoName?: string; // explicit repo binding; if omitted, AI extracts from ticket content
  pipelineName?: string; // pipeline to use; defaults to "pipeline-generator"
  edge?: boolean; // run task on edge workers instead of local agent
}

export interface CreateTaskResponse {
  taskId: string;
}

export interface AnswerRequest {
  questionId: string;
  answer: string;
}

// Keep backward compat aliases
export type TriggerRequest = CreateTaskRequest;
export type TriggerResponse = CreateTaskResponse;

// --- Dynamic Script Types ---

export interface ScriptInput {
  cwd: string;
  store: Record<string, any>;
  args?: Record<string, any>;
  taskId: string;
}

export interface ScriptResult {
  success: boolean;
  [key: string]: any;
}
