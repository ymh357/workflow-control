import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("./config/settings.js", () => ({
  CONFIG_DIR: "/fake/config",
}));

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { loadDynamicScript, clearDynamicScriptCache } from "./script-loader.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  clearDynamicScriptCache();
});

describe("loadDynamicScript", () => {
  it("returns null when scripts directory does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await loadDynamicScript("my-script");
    expect(result).toBeNull();
  });

  it("returns null when no matching script_id found", async () => {
    // Scripts dir exists but no subdirectories
    mockExistsSync.mockImplementation((p: any) => {
      if ((p as string).endsWith("scripts")) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([] as any);
    const result = await loadDynamicScript("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null when manifest lacks script_id or entry", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "broken-script", isDirectory: () => true },
    ] as any);
    mockReadFileSync.mockReturnValue("name: Broken\nversion: 1.0.0\ntype: script");
    const result = await loadDynamicScript("broken-script");
    expect(result).toBeNull();
  });

  it("returns null when entry file does not exist on disk", async () => {
    mockReaddirSync.mockReturnValue([
      { name: "my-script", isDirectory: () => true },
    ] as any);
    mockReadFileSync.mockReturnValue(
      "name: My Script\nversion: 1.0.0\ntype: script\nscript_id: my-script\nentry: index.ts",
    );
    mockExistsSync.mockImplementation((p: any) => {
      const s = p as string;
      // scripts dir and manifest exist, but entry file does not
      if (s.endsWith("scripts") || s.endsWith("manifest.yaml")) return true;
      return false;
    });
    const result = await loadDynamicScript("my-script");
    expect(result).toBeNull();
  });

  it("returns null when dynamic import fails", async () => {
    mockReaddirSync.mockReturnValue([
      { name: "bad-module", isDirectory: () => true },
    ] as any);
    mockReadFileSync.mockReturnValue(
      "name: Bad\nversion: 1.0.0\ntype: script\nscript_id: bad-module\nentry: index.ts",
    );
    mockExistsSync.mockReturnValue(true);
    // The dynamic import will fail because the file doesn't actually exist
    const result = await loadDynamicScript("bad-module");
    expect(result).toBeNull();
  });

  it("skips non-directory entries", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "readme.md", isDirectory: () => false },
    ] as any);
    const result = await loadDynamicScript("readme.md");
    expect(result).toBeNull();
  });

  it("skips directories without manifest.yaml", async () => {
    mockExistsSync.mockImplementation((p: any) => {
      if ((p as string).endsWith("manifest.yaml")) return false;
      return true;
    });
    mockReaddirSync.mockReturnValue([
      { name: "no-manifest", isDirectory: () => true },
    ] as any);
    const result = await loadDynamicScript("no-manifest");
    expect(result).toBeNull();
  });
});

describe("clearDynamicScriptCache", () => {
  it("does not throw", () => {
    expect(() => clearDynamicScriptCache()).not.toThrow();
  });
});
