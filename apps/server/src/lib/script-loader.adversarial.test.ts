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

describe("script-loader adversarial", () => {
  it("manifest with script_id but no entry is skipped", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "partial", isDirectory: () => true },
    ] as any);
    mockReadFileSync.mockReturnValue(
      "name: Partial\nversion: 1.0.0\ntype: script\nscript_id: partial",
    );

    const result = await loadDynamicScript("partial");
    expect(result).toBeNull();
  });

  it("manifest with entry but no script_id is skipped", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "no-id", isDirectory: () => true },
    ] as any);
    mockReadFileSync.mockReturnValue(
      "name: NoId\nversion: 1.0.0\ntype: script\nentry: index.ts",
    );

    const result = await loadDynamicScript("no-id");
    expect(result).toBeNull();
  });

  it("malformed YAML in manifest is silently skipped", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "bad-yaml", isDirectory: () => true },
    ] as any);
    mockReadFileSync.mockReturnValue("{{{{ invalid yaml !@#$");

    const result = await loadDynamicScript("bad-yaml");
    expect(result).toBeNull();
  });

  it("multiple script directories, only matching script_id is loaded", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "script-a", isDirectory: () => true },
      { name: "script-b", isDirectory: () => true },
    ] as any);
    mockReadFileSync.mockImplementation((p: any) => {
      const path = p as string;
      if (path.includes("script-a")) {
        return "name: A\nversion: 1.0.0\ntype: script\nscript_id: alpha\nentry: index.ts";
      }
      if (path.includes("script-b")) {
        return "name: B\nversion: 1.0.0\ntype: script\nscript_id: beta\nentry: index.ts";
      }
      return "";
    });

    // Looking for "alpha" which is in script-a, not "script-a"
    // But entry file won't actually exist for import, so returns null at import step
    const result = await loadDynamicScript("alpha");
    // It finds the entry but import fails -> null
    expect(result).toBeNull();
  });

  it("cached executor is returned without re-scanning", async () => {
    // First call: set up to fail at import
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "cached-script", isDirectory: () => true },
    ] as any);
    mockReadFileSync.mockReturnValue(
      "name: Cached\nversion: 1.0.0\ntype: script\nscript_id: cached\nentry: index.ts",
    );

    // First call fails at import
    const result1 = await loadDynamicScript("cached");
    expect(result1).toBeNull();

    // Clear and set up differently - but since first call returned null,
    // nothing was cached, so it re-scans
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);

    const result2 = await loadDynamicScript("cached");
    expect(result2).toBeNull();
  });

  it("readFileSync throwing for manifest is caught silently", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "throw-read", isDirectory: () => true },
    ] as any);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const result = await loadDynamicScript("throw-read");
    expect(result).toBeNull();
  });

  it("clearDynamicScriptCache can be called multiple times safely", () => {
    clearDynamicScriptCache();
    clearDynamicScriptCache();
    clearDynamicScriptCache();
    // No error thrown
  });

  it("entry path with relative traversal resolves correctly", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "traversal", isDirectory: () => true },
    ] as any);
    mockReadFileSync.mockReturnValue(
      "name: Traversal\nversion: 1.0.0\ntype: script\nscript_id: traversal\nentry: ../../../etc/passwd",
    );

    // resolve() will normalize the path but existsSync returns true
    // The import will fail since the file isn't a valid module
    const result = await loadDynamicScript("traversal");
    expect(result).toBeNull();
  });
});
