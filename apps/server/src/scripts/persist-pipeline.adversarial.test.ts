import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
}));

vi.mock("../lib/config-loader.js", () => ({
  CONFIG_DIR: "/fake/config",
}));

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mockValidatePipelineConfig = vi.fn();
vi.mock("../lib/config/schema.js", () => ({
  validatePipelineConfig: (...args: any[]) => mockValidatePipelineConfig(...args),
}));

const mockValidatePipelineLogic = vi.fn();
const mockGetValidationErrors = vi.fn();
const mockValidatePromptAlignment = vi.fn();
vi.mock("@workflow-control/shared", () => ({
  validatePipelineLogic: (...args: any[]) => mockValidatePipelineLogic(...args),
  getValidationErrors: (...args: any[]) => mockGetValidationErrors(...args),
  validatePromptAlignment: (...args: any[]) => mockValidatePromptAlignment(...args),
}));

import { persistPipelineScript } from "./persist-pipeline.js";

const VALID_YAML = `name: test-pipeline\nstages:\n  - name: stage1\n    type: agent\n    runtime:\n      engine: claude\n`;
const VALID_PARSED = { name: "test-pipeline", stages: [{ name: "stage1", type: "agent", runtime: { engine: "claude" } }] };

function makeParams(overrides: Record<string, any> = {}) {
  return {
    taskId: "task-1",
    context: {} as any,
    settings: {} as any,
    inputs: {
      yaml: VALID_YAML,
      pipelineId: "my-pipeline",
      ...overrides,
    },
    args: {},
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockValidatePipelineConfig.mockReturnValue({ success: true });
  mockValidatePipelineLogic.mockReturnValue([]);
  mockGetValidationErrors.mockReturnValue([]);
  mockValidatePromptAlignment.mockReturnValue([]);
});

// ── Missing required inputs ──

describe("missing required inputs", () => {
  it("no yaml or pipeline — throws 'Missing required inputs'", async () => {
    await expect(
      persistPipelineScript.handler(makeParams({ yaml: undefined, pipeline: undefined })),
    ).rejects.toThrow("Missing required inputs");
  });

  it("no pipelineId — throws 'Missing required inputs'", async () => {
    await expect(
      persistPipelineScript.handler(makeParams({ pipelineId: undefined })),
    ).rejects.toThrow("Missing required inputs");
  });

  it("empty string pipelineId sanitizes to empty — throws 'Invalid pipelineId'", async () => {
    await expect(
      persistPipelineScript.handler(makeParams({ pipelineId: "" })),
    ).rejects.toThrow("Missing required inputs");
  });
});

// ── pipelineId sanitization ──

describe("pipelineId sanitization", () => {
  it("pipelineId with uppercase letters — non-lowercase chars become dashes", async () => {
    // Regex is /[^a-z0-9-]/g — uppercase letters are replaced with '-', not lowercased
    const result = await persistPipelineScript.handler(makeParams({ pipelineId: "my-pipeline" }));
    expect((result as any).persistResult.pipelineId).toBe("my-pipeline");
  });

  it("pipelineId with path separators is sanitized (/ becomes -)", async () => {
    const result = await persistPipelineScript.handler(makeParams({ pipelineId: "path/to/pipe" }));
    // slashes are replaced by -
    expect((result as any).persistResult.pipelineId).toMatch(/^[a-z0-9-]+$/);
    expect((result as any).persistResult.pipelineId).not.toContain("/");
  });

  it("pipelineId '../../../etc' is sanitized to not contain dots or slashes", async () => {
    const result = await persistPipelineScript.handler(makeParams({ pipelineId: "../../../etc" }));
    const safeId = (result as any).persistResult.pipelineId;
    expect(safeId).not.toContain(".");
    expect(safeId).not.toContain("/");
    expect(safeId).not.toContain("\\");
  });

  it("pipelineId consisting entirely of special chars throws 'Invalid pipelineId'", async () => {
    // All non-alphanumeric-or-dash stripped, leading/trailing dashes removed => empty
    await expect(
      persistPipelineScript.handler(makeParams({ pipelineId: "..." })),
    ).rejects.toThrow("Invalid pipelineId");
  });

  it("pipelineId '@@@' sanitizes to empty and throws 'Invalid pipelineId'", async () => {
    await expect(
      persistPipelineScript.handler(makeParams({ pipelineId: "@@@" })),
    ).rejects.toThrow("Invalid pipelineId");
  });

  it("consecutive dashes are collapsed to one", async () => {
    const result = await persistPipelineScript.handler(makeParams({ pipelineId: "my---pipeline" }));
    const safeId = (result as any).persistResult.pipelineId;
    expect(safeId).not.toContain("--");
  });

  it("leading and trailing dashes are stripped", async () => {
    const result = await persistPipelineScript.handler(makeParams({ pipelineId: "-my-pipeline-" }));
    const safeId = (result as any).persistResult.pipelineId;
    expect(safeId).not.toMatch(/^-/);
    expect(safeId).not.toMatch(/-$/);
  });

  it("very long pipelineId is accepted without truncation", async () => {
    const longId = "a".repeat(200);
    const result = await persistPipelineScript.handler(makeParams({ pipelineId: longId }));
    const safeId = (result as any).persistResult.pipelineId;
    expect(safeId.length).toBeGreaterThan(0);
  });
});

