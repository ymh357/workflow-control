import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external dependencies before importing the module under test
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  statSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => "/usr/bin/claude\n"),
}));

vi.mock("./config-loader.js", () => ({
  loadSystemSettings: vi.fn(() => ({})),
  getNestedValue: vi.fn((obj: any, path: string) => {
    if (!obj || !path) return undefined;
    return path.split(".").reduce((acc: any, part: string) => acc && acc[part], obj);
  }),
}));

vi.mock("./config/mcp.js", () => ({
  loadMcpRegistry: vi.fn(() => null),
  buildMcpFromRegistry: vi.fn(() => null),
}));

vi.mock("../scripts/index.js", () => ({
  scriptRegistry: {
    getAllScripts: vi.fn(() => []),
  },
}));

import { runPreflight } from "./preflight.js";
import { loadSystemSettings, getNestedValue } from "./config-loader.js";
import { loadMcpRegistry, buildMcpFromRegistry } from "./config/mcp.js";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { scriptRegistry } from "../scripts/index.js";

const mockLoadSystemSettings = vi.mocked(loadSystemSettings);
const mockGetNestedValue = vi.mocked(getNestedValue);
const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockLoadMcpRegistry = vi.mocked(loadMcpRegistry);
const mockBuildMcpFromRegistry = vi.mocked(buildMcpFromRegistry);
const mockGetAllScripts = vi.mocked(scriptRegistry.getAllScripts);

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadSystemSettings.mockReturnValue({});
  mockGetNestedValue.mockImplementation((obj: any, path: string) => {
    if (!obj || !path) return undefined;
    return path.split(".").reduce((acc: any, part: string) => acc && acc[part], obj);
  });
  mockExecFileSync.mockReturnValue("/usr/bin/claude\n");
  mockExistsSync.mockReturnValue(false);
  mockReaddirSync.mockReturnValue([]);
  mockLoadMcpRegistry.mockReturnValue(null);
  mockBuildMcpFromRegistry.mockReturnValue(null);
  mockGetAllScripts.mockReturnValue([]);
});

describe("preflight - sensitive value masking regex", () => {
  it("masks paths containing 'token'", () => {
    const settings = { slack: { bot_token: "xoxb-1234-secret-value-9999" } };
    mockLoadSystemSettings.mockReturnValue(settings);
    mockGetNestedValue.mockImplementation((obj: any, path: string) => {
      if (!obj || !path) return undefined;
      return path.split(".").reduce((acc: any, part: string) => acc && acc[part], obj);
    });

    const { results } = runPreflight();
    const tokenResult = results.find((r) => r.name === "Setting: slack.bot_token");
    expect(tokenResult).toBeDefined();
    expect(tokenResult!.detail).toBe("xoxb...9999");
    expect(tokenResult!.detail).not.toContain("secret");
  });

  it("masks paths containing 'secret'", () => {
    const settings = { slack: { signing_secret: "abcd1234efgh5678" } };
    mockLoadSystemSettings.mockReturnValue(settings);
    mockGetNestedValue.mockImplementation((obj: any, path: string) => {
      if (!obj || !path) return undefined;
      return path.split(".").reduce((acc: any, part: string) => acc && acc[part], obj);
    });
    const { results } = runPreflight();
    // "signing_secret" contains "secret" so should be masked
    // But it won't show up unless a script or pipeline stage requires it.
    // Let's test with a script that requires it.
    mockGetAllScripts.mockReturnValue([
      { metadata: { id: "test", name: "test", requiredSettings: ["slack.signing_secret"] }, run: vi.fn() } as any,
    ]);

    const result2 = runPreflight();
    const secretResult = result2.results.find((r) => r.name === "Setting: slack.signing_secret");
    expect(secretResult).toBeDefined();
    expect(secretResult!.detail).toBe("abcd...5678");
  });

  it("false-positive: masks paths containing 'id' like 'notify_channel_id'", () => {
    // The regex /token|secret|key|id/i matches "id" anywhere in the path,
    // so "notify_channel_id" will be masked even though it may not be sensitive.
    const settings = { slack: { notify_channel_id: "C0123456789" } };
    mockLoadSystemSettings.mockReturnValue(settings);
    mockGetNestedValue.mockImplementation((obj: any, path: string) => {
      if (!obj || !path) return undefined;
      return path.split(".").reduce((acc: any, part: string) => acc && acc[part], obj);
    });

    const { results } = runPreflight();
    const idResult = results.find((r) => r.name === "Setting: slack.notify_channel_id");
    expect(idResult).toBeDefined();
    // "notify_channel_id" contains "id" -> masked
    expect(idResult!.detail).toBe("C012...6789");
  });

  it("false-positive: masks paths containing 'kid' or 'keyboard' due to /id/i and /key/i", () => {
    // "kid" contains "id" -> masked; "keyboard" contains "key" -> masked
    // This is a known false-positive in the regex.
    const regex = /token|secret|key|id/i;
    expect(regex.test("kid")).toBe(true); // false positive: "kid" matches "id"
    expect(regex.test("keyboard")).toBe(true); // false positive: "keyboard" matches "key"
    expect(regex.test("grid")).toBe(true); // false positive: "grid" matches "id"
    expect(regex.test("monkey")).toBe(true); // false positive: "monkey" matches "key"
  });

  it("does not mask non-sensitive paths", () => {
    const regex = /token|secret|key|id/i;
    expect(regex.test("name")).toBe(false);
    expect(regex.test("repos_base")).toBe(false);
    expect(regex.test("engine")).toBe(false);
  });
});

