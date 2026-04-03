import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClearSettingsCache = vi.fn();
const mockClearPipelineCache = vi.fn();
const mockClearFragmentCache = vi.fn();
const mockClearDynamicScriptCache = vi.fn();

vi.mock("./settings.js", () => ({
  clearSettingsCache: (...a: any[]) => mockClearSettingsCache(...a),
  CONFIG_DIR: "/fake/config",
  interpolateEnvVar: vi.fn((v: string) => v),
  interpolateObject: vi.fn((v: any) => v),
  getNestedValue: vi.fn(),
  loadSystemSettings: vi.fn(() => ({})),
}));

vi.mock("./pipeline.js", () => ({
  clearPipelineCache: (...a: any[]) => mockClearPipelineCache(...a),
  loadPipelineConfig: vi.fn(),
  listAvailablePipelines: vi.fn(() => []),
  deepMergePipeline: vi.fn(),
}));

vi.mock("./fragments.js", () => ({
  clearFragmentCache: (...a: any[]) => mockClearFragmentCache(...a),
  getFragmentRegistry: vi.fn(),
  parseFrontmatter: vi.fn(),
  FragmentRegistry: vi.fn(),
  resolveFragmentsFromSnapshot: vi.fn(),
}));

vi.mock("../script-loader.js", () => ({
  clearDynamicScriptCache: (...a: any[]) => mockClearDynamicScriptCache(...a),
  loadDynamicScript: vi.fn(),
}));

vi.mock("./prompts.js", () => ({
  loadPipelineSystemPrompt: vi.fn(),
  loadPipelineConstraints: vi.fn(),
  readProjectClaudeMd: vi.fn(),
  readProjectGeminiMd: vi.fn(),
  loadPromptFragment: vi.fn(),
  getSkillPath: vi.fn(),
  getClaudeMdPath: vi.fn(),
  getGeminiMdPath: vi.fn(),
  loadHookConfig: vi.fn(),
  getGatePath: vi.fn(),
}));

vi.mock("./mcp.js", () => ({
  loadMcpRegistry: vi.fn(),
  buildMcpFromRegistry: vi.fn(),
}));

import { clearConfigCache } from "./index.js";

beforeEach(() => {
  vi.resetAllMocks();
});

// ── Error isolation ──

describe("clearConfigCache error isolation", () => {
  it("clearSettingsCache throws — error propagates and stops subsequent calls", () => {
    mockClearSettingsCache.mockImplementation(() => { throw new Error("settings cache error"); });

    // The implementation calls them sequentially without try/catch,
    // so an error in the first one stops the rest
    expect(() => clearConfigCache()).toThrow("settings cache error");
  });

  it("clearPipelineCache throws — error propagates", () => {
    mockClearPipelineCache.mockImplementation(() => { throw new Error("pipeline cache error"); });

    expect(() => clearConfigCache()).toThrow("pipeline cache error");
    expect(mockClearSettingsCache).toHaveBeenCalled();
  });

  it("clearFragmentCache throws — settings and pipeline were already called", () => {
    mockClearFragmentCache.mockImplementation(() => { throw new Error("fragment cache error"); });

    expect(() => clearConfigCache()).toThrow("fragment cache error");
    expect(mockClearSettingsCache).toHaveBeenCalled();
    expect(mockClearPipelineCache).toHaveBeenCalled();
  });

  it("clearDynamicScriptCache throws — other three were already called", () => {
    mockClearDynamicScriptCache.mockImplementation(() => { throw new Error("script cache error"); });

    expect(() => clearConfigCache()).toThrow("script cache error");
    expect(mockClearSettingsCache).toHaveBeenCalled();
    expect(mockClearPipelineCache).toHaveBeenCalled();
    expect(mockClearFragmentCache).toHaveBeenCalled();
  });
});

// ── Idempotency ──

describe("clearConfigCache idempotency", () => {
  it("calling twice — does not throw on second call", () => {
    clearConfigCache();
    expect(() => clearConfigCache()).not.toThrow();
  });

  it("calling ten times — each sub-function called ten times", () => {
    for (let i = 0; i < 10; i++) {
      clearConfigCache();
    }
    expect(mockClearSettingsCache).toHaveBeenCalledTimes(10);
    expect(mockClearPipelineCache).toHaveBeenCalledTimes(10);
    expect(mockClearFragmentCache).toHaveBeenCalledTimes(10);
    expect(mockClearDynamicScriptCache).toHaveBeenCalledTimes(10);
  });
});

// ── Call order ──

describe("clearConfigCache call order", () => {
  it("all four sub-functions are called in a single invocation", () => {
    clearConfigCache();
    expect(mockClearSettingsCache).toHaveBeenCalledOnce();
    expect(mockClearPipelineCache).toHaveBeenCalledOnce();
    expect(mockClearFragmentCache).toHaveBeenCalledOnce();
    expect(mockClearDynamicScriptCache).toHaveBeenCalledOnce();
  });

  it("sub-functions are called with no arguments", () => {
    clearConfigCache();
    expect(mockClearSettingsCache).toHaveBeenCalledWith();
    expect(mockClearPipelineCache).toHaveBeenCalledWith();
    expect(mockClearFragmentCache).toHaveBeenCalledWith();
    expect(mockClearDynamicScriptCache).toHaveBeenCalledWith();
  });

  it("clearConfigCache returns void (undefined)", () => {
    const result = clearConfigCache();
    expect(result).toBeUndefined();
  });
});
