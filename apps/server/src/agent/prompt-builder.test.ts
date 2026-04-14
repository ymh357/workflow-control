import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../lib/capability-registry.js", () => ({
  buildCapabilitySummary: vi.fn(() => ({ mcps: [], scripts: [], skills: [] })),
  formatCapabilityPrompt: vi.fn(() => "## Available Capabilities\n\nNo capabilities registered."),
}));

vi.mock("../lib/config-loader.js", () => ({
  getFragmentRegistry: vi.fn(() => ({
    resolve: vi.fn(() => []),
    getAllKeywordsWithDescriptions: vi.fn(() => []),
  })),
  resolveFragmentsFromSnapshot: vi.fn(() => []),
  isParallelGroup: (entry: any) => entry && typeof entry === "object" && "parallel" in entry,
  flattenStages: (entries: any[]) => {
    const result: any[] = [];
    for (const e of entries) {
      if (e && typeof e === "object" && "parallel" in e) {
        result.push(...e.parallel.stages);
      } else {
        result.push(e);
      }
    }
    return result;
  },
}));

import { generateSchemaPrompt, buildEffectivePrompt, buildStaticPromptPrefix } from "./prompt-builder.js";
import type { StageOutputSchema } from "../lib/config-loader.js";

describe("generateSchemaPrompt", () => {
  it("generates prompt for a single string field", () => {
    const outputs: StageOutputSchema = {
      result: {
        type: "object",
        fields: [{ key: "summary", type: "string", description: "A brief summary" }],
      },
    };
    const prompt = generateSchemaPrompt(outputs);
    expect(prompt).toContain("## Required Output Format");
    expect(prompt).toContain('"result"');
    expect(prompt).toContain('"summary": string');
    expect(prompt).toContain("// A brief summary");
    expect(prompt).toContain("Return ONLY this JSON object");
  });

  it("generates prompt for multiple fields", () => {
    const outputs: StageOutputSchema = {
      analysis: {
        type: "object",
        fields: [
          { key: "summary", type: "string", description: "Summary" },
          { key: "score", type: "number", description: "Score" },
          { key: "tags", type: "string[]", description: "Tags" },
        ],
      },
    };
    const prompt = generateSchemaPrompt(outputs);
    expect(prompt).toContain('"summary": string');
    expect(prompt).toContain('"score": number');
    expect(prompt).toContain('"tags": string[]');
  });

  it("generates prompt for nested object fields", () => {
    const outputs: StageOutputSchema = {
      data: {
        type: "object",
        fields: [
          {
            key: "config",
            type: "object",
            description: "Config",
            fields: [
              { key: "name", type: "string", description: "Name" },
            ],
          },
        ],
      },
    };
    const prompt = generateSchemaPrompt(outputs);
    expect(prompt).toContain('"config": {');
    expect(prompt).toContain('"name": string');
  });

  it("handles store key with no fields", () => {
    const outputs: StageOutputSchema = {
      empty: { type: "object", fields: [] },
    };
    const prompt = generateSchemaPrompt(outputs);
    expect(prompt).toContain('"empty": {}');
  });

  it("adds decisions instruction when decisions field is present", () => {
    const outputs: StageOutputSchema = {
      result: {
        type: "object",
        fields: [
          { key: "decisions", type: "string", description: "Key decisions" },
        ],
      },
    };
    const prompt = generateSchemaPrompt(outputs);
    expect(prompt).toContain("decisions");
    expect(prompt).toContain("briefly record the most important choices");
  });

  it("does not add decisions instruction when no decisions field", () => {
    const outputs: StageOutputSchema = {
      result: {
        type: "object",
        fields: [
          { key: "summary", type: "string", description: "Summary" },
        ],
      },
    };
    const prompt = generateSchemaPrompt(outputs);
    expect(prompt).not.toContain("briefly record the most important choices");
  });
});

