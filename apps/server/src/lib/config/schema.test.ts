import { describe, it, expect } from "vitest";
import {
  validatePipelineConfig,
  PipelineConfigSchema,
  PipelineStageConfigSchema,
  AgentRuntimeConfigSchema,
  ScriptRuntimeConfigSchema,
  HumanGateRuntimeConfigSchema,
  ConditionRuntimeConfigSchema,
  PipelineCallRuntimeConfigSchema,
  ForeachRuntimeConfigSchema,
  StageRuntimeConfigSchema,
  OutputFieldSchema,
  StageOutputSchemaSchema,
  McpRegistryEntrySchema,
  SandboxConfigSchema,
  SystemSettingsSchema,
  HookConfigSchema,
  GateCheckSchema,
  GateResultSchema,
  FragmentMetaSchema,
  SubAgentDefinitionSchema,
  PipelineManifestSchema,
} from "./schema.js";

// ---------- validatePipelineConfig ----------

describe("validatePipelineConfig", () => {
  const minimalValid = {
    name: "test-pipeline",
    stages: [
      { name: "stage-1", type: "agent" },
    ],
  };

  it("returns success for valid pipeline config", () => {
    const result = validatePipelineConfig(minimalValid);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.name).toBe("test-pipeline");
  });

  it("returns success for full pipeline config", () => {
    const full = {
      name: "full-pipeline",
      description: "A test pipeline",
      engine: "claude",
      use_cases: ["testing"],
      default_execution_mode: "auto",
      stages: [
        {
          name: "analyze",
          type: "agent",
          engine: "claude",
          model: "sonnet",
          max_turns: 10,
          max_budget_usd: 5.0,
          mcps: ["notion"],
          permission_mode: "acceptEdits",
          runtime: {
            engine: "llm",
            system_prompt: "You are an analyzer",
          },
        },
        {
          name: "review",
          type: "human_confirm",
          runtime: {
            engine: "human_gate",
            on_approve_to: "deploy",
            on_reject_to: "analyze",
          },
        },
      ],
      hooks: ["pre-check"],
      skills: ["search"],
      display: { title_path: "outputs.title" },
    };
    const result = validatePipelineConfig(full);
    expect(result.success).toBe(true);
  });

  it("returns errors for missing name", () => {
    const result = validatePipelineConfig({ stages: [] });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it("returns errors for missing stages", () => {
    const result = validatePipelineConfig({ name: "test" });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it("returns errors for null input", () => {
    const result = validatePipelineConfig(null);
    expect(result.success).toBe(false);
  });

  it("returns errors for non-object input", () => {
    const result = validatePipelineConfig("not-an-object");
    expect(result.success).toBe(false);
  });

  it("returns errors for invalid stage type", () => {
    const result = validatePipelineConfig({
      name: "test",
      stages: [{ name: "s1", type: "invalid_type" }],
    });
    expect(result.success).toBe(false);
  });

  it("returns errors for stage missing name", () => {
    const result = validatePipelineConfig({
      name: "test",
      stages: [{ type: "agent" }],
    });
    expect(result.success).toBe(false);
  });
});

// ---------- PipelineStageConfigSchema ----------

describe("PipelineStageConfigSchema", () => {
  it("accepts minimal stage", () => {
    const result = PipelineStageConfigSchema.safeParse({
      name: "my-stage",
      type: "agent",
    });
    expect(result.success).toBe(true);
  });

  it("accepts agent type", () => {
    const result = PipelineStageConfigSchema.safeParse({ name: "s", type: "agent" });
    expect(result.success).toBe(true);
  });

  it("accepts script type", () => {
    const result = PipelineStageConfigSchema.safeParse({ name: "s", type: "script" });
    expect(result.success).toBe(true);
  });

  it("accepts human_confirm type", () => {
    const result = PipelineStageConfigSchema.safeParse({ name: "s", type: "human_confirm" });
    expect(result.success).toBe(true);
  });

  it("accepts condition type", () => {
    const result = PipelineStageConfigSchema.safeParse({ name: "s", type: "condition" });
    expect(result.success).toBe(true);
  });

  it("accepts pipeline type", () => {
    const result = PipelineStageConfigSchema.safeParse({ name: "s", type: "pipeline" });
    expect(result.success).toBe(true);
  });

  it("accepts foreach type", () => {
    const result = PipelineStageConfigSchema.safeParse({ name: "s", type: "foreach" });
    expect(result.success).toBe(true);
  });

  it("rejects unknown type", () => {
    const result = PipelineStageConfigSchema.safeParse({ name: "s", type: "unknown" });
    expect(result.success).toBe(false);
  });

  it("accepts all optional fields", () => {
    const result = PipelineStageConfigSchema.safeParse({
      name: "full-stage",
      type: "agent",
      engine: "gemini",
      model: "pro",
      thinking: { type: "enabled" },
      effort: "high",
      permission_mode: "bypassPermissions",
      debug: true,
      max_turns: 20,
      max_budget_usd: 3.5,
      mcps: ["context7", "figma"],
      notion_label: "Review",
      execution_mode: "edge",
      on_complete: { notify: "slack" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid engine", () => {
    const result = PipelineStageConfigSchema.safeParse({
      name: "s",
      type: "agent",
      engine: "openai",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid effort", () => {
    const result = PipelineStageConfigSchema.safeParse({
      name: "s",
      type: "agent",
      effort: "ultra",
    });
    expect(result.success).toBe(false);
  });
});

// ---------- StageRuntimeConfigSchema (discriminated union) ----------

describe("StageRuntimeConfigSchema", () => {
  it("accepts llm engine config", () => {
    const result = StageRuntimeConfigSchema.safeParse({
      engine: "llm",
      system_prompt: "You are helpful",
    });
    expect(result.success).toBe(true);
  });

  it("accepts script engine config", () => {
    const result = StageRuntimeConfigSchema.safeParse({
      engine: "script",
      script_id: "my-script",
    });
    expect(result.success).toBe(true);
  });

  it("accepts human_gate engine config", () => {
    const result = StageRuntimeConfigSchema.safeParse({
      engine: "human_gate",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown engine", () => {
    const result = StageRuntimeConfigSchema.safeParse({
      engine: "unknown",
    });
    expect(result.success).toBe(false);
  });

  it("rejects llm without system_prompt", () => {
    const result = AgentRuntimeConfigSchema.safeParse({
      engine: "llm",
    });
    expect(result.success).toBe(false);
  });

  it("rejects script without script_id", () => {
    const result = ScriptRuntimeConfigSchema.safeParse({
      engine: "script",
    });
    expect(result.success).toBe(false);
  });

  it("accepts llm with agents and retry", () => {
    const result = AgentRuntimeConfigSchema.safeParse({
      engine: "llm",
      system_prompt: "test",
      writes: ["output"],
      reads: { input: "prev.output" },
      agents: {
        sub: {
          description: "Sub agent",
          prompt: "Do sub-work",
          tools: ["bash"],
          model: "sonnet",
        },
      },
      retry: { max_retries: 3, back_to: "stage-1" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts human_gate with notify", () => {
    const result = HumanGateRuntimeConfigSchema.safeParse({
      engine: "human_gate",
      notify: { type: "slack", template: "Please review" },
      on_approve_to: "deploy",
      on_reject_to: "fix",
      max_feedback_loops: 3,
    });
    expect(result.success).toBe(true);
  });

  it("accepts condition engine config", () => {
    const result = StageRuntimeConfigSchema.safeParse({
      engine: "condition",
      branches: [
        { when: "store.score > 80", to: "fast-track" },
        { default: true, to: "fallback" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts pipeline engine config", () => {
    const result = StageRuntimeConfigSchema.safeParse({
      engine: "pipeline",
      pipeline_name: "child-pipeline",
      reads: { pr_url: "store.pr_url" },
      writes: ["review_result"],
      timeout_sec: 600,
    });
    expect(result.success).toBe(true);
  });

  it("accepts foreach engine config", () => {
    const result = StageRuntimeConfigSchema.safeParse({
      engine: "foreach",
      items: "store.pr_list",
      item_var: "current_pr",
      pipeline_name: "review-pipeline",
      max_concurrency: 3,
      collect_to: "reviews",
      item_writes: ["review_result"],
      on_item_error: "continue",
    });
    expect(result.success).toBe(true);
  });
});

// ---------- ConditionRuntimeConfigSchema ----------

describe("ConditionRuntimeConfigSchema", () => {
  it("accepts valid condition with when and default branches", () => {
    const result = ConditionRuntimeConfigSchema.safeParse({
      engine: "condition",
      branches: [
        { when: "store.x == true", to: "a" },
        { default: true, to: "b" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects condition with fewer than 2 branches", () => {
    const result = ConditionRuntimeConfigSchema.safeParse({
      engine: "condition",
      branches: [{ default: true, to: "a" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects condition with multiple default branches", () => {
    const result = ConditionRuntimeConfigSchema.safeParse({
      engine: "condition",
      branches: [
        { default: true, to: "a" },
        { default: true, to: "b" },
        { when: "store.x", to: "c" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects branch with neither when nor default", () => {
    const result = ConditionRuntimeConfigSchema.safeParse({
      engine: "condition",
      branches: [
        { to: "a" },
        { default: true, to: "b" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects branch with empty to", () => {
    const result = ConditionRuntimeConfigSchema.safeParse({
      engine: "condition",
      branches: [
        { when: "store.x", to: "" },
        { default: true, to: "b" },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ---------- PipelineCallRuntimeConfigSchema ----------

describe("PipelineCallRuntimeConfigSchema", () => {
  it("accepts minimal pipeline call config", () => {
    const result = PipelineCallRuntimeConfigSchema.safeParse({
      engine: "pipeline",
      pipeline_name: "child",
    });
    expect(result.success).toBe(true);
  });

  it("accepts full pipeline call config", () => {
    const result = PipelineCallRuntimeConfigSchema.safeParse({
      engine: "pipeline",
      pipeline_name: "child",
      reads: { pr: "store.pr_url" },
      writes: ["summary", "passed"],
      timeout_sec: 600,
    });
    expect(result.success).toBe(true);
  });

  it("rejects pipeline call without pipeline_name", () => {
    const result = PipelineCallRuntimeConfigSchema.safeParse({
      engine: "pipeline",
    });
    expect(result.success).toBe(false);
  });
});

// ---------- ForeachRuntimeConfigSchema ----------

describe("ForeachRuntimeConfigSchema", () => {
  it("accepts minimal foreach config", () => {
    const result = ForeachRuntimeConfigSchema.safeParse({
      engine: "foreach",
      items: "store.list",
      item_var: "item",
      pipeline_name: "child",
    });
    expect(result.success).toBe(true);
  });

  it("accepts full foreach config", () => {
    const result = ForeachRuntimeConfigSchema.safeParse({
      engine: "foreach",
      items: "store.pr_list",
      item_var: "current_pr",
      max_concurrency: 5,
      pipeline_name: "review",
      collect_to: "reviews",
      item_writes: ["result"],
      on_item_error: "continue",
    });
    expect(result.success).toBe(true);
  });

  it("accepts foreach with isolation and auto_commit", () => {
    const result = ForeachRuntimeConfigSchema.safeParse({
      engine: "foreach",
      items: "store.tasks",
      item_var: "task",
      pipeline_name: "refactor-sub",
      isolation: "worktree",
      auto_commit: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts isolation: shared", () => {
    const result = ForeachRuntimeConfigSchema.safeParse({
      engine: "foreach",
      items: "store.list",
      item_var: "item",
      pipeline_name: "child",
      isolation: "shared",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid isolation value", () => {
    const result = ForeachRuntimeConfigSchema.safeParse({
      engine: "foreach",
      items: "store.list",
      item_var: "item",
      pipeline_name: "child",
      isolation: "docker",
    });
    expect(result.success).toBe(false);
  });

  it("rejects foreach without items", () => {
    const result = ForeachRuntimeConfigSchema.safeParse({
      engine: "foreach",
      item_var: "item",
      pipeline_name: "child",
    });
    expect(result.success).toBe(false);
  });

  it("rejects foreach without item_var", () => {
    const result = ForeachRuntimeConfigSchema.safeParse({
      engine: "foreach",
      items: "store.list",
      pipeline_name: "child",
    });
    expect(result.success).toBe(false);
  });

  it("rejects foreach with invalid on_item_error", () => {
    const result = ForeachRuntimeConfigSchema.safeParse({
      engine: "foreach",
      items: "store.list",
      item_var: "item",
      pipeline_name: "child",
      on_item_error: "ignore",
    });
    expect(result.success).toBe(false);
  });

  it("rejects foreach with max_concurrency < 1", () => {
    const result = ForeachRuntimeConfigSchema.safeParse({
      engine: "foreach",
      items: "store.list",
      item_var: "item",
      pipeline_name: "child",
      max_concurrency: 0,
    });
    expect(result.success).toBe(false);
  });
});

// ---------- OutputFieldSchema ----------

describe("OutputFieldSchema", () => {
  it("accepts basic field", () => {
    const result = OutputFieldSchema.safeParse({
      key: "title",
      type: "string",
      description: "The title",
    });
    expect(result.success).toBe(true);
  });

  it("accepts nested fields", () => {
    const result = OutputFieldSchema.safeParse({
      key: "details",
      type: "object",
      description: "Details",
      fields: [
        { key: "sub", type: "number", description: "Num" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts display_hint and hidden", () => {
    const result = OutputFieldSchema.safeParse({
      key: "url",
      type: "string",
      description: "Link",
      display_hint: "link",
      hidden: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts object[] type", () => {
    const result = OutputFieldSchema.safeParse({
      key: "items",
      type: "object[]",
      description: "List of items",
    });
    expect(result.success).toBe(true);
  });

  it("accepts object[] with nested fields", () => {
    const result = OutputFieldSchema.safeParse({
      key: "files",
      type: "object[]",
      description: "File list",
      fields: [
        { key: "path", type: "string", description: "File path" },
        { key: "size", type: "number", description: "File size" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid type", () => {
    const result = OutputFieldSchema.safeParse({
      key: "x",
      type: "date",
      description: "Date field",
    });
    expect(result.success).toBe(false);
  });
});

// ---------- McpRegistryEntrySchema ----------

describe("McpRegistryEntrySchema", () => {
  it("accepts basic entry", () => {
    const result = McpRegistryEntrySchema.safeParse({
      command: "npx",
      args: ["-y", "some-pkg"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts entry with env", () => {
    const result = McpRegistryEntrySchema.safeParse({
      command: "npx",
      env: { TOKEN: "${MY_TOKEN}" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts entry with json env", () => {
    const result = McpRegistryEntrySchema.safeParse({
      command: "npx",
      env: { HEADERS: { json: { Authorization: "Bearer abc" } } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts entry with gemini override", () => {
    const result = McpRegistryEntrySchema.safeParse({
      command: "npx",
      args: ["-y", "pkg"],
      gemini: {
        command: "npx",
        args: ["-y", "pkg-gemini"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty entry", () => {
    const result = McpRegistryEntrySchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ---------- SandboxConfigSchema ----------

describe("SandboxConfigSchema", () => {
  it("accepts empty object", () => {
    const result = SandboxConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts full config", () => {
    const result = SandboxConfigSchema.safeParse({
      enabled: true,
      auto_allow_bash: false,
      allow_unsandboxed_commands: false,
      network: { allowed_domains: ["api.example.com"] },
      filesystem: {
        allow_write: ["/workspace"],
        deny_write: ["/system"],
        deny_read: ["/secrets"],
      },
    });
    expect(result.success).toBe(true);
  });
});

// ---------- SystemSettingsSchema ----------

describe("SystemSettingsSchema", () => {
  it("accepts empty object", () => {
    const result = SystemSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts full settings", () => {
    const result = SystemSettingsSchema.safeParse({
      slack: { bot_token: "xoxb-123", notify_channel_id: "C123" },
      paths: { repos_base: "/repos", claude_executable: "claude" },
      agent: { default_engine: "claude", max_budget_usd: 10 },
      sandbox: { enabled: false },
    });
    expect(result.success).toBe(true);
  });

  it("allows unknown extra keys via catchall", () => {
    const result = SystemSettingsSchema.safeParse({
      custom_section: { key: "value" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid engine in agent", () => {
    const result = SystemSettingsSchema.safeParse({
      agent: { default_engine: "openai" },
    });
    expect(result.success).toBe(false);
  });
});

// ---------- HookConfigSchema ----------

describe("HookConfigSchema", () => {
  it("accepts minimal hook", () => {
    const result = HookConfigSchema.safeParse({
      event: "stage:complete",
      type: "shell",
    });
    expect(result.success).toBe(true);
  });

  it("accepts full hook", () => {
    const result = HookConfigSchema.safeParse({
      event: "stage:complete",
      matcher: "deploy",
      type: "shell",
      command: "echo done",
      timeout: 30,
      statusMessage: "Deploying...",
      script: "deploy.sh",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing event", () => {
    const result = HookConfigSchema.safeParse({ type: "shell" });
    expect(result.success).toBe(false);
  });
});

// ---------- GateCheckSchema / GateResultSchema ----------

describe("GateCheckSchema", () => {
  it("accepts check with detail", () => {
    const result = GateCheckSchema.safeParse({
      name: "lint",
      passed: true,
      detail: "No issues",
    });
    expect(result.success).toBe(true);
  });

  it("accepts check without detail", () => {
    const result = GateCheckSchema.safeParse({ name: "test", passed: false });
    expect(result.success).toBe(true);
  });
});

describe("GateResultSchema", () => {
  it("accepts valid result", () => {
    const result = GateResultSchema.safeParse({
      passed: true,
      checks: [{ name: "lint", passed: true }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing checks", () => {
    const result = GateResultSchema.safeParse({ passed: true });
    expect(result.success).toBe(false);
  });
});

// ---------- FragmentMetaSchema ----------

describe("FragmentMetaSchema", () => {
  it("accepts with stages array", () => {
    const result = FragmentMetaSchema.safeParse({
      id: "frag1",
      keywords: ["test"],
      stages: ["analyze"],
      always: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts with stages wildcard", () => {
    const result = FragmentMetaSchema.safeParse({
      id: "frag2",
      keywords: [],
      stages: "*",
      always: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid stages value", () => {
    const result = FragmentMetaSchema.safeParse({
      id: "frag3",
      keywords: [],
      stages: "some-stage",
      always: false,
    });
    expect(result.success).toBe(false);
  });
});

// ---------- SubAgentDefinitionSchema ----------

describe("SubAgentDefinitionSchema", () => {
  it("accepts minimal sub-agent", () => {
    const result = SubAgentDefinitionSchema.safeParse({
      description: "Helper",
      prompt: "Do something",
    });
    expect(result.success).toBe(true);
  });

  it("accepts full sub-agent", () => {
    const result = SubAgentDefinitionSchema.safeParse({
      description: "Helper",
      prompt: "Do something",
      tools: ["bash", "read"],
      disallowedTools: ["write"],
      model: "opus",
      maxTurns: 5,
      skills: ["search"],
      mcpServers: ["notion", { custom: true }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing prompt", () => {
    const result = SubAgentDefinitionSchema.safeParse({
      description: "Helper",
    });
    expect(result.success).toBe(false);
  });
});

// ---------- PipelineManifestSchema ----------

describe("PipelineManifestSchema", () => {
  it("accepts minimal manifest", () => {
    const result = PipelineManifestSchema.safeParse({
      id: "test",
      name: "Test Pipeline",
      engine: "claude",
    });
    expect(result.success).toBe(true);
  });

  it("accepts full manifest", () => {
    const result = PipelineManifestSchema.safeParse({
      id: "test",
      name: "Test Pipeline",
      description: "For testing",
      engine: "mixed",
      stageCount: 3,
      totalBudget: 15.5,
      mcps: ["notion"],
      stageSummary: "analyze -> review -> deploy",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing engine", () => {
    const result = PipelineManifestSchema.safeParse({
      id: "test",
      name: "Test",
    });
    expect(result.success).toBe(false);
  });
});
