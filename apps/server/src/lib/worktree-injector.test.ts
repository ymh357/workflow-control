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

// ── Import under test (after mocks) ─────────────────────────────────────────

const { injectWorktreeConfig } = await import("./worktree-injector.js");

// ── Tests ────────────────────────────────────────────────────────────────────

describe("injectWorktreeConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("");
    mockReaddirSync.mockReturnValue([]);
  });

  // 1. Returns empty warnings when no pipeline config exists
  it("returns empty array and skips injection when no pipeline config", () => {
    const warnings = injectWorktreeConfig("/tmp/wt", null);
    expect(warnings).toEqual([]);
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  // 2. Creates .claude/commands and .gemini/commands directories for skills
  it("creates command directories when skills are provided", () => {
    mockGetSkillPath.mockReturnValue("/skills/lint.md");

    injectWorktreeConfig("/tmp/wt", { skills: ["lint"], hooks: [] } as any);

    expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/wt/.claude/commands", { recursive: true });
    expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/wt/.gemini/commands", { recursive: true });
  });

  // 3. Copies skill file to both .claude and .gemini command dirs
  it("copies skill file to both claude and gemini command directories", () => {
    mockGetSkillPath.mockReturnValue("/skills/lint.md");

    injectWorktreeConfig("/tmp/wt", { skills: ["lint"], hooks: [] } as any);

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      "/skills/lint.md",
      "/tmp/wt/.claude/commands/lint.md",
    );
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      "/skills/lint.md",
      "/tmp/wt/.gemini/commands/lint.md",
    );
  });

  // 4. Skips skill when getSkillPath returns null (source doesn't exist)
  it("skips skill when source file is not found", () => {
    mockGetSkillPath.mockReturnValue(null);

    const warnings = injectWorktreeConfig("/tmp/wt", { skills: ["missing"], hooks: [] } as any);

    expect(mockCopyFileSync).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  // 5. Does nothing when skills array is empty
  it("does not create directories when skills array is empty", () => {
    injectWorktreeConfig("/tmp/wt", { skills: [], hooks: [] } as any);

    // mkdirSync should not be called for skills (no commands dirs needed)
    const mkdirCalls = mockMkdirSync.mock.calls.map(c => c[0] as string);
    expect(mkdirCalls.filter(p => p.includes("commands"))).toHaveLength(0);
  });

  // 6. Injects hook with script content, writes .sh file with 0o755
  it("writes hook script file with executable permission", () => {
    mockLoadHookConfig.mockReturnValue({
      event: "PreToolUse",
      script: "#!/bin/bash\necho test",
      type: "command",
    });

    injectWorktreeConfig("/tmp/wt", { skills: [], hooks: ["my-hook"] } as any);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/wt/.claude/hooks/my-hook.sh",
      "#!/bin/bash\necho test",
      "utf-8",
    );
    expect(mockChmodSync).toHaveBeenCalledWith("/tmp/wt/.claude/hooks/my-hook.sh", 0o755);
  });

  // 7. Injects hook with command (no script), produces settings.json
  it("writes settings.json with hook command entry", () => {
    mockLoadHookConfig.mockReturnValue({
      event: "PostToolUse",
      command: "npx eslint .",
      type: "command",
    });

    injectWorktreeConfig("/tmp/wt", { skills: [], hooks: ["eslint-hook"] } as any);

    // Find the writeFileSync call that writes settings.json
    const settingsCall = mockWriteFileSync.mock.calls.find(
      (c) => (c[0] as string).endsWith("settings.json"),
    );
    expect(settingsCall).toBeDefined();

    const settings = JSON.parse(settingsCall![1] as string);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe("npx eslint .");
  });

  // 8. Skips hook when loadHookConfig returns null
  it("skips hook when config is not found", () => {
    mockLoadHookConfig.mockReturnValue(null);

    const warnings = injectWorktreeConfig("/tmp/wt", { skills: [], hooks: ["missing-hook"] } as any);

    // No settings.json should be written (no valid hooks)
    const settingsCall = mockWriteFileSync.mock.calls.find(
      (c) => (c[0] as string).endsWith("settings.json"),
    );
    expect(settingsCall).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  // 9. CLAUDE.md merges global content with existing content
  it("merges global CLAUDE.md content with existing file", () => {
    mockGetClaudeMdPath.mockReturnValue("/config/global-claude.md");
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === "/config/global-claude.md") return "global rules";
      if (path === "/tmp/wt/CLAUDE.md") return "existing rules";
      return "";
    });
    mockExistsSync.mockImplementation((path: string) => {
      return path === "/tmp/wt/CLAUDE.md";
    });

    injectWorktreeConfig("/tmp/wt", {
      skills: [],
      hooks: [],
      claude_md: { global: "global-claude.md" },
    } as any);

    const claudeMdCall = mockWriteFileSync.mock.calls.find(
      (c) => (c[0] as string).endsWith("CLAUDE.md"),
    );
    expect(claudeMdCall).toBeDefined();
    const content = claudeMdCall![1] as string;
    expect(content).toContain("existing rules");
    expect(content).toContain("global rules");
    expect(content).toContain("---");
  });

  // 10. CLAUDE.md skips injection when global content already present (dedup)
  it("skips CLAUDE.md injection when global content is already present", () => {
    mockGetClaudeMdPath.mockReturnValue("/config/global-claude.md");
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === "/config/global-claude.md") return "global rules";
      if (path === "/tmp/wt/CLAUDE.md") return "old stuff\n\n---\n\nglobal rules";
      return "";
    });
    mockExistsSync.mockImplementation((path: string) => {
      return path === "/tmp/wt/CLAUDE.md";
    });

    injectWorktreeConfig("/tmp/wt", {
      skills: [],
      hooks: [],
      claude_md: { global: "global-claude.md" },
    } as any);

    const claudeMdCall = mockWriteFileSync.mock.calls.find(
      (c) => (c[0] as string).endsWith("CLAUDE.md"),
    );
    expect(claudeMdCall).toBeUndefined();
  });

  // 11. Knowledge files are copied from fragments dir
  it("copies .md knowledge files from fragments directory", () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${MOCK_CONFIG_DIR}/prompts/fragments`;
    });
    mockReaddirSync.mockReturnValue(["arch.md", "style.md", "ignore.txt"]);

    injectWorktreeConfig("/tmp/wt", { skills: [], hooks: [] } as any);

    expect(mockMkdirSync).toHaveBeenCalledWith(
      "/tmp/wt/.workflow/knowledge",
      { recursive: true },
    );
    // Only .md files are copied
    expect(mockCopyFileSync).toHaveBeenCalledTimes(2);
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      `${MOCK_CONFIG_DIR}/prompts/fragments/arch.md`,
      "/tmp/wt/.workflow/knowledge/arch.md",
    );
  });

  // 12. Error isolation: skills failure does not block hooks injection
  it("captures skills error in warnings but continues with hooks", () => {
    mockGetSkillPath.mockImplementation(() => {
      throw new Error("disk full");
    });
    mockLoadHookConfig.mockReturnValue({
      event: "PostToolUse",
      command: "echo ok",
      type: "command",
    });

    const warnings = injectWorktreeConfig("/tmp/wt", {
      skills: ["broken"],
      hooks: ["good-hook"],
    } as any);

    expect(warnings.some((w) => w.includes("skills"))).toBe(true);
    // Hooks should still have been processed
    const settingsCall = mockWriteFileSync.mock.calls.find(
      (c) => (c[0] as string).endsWith("settings.json"),
    );
    expect(settingsCall).toBeDefined();
  });
});
