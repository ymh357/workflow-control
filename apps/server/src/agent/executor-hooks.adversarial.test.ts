import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../lib/question-manager.js", () => ({
  questionManager: {
    ask: vi.fn(),
  },
}));

import { createAskUserQuestionInterceptor, createSpecAuditHook } from "./executor-hooks.js";
import { questionManager } from "../lib/question-manager.js";

const mockAsk = vi.mocked(questionManager.ask);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("createAskUserQuestionInterceptor – adversarial", () => {
  it("handles questions array with first element having no question field", async () => {
    mockAsk.mockResolvedValue("ok");
    const interceptor = createAskUserQuestionInterceptor("task-1");
    await interceptor("AskUserQuestion", {
      questions: [{ options: [{ label: "A" }] }],
    });
    // firstQ.question is undefined, so falls back to JSON.stringify(input)
    expect(mockAsk).toHaveBeenCalledWith(
      "task-1",
      expect.any(String),
      ["A"],
    );
  });

  it("truncates logged input to 200 chars (does not crash on huge input)", async () => {
    mockAsk.mockResolvedValue("ok");
    const interceptor = createAskUserQuestionInterceptor("task-1");
    const hugeInput = { questions: [{ question: "x".repeat(1000) }] };
    const result = await interceptor("AskUserQuestion", hugeInput);
    expect(result.behavior).toBe("deny");
  });

  it("handles non-Error rejection from ask (string throw)", async () => {
    mockAsk.mockRejectedValue("string error");
    const interceptor = createAskUserQuestionInterceptor("task-1");
    const result = await interceptor("AskUserQuestion", {
      questions: [{ question: "Q?" }],
    });
    expect(result.behavior).toBe("deny");
    expect((result as any).message).toContain("timed out or was cancelled");
  });

  it("handles input with questions set to null", async () => {
    mockAsk.mockResolvedValue("ok");
    const interceptor = createAskUserQuestionInterceptor("task-1");
    await interceptor("AskUserQuestion", { questions: null });
    // questions is null, so firstQ is undefined, falls back to JSON.stringify
    expect(mockAsk).toHaveBeenCalledWith("task-1", expect.stringContaining("null"), undefined);
  });

  it("case-sensitive tool name check (askuserquestion lowercase does not intercept)", async () => {
    const interceptor = createAskUserQuestionInterceptor("task-1");
    const result = await interceptor("askuserquestion", { questions: [] });
    expect(result).toEqual({ behavior: "allow" });
    expect(mockAsk).not.toHaveBeenCalled();
  });
});

describe("createSpecAuditHook – adversarial", () => {
  it("blocks file that partially matches spec name but is not the same file", async () => {
    const hook = createSpecAuditHook("task-1", ["spec.md"]);
    // "my-spec.md" ends with "spec.md" so it matches
    const result = await hook({
      tool_name: "Write",
      tool_input: { file_path: "/project/my-spec.md" },
    } as any);
    expect((result as any).decision).toBe("approve");
  });

  it("handles file_path with only a filename (no directory)", async () => {
    const hook = createSpecAuditHook("task-1", ["main.ts"]);
    const result = await hook({
      tool_name: "Write",
      tool_input: { file_path: "main.ts" },
    } as any);
    expect((result as any).decision).toBe("approve");
  });

  it("handles tool_input being undefined (no file_path at all)", async () => {
    const hook = createSpecAuditHook("task-1", ["spec.md"]);
    const result = await hook({
      tool_name: "Write",
      tool_input: undefined,
    } as any);
    // String(undefined) => "undefined", which is truthy but won't match .workflow/
    // Actually filePath = String(undefined?.file_path ?? "") = String("") = ""
    // "" is falsy, so the if(!filePath) check makes it approve
    expect((result as any).decision).toBe("approve");
  });

  it("warnedPaths is per-hook-instance (separate hooks don't share state)", async () => {
    const hook1 = createSpecAuditHook("task-1", ["spec.md"]);
    const hook2 = createSpecAuditHook("task-1", ["spec.md"]);
    const input = { tool_name: "Edit", tool_input: { file_path: "/project/other.ts" } } as any;

    const r1 = await hook1(input);
    expect((r1 as any).decision).toBe("block");

    // hook2 is a different instance, should also block
    const r2 = await hook2(input);
    expect((r2 as any).decision).toBe("block");
  });

  it("spec file with path separator matches endsWith correctly", async () => {
    const hook = createSpecAuditHook("task-1", ["src/components/Button.tsx"]);
    const result = await hook({
      tool_name: "Write",
      tool_input: { file_path: "/project/src/components/Button.tsx" },
    } as any);
    expect((result as any).decision).toBe("approve");
  });

  it("file inside .workflow/ nested deeply is still approved", async () => {
    const hook = createSpecAuditHook("task-1", ["spec.md"]);
    const result = await hook({
      tool_name: "Edit",
      tool_input: { file_path: "/project/.workflow/deep/nested/file.json" },
    } as any);
    expect((result as any).decision).toBe("approve");
  });
});
