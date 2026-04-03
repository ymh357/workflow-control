// Unified config loader for YAML pipelines, MCP registry, and prompt files.
// All loaders return null when the config file is missing — callers handle the absence gracefully.

export interface FragmentMeta {
  id: string;
  keywords: string[];
  stages: string[] | "*";
  always: boolean;
}

export interface SubAgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: "sonnet" | "opus" | "haiku" | "inherit";
  maxTurns?: number;
  skills?: string[];
  mcpServers?: (string | Record<string, unknown>)[];
}

export interface AgentRuntimeConfig {
  engine: "llm";
  system_prompt: string;
  writes?: string[];
  reads?: Record<string, string>;
  enabled_steps_path?: string;
  available_steps?: { key: string; label: string }[];
  agents?: Record<string, SubAgentDefinition>;
  disallowed_tools?: string[];
  retry?: {
    max_retries?: number;
    back_to?: string;
  };
}

export interface ScriptRuntimeConfig {
  engine: "script";
  script_id: string;
  writes?: string[];
  args?: Record<string, unknown>;
  reads?: Record<string, string>;
  timeout_sec?: number;
  retry?: {
    max_retries?: number;
    back_to?: string;
  };
}

export interface HumanGateRuntimeConfig {
  engine: "human_gate";
  notify?: {
    type: "slack";
    template: string;
  };
  on_approve_to?: string;
  on_reject_to?: string;
  max_feedback_loops?: number;
}

export interface ConditionBranch {
  when?: string;
  default?: true;
  to: string;
}

export interface ConditionRuntimeConfig {
  engine: "condition";
  branches: ConditionBranch[];
  converge_to?: string;
}

export interface PipelineCallRuntimeConfig {
  engine: "pipeline";
  pipeline_name: string;
  reads?: Record<string, string>;
  writes?: string[];
  timeout_sec?: number;
}

export interface ForeachRuntimeConfig {
  engine: "foreach";
  items: string;
  item_var: string;
  max_concurrency?: number;
  pipeline_name: string;
  reads?: Record<string, string>;
  collect_to?: string;
  item_writes?: string[];
  on_item_error?: "fail_fast" | "continue";
  isolation?: "shared" | "worktree";
  auto_commit?: boolean;
}

export type StageRuntimeConfig =
  | AgentRuntimeConfig
  | ScriptRuntimeConfig
  | HumanGateRuntimeConfig
  | ConditionRuntimeConfig
  | PipelineCallRuntimeConfig
  | ForeachRuntimeConfig;

// --- Output Schema Types ---

export interface OutputFieldSchema {
  key: string;
  type: "string" | "number" | "boolean" | "string[]" | "object" | "object[]" | "markdown";
  description: string;
  fields?: OutputFieldSchema[];
  display_hint?: "link" | "badge" | "code";
  hidden?: boolean;
}

export interface StageOutputSchema {
  [storeName: string]: {
    type: "object";
    label?: string;
    fields: OutputFieldSchema[];
    hidden?: boolean;
  };
}

export interface PipelineStageConfig {
  name: string;
  type: "agent" | "script" | "human_confirm" | "condition" | "pipeline" | "foreach";
  engine?: "claude" | "gemini" | "codex";
  model?: string;
  thinking?: { type: string };
  effort?: "low" | "medium" | "high" | "max";
  permission_mode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  debug?: boolean;
  max_turns?: number;
  max_budget_usd?: number;
  mcps?: string[];
  notion_label?: string;
  interactive?: boolean;
  execution_mode?: "auto" | "edge" | "any";
  runtime?: StageRuntimeConfig;
  outputs?: StageOutputSchema;
  on_complete?: {
    notify?: string;
  };
}

// Narrowed stage config types for type-safe builders
export type AgentStageConfig = PipelineStageConfig & { runtime: AgentRuntimeConfig };
export type ScriptStageConfig = PipelineStageConfig & { runtime: ScriptRuntimeConfig };
export type HumanGateStageConfig = PipelineStageConfig & { runtime: HumanGateRuntimeConfig };
export type ConditionStageConfig = PipelineStageConfig & { runtime: ConditionRuntimeConfig };
export type PipelineCallStageConfig = PipelineStageConfig & { runtime: PipelineCallRuntimeConfig };
export type ForeachStageConfig = PipelineStageConfig & { runtime: ForeachRuntimeConfig };

// --- Parallel Group ---

export interface ParallelGroupConfig {
  parallel: {
    name: string;
    stages: PipelineStageConfig[];
  };
}

export type PipelineStageEntry = PipelineStageConfig | ParallelGroupConfig;

export function isParallelGroup(entry: PipelineStageEntry): entry is ParallelGroupConfig {
  return "parallel" in entry;
}

export function flattenStages(entries: PipelineStageEntry[]): PipelineStageConfig[] {
  const result: PipelineStageConfig[] = [];
  for (const e of entries) {
    if (isParallelGroup(e)) {
      result.push(...e.parallel.stages);
    } else {
      result.push(e);
    }
  }
  return result;
}

export interface PipelineConfig {
  name: string;
  description?: string;
  engine?: "claude" | "gemini" | "codex" | "mixed";
  use_cases?: string[];
  default_execution_mode?: "auto" | "edge";
  official?: boolean;
  stages: PipelineStageEntry[];
  hooks?: string[];
  skills?: string[];
  claude_md?: { global?: string };
  gemini_md?: { global?: string };
  codex_md?: { global?: string };
  display?: { title_path?: string; completion_summary_path?: string };
  integrations?: { notion_page_id_path?: string };
}

export interface PipelineManifest {
  id: string;
  name: string;
  description?: string;
  engine: "claude" | "gemini" | "codex" | "mixed";
  official?: boolean;
  stageCount?: number;
  totalBudget?: number;
  mcps?: string[];
  stageSummary?: string;
}

type McpEnvValue = string | { json: Record<string, string> };

export interface McpRegistryEntry {
  description?: string;
  command?: string;
  args?: string[];
  env?: Record<string, McpEnvValue>;
  gemini?: {
    command: string;
    args?: string[];
    env?: Record<string, McpEnvValue>;
  };
  codex?: {
    command: string;
    args?: string[];
    env?: Record<string, McpEnvValue>;
  };
}

export interface SandboxConfig {
  enabled?: boolean;
  auto_allow_bash?: boolean;
  allow_unsandboxed_commands?: boolean;
  network?: {
    allowed_domains?: string[];
  };
  filesystem?: {
    allow_write?: string[];
    deny_write?: string[];
    deny_read?: string[];
  };
}

export interface SystemSettings extends Record<string, any> {
  slack?: {
    bot_token?: string;
    notify_channel_id?: string;
    signing_secret?: string;
    app_token?: string;
  };
  paths?: {
    repos_base?: string;
    worktrees_base?: string;
    data_dir?: string;
    claude_executable?: string;
    gemini_executable?: string;
    codex_executable?: string;
  };
  agent?: {
    default_model?: string; // Legacy
    claude_model?: string;
    gemini_model?: string;
    codex_model?: string;
    default_engine?: "claude" | "gemini" | "codex";
    max_budget_usd?: number;
  };
  sandbox?: SandboxConfig;
}

export interface HookConfig {
  event: string;
  matcher?: string;
  type: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
  script?: string;
}

export interface GateCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface GateResult {
  passed: boolean;
  checks: GateCheck[];
}
