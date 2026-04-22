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

import { clearConfigCache } from "./index.js";
import { clearSettingsCache } from "./settings.js";

describe("clearConfigCache", () => {
  it("calls clearSettingsCache", () => {
    clearConfigCache();
    expect(clearSettingsCache).toHaveBeenCalled();
  });
});
