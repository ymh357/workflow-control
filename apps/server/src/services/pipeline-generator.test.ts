import { describe, it, expect, vi, beforeEach } from "vitest";

// We cannot easily test generatePipeline without spawning real LLM processes,
// but we can test extractJson which is a pure function.
// Since extractJson is not exported, we test it by importing the module internals.

// Mock all heavy dependencies to allow module import
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock("../lib/config-loader.js", () => ({
  loadSystemSettings: () => ({ agent: {}, paths: {} }),
  loadMcpRegistry: () => ({}),
  CONFIG_DIR: "/tmp/fake-config",
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

vi.mock("../lib/config/schema.js", () => ({
  validatePipelineConfig: vi.fn(),
}));

vi.mock("../scripts/index.js", () => ({
  scriptRegistry: {
    getAllMetadata: () => [
      { id: "git-commit", description: "Commit changes" },
    ],
  },
}));

vi.mock("../lib/capability-discovery.js", () => ({
  discoverExternalCapabilities: vi.fn(async () => ({ mcps: [], skills: [] })),
  autoInstallSkill: vi.fn(async () => false),
}));

vi.mock("./registry-service.js", () => ({
  registryService: {
    installDiscoveredMcp: vi.fn(() => ({ installed: false })),
  },
}));

// Since extractJson and buildPrompt are private, we use a workaround:
// We'll test them through dynamic import tricks or test generatePipeline behavior.
// Actually, let's just test the module by accessing the non-exported functions
// via a re-export test helper pattern. Since we can't modify source, we test
// generatePipeline's behavior with mocked subprocess.

// For extractJson, we replicate its logic in a focused test since it's internal.
// This tests the same algorithm the module uses.
describe("extractJson logic (mirrors internal extractJson)", () => {
  // Replicate the function for isolated testing
  function extractJson(raw: string): string {
    const jsonBlockMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (jsonBlockMatch) return jsonBlockMatch[1].trim();
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return raw.slice(firstBrace, lastBrace + 1);
    }
    return raw.trim();
  }

  it("extracts JSON from markdown code block with json tag", () => {
    const raw = 'Some text\n```json\n{"pipeline": "test"}\n```\nMore text';
    expect(extractJson(raw)).toBe('{"pipeline": "test"}');
  });

  it("extracts JSON from markdown code block without json tag", () => {
    const raw = 'Before\n```\n{"key": "value"}\n```\nAfter';
    expect(extractJson(raw)).toBe('{"key": "value"}');
  });

  it("extracts raw JSON object by finding braces", () => {
    const raw = 'Some prefix text {"pipeline": "yaml"} some suffix';
    expect(extractJson(raw)).toBe('{"pipeline": "yaml"}');
  });

  it("handles nested braces correctly", () => {
    const raw = '{"outer": {"inner": "value"}}';
    expect(extractJson(raw)).toBe('{"outer": {"inner": "value"}}');
  });

  it("returns trimmed input when no JSON found", () => {
    const raw = "  just plain text  ";
    expect(extractJson(raw)).toBe("just plain text");
  });

  it("handles multi-line JSON in code block", () => {
    const raw = '```json\n{\n  "pipeline": "test",\n  "scripts": []\n}\n```';
    expect(extractJson(raw)).toBe('{\n  "pipeline": "test",\n  "scripts": []\n}');
  });

  it("prefers code block over raw braces", () => {
    const raw = 'prefix { bad } \n```json\n{"good": true}\n```\n suffix { also bad }';
    expect(extractJson(raw)).toBe('{"good": true}');
  });
});

describe("generatePipeline", () => {
  it("module can be imported without errors", async () => {
    // Just verifying the mocks allow import
    const mod = await import("./pipeline-generator.js");
    expect(typeof mod.generatePipeline).toBe("function");
  });
});

// ---------- generatePipeline with mocked spawn ----------

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => ""),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  mkdtempSync: vi.fn(() => "/tmp/gen-123"),
  rmSync: vi.fn(),
}));

const mockSpawn = vi.mocked(spawn);

function createMockProcess(stdout: string, exitCode = 0) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn();

  // Emit data and close asynchronously
  setTimeout(() => {
    proc.stdout.emit("data", Buffer.from(stdout));
    proc.emit("close", exitCode);
  }, 5);

  return proc;
}

import { validatePipelineConfig } from "../lib/config/schema.js";
const mockValidate = vi.mocked(validatePipelineConfig);

