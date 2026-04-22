import { describe, it, expect, vi } from "vitest";

vi.mock("./settings.js", () => ({
  clearSettingsCache: vi.fn(),
  CONFIG_DIR: "/fake/config",
  interpolateEnvVar: vi.fn((v: string) => v),
  interpolateObject: vi.fn((v: unknown) => v),
  getNestedValue: vi.fn(),
  loadSystemSettings: vi.fn(() => ({})),
  SystemSettingsSchema: { safeParse: vi.fn() },
}));

vi.mock("../script-loader.js", () => ({
  clearDynamicScriptCache: vi.fn(),
  loadDynamicScript: vi.fn(),
}));

import { clearConfigCache } from "./index.js";
import { clearSettingsCache } from "./settings.js";
import { clearDynamicScriptCache } from "../script-loader.js";

describe("clearConfigCache", () => {
  it("calls all sub-cache clear functions", () => {
    clearConfigCache();
    expect(clearSettingsCache).toHaveBeenCalled();
    expect(clearDynamicScriptCache).toHaveBeenCalled();
  });
});
