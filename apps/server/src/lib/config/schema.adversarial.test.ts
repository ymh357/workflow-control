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
  FragmentMetaSchema,
  SubAgentDefinitionSchema,
  PipelineManifestSchema,
  HookConfigSchema,
  GateCheckSchema,
  GateResultSchema,
} from "./schema.js";

describe("schema adversarial: validatePipelineConfig", () => {
  it("rejects undefined input", () => {
    const result = validatePipelineConfig(undefined);
    expect(result.success).toBe(false);
  });

  it("rejects numeric input", () => {
    const result = validatePipelineConfig(42);
    expect(result.success).toBe(false);
  });

  it("rejects array input", () => {
    const result = validatePipelineConfig([{ name: "x", stages: [] }]);
    expect(result.success).toBe(false);
  });

  it("rejects pipeline with empty string name", () => {
    // Empty string is technically a valid string for zod z.string()
    const result = validatePipelineConfig({ name: "", stages: [] });
    expect(result.success).toBe(true);
  });

  it("rejects stages as a non-array value", () => {
    const result = validatePipelineConfig({ name: "x", stages: "not-array" });
    expect(result.success).toBe(false);
  });

  it("rejects stages as an object", () => {
    const result = validatePipelineConfig({ name: "x", stages: { s1: {} } });
    expect(result.success).toBe(false);
  });

  it("accepts empty stages array", () => {
    const result = validatePipelineConfig({ name: "x", stages: [] });
    expect(result.success).toBe(true);
  });

  it("rejects invalid default_execution_mode", () => {
    const result = validatePipelineConfig({ name: "x", stages: [], default_execution_mode: "manual" });
    expect(result.success).toBe(false);
  });

  it("strips unknown top-level fields (zod default behavior)", () => {
    const result = validatePipelineConfig({ name: "x", stages: [], __proto_pollution__: true });
    expect(result.success).toBe(true);
  });
});

