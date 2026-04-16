import { z, type ZodError } from "zod";
import type { PipelineConfig } from "./types.js";

// --- Fragment / SubAgent ---

export const FragmentMetaSchema = z.object({
  id: z.string(),
  keywords: z.array(z.string()),
  stages: z.union([z.array(z.string()), z.literal("*")]),
  always: z.boolean(),
});

export const SubAgentDefinitionSchema = z.object({
  description: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.enum(["sonnet", "opus", "haiku", "inherit"]).optional(),
  maxTurns: z.number().optional(),
  skills: z.array(z.string()).optional(),
  mcpServers: z
    .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
    .optional(),
});

// --- Retry ---

const RetrySchema = z.object({
  max_retries: z.number().optional(),
  max_attempts: z.number().optional(),
  back_to: z.string().optional(),
});

// --- Runtime configs (discriminated on `engine`) ---

const WriteDeclarationSchema = z.union([
  z.string(),
  z.object({
    key: z.string(),
    strategy: z.enum(["replace", "append", "merge"]).optional(),
    summary_prompt: z.string().optional(),
    assertions: z.array(z.string()).optional(),
  }),
]);

export const AgentRuntimeConfigSchema = z.object({
  engine: z.literal("llm"),
  system_prompt: z.string(),
  writes: z.array(WriteDeclarationSchema).optional(),
  reads: z.record(z.string(), z.string()).optional(),
  enabled_steps_path: z.string().optional(),
  available_steps: z
    .array(z.object({ key: z.string(), label: z.string() }))
    .optional(),
  agents: z.record(z.string(), SubAgentDefinitionSchema).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  compensation: z.object({
    strategy: z.enum(["git_reset", "git_stash", "none"]),
  }).optional(),
  retry: RetrySchema.optional(),
});

export const ScriptRuntimeConfigSchema = z.object({
  engine: z.literal("script"),
  script_id: z.string(),
  writes: z.array(WriteDeclarationSchema).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  reads: z.record(z.string(), z.string()).optional(),
  timeout_sec: z.number().optional(),
  compensation: z.object({
    strategy: z.enum(["git_reset", "git_stash", "none"]),
  }).optional(),
  retry: RetrySchema.optional(),
});

export const HumanGateRuntimeConfigSchema = z.object({
  engine: z.literal("human_gate"),
  notify: z
    .object({
      type: z.literal("slack"),
      template: z.string(),
    })
    .optional(),
  on_approve_to: z.string().optional(),
  on_reject_to: z.string().optional(),
  max_feedback_loops: z.number().optional(),
});

export const ConditionBranchSchema = z.object({
  when: z.string().optional(),
  default: z.literal(true).optional(),
  to: z.string().min(1),
}).refine(
  (b) => b.when !== undefined || b.default === true,
  { message: "Branch must have either 'when' or 'default: true'" }
);

export const ConditionRuntimeConfigSchema = z.object({
  engine: z.literal("condition"),
  branches: z.array(ConditionBranchSchema)
    .min(2, "Condition must have at least 2 branches")
    .refine(
      (branches) => branches.filter((b) => b.default).length <= 1,
      { message: "Condition can have at most one default branch" }
    ),
});

export const PipelineCallRuntimeConfigSchema = z.object({
  engine: z.literal("pipeline"),
  pipeline_name: z.string().min(1),
  reads: z.record(z.string(), z.string()).optional(),
  writes: z.array(WriteDeclarationSchema).optional(),
  timeout_sec: z.number().optional(),
});

export const ForeachRuntimeConfigSchema = z.object({
  engine: z.literal("foreach"),
  items: z.string().min(1),
  item_var: z.string().min(1),
  max_concurrency: z.number().int().min(1).optional(),
  pipeline_name: z.string().min(1),
  collect_to: z.string().optional(),
  item_writes: z.array(z.string()).optional(),
  on_item_error: z.enum(["fail_fast", "continue"]).optional(),
  isolation: z.enum(["shared", "worktree"]).optional(),
  auto_commit: z.boolean().optional(),
});

const LlmDecisionChoiceSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  goto: z.string().min(1),
});

export const LlmDecisionRuntimeConfigSchema = z.object({
  engine: z.literal("llm_decision"),
  prompt: z.string().min(1),
  reads: z.record(z.string(), z.string()).optional(),
  choices: z.array(LlmDecisionChoiceSchema).min(2, "Must have at least 2 choices"),
  default_choice: z.string().min(1),
}).refine(
  (data) => data.choices.some(c => c.id === data.default_choice),
  { message: "default_choice must match one of the choices[].id values" }
);

