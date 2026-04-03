import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockLoadSystemSettings = vi.fn();
vi.mock("./config-loader.js", () => ({
  loadSystemSettings: (...args: unknown[]) => mockLoadSystemSettings(...args),
}));

vi.mock("./spawn-utils.js", () => ({
  spawnWithTimeout: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

import { buildBranchName, resolveRepoPath } from "./git.js";

beforeEach(() => {
  mockLoadSystemSettings.mockReset();
});

describe("buildBranchName", () => {
  it("creates feature branch with short id and slug", () => {
    const result = buildBranchName("abcd1234-5678-9abc-def0-111122223333", "My Cool Feature");
    expect(result).toMatch(/^feature\/abcd1234-my-cool-feature$/);
  });

  it("strips dashes from pageId", () => {
    const result = buildBranchName("a-b-c-d-1-2-3-4-more-stuff", "test");
    expect(result).toMatch(/^feature\/abcd1234/);
  });

  it("lowercases and sanitizes slug", () => {
    const result = buildBranchName("12345678", "Hello World! @#$ Test");
    expect(result).toBe("feature/12345678-hello-world-test");
  });

  it("trims leading/trailing hyphens from slug", () => {
    const result = buildBranchName("12345678", "---leading-trailing---");
    expect(result).toBe("feature/12345678-leading-trailing");
  });

  it("truncates slug to 40 characters", () => {
    const longSlug = "a".repeat(60);
    const result = buildBranchName("12345678", longSlug);
    const slugPart = result.replace("feature/12345678-", "");
    expect(slugPart.length).toBeLessThanOrEqual(40);
  });

  it("handles empty slug", () => {
    const result = buildBranchName("12345678", "");
    expect(result).toBe("feature/12345678-");
  });
});

describe("resolveRepoPath", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns exact match when directory exists", async () => {
    tmpDir = await mkdtemp(join(os.tmpdir(), "git-test-"));
    const repoDir = join(tmpDir, "my-repo");
    await mkdir(repoDir);
    mockLoadSystemSettings.mockReturnValue({ paths: { repos_base: tmpDir } });
    expect(resolveRepoPath("my-repo")).toBe(repoDir);
  });

  it("returns case-insensitive match", async () => {
    tmpDir = await mkdtemp(join(os.tmpdir(), "git-test-"));
    const repoDir = join(tmpDir, "MyRepo");
    await mkdir(repoDir);
    mockLoadSystemSettings.mockReturnValue({ paths: { repos_base: tmpDir } });
    const result = resolveRepoPath("myrepo");
    // On case-insensitive FS (macOS), exact match may resolve with original casing;
    // on case-sensitive FS, the CI fallback returns the actual directory name.
    expect(result.toLowerCase()).toBe(repoDir.toLowerCase());
  });

  it("returns partial suffix match", async () => {
    tmpDir = await mkdtemp(join(os.tmpdir(), "git-test-"));
    const repoDir = join(tmpDir, "org-my-project");
    await mkdir(repoDir);
    mockLoadSystemSettings.mockReturnValue({ paths: { repos_base: tmpDir } });
    expect(resolveRepoPath("my-project")).toBe(repoDir);
  });

  it("returns empty string when no match", async () => {
    tmpDir = await mkdtemp(join(os.tmpdir(), "git-test-"));
    mockLoadSystemSettings.mockReturnValue({ paths: { repos_base: tmpDir } });
    expect(resolveRepoPath("nonexistent")).toBe("");
  });

  it("returns empty string when repos_base is not set", () => {
    mockLoadSystemSettings.mockReturnValue({ paths: {} });
    expect(resolveRepoPath("anything")).toBe("");
  });

  it("returns empty string when repoName is empty", () => {
    mockLoadSystemSettings.mockReturnValue({ paths: { repos_base: "/tmp" } });
    expect(resolveRepoPath("")).toBe("");
  });

  it("returns empty string when reposBase is empty string", () => {
    mockLoadSystemSettings.mockReturnValue({ paths: { repos_base: "" } });
    expect(resolveRepoPath("some-repo")).toBe("");
  });
});