describe("buildEffectivePrompt", () => {
  const baseParams = {
    isResume: false,
    tier1Context: "tier1 context here",
    prompt: "original prompt",
  };

  it("returns resumeSync prompt when isResume + resumeSync", () => {
    const result = buildEffectivePrompt({
      ...baseParams,
      isResume: true,
      resumeSync: true,
    });
    expect(result).toContain("user has completed manual work");
    expect(result).toContain("inspect the CURRENT state");
    expect(result).not.toContain("tier1 context here");
  });

  it("returns feedback prompt when isResume + resumePrompt (canResume=true)", () => {
    const result = buildEffectivePrompt({
      ...baseParams,
      isResume: true,
      resumePrompt: "fix the colors",
      canResume: true,
    });
    expect(result).toContain("user has reviewed your previous output");
    expect(result).toContain('"fix the colors"');
    expect(result).toContain("Incorporate this feedback");
    // Should NOT include tier1Context when canResume
    expect(result).not.toContain("tier1 context here");
  });

  it("includes tier1Context in feedback when canResume=false", () => {
    const result = buildEffectivePrompt({
      ...baseParams,
      isResume: true,
      resumePrompt: "fix the colors",
      canResume: false,
    });
    expect(result).toContain("tier1 context here");
    expect(result).toContain("---");
    expect(result).toContain('"fix the colors"');
  });

  it("defaults canResume to true", () => {
    const result = buildEffectivePrompt({
      ...baseParams,
      isResume: true,
      resumePrompt: "try again",
    });
    // canResume defaults to true, so no tier1Context
    expect(result).not.toContain("tier1 context here");
    expect(result).toContain('"try again"');
  });

  it("returns tier1Context in normal (non-resume) case", () => {
    const result = buildEffectivePrompt(baseParams);
    expect(result).toBe("tier1 context here");
  });

  it("falls back to prompt when tier1Context is empty", () => {
    const result = buildEffectivePrompt({
      ...baseParams,
      tier1Context: "",
    });
    expect(result).toBe("original prompt");
  });
});

// ---------- buildSystemAppendPrompt ----------

import { buildSystemAppendPrompt } from "./prompt-builder.js";
import {
  getFragmentRegistry,
  resolveFragmentsFromSnapshot,
} from "../lib/config-loader.js";

const mockGetFragmentRegistry = vi.mocked(getFragmentRegistry);
const mockResolveFragmentsFromSnapshot = vi.mocked(resolveFragmentsFromSnapshot);

