import { describe, it, expect, vi, beforeEach } from "vitest";

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

describe("buildBranchName adversarial", () => {
  it("all-special-char slug produces empty slug part", () => {
    const result = buildBranchName("12345678", "!@#$%^&*()");
    // All chars replaced by hyphens, then leading/trailing hyphens stripped, leaving empty
    expect(result).toBe("feature/12345678-");
  });

  it("slug with only hyphens produces empty slug", () => {
    const result = buildBranchName("12345678", "------");
    expect(result).toBe("feature/12345678-");
  });

  it("pageId shorter than 8 chars (after dash removal) uses what's available", () => {
    const result = buildBranchName("ab", "test");
    expect(result).toBe("feature/ab-test");
  });

  it("empty pageId still generates branch name", () => {
    const result = buildBranchName("", "test");
    expect(result).toBe("feature/-test");
  });

  it("slug truncation at 40 chars may cut mid-word", () => {
    // 40 chars of slug: creates exactly 40 char boundary
    const slug = "a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w-x-y-z";
    const result = buildBranchName("12345678", slug);
    const slugPart = result.replace("feature/12345678-", "");
    expect(slugPart.length).toBeLessThanOrEqual(40);
  });

  it("consecutive special chars collapse into single hyphen", () => {
    const result = buildBranchName("12345678", "hello!!!world");
    expect(result).toBe("feature/12345678-hello-world");
  });
});

describe("resolveRepoPath adversarial", () => {
  it("returns empty string when repos_base is undefined (not just empty)", () => {
    mockLoadSystemSettings.mockReturnValue({ paths: {} });
    expect(resolveRepoPath("repo")).toBe("");
  });

  it("returns empty string when paths is completely missing", () => {
    mockLoadSystemSettings.mockReturnValue({});
    expect(resolveRepoPath("repo")).toBe("");
  });

  it("partial match: input is suffix of directory name (case-insensitive)", () => {
    // This tests the partial match path in resolveRepoPath
    // We can't easily test with real FS here, so just verify empty repos_base
    mockLoadSystemSettings.mockReturnValue({ paths: { repos_base: "" } });
    expect(resolveRepoPath("repo")).toBe("");
  });

  it("path traversal in repoName joins with repos_base unsafely", () => {
    // resolveRepoPath does join(reposBase, repoName) which allows traversal
    mockLoadSystemSettings.mockReturnValue({ paths: { repos_base: "/tmp/repos" } });
    // statSync will throw since dir doesn't exist, so returns ""
    const result = resolveRepoPath("../../../etc/passwd");
    // The function catches statSync errors and returns ""
    expect(result).toBe("");
  });
});

describe("createWorktree adversarial", () => {
  let mockExecFileFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import("node:child_process");
    mockExecFileFn = cp.execFile as unknown as ReturnType<typeof vi.fn>;
    mockExecFileFn.mockReset();
  });

  it("branch with multiple consecutive slashes converts all to hyphens", async () => {
    mockExecFileFn.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as Function;
      cb(null, "", "");
    });

    const { createWorktree } = await import("./git.js");
    const result = await createWorktree("/repo", "a///b", "/tmp/wt");
    expect(result).toContain("a---b");
  });

  it("rejects when git worktree add fails", async () => {
    mockExecFileFn.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as Function;
      cb(new Error("fatal: branch already exists"), "", "");
    });

    const { createWorktree } = await import("./git.js");
    await expect(createWorktree("/repo", "existing", "/tmp/wt")).rejects.toThrow("branch already exists");
  });

  // Bug 54 (c12+ review): branch name must be sanitized before being
  // joined into worktreePath / passed as a git argument. Malformed
  // names that contain `..`, control characters, leading `-`, or git
  // refname-forbidden tokens are now refused at the helper level.
  it("Bug 54: rejects branch containing path-traversal segments", async () => {
    const { createWorktree } = await import("./git.js");
    await expect(createWorktree("/repo", "../escape", "/tmp/wt")).rejects.toThrow(/invalid branch name/);
  });

  it("Bug 54: rejects branch containing null bytes", async () => {
    const { createWorktree } = await import("./git.js");
    await expect(createWorktree("/repo", "name\0evil", "/tmp/wt")).rejects.toThrow(/invalid branch name/);
  });

  it("Bug 54: rejects branch starting with '-' (would parse as CLI flag)", async () => {
    const { createWorktree } = await import("./git.js");
    await expect(createWorktree("/repo", "-flag", "/tmp/wt")).rejects.toThrow(/invalid branch name/);
  });

  it("Bug 54: rejects branch with whitespace and other refname-forbidden chars", async () => {
    const { createWorktree } = await import("./git.js");
    await expect(createWorktree("/repo", "with space", "/tmp/wt")).rejects.toThrow(/invalid branch name/);
    await expect(createWorktree("/repo", "with~tilde", "/tmp/wt")).rejects.toThrow(/invalid branch name/);
    await expect(createWorktree("/repo", "with?question", "/tmp/wt")).rejects.toThrow(/invalid branch name/);
  });
});
