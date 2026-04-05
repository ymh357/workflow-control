import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { actionToResponse } from "./action-helpers.js";
import type { ActionResult, ActionErrorCode } from "../actions/task-actions.js";

function mockContext() {
  const jsonCalls: Array<{ body: unknown; status?: number }> = [];
  const c = {
    json: vi.fn((body: unknown, status?: number) => {
      jsonCalls.push({ body, status });
      return { body, status } as unknown as Response;
    }),
    _jsonCalls: jsonCalls,
  };
  return c;
}

describe("actionToResponse", () => {
  it("returns success response for ok result", () => {
    const c = mockContext();
    const result: ActionResult<{ taskId: string }> = {
      ok: true,
      data: { taskId: "t1" },
    };

    actionToResponse(c as any, result);

    expect(c.json).toHaveBeenCalledWith({ ok: true, taskId: "t1" });
  });

  it("spreads data fields into response for ok result", () => {
    const c = mockContext();
    const result: ActionResult<{ a: number; b: string }> = {
      ok: true,
      data: { a: 1, b: "two" },
    };

    actionToResponse(c as any, result);

    expect(c.json).toHaveBeenCalledWith({ ok: true, a: 1, b: "two" });
  });

  it("returns 404 for TASK_NOT_FOUND", () => {
    const c = mockContext();
    const result: ActionResult<never> = {
      ok: false,
      code: "TASK_NOT_FOUND",
      message: "Task xyz not found",
    };

    actionToResponse(c as any, result);

    expect(c.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Task xyz not found", code: "TASK_NOT_FOUND" }),
      404,
    );
  });

  it("returns 400 for INVALID_STATE", () => {
    const c = mockContext();
    const result: ActionResult<never> = {
      ok: false,
      code: "INVALID_STATE",
      message: "Cannot transition",
    };

    actionToResponse(c as any, result);

    expect(c.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INVALID_STATE" }),
      400,
    );
  });

  it("returns 400 for VALIDATION_FAILED", () => {
    const c = mockContext();
    const result: ActionResult<never> = {
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Missing field",
    };

    actionToResponse(c as any, result);

    expect(c.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
      400,
    );
  });

  it("returns 400 for INVALID_CONFIG", () => {
    const c = mockContext();
    const result: ActionResult<never> = {
      ok: false,
      code: "INVALID_CONFIG",
      message: "Pipeline not found",
    };

    actionToResponse(c as any, result);

    expect(c.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INVALID_CONFIG" }),
      400,
    );
  });

  it("returns 500 for INTERNAL_ERROR", () => {
    const c = mockContext();
    const result: ActionResult<never> = {
      ok: false,
      code: "INTERNAL_ERROR",
      message: "Something went wrong",
    };

    actionToResponse(c as any, result);

    expect(c.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
      500,
    );
  });

  it("returns 404 for QUESTION_NOT_FOUND", () => {
    const c = mockContext();
    const result: ActionResult<never> = {
      ok: false,
      code: "QUESTION_NOT_FOUND",
      message: "Question not found",
    };

    actionToResponse(c as any, result);

    expect(c.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "QUESTION_NOT_FOUND" }),
      404,
    );
  });

  it("returns 409 for QUESTION_STALE", () => {
    const c = mockContext();
    const result: ActionResult<never> = {
      ok: false,
      code: "QUESTION_STALE",
      message: "Question already answered",
    };

    actionToResponse(c as any, result);

    expect(c.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "QUESTION_STALE" }),
      409,
    );
  });

  it("maps all error codes to correct HTTP statuses", () => {
    const expectedMap: Record<ActionErrorCode, number> = {
      TASK_NOT_FOUND: 404,
      INVALID_STATE: 400,
      VALIDATION_FAILED: 400,
      INVALID_CONFIG: 400,
      INTERNAL_ERROR: 500,
      QUESTION_NOT_FOUND: 404,
      QUESTION_STALE: 409,
    };

    for (const [code, expectedStatus] of Object.entries(expectedMap)) {
      const c = mockContext();
      actionToResponse(c as any, {
        ok: false,
        code: code as ActionErrorCode,
        message: `test ${code}`,
      });

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({ code }),
        expectedStatus,
      );
    }
  });
});