export const StageRuntimeConfigSchema = z.discriminatedUnion("engine", [
  AgentRuntimeConfigSchema,
  ScriptRuntimeConfigSchema,
  HumanGateRuntimeConfigSchema,
  ConditionRuntimeConfigSchema,
  PipelineCallRuntimeConfigSchema,
  ForeachRuntimeConfigSchema,
  LlmDecisionRuntimeConfigSchema,
]);

// --- Output Schema ---

export const OutputFieldSchema: z.ZodType<{
  key: string;
  type: "string" | "number" | "boolean" | "string[]" | "object" | "object[]" | "markdown";
  description: string;
  fields?: unknown[];
  display_hint?: "link" | "badge" | "code";
  hidden?: boolean;
}> = z.lazy(() =>
  z.object({
    key: z.string(),
    type: z.enum(["string", "number", "boolean", "string[]", "object", "object[]", "markdown"]),
    description: z.string(),
    fields: z.array(OutputFieldSchema).optional(),
    display_hint: z.enum(["link", "badge", "code"]).optional(),
    hidden: z.boolean().optional(),
  })
);

export const StageOutputSchemaSchema = z.record(
  z.string(),
  z.object({
    type: z.literal("object"),
    label: z.string().optional(),
    fields: z.array(OutputFieldSchema),
    hidden: z.boolean().optional(),
  })
);

// --- Pipeline Stage ---

export const PipelineStageConfigSchema = z.object({
  name: z.string(),
  type: z.enum(["agent", "script", "human_confirm", "condition", "pipeline", "foreach", "llm_decision"]),
  engine: z.enum(["claude", "gemini", "codex", "mixed"]).optional(),
  model: z.string().optional(),
  thinking: z.object({ type: z.string() }).optional(),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
  permission_mode: z
    .enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"])
    .optional(),
  debug: z.boolean().optional(),
  max_turns: z.number().optional(),
  max_budget_usd: z.number().optional(),
  mcps: z.array(z.string()).optional(),
  notion_label: z.string().optional(),
  interactive: z.boolean().optional(),
  execution_mode: z.enum(["auto", "edge", "any"]).optional(),
  runtime: StageRuntimeConfigSchema.optional(),
  outputs: StageOutputSchemaSchema.optional(),
  on_complete: z
    .object({
      notify: z.string().optional(),
    })
    .optional(),
  invariants: z.array(z.string()).optional(),
  verify_commands: z.array(z.string()).optional(),
  verify_policy: z.enum(["must_pass", "warn", "skip"]).optional(),
  verify_max_retries: z.number().int().min(0).optional(),
  depends_on: z.array(z.string()).optional(),
  stage_timeout_sec: z.number().int().min(1).max(86400).optional(),
});

// --- Parallel Group ---

export const ParallelGroupConfigSchema = z.object({
  parallel: z.object({
    name: z.string(),
    stages: z.array(PipelineStageConfigSchema).min(2),
  }),
});

export const PipelineStageEntrySchema = z.union([
  PipelineStageConfigSchema,
  ParallelGroupConfigSchema,
]);

// --- Store Persistence ---

const StorePersistenceSchema = z.object({
  inherit_from: z.enum(["last_completed", "none"]),
  inherit_keys: z.union([z.array(z.string()), z.literal("*")]),
});

// --- Store Schema ---

const StoreSchemaFieldSchema: z.ZodType<{
  type: string;
  description?: string;
  required?: boolean;
  fields?: Record<string, unknown>;
  display_hint?: string;
  hidden?: boolean;
}> = z.lazy(() =>
  z.object({
    type: z.enum(["string", "number", "boolean", "string[]", "object", "object[]", "markdown"]),
    description: z.string().optional(),
    required: z.boolean().optional(),
    fields: z.record(z.string(), StoreSchemaFieldSchema).optional(),
    display_hint: z.enum(["link", "badge", "code"]).optional(),
    hidden: z.boolean().optional(),
  })
);

const StoreSchemaEntrySchema = z.object({
  produced_by: z.string().min(1),
  type: z.literal("object").optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  fields: z.record(z.string(), StoreSchemaFieldSchema).optional(),
  additional_properties: z.boolean().optional(),
  assertions: z.array(z.string()).optional(),
});