describe("generatePipeline with mocked LLM", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generates pipeline from valid LLM response", async () => {
    const pipelineYaml = "name: test-pipe\nstages:\n  - name: analyze\n    type: agent\n    runtime:\n      engine: llm\n      system_prompt: analyze";
    const llmResponse = JSON.stringify({
      pipeline: pipelineYaml,
      scripts: [],
    });

    // generatePipeline spawns: 1 for skeleton, 1 for each agent stage prompt
    // The validated data has one agent stage, so there will be 2 spawn calls total
    mockSpawn.mockImplementation(() => createMockProcess(llmResponse) as any);

    const validatedData = {
      name: "test-pipe",
      stages: [{
        name: "analyze",
        type: "agent",
        runtime: { engine: "llm", system_prompt: "analyze" },
      }],
    };
    mockValidate.mockReturnValue({
      success: true,
      data: validatedData,
    } as any);

    const { generatePipeline } = await import("./pipeline-generator.js");
    const result = await generatePipeline({ description: "A simple pipeline" });

    // yaml is re-serialized from the validated object, so check it's a non-empty string
    expect(typeof result.yaml).toBe("string");
    expect(result.yaml.length).toBeGreaterThan(0);
    expect(result.scripts).toEqual([]);
    // promptFiles are now GeneratedPromptFile[] generated per agent stage
    expect(result.promptFiles).toHaveLength(1);
    expect(result.promptFiles[0]).toHaveProperty("name");
    expect(result.promptFiles[0]).toHaveProperty("content");
  }, 10_000);

  it("retries on validation failure then succeeds", async () => {
    const badYaml = "name: bad\nstages: []";
    const goodYaml = "name: good\nstages:\n  - name: s1\n    type: agent";

    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return createMockProcess(JSON.stringify({ pipeline: badYaml, scripts: [] })) as any;
      }
      return createMockProcess(JSON.stringify({ pipeline: goodYaml, scripts: [] })) as any;
    });

    let validateCount = 0;
    mockValidate.mockImplementation(() => {
      validateCount++;
      if (validateCount === 1) {
        return {
          success: false,
          errors: { issues: [{ path: ["stages"], message: "too few stages" }] },
        } as any;
      }
      return { success: true, data: { name: "good", stages: [] } } as any;
    });

    const { generatePipeline } = await import("./pipeline-generator.js");
    const result = await generatePipeline({ description: "retry test" });
    // yaml is re-serialized from the validated object
    expect(typeof result.yaml).toBe("string");
    expect(result.yaml.length).toBeGreaterThan(0);
  });

  it("throws after 2 failed attempts", async () => {
    mockSpawn.mockImplementation(() => createMockProcess("not json at all {{{") as any);
    mockValidate.mockReturnValue({ success: false, errors: { issues: [] } } as any);

    const { generatePipeline } = await import("./pipeline-generator.js");
    await expect(generatePipeline({ description: "fail test" })).rejects.toThrow(
      /Pipeline skeleton generation failed after 2 attempts/,
    );
  });

  it("throws when LLM response has no pipeline field", async () => {
    const response = JSON.stringify({ scripts: [] });
    mockSpawn.mockImplementation(() => createMockProcess(response) as any);

    const { generatePipeline } = await import("./pipeline-generator.js");
    await expect(generatePipeline({ description: "no pipeline" })).rejects.toThrow(
      /Pipeline skeleton generation failed/,
    );
  });

  it("uses gemini engine with stdin when specified", async () => {
    const pipelineYaml = "name: gemini-pipe\nstages: []";
    const llmResponse = JSON.stringify({
      pipeline: pipelineYaml,
      scripts: [],
    });

    mockSpawn.mockReturnValue(createMockProcess(llmResponse));
    mockValidate.mockReturnValue({
      success: true,
      data: { name: "gemini-pipe", stages: [] } as any,
    } as any);

    const { generatePipeline } = await import("./pipeline-generator.js");
    const result = await generatePipeline({ description: "gemini test", engine: "gemini" });
    // yaml is re-serialized from the validated object
    expect(typeof result.yaml).toBe("string");
    expect(result.yaml.length).toBeGreaterThan(0);

    // Gemini uses stdin
    const spawnCall = mockSpawn.mock.calls[0];
    expect(spawnCall[0]).toBe("gemini");
  });

  it("generates prompt files for agent stages", async () => {
    const pipelineYaml = "name: test\nstages:\n  - name: analyze\n    type: agent\n    runtime:\n      engine: llm\n      system_prompt: analyze\n  - name: implement\n    type: agent\n    runtime:\n      engine: llm\n      system_prompt: implement";

    // 1 spawn for skeleton + 2 spawns for agent stage prompts = 3 total
    mockSpawn.mockImplementation(() =>
      createMockProcess(JSON.stringify({
        pipeline: pipelineYaml,
        scripts: [],
      })) as any,
    );
    mockValidate.mockReturnValue({
      success: true,
      data: {
        name: "test",
        stages: [
          { name: "analyze", type: "agent", runtime: { engine: "llm", system_prompt: "analyze" } },
          { name: "implement", type: "agent", runtime: { engine: "llm", system_prompt: "implement" } },
        ],
      } as any,
    } as any);

    const { generatePipeline } = await import("./pipeline-generator.js");
    const result = await generatePipeline({ description: "prompt files test" });
    // promptFiles are now GeneratedPromptFile[] with name and content
    expect(result.promptFiles).toHaveLength(2);
    expect(result.promptFiles[0]).toHaveProperty("name");
    expect(result.promptFiles[0]).toHaveProperty("content");
    expect(result.promptFiles[1]).toHaveProperty("name");
    expect(result.promptFiles[1]).toHaveProperty("content");
  }, 10_000);
});