describe("preflight - checkedPaths deduplication", () => {
  it("does not add duplicate results for the same setting path", () => {
    const settings = { slack: { bot_token: "xoxb-1234-5678-abcd" } };
    mockLoadSystemSettings.mockReturnValue(settings);
    mockGetNestedValue.mockImplementation((obj: any, path: string) => {
      if (!obj || !path) return undefined;
      return path.split(".").reduce((acc: any, part: string) => acc && acc[part], obj);
    });
    // Both core framework and a script require the same path
    mockGetAllScripts.mockReturnValue([
      { metadata: { id: "s1", name: "s1", requiredSettings: ["slack.bot_token"] }, run: vi.fn() } as any,
    ]);

    const { results } = runPreflight();
    const tokenResults = results.filter((r) => r.name === "Setting: slack.bot_token");
    expect(tokenResults).toHaveLength(1);
  });

  it("shows MCP registry entries with their availability status", () => {
    mockLoadMcpRegistry.mockReturnValue({
      notion: { description: "Notion API", command: "npx", args: [] },
      context7: { description: "Library docs", command: "npx", args: [] },
    });
    mockBuildMcpFromRegistry.mockImplementation((_name, _entry) => {
      if (_name === "notion") return null; // missing credentials
      return { command: "npx", args: [] };
    });

    const { results } = runPreflight();
    const notionResult = results.find((r) => r.name === "MCP: notion");
    expect(notionResult).toBeDefined();
    expect(notionResult!.detail).toContain("Missing credentials");

    const c7Result = results.find((r) => r.name === "MCP: context7");
    expect(c7Result).toBeDefined();
    expect(c7Result!.detail).toBe("Library docs");
  });
});

describe("preflight - passed calculation", () => {
  it("returns passed=true when all checks are ok", () => {
    mockExecFileSync.mockReturnValue("/usr/bin/claude\n");
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "default", isDirectory: () => true, isFile: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false, isSymbolicLink: () => false, parentPath: "", path: "" },
    ] as any);
    const settings = {
      slack: { bot_token: "xoxb-test", notify_channel_id: "C123" },
    };
    mockLoadSystemSettings.mockReturnValue(settings);
    mockGetNestedValue.mockImplementation((obj: any, path: string) => {
      if (!obj || !path) return undefined;
      return path.split(".").reduce((acc: any, part: string) => acc && acc[part], obj);
    });

    const { passed, results } = runPreflight();
    const failedItems = results.filter((r) => !r.ok);
    expect(failedItems).toHaveLength(0);
    expect(passed).toBe(true);
  });

  it("returns passed=false when any check has ok=false", () => {
    // Make execFileSync throw for claude to cause a failure
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      if (args?.[0] === "claude" || args?.[0] === "gemini") throw new Error("not found");
      if (cmd === "gh") throw new Error("not found");
      return "";
    });
    const settings = {};
    mockLoadSystemSettings.mockReturnValue(settings);
    mockGetNestedValue.mockReturnValue(undefined);

    const { passed, results } = runPreflight();
    const failedItems = results.filter((r) => !r.ok);
    expect(failedItems.length).toBeGreaterThan(0);
    expect(passed).toBe(false);
  });

  it("treats MCP with missing credentials as ok=true (optional)", () => {
    mockLoadMcpRegistry.mockReturnValue({
      notion: { description: "Notion API", command: "npx", args: [] },
    });
    mockBuildMcpFromRegistry.mockReturnValue(null); // missing credentials
    const settings = { slack: { bot_token: "xoxb", notify_channel_id: "C1" } };
    mockLoadSystemSettings.mockReturnValue(settings);

    const { results } = runPreflight();
    const notionResult = results.find((r) => r.name === "MCP: notion");
    expect(notionResult).toBeDefined();
    expect(notionResult!.ok).toBe(true);
    expect(notionResult!.detail).toContain("Missing credentials");
  });
});

describe("preflight - MCP registry checks", () => {
  it("reports all registered MCPs with availability", () => {
    mockLoadMcpRegistry.mockReturnValue({
      figma: { description: "Figma designs", command: "npx", args: [] },
      notion: { description: "Notion API", command: "npx", args: [] },
      context7: { description: "Library docs", command: "npx", args: [] },
    });
    mockBuildMcpFromRegistry.mockImplementation((name) => {
      if (name === "figma") return null; // missing credentials
      return { command: "npx", args: [] };
    });

    const { results } = runPreflight();
    const figmaResult = results.find((r) => r.name === "MCP: figma");
    expect(figmaResult).toBeDefined();
    expect(figmaResult!.ok).toBe(true);
    expect(figmaResult!.detail).toContain("Missing credentials");

    const notionResult = results.find((r) => r.name === "MCP: notion");
    expect(notionResult).toBeDefined();
    expect(notionResult!.detail).toBe("Notion API");

    const c7Result = results.find((r) => r.name === "MCP: context7");
    expect(c7Result).toBeDefined();
    expect(c7Result!.detail).toBe("Library docs");
  });
});