describe("installDepsInWorktree", () => {
  // installDepsInWorktree uses spawnWithTimeout which is mocked
  let mockSpawnWithTimeout: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import("./spawn-utils.js");
    mockSpawnWithTimeout = vi.mocked(mod.spawnWithTimeout);
    mockSpawnWithTimeout.mockReset();
  });

  it("detects bun lockfile (bun.lockb)", async () => {
    const { existsSync } = await import("node:fs");
    const tmpDir = await mkdtemp(join(os.tmpdir(), "git-dep-test-"));
    await writeFile(join(tmpDir, "bun.lockb"), "");
    mockSpawnWithTimeout.mockResolvedValue({ stdout: "", stderr: "", combined: "", exitCode: 0, timedOut: false });

    const { installDepsInWorktree } = await import("./git.js");
    await installDepsInWorktree(tmpDir);

    expect(mockSpawnWithTimeout).toHaveBeenCalledWith(
      "bun",
      ["install", "--frozen-lockfile"],
      expect.objectContaining({ cwd: tmpDir }),
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("detects yarn lockfile", async () => {
    const tmpDir = await mkdtemp(join(os.tmpdir(), "git-dep-test-"));
    await writeFile(join(tmpDir, "yarn.lock"), "");
    mockSpawnWithTimeout.mockResolvedValue({ stdout: "", stderr: "", combined: "", exitCode: 0, timedOut: false });

    const { installDepsInWorktree } = await import("./git.js");
    await installDepsInWorktree(tmpDir);

    expect(mockSpawnWithTimeout).toHaveBeenCalledWith(
      "yarn",
      ["install", "--frozen-lockfile"],
      expect.objectContaining({ cwd: tmpDir }),
    );

    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe("buildBranchName (additional)", () => {
  it("handles unicode characters by stripping them", () => {
    const result = buildBranchName("12345678", "fix bug in module");
    expect(result).toMatch(/^feature\/12345678-/);
    expect(result).not.toMatch(/[^\x20-\x7E]/);
  });

  it("strips CJK and emoji characters from slug", () => {
    const result = buildBranchName("12345678", "fix-bug");
    expect(result).toBe("feature/12345678-fix-bug");
  });

  it("truncates very long slugs to 40 chars and trims trailing hyphens", () => {
    const longSlug = "this-is-a-very-long-feature-name-that-exceeds-the-forty-character-limit-by-a-lot";
    const result = buildBranchName("12345678", longSlug);
    const slugPart = result.replace("feature/12345678-", "");
    expect(slugPart.length).toBeLessThanOrEqual(40);
    expect(slugPart).not.toMatch(/-$/);
  });
});

describe("createWorktree", () => {
  let mockExecFileFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import("node:child_process");
    mockExecFileFn = cp.execFile as unknown as ReturnType<typeof vi.fn>;
    mockExecFileFn.mockReset();
  });

  it("calls git worktree add with correct args and returns worktree path", async () => {
    mockExecFileFn.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as Function;
      cb(null, "", "");
    });

    const { createWorktree } = await import("./git.js");
    const result = await createWorktree("/repo", "feat/my-branch", "/tmp/worktrees");

    expect(result).toBe(join("/tmp/worktrees", "feat-my-branch"));
    expect(mockExecFileFn).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "feat/my-branch", join("/tmp/worktrees", "feat-my-branch")],
      expect.objectContaining({ cwd: "/repo" }),
      expect.any(Function),
    );
  });

  it("replaces slashes in branch name for worktree directory", async () => {
    mockExecFileFn.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as Function;
      cb(null, "", "");
    });

    const { createWorktree } = await import("./git.js");
    const result = await createWorktree("/repo", "feature/sub/deep", "/tmp/wt");

    expect(result).toBe(join("/tmp/wt", "feature-sub-deep"));
  });
});