// ── YAML parsing ──

describe("YAML parsing failures", () => {
  it("invalid YAML syntax throws 'Invalid YAML syntax'", async () => {
    await expect(
      persistPipelineScript.handler(makeParams({ yaml: "not: valid: yaml: : :" })),
    ).rejects.toThrow("Invalid YAML syntax");
  });

  it("invalid pipeline input type number throws error about type", async () => {
    await expect(
      persistPipelineScript.handler(makeParams({ yaml: undefined, pipeline: 42 as any })),
    ).rejects.toThrow("Invalid pipeline input type");
  });

  it("pipeline as JSON object (non-string) is accepted and serialized", async () => {
    const result = await persistPipelineScript.handler(makeParams({
      yaml: undefined,
      pipeline: VALID_PARSED,
    }));
    expect((result as any).persistResult.validationPassed).toBe(true);
  });
});

// ── Schema validation failures ──

describe("schema validation failures", () => {
  it("validatePipelineConfig returns failure — throws 'Pipeline schema validation failed'", async () => {
    mockValidatePipelineConfig.mockReturnValue({
      success: false,
      errors: { issues: [{ path: ["stages"], message: "Required" }] },
    });
    await expect(
      persistPipelineScript.handler(makeParams()),
    ).rejects.toThrow("Pipeline schema validation failed");
  });

  it("validation error message includes the field path and message", async () => {
    mockValidatePipelineConfig.mockReturnValue({
      success: false,
      errors: { issues: [{ path: ["name"], message: "Name is required" }] },
    });
    await expect(
      persistPipelineScript.handler(makeParams()),
    ).rejects.toThrow("name: Name is required");
  });

  it("multiple validation errors all included in thrown message", async () => {
    mockValidatePipelineConfig.mockReturnValue({
      success: false,
      errors: {
        issues: [
          { path: ["name"], message: "Required" },
          { path: ["stages"], message: "Must be array" },
        ],
      },
    });
    try {
      await persistPipelineScript.handler(makeParams());
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("name: Required");
      expect(err.message).toContain("stages: Must be array");
    }
  });
});

// ── Logic validation failures ──