describe("buildSystemAppendPrompt", () => {
  const baseParams = {
    taskId: "task-1",
    stageName: "coding",
    stageConfig: { engine: "claude", mcpServices: [] },
    privateConfig: {
      prompts: {
        globalConstraints: "## Test Constraints",
        fragments: { "frag1": "Fragment 1 content" },
        fragmentMeta: {
          frag1: { id: "frag1", keywords: ["lint"], stages: ["coding"], always: false },
        },
        system: { coding: "You are a coding assistant." },
      },
      pipeline: { stages: [] },
    },
    cwd: "/project",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFragmentRegistry.mockReturnValue({
      resolve: vi.fn(() => []),
      getAllKeywordsWithDescriptions: vi.fn(() => []),
    } as any);
    mockResolveFragmentsFromSnapshot.mockReturnValue([]);
  });

  it("includes global constraints from privateConfig", async () => {
    const { prompt: result } = await buildSystemAppendPrompt(baseParams as any);
    expect(result).toContain("## Test Constraints");
  });

  it("uses DEFAULT_GLOBAL_CONSTRAINTS when privateConfig constraints are empty", async () => {
    const params = {
      ...baseParams,
      privateConfig: {
        ...baseParams.privateConfig,
        prompts: { ...baseParams.privateConfig.prompts, globalConstraints: "" },
      },
    };
    const { prompt: result } = await buildSystemAppendPrompt(params as any);
    // Falsy globalConstraints -> falls back to DEFAULT_GLOBAL_CONSTRAINTS
    expect(result).toContain("Global Constraints");
  });

  it("resolves fragments from snapshot when fragmentMeta is present", async () => {
    mockResolveFragmentsFromSnapshot.mockReturnValue([
      { id: "frag1", content: "Resolved fragment content" },
    ]);
    const { prompt: result, fragmentIds } = await buildSystemAppendPrompt({
      ...baseParams,
      enabledSteps: ["lint"],
    } as any);
    expect(mockResolveFragmentsFromSnapshot).toHaveBeenCalledWith(
      "coding",
      ["lint"],
      baseParams.privateConfig.prompts.fragments,
      baseParams.privateConfig.prompts.fragmentMeta,
    );
    expect(result).toContain("Resolved fragment content");
    expect(fragmentIds).toEqual(["frag1"]);
  });

  it("uses fragment registry when no fragmentMeta in privateConfig", async () => {
    const mockResolve = vi.fn(() => [{ id: "reg-frag", content: "Registry fragment" }]);
    mockGetFragmentRegistry.mockReturnValue({
      resolve: mockResolve,
      getAllKeywordsWithDescriptions: vi.fn(() => []),
    } as any);

    const params = {
      ...baseParams,
      privateConfig: null,
    };
    const { prompt: result } = await buildSystemAppendPrompt(params as any);
    expect(mockResolve).toHaveBeenCalledWith("coding", undefined);
    expect(result).toContain("Registry fragment");
  });

  it("falls back to flat fragment entries when privateConfig has no fragmentMeta", async () => {
    const params = {
      ...baseParams,
      privateConfig: {
        ...baseParams.privateConfig,
        prompts: {
          ...baseParams.privateConfig.prompts,
          fragmentMeta: undefined,
          fragments: { "inline": "Inline fragment text" },
        },
      },
    };
    const { prompt: result } = await buildSystemAppendPrompt(params as any);
    expect(result).toContain("Inline fragment text");
  });

  it("includes stage-specific system prompt", async () => {
    const { prompt: result } = await buildSystemAppendPrompt(baseParams as any);
    expect(result).toContain("You are a coding assistant.");
  });

  it("uses fallback system prompt when stage not in system map", async () => {
    const params = {
      ...baseParams,
      stageName: "unknown-stage",
    };
    const { prompt: result } = await buildSystemAppendPrompt(params as any);
    expect(result).toContain("Execute the current task stage based on project context.");
  });

  it("injects keyword descriptions for analyzing stage", async () => {
    const params = {
      ...baseParams,
      stageName: "analyzing",
      privateConfig: {
        ...baseParams.privateConfig,
        prompts: {
          ...baseParams.privateConfig.prompts,
          fragmentMeta: {
            frag1: { id: "frag1", keywords: ["lint", "test"], stages: "*", always: false },
          },
          system: { analyzing: "Analyze the task." },
        },
      },
    };
    const { prompt: result } = await buildSystemAppendPrompt(params as any);
    expect(result).toContain("### Available enabledSteps keywords");
    expect(result).toContain('"lint", "test"');
    expect(result).toContain("activates frag1");
  });

  it("uses fragment registry for keyword descriptions when no fragmentMeta", async () => {
    mockGetFragmentRegistry.mockReturnValue({
      resolve: vi.fn(() => []),
      getAllKeywordsWithDescriptions: vi.fn(() => [
        { keyword: "lint", fragmentId: "lint-frag" },
      ]),
    } as any);

    const params = {
      ...baseParams,
      stageName: "analyzing",
      privateConfig: null,
    };
    const { prompt: result } = await buildSystemAppendPrompt(params as any);
    expect(result).toContain('"lint"');
    expect(result).toContain("activates lint-frag");
  });

  it("does not inject project CLAUDE.md when globalClaudeMd is empty", async () => {
    const params = {
      ...baseParams,
      privateConfig: {
        ...baseParams.privateConfig,
        prompts: {
          ...baseParams.privateConfig.prompts,
          globalClaudeMd: "",
        },
      },
    };
    const { prompt: result } = await buildSystemAppendPrompt(params as any);
    expect(result).not.toContain("# Project Instructions");
  });

  it("does not inject project GEMINI.md when globalGeminiMd is empty", async () => {
    const params = {
      ...baseParams,
      stageConfig: { engine: "gemini", mcpServices: [] },
      privateConfig: {
        ...baseParams.privateConfig,
        prompts: {
          ...baseParams.privateConfig.prompts,
          globalGeminiMd: "",
        },
      },
    };
    const { prompt: result } = await buildSystemAppendPrompt(params as any);
    expect(result).not.toContain("# Project Instructions");
  });

  it("includes codex project instructions when engine is codex", async () => {
    const { prompt: result } = await buildSystemAppendPrompt({
      taskId: "t1",
      stageName: "test",
      runtime: { engine: "llm" as const, system_prompt: "test" },
      privateConfig: {
        prompts: {
          system: { test: "do stuff" },
          fragments: {},
          globalConstraints: "",
          globalClaudeMd: "claude instructions",
          globalGeminiMd: "gemini instructions",
          globalCodexMd: "codex instructions",
        },
        pipeline: { stages: [] },
      },
      stageConfig: { engine: "codex", mcpServices: [] },
    } as any);
    expect(result).toContain("codex instructions");
    expect(result).not.toContain("claude instructions");
    expect(result).not.toContain("gemini instructions");
  });

  it("injects globalClaudeMd from privateConfig", async () => {
    const params = {
      ...baseParams,
      privateConfig: {
        ...baseParams.privateConfig,
        prompts: {
          ...baseParams.privateConfig.prompts,
          globalClaudeMd: "Private claude md",
        },
      },
    };
    const { prompt: result } = await buildSystemAppendPrompt(params as any);
    expect(result).toContain("Private claude md");
  });

  it("generates schema output section when stage has outputs", async () => {
    const params = {
      ...baseParams,
      privateConfig: {
        ...baseParams.privateConfig,
        pipeline: {
          stages: [
            {
              name: "coding",
              outputs: {
                result: {
                  type: "object",
                  fields: [{ key: "summary", type: "string", description: "Summary" }],
                },
              },
            },
          ],
        },
      },
    };
    const { prompt: result } = await buildSystemAppendPrompt(params as any);
    expect(result).toContain("## Required Output Format");
    expect(result).toContain('"summary": string');
  });

  it("does not duplicate fragment content", async () => {
    mockResolveFragmentsFromSnapshot.mockReturnValue([
      { id: "a", content: "Same content" },
      { id: "b", content: "Same content" },
    ]);
    const { prompt: result } = await buildSystemAppendPrompt(baseParams as any);
    const occurrences = result.split("Same content").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("buildStaticPromptPrefix", () => {
  it("includes global constraints", () => {
    const config = {
      prompts: {
        globalConstraints: "Always be careful",
        fragments: {},
        globalClaudeMd: "",
        globalGeminiMd: "",
      },
    };
    const result = buildStaticPromptPrefix(config, "claude");
    expect(result).toContain("Always be careful");
  });

  it("includes all fragments", () => {
    const config = {
      prompts: {
        globalConstraints: "",
        fragments: { "frag-1": "Fragment one content", "frag-2": "Fragment two content" },
        globalClaudeMd: "",
        globalGeminiMd: "",
      },
    };
    const result = buildStaticPromptPrefix(config, "claude");
    expect(result).toContain("Fragment one content");
    expect(result).toContain("Fragment two content");
  });

  it("includes CLAUDE.md for claude engine", () => {
    const config = {
      prompts: {
        globalConstraints: "",
        fragments: {},
        globalClaudeMd: "Claude specific instructions",
        globalGeminiMd: "Gemini specific instructions",
      },
    };
    const result = buildStaticPromptPrefix(config, "claude");
    expect(result).toContain("Claude specific instructions");
    expect(result).not.toContain("Gemini specific instructions");
  });

  it("includes GEMINI.md for gemini engine", () => {
    const config = {
      prompts: {
        globalConstraints: "",
        fragments: {},
        globalClaudeMd: "Claude specific",
        globalGeminiMd: "Gemini specific",
      },
    };
    const result = buildStaticPromptPrefix(config, "gemini");
    expect(result).toContain("Gemini specific");
    expect(result).not.toContain("Claude specific");
  });

  it("includes CODEX.md for codex engine", () => {
    const config = {
      prompts: {
        globalConstraints: "",
        fragments: {},
        globalClaudeMd: "Claude specific",
        globalGeminiMd: "Gemini specific",
        globalCodexMd: "Codex specific",
      },
    };
    const result = buildStaticPromptPrefix(config, "codex");
    expect(result).toContain("Codex specific");
    expect(result).not.toContain("Claude specific");
    expect(result).not.toContain("Gemini specific");
  });

  it("returns empty constraints when config is undefined", () => {
    const result = buildStaticPromptPrefix(undefined, "claude");
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
  });
});
