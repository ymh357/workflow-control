import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

vi.mock("./logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("./artifacts.js", () => ({
  writeArtifact: vi.fn(async () => {}),
}));

vi.mock("./config-loader.js", () => ({
  loadSystemSettings: vi.fn(() => ({
    notion: { token: "ntn_test_token", sprint_board_id: "db-123" },
  })),
}));

// Mock node:child_process via promisify - scripts.ts does promisify(execFile)
// so we need to make the promisified version return {stdout, stderr}
const { mockExecAsyncFn } = vi.hoisted(() => ({
  mockExecAsyncFn: vi.fn(),
}));
vi.mock("node:child_process", () => {
  const fn: any = (...args: any[]) => { throw new Error("Use promisified version"); };
  // Node's promisify uses [Symbol for custom promisify] for execFile
  const { promisify } = require("node:util");
  fn[promisify.custom] = mockExecAsyncFn;
  return { execFile: fn };
});

// Mock fs operations
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { scriptRegistration, scriptPRCreation } from "./scripts.js";
import { writeArtifact } from "./artifacts.js";
import { writeFileSync, unlinkSync } from "node:fs";

// Build a mock execFile that resolves/rejects based on sequential outcomes
function mockExecFile(outcomes: Array<{ stdout?: string; stderr?: string; error?: Error }>) {
  let callIndex = 0;
  mockExecAsyncFn.mockImplementation((_cmd: any, _args: any, _opts: any) => {
    const outcome = outcomes[callIndex++] ?? { stdout: "", stderr: "" };
    if (outcome.error) {
      return Promise.reject(outcome.error);
    }
    return Promise.resolve({ stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" });
  });
}

// Mock global fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
});

describe("scriptRegistration - Notion API body construction", () => {
  it("sends correct Authorization header with Bearer token", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "page-1" }),
    });

    await scriptRegistration({
      taskId: "t-1",
      analysis: { title: "My Task", repoName: "my-repo", estimatedDays: 3, risks: ["risk-a"] },
      branch: "feat/test",
      settings: { notion: { token: "secret-token", sprint_board_id: "db-1" } } as any,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.notion.com/v1/pages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer secret-token",
          "Notion-Version": "2022-06-28",
        }),
      }),
    );
  });

  it("constructs properties with title, status, branch, estimated days, risks, repo", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "page-2" }),
    });

    await scriptRegistration({
      taskId: "t-1",
      analysis: { title: "Fix Bug", repoName: "app", estimatedDays: 2, risks: ["timeout", "OOM"] },
      branch: "fix/bug",
      settings: { notion: { token: "tok", sprint_board_id: "db-1" } } as any,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.parent.database_id).toBe("db-1");
    expect(body.properties.Name.title[0].text.content).toBe("Fix Bug");
    expect(body.properties.Status.select.name).toBe("\u6267\u884c\u4e2d");
    expect(body.properties.Branch.rich_text[0].text.content).toBe("fix/bug");
    expect(body.properties["Estimated Days"].number).toBe(2);
    expect(body.properties.Risks.rich_text[0].text.content).toBe("timeout; OOM");
    expect(body.properties.Repo.select.name).toBe("app");
  });

  it("omits Repo property when repoName is 'unknown'", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "page-3" }),
    });

    await scriptRegistration({
      taskId: "t-1",
      analysis: { title: "T", repoName: "unknown" },
      branch: "b",
      settings: { notion: { token: "tok", sprint_board_id: "db-1" } } as any,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.properties.Repo).toBeUndefined();
  });

  it("uses custom notionStatusLabel when provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "p" }),
    });

    await scriptRegistration({
      taskId: "t-1",
      analysis: { title: "T", repoName: "r" },
      branch: "b",
      notionStatusLabel: "Done",
      settings: { notion: { token: "tok", sprint_board_id: "db-1" } } as any,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.properties.Status.select.name).toBe("Done");
  });
});

describe("scriptRegistration - token missing", () => {
  it("skips Notion call and returns empty pageId when token is missing", async () => {
    const result = await scriptRegistration({
      taskId: "t-1",
      analysis: { title: "T" },
      branch: "b",
      worktreePath: "/tmp/wt",
      settings: { notion: {} } as any,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.notionPageId).toBe("");
  });

  it("skips Notion call when sprint_board_id is missing", async () => {
    const result = await scriptRegistration({
      taskId: "t-1",
      analysis: { title: "T" },
      branch: "b",
      settings: { notion: { token: "tok" } } as any,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.notionPageId).toBe("");
  });
});

describe("scriptRegistration - writeArtifact", () => {
  it("writes task-registry.json with correct path when worktreePath is provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "page-99" }),
    });

    await scriptRegistration({
      taskId: "t-1",
      analysis: { title: "T", repoName: "r" },
      branch: "b",
      worktreePath: "/tmp/my-wt",
      settings: { notion: { token: "tok", sprint_board_id: "db-1" } } as any,
    });

    expect(writeArtifact).toHaveBeenCalledWith(
      "/tmp/my-wt",
      "task-registry.json",
      expect.stringContaining('"notionPageId"'),
    );
  });

  it("does NOT call writeArtifact when worktreePath is undefined", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "page-1" }),
    });

    await scriptRegistration({
      taskId: "t-1",
      analysis: { title: "T", repoName: "r" },
      branch: "b",
      settings: { notion: { token: "tok", sprint_board_id: "db-1" } } as any,
    });

    expect(writeArtifact).not.toHaveBeenCalled();
  });
});

