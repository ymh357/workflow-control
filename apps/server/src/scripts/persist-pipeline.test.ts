import { describe, it, expect, vi, beforeEach } from "vitest";

const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockRmSync = vi.fn();

vi.mock("node:fs", () => ({
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  readdirSync: (...args: any[]) => mockReaddirSync(...args),
  rmSync: (...args: any[]) => mockRmSync(...args),
}));

vi.mock("../lib/config-loader.js", () => ({
  CONFIG_DIR: "/tmp/test-config",
}));

const mockValidate = vi.fn();
vi.mock("../lib/config/schema.js", () => ({
  validatePipelineConfig: (...args: any[]) => mockValidate(...args),
}));

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { persistPipelineScript } from "./persist-pipeline.js";

const validYaml = "name: test\nstages: []";

const defaultInputs = {
  yaml: validYaml,
  pipelineId: "my-pipeline",
  pipelineName: "My Pipeline",
  prompts: {
    files: [
      { name: "analysis", content: "You are an analyst." },
      { name: "tech-prep", content: "You are a tech lead." },
    ],
    globalConstraints: "## Rules\n- Be precise",
  },
};

function makeParams(overrides: Record<string, any> = {}) {
  return {
    taskId: "task-99",
    context: { store: {} } as any,
    settings: {} as any,
    inputs: "inputs" in overrides ? overrides.inputs : defaultInputs,
    args: overrides.args,
  };
}