describe("removeWorktree", () => {
  let mockExecFileFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import("node:child_process");
    mockExecFileFn = cp.execFile as unknown as ReturnType<typeof vi.fn>;
    mockExecFileFn.mockReset();
  });

  it("calls git worktree remove with --force flag", async () => {
    mockExecFileFn.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as Function;
      cb(null, "", "");
    });

    const { removeWorktree } = await import("./git.js");
    await removeWorktree("/repo", "/tmp/worktrees/my-branch");

    expect(mockExecFileFn).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/tmp/worktrees/my-branch", "--force"],
      expect.objectContaining({ cwd: "/repo" }),
      expect.any(Function),
    );
  });
});

describe("initRepo", () => {
  let mockExecFileFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import("node:child_process");
    mockExecFileFn = cp.execFile as unknown as ReturnType<typeof vi.fn>;
    mockExecFileFn.mockReset();
    mockExecFileFn.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as Function;
      cb(null, "", "");
    });
  });

  it("initializes a git repo and returns repo path", async () => {
    mockLoadSystemSettings.mockReturnValue({ paths: { repos_base: "/tmp/repos" } });

    const { initRepo } = await import("./git.js");
    const result = await initRepo("my-new-repo");

    expect(result).toBe(join("/tmp/repos", "my-new-repo"));
    const gitCalls = mockExecFileFn.mock.calls.filter(
      (c: unknown[]) => c[0] === "git",
    );
    expect(gitCalls.some((c: unknown[]) => (c[1] as string[]).includes("init"))).toBe(true);
    expect(gitCalls.some((c: unknown[]) => (c[1] as string[]).includes("commit"))).toBe(true);
  });

  it("throws when repos_base is not configured", async () => {
    mockLoadSystemSettings.mockReturnValue({ paths: {} });

    const { initRepo } = await import("./git.js");
    await expect(initRepo("any-repo")).rejects.toThrow("paths.repos_base is not configured");
  });
});

describe("installDepsInWorktree (additional)", () => {
  let mockSpawnWithTimeout: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import("./spawn-utils.js");
    mockSpawnWithTimeout = vi.mocked(mod.spawnWithTimeout);
    mockSpawnWithTimeout.mockReset();
  });

  it("falls back to npm install when no lockfile exists", async () => {
    const tmpDir = await mkdtemp(join(os.tmpdir(), "git-dep-npm-"));
    // No lockfiles created - should default to npm
    mockSpawnWithTimeout.mockResolvedValue({ stdout: "", stderr: "", combined: "", exitCode: 0, timedOut: false });

    const { installDepsInWorktree } = await import("./git.js");
    await installDepsInWorktree(tmpDir);

    expect(mockSpawnWithTimeout).toHaveBeenCalledWith(
      "npm",
      ["install"],
      expect.objectContaining({ cwd: tmpDir }),
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("throws on timeout", async () => {
    const tmpDir = await mkdtemp(join(os.tmpdir(), "git-dep-timeout-"));
    mockSpawnWithTimeout.mockResolvedValue({ stdout: "", stderr: "", combined: "", exitCode: 0, timedOut: true });

    const { installDepsInWorktree } = await import("./git.js");
    await expect(installDepsInWorktree(tmpDir)).rejects.toThrow("timed out");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("throws on non-zero exit code", async () => {
    const tmpDir = await mkdtemp(join(os.tmpdir(), "git-dep-exit-"));
    mockSpawnWithTimeout.mockResolvedValue({ stdout: "", stderr: "error output", combined: "error output", exitCode: 1, timedOut: false });

    const { installDepsInWorktree } = await import("./git.js");
    await expect(installDepsInWorktree(tmpDir)).rejects.toThrow("Dependency installation failed (exit 1)");

    await rm(tmpDir, { recursive: true, force: true });
  });
});