describe("scriptPRCreation - gh pr create parameter assembly", () => {
  it("assembles correct gh pr create arguments", async () => {
    // git add, git diff (fail = has changes), git commit, git fetch, git push, gh pr create
    mockExecFile([
      { stdout: "" },                                   // git add -A
      { error: new Error("has changes") },              // git diff --cached --quiet (exit 1 = changes exist)
      { stdout: "" },                                   // git commit
      { stdout: "" },                                   // git fetch
      { stdout: "" },                                   // git push
      { stdout: JSON.stringify({ url: "https://github.com/org/repo/pull/42" }) }, // gh pr create
      { stdout: "" },                                   // gh pr comment
    ]);

    const result = await scriptPRCreation({
      taskId: "abcdef1234567890",
      worktreePath: "/tmp/wt",
      branch: "feat/thing",
      analysis: { title: "Add Feature" },
      qaResult: { buildPassed: true, testsPassed: true, passed: true },
      settings: {} as any,
    });

    expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");

    // Verify gh pr create was called with correct args
    const ghCall = mockExecAsyncFn.mock.calls.find(
      (c: any[]) => c[0] === "gh" && (c[1] as string[])[0] === "pr" && (c[1] as string[])[1] === "create",
    );
    expect(ghCall).toBeDefined();
    const args = ghCall![1] as string[];
    expect(args).toContain("--title");
    expect(args).toContain("--base");
    expect(args).toContain("main");
    expect(args).toContain("--head");
    expect(args).toContain("feat/thing");
    // Title should contain short task id
    const titleIdx = args.indexOf("--title") + 1;
    expect(args[titleIdx]).toContain("abcdef12");
    expect(args[titleIdx]).toContain("Add Feature");
  });

  it("writes delivery-checklist.md artifact after PR creation", async () => {
    mockExecFile([
      { stdout: "" },
      { error: new Error("changes") },
      { stdout: "" },
      { stdout: "" },
      { stdout: "" },
      { stdout: JSON.stringify({ url: "https://github.com/o/r/pull/1" }) },
      { stdout: "" },
    ]);

    await scriptPRCreation({
      taskId: "abcdef1234567890",
      worktreePath: "/tmp/wt",
      branch: "b",
      analysis: { title: "T" },
      qaResult: { buildPassed: true, testsPassed: true, passed: true },
      settings: {} as any,
    });

    expect(writeArtifact).toHaveBeenCalledWith(
      "/tmp/wt",
      "delivery-checklist.md",
      expect.stringContaining("https://github.com/o/r/pull/1"),
    );
  });

  it("falls back to raw stdout when gh pr create returns non-JSON", async () => {
    mockExecFile([
      { stdout: "" },
      { error: new Error("changes") },
      { stdout: "" },
      { stdout: "" },
      { stdout: "" },
      { stdout: "https://github.com/o/r/pull/99\n" },  // raw URL, not JSON
      { stdout: "" },
    ]);

    const result = await scriptPRCreation({
      taskId: "abcdef1234567890",
      worktreePath: "/tmp/wt",
      branch: "b",
      analysis: { title: "T" },
      qaResult: { buildPassed: true, testsPassed: true, passed: true },
      settings: {} as any,
    });

    expect(result.prUrl).toBe("https://github.com/o/r/pull/99");
  });

  it("cleans up .pr-body.md temp file even when gh pr create fails", async () => {
    mockExecFile([
      { stdout: "" },
      { error: new Error("changes") },
      { stdout: "" },
      { stdout: "" },
      { stdout: "" },
      { error: new Error("gh failed") },  // gh pr create fails
    ]);

    await expect(
      scriptPRCreation({
        taskId: "abcdef1234567890",
        worktreePath: "/tmp/wt",
        branch: "b",
        analysis: { title: "T" },
        qaResult: { buildPassed: true, testsPassed: true, passed: true },
        settings: {} as any,
      }),
    ).rejects.toThrow();

    // unlinkSync should still be called for cleanup
    expect(unlinkSync).toHaveBeenCalled();
  });
});

describe("scriptRegistration - Notion API error resilience", () => {
  it("returns empty pageId when Notion API returns non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: "bad request" }),
    });

    const result = await scriptRegistration({
      taskId: "t-1",
      analysis: { title: "T", repoName: "r" },
      branch: "b",
      settings: { notion: { token: "tok", sprint_board_id: "db-1" } } as any,
    });

    // Should not throw, just return empty
    expect(result.notionPageId).toBe("");
  });

  it("returns empty pageId when fetch throws network error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await scriptRegistration({
      taskId: "t-1",
      analysis: { title: "T", repoName: "r" },
      branch: "b",
      settings: { notion: { token: "tok", sprint_board_id: "db-1" } } as any,
    });

    expect(result.notionPageId).toBe("");
  });
});
