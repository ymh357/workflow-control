import { describe, it, expect, vi } from "vitest";

vi.mock("./settings.js", () => ({
  clearSettingsCache: vi.fn(),
  CONFIG_DIR: "/fake/config",
  interpolateEnvVar: vi.fn((v: string) => v),
  interpolateObject: vi.fn((v: any) => v),
  getNestedValue: vi.fn(),
  loadSystemSettings: vi.fn(() => ({})),
}));

vi.mock("./pipeline.js", () => ({
  clearPipelineCache: vi.fn(),
  loadPipelineConfig: vi.fn(),
  listAvailablePipelines: vi.fn(() => []),
  deepMergePipeline: vi.fn(),
}));

vi.mock("./fragments.js", () => ({
  clearFragmentCache: vi.fn(),
  getFragmentRegistry: vi.fn(),
  parseFrontmatter: vi.fn(),
  FragmentRegistry: vi.fn(),
  resolveFragmentsFromSnapshot: vi.fn(),
}));

vi.mock("../script-loader.js", () => ({
  clearDynamicScriptCache: vi.fn(),
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
import { clearSettingsCache } from "./settings.js";
import { clearPipelineCache } from "./pipeline.js";
import { clearFragmentCache } from "./fragments.js";
import { clearDynamicScriptCache } from "../script-loader.js";

describe("clearConfigCache", () => {
  it("calls all sub-cache clear functions", () => {
    clearConfigCache();
    expect(clearSettingsCache).toHaveBeenCalled();
    expect(clearPipelineCache).toHaveBeenCalled();
    expect(clearFragmentCache).toHaveBeenCalled();
    expect(clearDynamicScriptCache).toHaveBeenCalled();
  });
});

