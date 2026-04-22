import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClearSettingsCache = vi.fn();
const mockClearFragmentCache = vi.fn();
const mockClearDynamicScriptCache = vi.fn();

vi.mock("./settings.js", () => ({
  clearSettingsCache: (...a: unknown[]) => mockClearSettingsCache(...a),
  CONFIG_DIR: "/fake/config",
  interpolateEnvVar: vi.fn((v: string) => v),
  interpolateObject: vi.fn((v: unknown) => v),
  getNestedValue: vi.fn(),
  loadSystemSettings: vi.fn(() => ({})),
  SystemSettingsSchema: { safeParse: vi.fn() },
}));

vi.mock("./fragments.js", () => ({
  clearFragmentCache: (...a: unknown[]) => mockClearFragmentCache(...a),
  getFragmentRegistry: vi.fn(),
  parseFrontmatter: vi.fn(),
  FragmentRegistry: vi.fn(),
  resolveFragmentsFromSnapshot: vi.fn(),
}));

vi.mock("../script-loader.js", () => ({
  clearDynamicScriptCache: (...a: unknown[]) => mockClearDynamicScriptCache(...a),
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
    expect(() => clearConfigCache()).toThrow("settings cache error");
  });

  it("clearFragmentCache throws — settings was already called", () => {
    mockClearFragmentCache.mockImplementation(() => { throw new Error("fragment cache error"); });
    expect(() => clearConfigCache()).toThrow("fragment cache error");
    expect(mockClearSettingsCache).toHaveBeenCalled();
  });

  it("clearDynamicScriptCache throws — other two were already called", () => {
    mockClearDynamicScriptCache.mockImplementation(() => { throw new Error("script cache error"); });
    expect(() => clearConfigCache()).toThrow("script cache error");
    expect(mockClearSettingsCache).toHaveBeenCalled();
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
    expect(mockClearFragmentCache).toHaveBeenCalledTimes(10);
    expect(mockClearDynamicScriptCache).toHaveBeenCalledTimes(10);
  });
});

// ── Call order ──

describe("clearConfigCache call order", () => {
  it("all three sub-functions are called in a single invocation", () => {
    clearConfigCache();
    expect(mockClearSettingsCache).toHaveBeenCalledOnce();
    expect(mockClearFragmentCache).toHaveBeenCalledOnce();
    expect(mockClearDynamicScriptCache).toHaveBeenCalledOnce();
  });

  it("sub-functions are called with no arguments", () => {
    clearConfigCache();
    expect(mockClearSettingsCache).toHaveBeenCalledWith();
    expect(mockClearFragmentCache).toHaveBeenCalledWith();
    expect(mockClearDynamicScriptCache).toHaveBeenCalledWith();
  });

  it("clearConfigCache returns void (undefined)", () => {
    const result = clearConfigCache();
    expect(result).toBeUndefined();
  });
});