const StoreSchemaSchema = z.record(z.string(), StoreSchemaEntrySchema);

// --- Pipeline Config ---

export const PipelineConfigSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  engine: z.enum(["claude", "gemini", "codex", "mixed"]).optional(),
  use_cases: z.array(z.string()).optional(),
  default_execution_mode: z.enum(["auto", "edge"]).optional(),
  official: z.boolean().optional(),
  stages: z.array(PipelineStageEntrySchema),
  hooks: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  claude_md: z.object({ global: z.string().optional() }).optional(),
  gemini_md: z.object({ global: z.string().optional() }).optional(),
  codex_md: z.object({ global: z.string().optional() }).optional(),
  display: z
    .object({
      title_path: z.string().optional(),
      completion_summary_path: z.string().optional(),
    })
    .optional(),
  integrations: z
    .object({
      notion_page_id_path: z.string().optional(),
    })
    .optional(),
  store_persistence: StorePersistenceSchema.optional(),
  store_schema: StoreSchemaSchema.optional(),
});

// --- Pipeline Manifest ---

export const PipelineManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  engine: z.enum(["claude", "gemini", "codex", "mixed"]),
  official: z.boolean().optional(),
  stageCount: z.number().optional(),
  totalBudget: z.number().optional(),
  mcps: z.array(z.string()).optional(),
  stageSummary: z.string().optional(),
});

// --- MCP Registry ---

const McpEnvValueSchema = z.union([
  z.string(),
  z.object({ json: z.record(z.string(), z.string()) }),
]);

export const McpRegistryEntrySchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), McpEnvValueSchema).optional(),
  gemini: z
    .object({
      command: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), McpEnvValueSchema).optional(),
    })
    .optional(),
  codex: z
    .object({
      command: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), McpEnvValueSchema).optional(),
    })
    .optional(),
});

// --- Sandbox Config ---

export const SandboxConfigSchema = z.object({
  enabled: z.boolean().optional(),
  auto_allow_bash: z.boolean().optional(),
  allow_unsandboxed_commands: z.boolean().optional(),
  network: z
    .object({
      allowed_domains: z.array(z.string()).optional(),
    })
    .optional(),
  filesystem: z
    .object({
      allow_write: z.array(z.string()).optional(),
      deny_write: z.array(z.string()).optional(),
      deny_read: z.array(z.string()).optional(),
    })
    .optional(),
});

// --- System Settings ---

export const SystemSettingsSchema = z
  .object({
    slack: z
      .object({
        bot_token: z.string().optional(),
        notify_channel_id: z.string().optional(),
        signing_secret: z.string().optional(),
        app_token: z.string().optional(),
      })
      .optional(),
    paths: z
      .object({
        repos_base: z.string().optional(),
        worktrees_base: z.string().optional(),
        data_dir: z.string().optional(),
        claude_executable: z.string().optional(),
        gemini_executable: z.string().optional(),
        codex_executable: z.string().optional(),
      })
      .optional(),
    agent: z
      .object({
        default_model: z.string().optional(),
        claude_model: z.string().optional(),
        gemini_model: z.string().optional(),
        codex_model: z.string().optional(),
        default_engine: z.enum(["claude", "gemini", "codex"]).optional(),
        max_budget_usd: z.number().optional(),
      })
      .optional(),
    sandbox: SandboxConfigSchema.optional(),
  })
  .catchall(z.unknown());

// --- Hook Config ---

export const HookConfigSchema = z.object({
  event: z.string(),
  matcher: z.string().optional(),
  type: z.string(),
  command: z.string().optional(),
  timeout: z.number().optional(),
  statusMessage: z.string().optional(),
  script: z.string().optional(),
});

// --- Gate ---

export const GateCheckSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string().optional(),
});

export const GateResultSchema = z.object({
  passed: z.boolean(),
  checks: z.array(GateCheckSchema),
});

// --- Validation helper ---

export interface ValidationResult {
  success: boolean;
  data?: PipelineConfig;
  errors?: ZodError;
}

export function validatePipelineConfig(raw: unknown): ValidationResult {
  const result = PipelineConfigSchema.safeParse(raw);
  if (result.success) {
    return { success: true, data: result.data as PipelineConfig };
  }
  return { success: false, errors: result.error };
}
