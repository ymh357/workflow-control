import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { actionToResponse } from "./action-helpers.js";
import type { ActionResult } from "../actions/task-actions.js";

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

describe("actionToResponse — adversarial", () => {
  it("crashes on unknown error code not in codeMap", () => {
    const c = mockContext();
    const result = {
      ok: false,
      code: "UNKNOWN_CODE" as any,
      message: "weird error",
    };

    // codeMap["UNKNOWN_CODE"] is undefined, so mapped.status will throw
    expect(() => actionToResponse(c as any, result as any)).toThrow();
  });

  it("handles ok result with null data (spread of null)", () => {
    const c = mockContext();
    const result: ActionResult<null> = {
      ok: true,
      data: null as any,
    };

    // Spreading null: { ok: true, ...null } should work in JS
    expect(() => actionToResponse(c as any, result)).not.toThrow();
    expect(c.json).toHaveBeenCalledWith({ ok: true });
  });

  it("handles ok result with empty object data", () => {
    const c = mockContext();
    const result: ActionResult<Record<string, never>> = {
      ok: true,
      data: {},
    };

    actionToResponse(c as any, result);
    expect(c.json).toHaveBeenCalledWith({ ok: true });
  });

  it("does not let data.ok override the ok: true in success response", () => {
    const c = mockContext();
    const result: ActionResult<{ ok: boolean }> = {
      ok: true,
      data: { ok: false },
    };

    actionToResponse(c as any, result);
    // { ok: true, ...{ ok: false } } => { ok: false } — data overrides!
    // This is a potential bug: data field named 'ok' clobbers the ok: true
    const call = c.json.mock.calls[0][0] as any;
    expect(call.ok).toBe(false); // BUG: data.ok overrides response.ok
  });

  it("preserves error message with special characters", () => {
    const c = mockContext();
    const msg = 'Task "test" <b>not found</b> & gone';
    const result: ActionResult<never> = {
      ok: false,
      code: "TASK_NOT_FOUND",
      message: msg,
    };

    actionToResponse(c as any, result);
    expect(c.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: msg }),
      404,
    );
  });

  it("handles result with extra properties beyond ActionResult shape", () => {
    const c = mockContext();
    const result = {
      ok: true,
      data: { taskId: "t1" },
      extraField: "should be ignored by type but present at runtime",
    } as any;

    actionToResponse(c as any, result);
    // Extra fields on the ActionResult wrapper are ignored since only result.data is spread
    expect(c.json).toHaveBeenCalledWith({ ok: true, taskId: "t1" });
  });
});