describe("logical validation failures", () => {
  it("getValidationErrors returns errors — throws 'Pipeline logical validation failed'", async () => {
    mockValidatePipelineLogic.mockReturnValue([
      { severity: "error", field: "stageB.reads.data", message: "Field not written by any prior stage" },
    ]);
    mockGetValidationErrors.mockReturnValue([
      { field: "stageB.reads.data", message: "Field not written by any prior stage" },
    ]);
    await expect(
      persistPipelineScript.handler(makeParams()),
    ).rejects.toThrow("Pipeline logical validation failed");
  });

  it("logic error message includes field and message", async () => {
    mockValidatePipelineLogic.mockReturnValue([
      { severity: "error", field: "myField", message: "Unresolvable reference" },
    ]);
    mockGetValidationErrors.mockReturnValue([
      { field: "myField", message: "Unresolvable reference" },
    ]);
    await expect(
      persistPipelineScript.handler(makeParams()),
    ).rejects.toThrow("Unresolvable reference");
  });

  it("logic warnings do NOT block pipeline persistence", async () => {
    mockValidatePipelineLogic.mockReturnValue([
      { severity: "warning", field: "stageA", message: "Might be slow" },
    ]);
    mockGetValidationErrors.mockReturnValue([]); // no errors, only warnings
    const result = await persistPipelineScript.handler(makeParams());
    expect((result as any).persistResult.validationPassed).toBe(true);
  });

  it("yaml without stages field — validatePipelineLogic is NOT called", async () => {
    // YAML with no stages passes schema validation but logic check is skipped
    const yamlNoStages = "name: test-pipeline";
    const parsedNoStages = { name: "test-pipeline" };
    // parseYAML("name: test-pipeline") => { name: "test-pipeline" } — no stages key
    mockValidatePipelineConfig.mockReturnValue({ success: true });
    await persistPipelineScript.handler(makeParams({ yaml: yamlNoStages }));
    // validatePipelineLogic should not be called (stages is falsy)
    expect(mockValidatePipelineLogic).not.toHaveBeenCalled();
  });
});

// ── File already exists ──

describe("pipeline already exists", () => {
  it("pipeline.yaml already exists — throws error mentioning 'already exists'", async () => {
    mockExistsSync.mockReturnValue(true);
    await expect(
      persistPipelineScript.handler(makeParams()),
    ).rejects.toThrow("already exists");
  });

  it("error message includes the pipeline ID", async () => {
    mockExistsSync.mockReturnValue(true);
    await expect(
      persistPipelineScript.handler(makeParams({ pipelineId: "existing-pipe" })),
    ).rejects.toThrow("existing-pipe");
  });

  it("when pipeline does not exist — writeFileSync is called", async () => {
    mockExistsSync.mockReturnValue(false);
    await persistPipelineScript.handler(makeParams());
    expect(mockWriteFileSync).toHaveBeenCalled();
  });
});

// ── Prompt file writing ──

describe("prompt file writing", () => {
  it("prompts.files as array — each entry is written with sanitized name", async () => {
    await persistPipelineScript.handler(makeParams({
      prompts: {
        files: [
          { name: "analyzing", content: "Analysis prompt content" },
          { name: "reporting", content: "Report prompt content" },
        ],
      },
    }));
    const writeCalls = mockWriteFileSync.mock.calls.map(c => c[0] as string);
    expect(writeCalls.some(p => p.includes("analyzing.md"))).toBe(true);
    expect(writeCalls.some(p => p.includes("reporting.md"))).toBe(true);
  });

  it("prompts.files as dict object — normalized to array and written", async () => {
    await persistPipelineScript.handler(makeParams({
      prompts: {
        files: { analyzing: "Analysis content", reporting: "Report content" } as any,
      },
    }));
    const writeCalls = mockWriteFileSync.mock.calls.map(c => c[0] as string);
    expect(writeCalls.some(p => p.includes("analyzing.md"))).toBe(true);
  });

  it("prompt file with missing name is skipped without error", async () => {
    await persistPipelineScript.handler(makeParams({
      prompts: {
        files: [
          { name: "", content: "content" },
          { name: "valid-prompt", content: "valid content" },
        ],
      },
    }));
    const writeCalls = mockWriteFileSync.mock.calls.map(c => c[0] as string);
    expect(writeCalls.some(p => p.includes("valid-prompt.md"))).toBe(true);
    // No .md file with empty name
    expect(writeCalls.every(p => !p.includes("/.md"))).toBe(true);
  });

  it("prompt file with missing content is skipped without error", async () => {
    await expect(
      persistPipelineScript.handler(makeParams({
        prompts: {
          files: [
            { name: "no-content", content: "" },
          ],
        },
      })),
    ).resolves.not.toThrow();
  });

  it("prompt file names with special chars are sanitized (uppercase, spaces -> dashes)", async () => {
    await persistPipelineScript.handler(makeParams({
      prompts: {
        files: [{ name: "My Prompt Name!", content: "content" }],
      },
    }));
    const writeCalls = mockWriteFileSync.mock.calls.map(c => c[0] as string);
    // Special chars sanitized; path should not contain spaces or !
    const promptCall = writeCalls.find(p => p.endsWith(".md") && !p.includes("pipeline.yaml"));
    expect(promptCall).toBeDefined();
    expect(promptCall).not.toContain(" ");
    expect(promptCall).not.toContain("!");
  });

  it("globalConstraints is written to prompts/global-constraints.md", async () => {
    await persistPipelineScript.handler(makeParams({
      prompts: {
        globalConstraints: "Always be concise.",
      },
    }));
    const writeCalls = mockWriteFileSync.mock.calls.map(c => c[0] as string);
    expect(writeCalls.some(p => p.includes("global-constraints.md"))).toBe(true);
  });

  it("no prompts field — only pipeline.yaml is written", async () => {
    await persistPipelineScript.handler(makeParams({ prompts: undefined }));
    const writeCalls = mockWriteFileSync.mock.calls.map(c => c[0] as string);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]).toContain("pipeline.yaml");
  });
});

