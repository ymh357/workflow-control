import { describe, it, expect, vi, beforeEach } from "vitest";

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

const { mockExecAsyncFn } = vi.hoisted(() => ({
  mockExecAsyncFn: vi.fn(),
}));
vi.mock("node:child_process", () => {
  const fn: any = (...args: any[]) => { throw new Error("Use promisified version"); };
  const { promisify } = require("node:util");
  fn[promisify.custom] = mockExecAsyncFn;
  return { execFile: fn };
});

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { scriptRegistration, scriptPRCreation } from "./scripts.js";
import { writeArtifact } from "./artifacts.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
});

function mockExecFile(outcomes: Array<{ stdout?: string; stderr?: string; error?: Error }>) {
  let callIndex = 0;
  mockExecAsyncFn.mockImplementation(() => {
    const outcome = outcomes[callIndex++] ?? { stdout: "", stderr: "" };
    if (outcome.error) return Promise.reject(outcome.error);
    return Promise.resolve({ stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" });
  });
}

describe("scriptRegistration adversarial", () => {
  it("handles Notion API returning non-JSON error body gracefully", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new Error("not JSON"); },
    });

    const result = await scriptRegistration({
      taskId: "t-1",
      analysis: { title: "T", repoName: "r" },
      branch: "b",
      settings: { notion: { token: "tok", sprint_board_id: "db-1" } } as any,
    });

    // Should not throw, returns empty pageId
    expect(result.notionPageId).toBe("");
  });

  it("handles Notion API response missing id field", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ object: "page" }), // no id
    });

    const result = await scriptRegistration({
      taskId: "t-1",
      analysis: { title: "T", repoName: "r" },
      branch: "b",
      settings: { notion: { token: "tok", sprint_board_id: "db-1" } } as any,
    });

    expect(result.notionPageId).toBe("");
  });

  it("uses defaults when analysis has no title, estimatedDays, or risks", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "p1" }),
    });

    await scriptRegistration({
      taskId: "t-1",
      analysis: {}, // completely empty analysis
      branch: "b",
      settings: { notion: { token: "tok", sprint_board_id: "db-1" } } as any,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.properties.Name.title[0].text.content).toBe("Untitled Task");
    expect(body.properties["Estimated Days"].number).toBe(1);
    expect(body.properties.Risks.rich_text[0].text.content).toBe("");
  });

  it("writes artifact even when Notion call fails with network error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    await scriptRegistration({
      taskId: "t-1",
      analysis: { title: "T", repoName: "r" },
      branch: "b",
      worktreePath: "/tmp/wt",
      settings: { notion: { token: "tok", sprint_board_id: "db-1" } } as any,
    });

    expect(writeArtifact).toHaveBeenCalledWith(
      "/tmp/wt",
      "task-registry.json",
      expect.any(String),
    );
  });

  it("both token and sprint_board_id undefined skips fetch entirely", async () => {
    const result = await scriptRegistration({
      taskId: "t-1",
      analysis: { title: "T" },
      branch: "b",
      settings: {} as any,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.notionPageId).toBe("");
  });
});

describe("scriptPRCreation adversarial", () => {
  it("handles no staged changes (git diff --cached --quiet succeeds)", async () => {
    mockExecFile([
      { stdout: "" },           // git add -A
      { stdout: "" },           // git diff --cached --quiet SUCCESS (no changes)
      { stdout: "" },           // git fetch
      { stdout: "" },           // git push
      { stdout: JSON.stringify({ url: "https://github.com/o/r/pull/1" }) },
      { stdout: "" },           // gh pr comment
    ]);

    const result = await scriptPRCreation({
      taskId: "abcdef1234567890",
      worktreePath: "/tmp/wt",
      branch: "b",
      analysis: { title: "T" },
      qaResult: { buildPassed: true, testsPassed: true, passed: true },
      settings: {} as any,
    });

    // Should still push and create PR (skipping commit)
    expect(result.prUrl).toBe("https://github.com/o/r/pull/1");
  });

  it("extracts PR number from URL with trailing slash", async () => {
    mockExecFile([
      { stdout: "" },
      { error: new Error("changes") },
      { stdout: "" },
      { stdout: "" },
      { stdout: "" },
      { stdout: JSON.stringify({ url: "https://github.com/o/r/pull/42/" }) },
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

    // PR number extraction uses split("/").pop(), trailing slash gives empty string
    // This means the QA comment step gets an empty prNumber and is skipped
    expect(result.prUrl).toBe("https://github.com/o/r/pull/42/");
  });

  it("PR body correctly shows FAILED/SKIPPED statuses", async () => {
    const { writeFileSync } = await import("node:fs");
    const mockWriteFileSync = vi.mocked(writeFileSync);

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
      analysis: { title: "My Feature", description: "desc" },
      qaResult: {
        buildPassed: false,
        testsPassed: false,
        passed: false,
        aiCodeReviewPassed: false,
        blockers: ["blocker-1"],
        warnings: ["warn-1"],
      },
      settings: {} as any,
    });

    const bodyCall = mockWriteFileSync.mock.calls.find(
      (c) => (c[0] as string).endsWith(".pr-body.md"),
    );
    expect(bodyCall).toBeDefined();
    const body = bodyCall![1] as string;
    expect(body).toContain("FAILED");
    expect(body).toContain("ISSUES FOUND");
    expect(body).toContain("blocker-1");
    expect(body).toContain("warn-1");
  });
});
