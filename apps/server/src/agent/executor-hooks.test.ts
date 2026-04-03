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

describe("createAskUserQuestionInterceptor", () => {
  it("returns a function", () => {
    const interceptor = createAskUserQuestionInterceptor("task-1");
    expect(typeof interceptor).toBe("function");
  });

  it("allows non-AskUserQuestion tools", async () => {
    const interceptor = createAskUserQuestionInterceptor("task-1");
    const result = await interceptor("Read", { file_path: "/foo" });
    expect(result).toEqual({ behavior: "allow" });
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it("intercepts AskUserQuestion and returns user answer as deny message", async () => {
    mockAsk.mockResolvedValue("Yes, proceed");
    const interceptor = createAskUserQuestionInterceptor("task-1");
    const result = await interceptor("AskUserQuestion", {
      questions: [{ question: "Should I proceed?", options: [{ label: "Yes" }, { label: "No" }] }],
    });
    expect(result.behavior).toBe("deny");
    expect((result as any).message).toContain("Yes, proceed");
    expect(mockAsk).toHaveBeenCalledWith("task-1", "Should I proceed?", ["Yes", "No"]);
  });

  it("uses JSON.stringify fallback when questions array is missing", async () => {
    mockAsk.mockResolvedValue("ok");
    const interceptor = createAskUserQuestionInterceptor("task-1");
    const input = { some_field: "value" };
    await interceptor("AskUserQuestion", input);
    expect(mockAsk).toHaveBeenCalledWith("task-1", JSON.stringify(input), undefined);
  });

  it("uses JSON.stringify fallback when questions is empty array", async () => {
    mockAsk.mockResolvedValue("ok");
    const interceptor = createAskUserQuestionInterceptor("task-1");
    await interceptor("AskUserQuestion", { questions: [] });
    // firstQ is undefined, so question falls back to JSON.stringify(input)
    expect(mockAsk).toHaveBeenCalledWith(
      "task-1",
      expect.any(String),
      undefined,
    );
  });

  it("handles question without options", async () => {
    mockAsk.mockResolvedValue("free text answer");
    const interceptor = createAskUserQuestionInterceptor("task-1");
    await interceptor("AskUserQuestion", {
      questions: [{ question: "What color?" }],
    });
    expect(mockAsk).toHaveBeenCalledWith("task-1", "What color?", undefined);
  });

  it("returns deny with timeout/cancel message when ask rejects", async () => {
    mockAsk.mockRejectedValue(new Error("Question timed out"));
    const interceptor = createAskUserQuestionInterceptor("task-1");
    const result = await interceptor("AskUserQuestion", {
      questions: [{ question: "Pick one?" }],
    });
    expect(result.behavior).toBe("deny");
    expect((result as any).message).toContain("timed out or was cancelled");
  });
});

describe("createSpecAuditHook", () => {
  it("returns a function", () => {
    const hook = createSpecAuditHook("task-1", ["spec.md"]);
    expect(typeof hook).toBe("function");
  });

  it("approves non-Write/Edit tools", async () => {
    const hook = createSpecAuditHook("task-1", ["spec.md"]);
    const result = await hook({ tool_name: "Read", tool_input: { file_path: "/foo/bar.ts" } } as any);
    expect((result as any).decision).toBe("approve");
  });

  it("approves Write to a file matching specFiles", async () => {
    const hook = createSpecAuditHook("task-1", ["design.md", "spec.md"]);
    const result = await hook({ tool_name: "Write", tool_input: { file_path: "/project/spec.md" } } as any);
    expect((result as any).decision).toBe("approve");
  });

  it("approves Write to a .workflow/ path", async () => {
    const hook = createSpecAuditHook("task-1", ["spec.md"]);
    const result = await hook({ tool_name: "Write", tool_input: { file_path: "/project/.workflow/output.json" } } as any);
    expect((result as any).decision).toBe("approve");
  });

  it("blocks Write to a file outside spec scope", async () => {
    const hook = createSpecAuditHook("task-1", ["spec.md"]);
    const result = await hook({ tool_name: "Write", tool_input: { file_path: "/project/src/main.ts" } } as any);
    expect((result as any).decision).toBe("block");
    expect((result as any).reason).toContain("main.ts");
    expect((result as any).reason).toContain("spec.md");
  });

  it("blocks Edit to a file outside spec scope", async () => {
    const hook = createSpecAuditHook("task-1", ["spec.md"]);
    const result = await hook({ tool_name: "Edit", tool_input: { file_path: "/project/src/app.ts" } } as any);
    expect((result as any).decision).toBe("block");
  });

  it("only warns once per file path (warnedPaths dedup)", async () => {
    const hook = createSpecAuditHook("task-1", ["spec.md"]);
    const input = { tool_name: "Write", tool_input: { file_path: "/project/src/main.ts" } } as any;

    const first = await hook(input);
    expect((first as any).decision).toBe("block");

    const second = await hook(input);
    expect((second as any).decision).toBe("approve");
  });

  it("approves everything when specFiles is empty", async () => {
    const hook = createSpecAuditHook("task-1", []);
    const result = await hook({ tool_name: "Write", tool_input: { file_path: "/project/anything.ts" } } as any);
    expect((result as any).decision).toBe("approve");
  });

  it("approves when file_path is empty", async () => {
    const hook = createSpecAuditHook("task-1", ["spec.md"]);
    const result = await hook({ tool_name: "Write", tool_input: {} } as any);
    expect((result as any).decision).toBe("approve");
  });
});