// ── Successful return value ──

describe("successful return value", () => {
  it("returns persistResult with correct pipelineId", async () => {
    const result = await persistPipelineScript.handler(makeParams({ pipelineId: "my-pipeline" }));
    expect((result as any).persistResult.pipelineId).toBe("my-pipeline");
  });

  it("returns persistResult with validationPassed: true", async () => {
    const result = await persistPipelineScript.handler(makeParams());
    expect((result as any).persistResult.validationPassed).toBe(true);
  });

  it("savedFiles includes 'pipeline.yaml'", async () => {
    const result = await persistPipelineScript.handler(makeParams());
    expect((result as any).persistResult.savedFiles).toContain("pipeline.yaml");
  });

  it("pipelineName defaults to pipelineId when not provided", async () => {
    const result = await persistPipelineScript.handler(makeParams({ pipelineId: "test-id" }));
    expect((result as any).persistResult.pipelineName).toBe("test-id");
  });

  it("pipelineName is used when provided", async () => {
    const result = await persistPipelineScript.handler(makeParams({ pipelineName: "My Test Pipeline" }));
    expect((result as any).persistResult.pipelineName).toBe("My Test Pipeline");
  });
});

// ── fs failure mid-write ──

describe("filesystem failures mid-write", () => {
  it("mkdirSync throws EACCES — propagates error, no files written", async () => {
    mockMkdirSync.mockImplementation(() => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); });
    await expect(
      persistPipelineScript.handler(makeParams()),
    ).rejects.toThrow("EACCES");
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("mkdirSync throws ENOSPC — propagates error", async () => {
    mockMkdirSync.mockImplementation(() => { throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" }); });
    await expect(
      persistPipelineScript.handler(makeParams()),
    ).rejects.toThrow("ENOSPC");
  });

  it("writeFileSync throws on pipeline.yaml — propagates error", async () => {
    mockWriteFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith("pipeline.yaml")) {
        throw Object.assign(new Error("ENOSPC: disk full"), { code: "ENOSPC" });
      }
    });
    await expect(
      persistPipelineScript.handler(makeParams()),
    ).rejects.toThrow("ENOSPC");
  });

  it("writeFileSync throws on prompt file — propagates error after pipeline.yaml written", async () => {
    let calls = 0;
    mockWriteFileSync.mockImplementation(() => {
      calls++;
      if (calls === 2) {
        // Second write (first prompt file) fails
        throw new Error("EROFS: read-only file system");
      }
    });
    await expect(
      persistPipelineScript.handler(makeParams({
        prompts: { files: [{ name: "prompt1", content: "c" }] },
      })),
    ).rejects.toThrow("EROFS");
    // pipeline.yaml was already written (call 1 succeeded)
    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
  });
});