describe("persistPipelineScript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
    mockReadFileSync.mockReturnValue("");
    mockValidate.mockReturnValue({ success: true, data: { name: "test", stages: [] } });
  });

  it("has correct metadata id", () => {
    expect(persistPipelineScript.metadata.id).toBe("persist_pipeline");
  });

  it("creates directory structure and writes all files", async () => {
    const result = await persistPipelineScript.handler(makeParams());

    expect(mockMkdirSync).toHaveBeenCalledWith(
      "/tmp/test-config/pipelines/my-pipeline/prompts/system",
      { recursive: true },
    );

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/test-config/pipelines/my-pipeline/pipeline.yaml",
      validYaml,
      "utf-8",
    );

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/test-config/pipelines/my-pipeline/prompts/system/analysis.md",
      "You are an analyst.",
      "utf-8",
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/test-config/pipelines/my-pipeline/prompts/system/tech-prep.md",
      "You are a tech lead.",
      "utf-8",
    );

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/test-config/pipelines/my-pipeline/prompts/global-constraints.md",
      "## Rules\n- Be precise",
      "utf-8",
    );

    expect(result.persistResult.pipelineId).toBe("my-pipeline");
    expect(result.persistResult.pipelineName).toBe("My Pipeline");
    expect(result.persistResult.validationPassed).toBe(true);
    expect(result.persistResult.savedFiles).toEqual([
      "pipeline.yaml",
      "prompts/system/analysis.md",
      "prompts/system/tech-prep.md",
      "prompts/global-constraints.md",
    ]);
  });

  it("calls validatePipelineConfig before writing", async () => {
    await persistPipelineScript.handler(makeParams());
    expect(mockValidate).toHaveBeenCalledTimes(1);
    expect(mockValidate).toHaveBeenCalledWith({ name: "test", stages: [] });
  });

  it("throws on schema validation failure without writing any files", async () => {
    mockValidate.mockReturnValue({
      success: false,
      errors: { issues: [{ path: ["stages"], message: "Required" }] },
    });

    await expect(
      persistPipelineScript.handler(makeParams()),
    ).rejects.toThrow(/Pipeline schema validation failed/);

    // No files should have been written
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("throws on invalid YAML syntax", async () => {
    await expect(
      persistPipelineScript.handler(makeParams({ inputs: { yaml: "{{invalid: yaml: :", pipelineId: "x" } })),
    ).rejects.toThrow(/Invalid YAML syntax/);

    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("throws when yaml input is missing", async () => {
    await expect(
      persistPipelineScript.handler(makeParams({ inputs: { pipelineId: "x" } })),
    ).rejects.toThrow("Missing required inputs");
  });

  it("throws when pipelineId input is missing", async () => {
    await expect(
      persistPipelineScript.handler(makeParams({ inputs: { yaml: "x" } })),
    ).rejects.toThrow("Missing required inputs");
  });

  it("throws when pipeline already exists", async () => {
    mockExistsSync.mockReturnValue(true);
    await expect(
      persistPipelineScript.handler(makeParams()),
    ).rejects.toThrow(/already exists/);
  });

  it("sanitizes pipelineId to prevent path traversal", async () => {
    const result = await persistPipelineScript.handler(
      makeParams({ inputs: { yaml: validYaml, pipelineId: "../../../etc/evil" } }),
    );
    expect(result.persistResult.pipelineId).toBe("etc-evil");
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("etc-evil/prompts/system"),
      { recursive: true },
    );
  });

  it("rejects pipelineId that sanitizes to empty string", async () => {
    await expect(
      persistPipelineScript.handler(makeParams({ inputs: { yaml: validYaml, pipelineId: "../../.." } })),
    ).rejects.toThrow("Invalid pipelineId");
  });

  it("skips prompt files with empty name or content", async () => {
    const result = await persistPipelineScript.handler(
      makeParams({
        inputs: {
          yaml: validYaml,
          pipelineId: "test",
          prompts: {
            files: [
              { name: "", content: "ignored" },
              { name: "valid", content: "" },
              { name: "good", content: "content" },
            ],
          },
        },
      }),
    );
    expect(result.persistResult.savedFiles).toEqual(["pipeline.yaml", "prompts/system/good.md"]);
  });

  it("works without prompts input", async () => {
    const result = await persistPipelineScript.handler(
      makeParams({ inputs: { yaml: "name: bare\nstages: []", pipelineId: "bare" } }),
    );
    expect(result.persistResult.savedFiles).toEqual(["pipeline.yaml"]);
    expect(result.persistResult.pipelineId).toBe("bare");
  });

  it("uses pipelineId as pipelineName when pipelineName is not provided", async () => {
    const result = await persistPipelineScript.handler(
      makeParams({ inputs: { yaml: validYaml, pipelineId: "no-name" } }),
    );
    expect(result.persistResult.pipelineName).toBe("no-name");
  });

  it("sanitizes prompt file names", async () => {
    const result = await persistPipelineScript.handler(
      makeParams({
        inputs: {
          yaml: validYaml,
          pipelineId: "test",
          prompts: { files: [{ name: "my_prompt.v2", content: "hi" }] },
        },
      }),
    );
    expect(result.persistResult.savedFiles).toContain("prompts/system/my-prompt-v2.md");
  });

  it("sanitizes uppercase and special chars in pipelineId", async () => {
    const result = await persistPipelineScript.handler(
      makeParams({ inputs: { yaml: validYaml, pipelineId: "My Pipeline (v2)" } }),
    );
    expect(result.persistResult.pipelineId).toBe("y-ipeline-v2");
  });

  it("handles dict-format prompt files (AI outputs {name: content} instead of [{name, content}])", async () => {
    const result = await persistPipelineScript.handler(
      makeParams({
        inputs: {
          yaml: validYaml,
          pipelineId: "dict-test",
          prompts: {
            files: {
              "analysis": "You are an analyst...",
              "security-audit": "You are a security auditor...",
            } as any,
          },
        },
      }),
    );
    expect(result.persistResult.savedFiles).toEqual([
      "pipeline.yaml",
      "prompts/system/analysis.md",
      "prompts/system/security-audit.md",
    ]);
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("analysis.md"),
      "You are an analyst...",
      "utf-8",
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("security-audit.md"),
      "You are a security auditor...",
      "utf-8",
    );
  });

  it("includes detailed validation errors in thrown message", async () => {
    mockValidate.mockReturnValue({
      success: false,
      errors: {
        issues: [
          { path: ["stages", 0, "name"], message: "Required" },
          { path: ["stages", 0, "type"], message: "Invalid enum value" },
        ],
      },
    });

    await expect(
      persistPipelineScript.handler(makeParams()),
    ).rejects.toThrow(/stages\.0\.name: Required.*stages\.0\.type: Invalid enum value/s);
  });

  // --- Disk-based prompt reading (Format 1: outputDir from refinePrompts/genPrompts) ---

  it("reads prompt files from outputDir when present", async () => {
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s === "/tmp/refined-prompts-task-99") return true; // outputDir exists
      if (s.includes("pipeline.yaml")) return false; // pipeline doesn't exist yet
      return false;
    });
    mockReaddirSync.mockImplementation((p: any) => {
      if (String(p) === "/tmp/refined-prompts-task-99") return ["audit.md", "plan.md", "global-constraints.md"];
      return [];
    });
    mockReadFileSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes("audit.md")) return "Enhanced audit prompt";
      if (s.includes("plan.md")) return "Enhanced plan prompt";
      if (s.includes("global-constraints.md")) return "Enhanced constraints";
      return "";
    });

    const result = await persistPipelineScript.handler(makeParams({
      inputs: {
        yaml: validYaml,
        pipelineId: "my-pipeline",
        pipelineName: "Test",
        prompts: {
          outputDir: "/tmp/refined-prompts-task-99",
          refinedFiles: ["audit", "plan"],
          summary: "Enhanced with project details",
        },
      },
    }));

    // Should have written pipeline.yaml + 2 prompts + 1 global constraints
    const writePaths = mockWriteFileSync.mock.calls.map((c: any[]) => c[0] as string);
    expect(writePaths.some((p: string) => p.includes("pipeline.yaml"))).toBe(true);
    expect(writePaths.some((p: string) => p.includes("prompts/system/audit.md"))).toBe(true);
    expect(writePaths.some((p: string) => p.includes("prompts/system/plan.md"))).toBe(true);
    expect(writePaths.some((p: string) => p.includes("global-constraints.md"))).toBe(true);

    // Should have cleaned up temp dir
    expect(mockRmSync).toHaveBeenCalledWith("/tmp/refined-prompts-task-99", { recursive: true, force: true });

    expect(result.persistResult.savedFiles).toContain("prompts/system/audit.md");
    expect(result.persistResult.savedFiles).toContain("prompts/system/plan.md");
    expect(result.persistResult.savedFiles).toContain("prompts/global-constraints.md");
  });

  it("falls back to store-based prompts when outputDir does not exist", async () => {
    // outputDir path doesn't exist on disk
    mockExistsSync.mockReturnValue(false);

    const result = await persistPipelineScript.handler(makeParams({
      inputs: {
        yaml: validYaml,
        pipelineId: "my-pipeline",
        pipelineName: "Test",
        prompts: {
          outputDir: "/tmp/nonexistent-dir",
          files: { "audit": "Fallback audit content" },
          globalConstraints: "Fallback constraints",
        },
      },
    }));

    // Should use the files dict fallback
    const writePaths = mockWriteFileSync.mock.calls.map((c: any[]) => c[0] as string);
    expect(writePaths.some((p: string) => p.includes("prompts/system/audit.md"))).toBe(true);
    expect(writePaths.some((p: string) => p.includes("global-constraints.md"))).toBe(true);
    expect(result.persistResult.savedFiles).toContain("prompts/system/audit.md");
  });

  it("cleans up rawPromptDir when provided and different from refinedOutputDir", async () => {
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s === "/tmp/refined-prompts-task-99") return true;
      if (s === "/tmp/gen-prompts-task-99") return true;
      if (s.includes("pipeline.yaml")) return false;
      return false;
    });
    mockReaddirSync.mockImplementation((p: any) => {
      if (String(p) === "/tmp/refined-prompts-task-99") return ["audit.md"];
      return [];
    });
    mockReadFileSync.mockReturnValue("prompt content");

    await persistPipelineScript.handler(makeParams({
      inputs: {
        yaml: validYaml,
        pipelineId: "my-pipeline",
        pipelineName: "Test",
        prompts: {
          outputDir: "/tmp/refined-prompts-task-99",
          refinedFiles: ["audit"],
        },
        rawPromptDir: "/tmp/gen-prompts-task-99",
      },
    }));

    // Both temp dirs should be cleaned up
    expect(mockRmSync).toHaveBeenCalledWith("/tmp/refined-prompts-task-99", { recursive: true, force: true });
    expect(mockRmSync).toHaveBeenCalledWith("/tmp/gen-prompts-task-99", { recursive: true, force: true });
  });

  it("does not double-clean when rawPromptDir equals refinedOutputDir", async () => {
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s === "/tmp/same-dir") return true;
      if (s.includes("pipeline.yaml")) return false;
      return false;
    });
    mockReaddirSync.mockImplementation((p: any) => {
      if (String(p) === "/tmp/same-dir") return ["audit.md"];
      return [];
    });
    mockReadFileSync.mockReturnValue("prompt content");

    await persistPipelineScript.handler(makeParams({
      inputs: {
        yaml: validYaml,
        pipelineId: "my-pipeline",
        prompts: {
          outputDir: "/tmp/same-dir",
          refinedFiles: ["audit"],
        },
        rawPromptDir: "/tmp/same-dir",
      },
    }));

    // rmSync should be called once for refinedOutputDir, not again for rawPromptDir
    const rmCalls = mockRmSync.mock.calls.filter((c: any[]) => c[0] === "/tmp/same-dir");
    expect(rmCalls).toHaveLength(1);
  });

  it("globalConstraints from store is written even when outputDir is absent and files is empty", async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await persistPipelineScript.handler(makeParams({
      inputs: {
        yaml: validYaml,
        pipelineId: "my-pipeline",
        pipelineName: "Test",
        prompts: {
          globalConstraints: "Only constraints, no files",
        },
      },
    }));

    const writePaths = mockWriteFileSync.mock.calls.map((c: any[]) => c[0] as string);
    expect(writePaths.some((p: string) => p.includes("global-constraints.md"))).toBe(true);
  });
});
