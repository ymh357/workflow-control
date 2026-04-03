import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock("../lib/config-loader.js", () => ({
  loadSystemSettings: () => ({
    agent: { default_engine: "claude" },
    paths: { claude_executable: "claude", gemini_executable: "gemini" },
  }),
  loadMcpRegistry: () => ({ notion: { command: "npx" } }),
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
      { id: "lint-fix", description: "Fix lint issues" },
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

import { spawn } from "node:child_process";
import { validatePipelineConfig } from "../lib/config/schema.js";

const mockSpawn = vi.mocked(spawn);
const mockValidate = vi.mocked(validatePipelineConfig);

function createMockProcess(stdout: string, exitCode = 0) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn();
  setTimeout(() => {
    proc.stdout.emit("data", Buffer.from(stdout));
    proc.emit("close", exitCode);
  }, 5);
  return proc;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ────────────────────────────────────────────────────────────
// Scenario: LLM returns invalid JSON in various formats
// ────────────────────────────────────────────────────────────

describe("pipeline generation should handle malformed LLM output gracefully", () => {
  it("rejects after 2 attempts when JSON is invalid", async () => {
    mockSpawn.mockImplementation(() => createMockProcess("{invalid json}") as any);

    const { generatePipeline } = await import("./pipeline-generator.js");
    await expect(generatePipeline({ description: "test" })).rejects.toThrow(
      /Pipeline skeleton generation failed after 2 attempts/,
    );
  });

  it("rejects when response has no braces at all", async () => {
    mockSpawn.mockImplementation(() => createMockProcess("just plain text") as any);

    const { generatePipeline } = await import("./pipeline-generator.js");
    await expect(generatePipeline({ description: "test" })).rejects.toThrow(
      /Pipeline skeleton generation failed/,
    );
  });

  it("rejects when code block contains non-JSON", async () => {
    mockSpawn.mockImplementation(() => createMockProcess("```json\nnot json\n```") as any);

    const { generatePipeline } = await import("./pipeline-generator.js");
    await expect(generatePipeline({ description: "test" })).rejects.toThrow(
      /Pipeline skeleton generation failed/,
    );
  });

  it("rejects when pipeline field is empty string", async () => {
    mockSpawn.mockImplementation(() => createMockProcess(JSON.stringify({ pipeline: "", scripts: [] })) as any);

    const { generatePipeline } = await import("./pipeline-generator.js");
    await expect(generatePipeline({ description: "empty" })).rejects.toThrow(
      /Pipeline skeleton generation failed/,
    );
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: LLM process failures
// ────────────────────────────────────────────────────────────

describe("LLM process failures should propagate as pipeline generation errors", () => {
  it("reports non-zero exit code", async () => {
    mockSpawn.mockImplementation(() => createMockProcess("", 1) as any);

    const { generatePipeline } = await import("./pipeline-generator.js");
    await expect(generatePipeline({ description: "fail" })).rejects.toThrow(/exited with code 1/);
  });

  it("reports spawn error (binary not found)", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      proc.kill = vi.fn();
      setTimeout(() => proc.emit("error", new Error("ENOENT")), 5);
      return proc as any;
    });

    const { generatePipeline } = await import("./pipeline-generator.js");
    await expect(generatePipeline({ description: "no binary" })).rejects.toThrow(/ENOENT/);
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: Validation retry uses error context
// ────────────────────────────────────────────────────────────

describe("validation failure should trigger retry with error context", () => {
  it("retries once before failing", async () => {
    const response = JSON.stringify({ pipeline: "name: test\nstages: []", scripts: [] });
    let callCount = 0;
    mockSpawn.mockImplementation(() => { callCount++; return createMockProcess(response) as any; });
    mockValidate.mockReturnValue({
      success: false,
      errors: { issues: [{ path: ["stages"], message: "Required" }] },
    } as any);

    const { generatePipeline } = await import("./pipeline-generator.js");
    await expect(generatePipeline({ description: "retry test" })).rejects.toThrow();
    expect(callCount).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: Valid generation edge cases
// ────────────────────────────────────────────────────────────

describe("valid pipeline generation should handle edge cases", () => {
  it("silently filters custom script that conflicts with built-in id", async () => {
    const yaml = "name: test\nstages:\n  - name: s1\n    type: script\n    runtime:\n      engine: script\n      script_id: git-commit";
    const response = JSON.stringify({
      pipeline: yaml,
      scripts: [{ scriptId: "git-commit", manifest: { name: "Git Commit", version: "1.0.0", type: "script", script_id: "git-commit", entry: "index.ts" } }],
    });
    mockSpawn.mockImplementation(() => createMockProcess(response) as any);
    mockValidate.mockReturnValue({
      success: true,
      data: { name: "test", stages: [{ name: "s1", type: "script", runtime: { engine: "script", script_id: "git-commit" } }] },
    } as any);

    const { generatePipeline } = await import("./pipeline-generator.js");
    const result = await generatePipeline({ description: "conflict" });

    expect(result.scripts).toEqual([]);
  });

  it("defaults scripts to empty when missing from LLM response", async () => {
    const response = JSON.stringify({ pipeline: "name: test\nstages: []" });
    mockSpawn.mockImplementation(() => createMockProcess(response) as any);
    mockValidate.mockReturnValue({
      success: true,
      data: { name: "test", stages: [] },
    } as any);

    const { generatePipeline } = await import("./pipeline-generator.js");
    const result = await generatePipeline({ description: "no scripts" });

    expect(result.scripts).toEqual([]);
  });

  it("returns empty promptFiles when no agent stages exist", async () => {
    const yaml = "name: test\nstages:\n  - name: s1\n    type: script\n    runtime:\n      engine: script\n      script_id: git-commit";
    const response = JSON.stringify({ pipeline: yaml, scripts: [] });
    mockSpawn.mockImplementation(() => createMockProcess(response) as any);
    mockValidate.mockReturnValue({
      success: true,
      data: { name: "test", stages: [{ name: "s1", type: "script", runtime: { engine: "script", script_id: "git-commit" } }] },
    } as any);

    const { generatePipeline } = await import("./pipeline-generator.js");
    const result = await generatePipeline({ description: "scripts only" });

    expect(result.promptFiles).toEqual([]);
  });

  it("uses gemini executable with stdin when engine is gemini", async () => {
    const response = JSON.stringify({ pipeline: "name: test\nstages: []", scripts: [] });
    mockSpawn.mockImplementation(() => createMockProcess(response) as any);
    mockValidate.mockReturnValue({
      success: true,
      data: { name: "test", stages: [] },
    } as any);

    const { generatePipeline } = await import("./pipeline-generator.js");
    await generatePipeline({ description: "gemini", engine: "gemini" });

    expect(mockSpawn.mock.calls[0][0]).toBe("gemini");
    expect(mockSpawn.mock.results[0].value.stdin.write).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: Auto-install failure should not break pipeline generation
// ────────────────────────────────────────────────────────────

describe("MCP auto-install failure should be isolated — not crash pipeline generation", () => {
  it("logs warning and continues when installDiscoveredMcp throws", async () => {
    const { discoverExternalCapabilities } = await import("../lib/capability-discovery.js");
    const { registryService } = await import("./registry-service.js");

    vi.mocked(discoverExternalCapabilities).mockResolvedValue({
      mcps: [
        { name: "mcp1", displayName: "MCP 1", description: "d", packageName: "pkg1" },
        { name: "mcp2", displayName: "MCP 2", description: "d", packageName: "pkg2" },
      ],
      skills: [],
    });

    let installCallCount = 0;
    vi.mocked(registryService.installDiscoveredMcp).mockImplementation(() => {
      installCallCount++;
      if (installCallCount === 1) throw new Error("lock file corrupted");
      return { installed: true };
    });

    const yaml = `name: test
stages:
  - name: s1
    type: agent
    mcps: [mcp1, mcp2]
    runtime:
      engine: llm
      system_prompt: __GENERATED__`;
    mockSpawn.mockImplementation(() => createMockProcess(JSON.stringify({ pipeline: yaml, scripts: [] })) as any);
    mockValidate.mockReturnValue({
      success: true,
      data: {
        name: "test",
        stages: [{ name: "s1", type: "agent", mcps: ["mcp1", "mcp2"], runtime: { engine: "llm", system_prompt: "s1" } }],
      },
    } as any);

    const { generatePipeline } = await import("./pipeline-generator.js");
    const result = await generatePipeline({ description: "test" });

    // Pipeline should still be returned despite first MCP install failing
    expect(result.yaml).toBeDefined();
    expect(result.capabilityDiscovery?.autoInstalledMcps).toContain("mcp2");
    expect(result.capabilityDiscovery?.autoInstalledMcps).not.toContain("mcp1");
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: extractJson internal logic
// ────────────────────────────────────────────────────────────

describe("extractJson should handle various LLM output formats", () => {
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

  it("extracts from code block with extra whitespace after json tag", () => {
    expect(extractJson("```json   \n{\"a\": 1}\n```")).toBe('{"a": 1}');
  });

  it("returns trimmed text when only closing brace exists", () => {
    expect(extractJson("no opening brace }")).toBe("no opening brace }");
  });

  it("returns trimmed text when only opening brace exists", () => {
    expect(extractJson("only { here")).toBe("only { here");
  });

  it("returns empty string for empty code block", () => {
    expect(extractJson("```json\n\n```")).toBe("");
  });

  it("extracts outermost braces when multiple JSON objects exist", () => {
    expect(extractJson('text {"a":1} more {"b":2} end')).toBe('{"a":1} more {"b":2}');
  });

  it("falls through to brace extraction when code block has no trailing newline", () => {
    expect(extractJson("```json\n{\"a\":1}```")).toBe('{"a":1}');
  });
});