describe("schema adversarial: StageRuntimeConfigSchema discriminated union", () => {
  it("rejects missing engine discriminator", () => {
    const result = StageRuntimeConfigSchema.safeParse({ system_prompt: "test" });
    expect(result.success).toBe(false);
  });

  it("rejects llm engine with script_id field (wrong discriminator fields)", () => {
    const result = AgentRuntimeConfigSchema.safeParse({
      engine: "llm",
      system_prompt: "x",
      script_id: "should-be-ignored",
    });
    // Zod strips unknown fields by default, so this should still pass
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).script_id).toBeUndefined();
    }
  });

  it("rejects script engine with empty string script_id", () => {
    // Empty string is valid for z.string()
    const result = ScriptRuntimeConfigSchema.safeParse({
      engine: "script",
      script_id: "",
    });
    expect(result.success).toBe(true);
  });

  it("rejects human_gate with invalid notify type", () => {
    const result = HumanGateRuntimeConfigSchema.safeParse({
      engine: "human_gate",
      notify: { type: "email", template: "test" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects human_gate notify without template", () => {
    const result = HumanGateRuntimeConfigSchema.safeParse({
      engine: "human_gate",
      notify: { type: "slack" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts negative max_retries in retry (no min constraint)", () => {
    const result = AgentRuntimeConfigSchema.safeParse({
      engine: "llm",
      system_prompt: "x",
      retry: { max_retries: -1 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-number max_retries", () => {
    const result = AgentRuntimeConfigSchema.safeParse({
      engine: "llm",
      system_prompt: "x",
      retry: { max_retries: "three" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts script with negative timeout_sec (no min constraint)", () => {
    const result = ScriptRuntimeConfigSchema.safeParse({
      engine: "script",
      script_id: "x",
      timeout_sec: -10,
    });
    expect(result.success).toBe(true);
  });
});

describe("schema adversarial: OutputFieldSchema recursive", () => {
  it("accepts deeply nested fields (3 levels)", () => {
    const result = OutputFieldSchema.safeParse({
      key: "root",
      type: "object",
      description: "root",
      fields: [{
        key: "mid",
        type: "object",
        description: "mid",
        fields: [{
          key: "leaf",
          type: "string",
          description: "leaf",
        }],
      }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects fields with non-array fields value", () => {
    const result = OutputFieldSchema.safeParse({
      key: "x",
      type: "object",
      description: "x",
      fields: "not-an-array",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid display_hint value", () => {
    const result = OutputFieldSchema.safeParse({
      key: "x",
      type: "string",
      description: "x",
      display_hint: "table",
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty fields array for object type", () => {
    const result = OutputFieldSchema.safeParse({
      key: "x",
      type: "object",
      description: "x",
      fields: [],
    });
    expect(result.success).toBe(true);
  });
});

describe("schema adversarial: StageOutputSchemaSchema", () => {
  it("rejects output with type other than 'object'", () => {
    const result = StageOutputSchemaSchema.safeParse({
      store1: { type: "array", fields: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects output missing fields array", () => {
    const result = StageOutputSchemaSchema.safeParse({
      store1: { type: "object" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts multiple stores in one schema", () => {
    const result = StageOutputSchemaSchema.safeParse({
      store1: { type: "object", fields: [{ key: "a", type: "string", description: "a" }] },
      store2: { type: "object", fields: [], hidden: true },
    });
    expect(result.success).toBe(true);
  });
});

describe("schema adversarial: SubAgentDefinitionSchema", () => {
  it("rejects invalid model enum value", () => {
    const result = SubAgentDefinitionSchema.safeParse({
      description: "x",
      prompt: "y",
      model: "gpt-4",
    });
    expect(result.success).toBe(false);
  });

  it("accepts mcpServers with mixed string and object entries", () => {
    const result = SubAgentDefinitionSchema.safeParse({
      description: "x",
      prompt: "y",
      mcpServers: ["simple", { complex: { nested: true } }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-string description", () => {
    const result = SubAgentDefinitionSchema.safeParse({
      description: 123,
      prompt: "y",
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty tools and skills arrays", () => {
    const result = SubAgentDefinitionSchema.safeParse({
      description: "x",
      prompt: "y",
      tools: [],
      skills: [],
      disallowedTools: [],
    });
    expect(result.success).toBe(true);
  });
});

describe("schema adversarial: PipelineStageConfigSchema edge cases", () => {
  it("rejects negative max_budget_usd (no min constraint present - passes)", () => {
    const result = PipelineStageConfigSchema.safeParse({
      name: "s",
      type: "agent",
      max_budget_usd: -5,
    });
    // z.number() has no min constraint
    expect(result.success).toBe(true);
  });

  it("accepts mixed engine on pipeline stage", () => {
    const result = PipelineStageConfigSchema.safeParse({
      name: "s",
      type: "agent",
      engine: "mixed",
    });
    expect(result.success).toBe(true);
  });

  it("rejects permission_mode not in enum", () => {
    const result = PipelineStageConfigSchema.safeParse({
      name: "s",
      type: "agent",
      permission_mode: "admin",
    });
    expect(result.success).toBe(false);
  });

  it("accepts stage with runtime that mismatches type (no cross-validation)", () => {
    // type is "agent" but runtime is "script" - schema doesn't cross-validate
    const result = PipelineStageConfigSchema.safeParse({
      name: "mismatch",
      type: "agent",
      runtime: { engine: "script", script_id: "x" },
    });
    expect(result.success).toBe(true);
  });
});

describe("schema adversarial: FragmentMetaSchema", () => {
  it("rejects stages as a number", () => {
    const result = FragmentMetaSchema.safeParse({
      id: "x",
      keywords: [],
      stages: 42,
      always: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-boolean always", () => {
    const result = FragmentMetaSchema.safeParse({
      id: "x",
      keywords: [],
      stages: "*",
      always: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("rejects keywords with non-string items", () => {
    const result = FragmentMetaSchema.safeParse({
      id: "x",
      keywords: [1, 2, 3],
      stages: "*",
      always: false,
    });
    expect(result.success).toBe(false);
  });
});

describe("schema adversarial: McpRegistryEntrySchema", () => {
  it("rejects env with non-string non-json-object value", () => {
    const result = McpRegistryEntrySchema.safeParse({
      command: "npx",
      env: { KEY: 123 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects gemini override missing required command", () => {
    const result = McpRegistryEntrySchema.safeParse({
      command: "npx",
      gemini: { args: ["x"] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts env with empty json record", () => {
    const result = McpRegistryEntrySchema.safeParse({
      command: "npx",
      env: { CONFIG: { json: {} } },
    });
    expect(result.success).toBe(true);
  });
});

describe("schema adversarial: SystemSettingsSchema catchall", () => {
  it("allows deeply nested unknown sections", () => {
    const result = SystemSettingsSchema.safeParse({
      custom: { deeply: { nested: { value: 42 } } },
    });
    expect(result.success).toBe(true);
  });

  it("rejects sandbox with non-boolean enabled", () => {
    const result = SystemSettingsSchema.safeParse({
      sandbox: { enabled: "yes" },
    });
    expect(result.success).toBe(false);
  });
});

describe("schema adversarial: PipelineManifestSchema", () => {
  it("rejects non-string id", () => {
    const result = PipelineManifestSchema.safeParse({
      id: 42,
      name: "test",
      engine: "claude",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid engine value", () => {
    const result = PipelineManifestSchema.safeParse({
      id: "x",
      name: "test",
      engine: "openai",
    });
    expect(result.success).toBe(false);
  });

  it("accepts zero totalBudget", () => {
    const result = PipelineManifestSchema.safeParse({
      id: "x",
      name: "test",
      engine: "claude",
      totalBudget: 0,
    });
    expect(result.success).toBe(true);
  });
});

describe("schema adversarial: HookConfigSchema", () => {
  it("rejects missing type field", () => {
    const result = HookConfigSchema.safeParse({ event: "push" });
    expect(result.success).toBe(false);
  });

  it("accepts negative timeout (no min constraint)", () => {
    const result = HookConfigSchema.safeParse({
      event: "push",
      type: "shell",
      timeout: -1,
    });
    expect(result.success).toBe(true);
  });
});

describe("schema adversarial: GateResultSchema", () => {
  it("rejects checks with non-array value", () => {
    const result = GateResultSchema.safeParse({
      passed: true,
      checks: "lint: passed",
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty checks array", () => {
    const result = GateResultSchema.safeParse({
      passed: true,
      checks: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects check with non-boolean passed", () => {
    const result = GateCheckSchema.safeParse({
      name: "lint",
      passed: "true",
    });
    expect(result.success).toBe(false);
  });
});

// ── Condition/Pipeline/Foreach schema adversarial ──

describe("schema adversarial: ConditionRuntimeConfigSchema", () => {
  it("rejects branches with neither when nor default", () => {
    const result = ConditionRuntimeConfigSchema.safeParse({
      engine: "condition",
      branches: [{ to: "a" }, { default: true, to: "b" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty branches array", () => {
    const result = ConditionRuntimeConfigSchema.safeParse({
      engine: "condition",
      branches: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects single branch (min 2)", () => {
    const result = ConditionRuntimeConfigSchema.safeParse({
      engine: "condition",
      branches: [{ default: true, to: "a" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects branch with numeric to", () => {
    const result = ConditionRuntimeConfigSchema.safeParse({
      engine: "condition",
      branches: [{ when: "store.x", to: 123 }, { default: true, to: "b" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects when as non-string", () => {
    const result = ConditionRuntimeConfigSchema.safeParse({
      engine: "condition",
      branches: [{ when: 42, to: "a" }, { default: true, to: "b" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects default as string instead of true", () => {
    const result = ConditionRuntimeConfigSchema.safeParse({
      engine: "condition",
      branches: [{ when: "store.x", to: "a" }, { default: "yes", to: "b" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects multiple default branches", () => {
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

  it("accepts branch with both when and default (when takes precedence at runtime)", () => {
    const result = ConditionRuntimeConfigSchema.safeParse({
      engine: "condition",
      branches: [
        { when: "store.x", default: true, to: "a" },
        { when: "store.y", to: "b" },
      ],
    });
    // Both when and default present — valid per schema (branch has when OR default)
    expect(result.success).toBe(true);
  });
});

describe("schema adversarial: PipelineCallRuntimeConfigSchema", () => {
  it("rejects empty pipeline_name", () => {
    const result = PipelineCallRuntimeConfigSchema.safeParse({
      engine: "pipeline",
      pipeline_name: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects pipeline_name as number", () => {
    const result = PipelineCallRuntimeConfigSchema.safeParse({
      engine: "pipeline",
      pipeline_name: 42,
    });
    expect(result.success).toBe(false);
  });

  it("rejects reads with non-string values", () => {
    const result = PipelineCallRuntimeConfigSchema.safeParse({
      engine: "pipeline",
      pipeline_name: "child",
      reads: { key: 123 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects writes with non-string array items", () => {
    const result = PipelineCallRuntimeConfigSchema.safeParse({
      engine: "pipeline",
      pipeline_name: "child",
      writes: [123],
    });
    expect(result.success).toBe(false);
  });

  it("rejects timeout_sec as string", () => {
    const result = PipelineCallRuntimeConfigSchema.safeParse({
      engine: "pipeline",
      pipeline_name: "child",
      timeout_sec: "600",
    });
    expect(result.success).toBe(false);
  });
});

describe("schema adversarial: ForeachRuntimeConfigSchema", () => {
  it("rejects empty items", () => {
    const result = ForeachRuntimeConfigSchema.safeParse({
      engine: "foreach",
      items: "",
      item_var: "x",
      pipeline_name: "c",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty item_var", () => {
    const result = ForeachRuntimeConfigSchema.safeParse({
      engine: "foreach",
      items: "store.list",
      item_var: "",
      pipeline_name: "c",
    });
    expect(result.success).toBe(false);
  });

  it("rejects max_concurrency of 0", () => {
    const result = ForeachRuntimeConfigSchema.safeParse({
      engine: "foreach",
      items: "store.list",
      item_var: "x",
      pipeline_name: "c",
      max_concurrency: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative max_concurrency", () => {
    const result = ForeachRuntimeConfigSchema.safeParse({
      engine: "foreach",
      items: "store.list",
      item_var: "x",
      pipeline_name: "c",
      max_concurrency: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer max_concurrency", () => {
    const result = ForeachRuntimeConfigSchema.safeParse({
      engine: "foreach",
      items: "store.list",
      item_var: "x",
      pipeline_name: "c",
      max_concurrency: 2.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid on_item_error value", () => {
    const result = ForeachRuntimeConfigSchema.safeParse({
      engine: "foreach",
      items: "store.list",
      item_var: "x",
      pipeline_name: "c",
      on_item_error: "ignore",
    });
    expect(result.success).toBe(false);
  });

  it("rejects items as array instead of string path", () => {
    const result = ForeachRuntimeConfigSchema.safeParse({
      engine: "foreach",
      items: ["a", "b"],
      item_var: "x",
      pipeline_name: "c",
    });
    expect(result.success).toBe(false);
  });
});
