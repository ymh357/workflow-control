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

import { generateSchemaPrompt, buildEffectivePrompt, buildSystemAppendPrompt } from "./prompt-builder.js";
import {
  getFragmentRegistry,
  resolveFragmentsFromSnapshot,
} from "../lib/config-loader.js";
import type { StageOutputSchema } from "../lib/config-loader.js";

const mockGetFragmentRegistry = vi.mocked(getFragmentRegistry);
const mockResolveFragmentsFromSnapshot = vi.mocked(resolveFragmentsFromSnapshot);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetFragmentRegistry.mockReturnValue({
    resolve: vi.fn(() => []),
    getAllKeywordsWithDescriptions: vi.fn(() => []),
  } as any);
  mockResolveFragmentsFromSnapshot.mockReturnValue([]);
});

describe("adversarial: generateSchemaPrompt edge cases", () => {
  it("handles multiple store keys with correct comma placement", () => {
    const outputs: StageOutputSchema = {
      first: {
        type: "object",
        fields: [{ key: "a", type: "string", description: "A" }],
      },
      second: {
        type: "object",
        fields: [{ key: "b", type: "number", description: "B" }],
      },
    };
    const prompt = generateSchemaPrompt(outputs);
    // The first store key's closing brace should have a comma
    expect(prompt).toContain("},");
    // The last should not
    const lines = prompt.split("\n");
    const closingBraces = lines.filter(l => l.trim().startsWith("}"));
    const lastClosing = closingBraces[closingBraces.length - 1];
    expect(lastClosing?.trim()).toBe("}");
  });

  it("handles store key with undefined fields (no fields property)", () => {
    const outputs: StageOutputSchema = {
      empty: { type: "object" } as any,
    };
    const prompt = generateSchemaPrompt(outputs);
    expect(prompt).toContain('"empty": {}');
  });

  it("renders nested object fields with proper indentation", () => {
    const outputs: StageOutputSchema = {
      data: {
        type: "object",
        fields: [
          {
            key: "meta",
            type: "object",
            description: "Metadata",
            fields: [
              { key: "author", type: "string", description: "Author name" },
              { key: "count", type: "number", description: "Count" },
            ],
          },
        ],
      },
    };
    const prompt = generateSchemaPrompt(outputs);
    expect(prompt).toContain('"author": string');
    expect(prompt).toContain('"count": number');
  });

  it("handles string[] type correctly", () => {
    const outputs: StageOutputSchema = {
      result: {
        type: "object",
        fields: [{ key: "tags", type: "string[]", description: "Tags" }],
      },
    };
    const prompt = generateSchemaPrompt(outputs);
    expect(prompt).toContain('"tags": string[]');
  });
});

describe("adversarial: buildEffectivePrompt priority and edge cases", () => {
  it("resumeSync takes priority over resumePrompt when both are set", () => {
    const result = buildEffectivePrompt({
      isResume: true,
      resumeSync: true,
      resumePrompt: "some feedback",
      tier1Context: "ctx",
      prompt: "orig",
    });
    // resumeSync path should win — contains "manual work" not "feedback"
    expect(result).toContain("manual work");
    expect(result).not.toContain("some feedback");
  });

  it("returns empty string when tier1Context and prompt are both empty and not resume", () => {
    const result = buildEffectivePrompt({
      isResume: false,
      tier1Context: "",
      prompt: "",
    });
    // tier1Context || prompt -> "" || "" -> ""
    expect(result).toBe("");
  });

  it("resumePrompt with canResume=false includes separator between context and feedback", () => {
    const result = buildEffectivePrompt({
      isResume: true,
      resumePrompt: "fix it",
      tier1Context: "context here",
      prompt: "orig",
      canResume: false,
    });
    expect(result).toContain("context here");
    expect(result).toContain("---");
    expect(result).toContain('"fix it"');
  });

  it("non-resume ignores resumePrompt and resumeSync entirely", () => {
    const result = buildEffectivePrompt({
      isResume: false,
      resumeSync: true,
      resumePrompt: "feedback",
      tier1Context: "my context",
      prompt: "p",
    });
    // isResume is false, so it goes straight to tier1Context || prompt
    expect(result).toBe("my context");
    expect(result).not.toContain("feedback");
  });
});

describe("adversarial: buildSystemAppendPrompt fragment handling", () => {
  it("fragment content is NOT in appendPrompt (lives in staticPromptPrefix)", async () => {
    mockResolveFragmentsFromSnapshot.mockReturnValue([
      { id: "a", content: "" },
      { id: "b", content: "real content" },
    ]);

    const { prompt: result, fragmentIds } = await buildSystemAppendPrompt({
      taskId: "t",
      stageName: "coding",
      stageConfig: { engine: "claude", mcpServices: [] },
      privateConfig: {
        prompts: {
          globalConstraints: "constraints",
          fragments: {},
          fragmentMeta: { a: {}, b: {} },
          system: { coding: "sys" },
        },
        pipeline: { stages: [] },
      },
      cwd: "/p",
    } as any);

    // Fragment content no longer in appendPrompt
    expect(result).not.toContain("real content");
    // But IDs are still resolved for staticPromptPrefix
    expect(fragmentIds).toContain("b");
  });

  it("handles analyzing stage with no keywords gracefully", async () => {
    const { prompt: result } = await buildSystemAppendPrompt({
      taskId: "t",
      stageName: "analyzing",
      stageConfig: { engine: "claude", mcpServices: [] },
      privateConfig: {
        prompts: {
          globalConstraints: "c",
          fragments: {},
          fragmentMeta: {
            frag1: { id: "frag1", keywords: [], stages: ["analyzing"], always: false },
          },
          system: { analyzing: "analyze" },
        },
        pipeline: { stages: [] },
      },
    } as any);

    // No keywords with length > 0, so no keyword section
    expect(result).not.toContain("### Available enabledSteps keywords");
  });

  it("uses runtime.system_prompt as fallback key for system prompt lookup", async () => {
    const { prompt: result } = await buildSystemAppendPrompt({
      taskId: "t",
      stageName: "custom-stage",
      runtime: { system_prompt: "alias-stage" } as any,
      stageConfig: { engine: "claude", mcpServices: [] },
      privateConfig: {
        prompts: {
          globalConstraints: "c",
          fragments: {},
          system: { "alias-stage": "Alias stage prompt found!" },
        },
        pipeline: { stages: [] },
      },
    } as any);

    expect(result).toContain("Alias stage prompt found!");
  });
});

describe("adversarial: buildSystemAppendPrompt system prompt precedence", () => {
  it("stageName key takes precedence over runtime.system_prompt key", async () => {
    const { prompt: result } = await buildSystemAppendPrompt({
      taskId: "t",
      stageName: "coding",
      runtime: { system_prompt: "fallback" } as any,
      stageConfig: { engine: "claude", mcpServices: [] },
      privateConfig: {
        prompts: {
          globalConstraints: "c",
          fragments: {},
          system: {
            coding: "Stage name prompt",
            fallback: "Fallback prompt",
          },
        },
        pipeline: { stages: [] },
      },
    } as any);

    expect(result).toContain("Stage name prompt");
    expect(result).not.toContain("Fallback prompt");
  });
});
