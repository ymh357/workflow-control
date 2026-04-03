import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockMkdirSync = vi.fn();
const mockCopyFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockChmodSync = vi.fn();
const mockExistsSync = vi.fn().mockReturnValue(false);
const mockReadFileSync = vi.fn().mockReturnValue("");
const mockReaddirSync = vi.fn().mockReturnValue([]);

vi.mock("node:fs", () => ({
  mkdirSync: (...a: unknown[]) => mockMkdirSync(...a),
  copyFileSync: (...a: unknown[]) => mockCopyFileSync(...a),
  writeFileSync: (...a: unknown[]) => mockWriteFileSync(...a),
  chmodSync: (...a: unknown[]) => mockChmodSync(...a),
  existsSync: (...a: unknown[]) => mockExistsSync(...a),
  readFileSync: (...a: unknown[]) => mockReadFileSync(...a),
  readdirSync: (...a: unknown[]) => mockReaddirSync(...a),
}));

const mockLoadPipelineConfig = vi.fn();
const mockLoadHookConfig = vi.fn();
const mockGetSkillPath = vi.fn();
const mockGetClaudeMdPath = vi.fn();
const mockGetGeminiMdPath = vi.fn();
const MOCK_CONFIG_DIR = "/mock/config";

vi.mock("./config-loader.js", () => ({
  loadPipelineConfig: (...a: unknown[]) => mockLoadPipelineConfig(...a),
  loadHookConfig: (...a: unknown[]) => mockLoadHookConfig(...a),
  getSkillPath: (...a: unknown[]) => mockGetSkillPath(...a),
  getClaudeMdPath: (...a: unknown[]) => mockGetClaudeMdPath(...a),
  getGeminiMdPath: (...a: unknown[]) => mockGetGeminiMdPath(...a),
  CONFIG_DIR: MOCK_CONFIG_DIR,
}));

vi.mock("./logger.js", () => {
  const noop = () => {};
  const child = () => ({ info: noop, warn: noop, error: noop, debug: noop });
  return { logger: { child } };
});

const { injectWorktreeConfig } = await import("./worktree-injector.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue("");
  mockReaddirSync.mockReturnValue([]);
});

describe("worktree-injector adversarial", () => {
  it("skill name with path traversal is resolved by join() removing traversal", () => {
    // join("/tmp/wt/.claude/commands", "../../../etc/passwd.md") resolves to /tmp/etc/passwd.md
    // This means the file escapes the intended directory
    mockGetSkillPath.mockReturnValue("/skills/evil.md");

    injectWorktreeConfig("/tmp/wt", { skills: ["../../../etc/passwd"], hooks: [] } as any);

    const copyCall = mockCopyFileSync.mock.calls[0];
    // join resolves traversal, so it ends up outside .claude/commands
    expect(copyCall[1]).not.toContain(".claude/commands");
    expect(copyCall[1]).toContain("passwd.md");
  });

  it("hook with both script and command uses script, ignoring command", () => {
    mockLoadHookConfig.mockReturnValue({
      event: "PostToolUse",
      script: "#!/bin/bash\necho injected",
      command: "should-be-ignored",
      type: "command",
    });

    injectWorktreeConfig("/tmp/wt", { skills: [], hooks: ["dual-hook"] } as any);

    const settingsCall = mockWriteFileSync.mock.calls.find(
      (c) => (c[0] as string).endsWith("settings.json"),
    );
    expect(settingsCall).toBeDefined();
    const settings = JSON.parse(settingsCall![1] as string);
    // Script path should be used, not the command string
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain(".claude/hooks/dual-hook.sh");
  });

  it("corrupt existing settings.json is silently replaced", () => {
    mockLoadHookConfig.mockReturnValue({
      event: "PostToolUse",
      command: "echo ok",
      type: "command",
    });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith("settings.json")) return "NOT VALID JSON {{{";
      return "";
    });

    const warnings = injectWorktreeConfig("/tmp/wt", { skills: [], hooks: ["h1"] } as any);

    // Should not produce a warning - corrupt JSON is silently discarded
    expect(warnings).toEqual([]);
    const settingsCall = mockWriteFileSync.mock.calls.find(
      (c) => (c[0] as string).endsWith("settings.json"),
    );
    expect(settingsCall).toBeDefined();
    const settings = JSON.parse(settingsCall![1] as string);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
  });

  it("multiple hooks for the same event are merged into the same array", () => {
    mockLoadHookConfig.mockImplementation((name: string) => ({
      event: "PostToolUse",
      command: `cmd-${name}`,
      type: "command",
    }));

    injectWorktreeConfig("/tmp/wt", { skills: [], hooks: ["hook-a", "hook-b"] } as any);

    const settingsCall = mockWriteFileSync.mock.calls.find(
      (c) => (c[0] as string).endsWith("settings.json"),
    );
    const settings = JSON.parse(settingsCall![1] as string);
    expect(settings.hooks.PostToolUse).toHaveLength(2);
  });

  it("hook without event defaults to PostToolUse", () => {
    mockLoadHookConfig.mockReturnValue({
      // no event field
      command: "echo default",
      type: "command",
    });

    injectWorktreeConfig("/tmp/wt", { skills: [], hooks: ["no-event"] } as any);

    const settingsCall = mockWriteFileSync.mock.calls.find(
      (c) => (c[0] as string).endsWith("settings.json"),
    );
    const settings = JSON.parse(settingsCall![1] as string);
    expect(settings.hooks.PostToolUse).toBeDefined();
  });

  it("hook with no script and no command is skipped, no settings.json written", () => {
    mockLoadHookConfig.mockReturnValue({
      event: "PreToolUse",
      type: "command",
      // no script, no command
    });

    injectWorktreeConfig("/tmp/wt", { skills: [], hooks: ["empty-hook"] } as any);

    const settingsCall = mockWriteFileSync.mock.calls.find(
      (c) => (c[0] as string).endsWith("settings.json"),
    );
    expect(settingsCall).toBeUndefined();
  });

  it("GEMINI.md injection failure does NOT add to warnings array (silent fail)", () => {
    mockGetGeminiMdPath.mockImplementation(() => {
      throw new Error("gemini md crash");
    });

    const warnings = injectWorktreeConfig("/tmp/wt", {
      skills: [],
      hooks: [],
      gemini_md: { global: "test.md" },
    } as any);

    // GEMINI.md errors are caught but NOT pushed to warnings (unlike claude_md)
    expect(warnings.some((w: string) => w.includes("gemini"))).toBe(false);
  });

  it("knowledge files with non-.md extensions are filtered out", () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${MOCK_CONFIG_DIR}/prompts/fragments`;
    });
    mockReaddirSync.mockReturnValue(["a.md", "b.txt", "c.yaml", "d.MD", "e.json"]);

    injectWorktreeConfig("/tmp/wt", { skills: [], hooks: [] } as any);

    // Only .md (lowercase) should be copied
    expect(mockCopyFileSync).toHaveBeenCalledTimes(1);
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      `${MOCK_CONFIG_DIR}/prompts/fragments/a.md`,
      "/tmp/wt/.workflow/knowledge/a.md",
    );
  });
});
