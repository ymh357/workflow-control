import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWarn = vi.fn();

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn() }),
}));

import { safeFire } from "./safe-fire.js";

beforeEach(() => {
  mockWarn.mockClear();
});

describe("safeFire – adversarial", () => {
  it("returns void (fire-and-forget, no return value)", () => {
    const result = safeFire(Promise.resolve(), "task-1", "msg");
    expect(result).toBeUndefined();
  });

  it("handles non-Error rejection (string)", async () => {
    safeFire(Promise.reject("string error"), "task-1", "string rejection");
    await new Promise((r) => setTimeout(r, 10));
    expect(mockWarn).toHaveBeenCalledWith({ err: "string error" }, "string rejection");
  });

  it("handles non-Error rejection (null)", async () => {
    safeFire(Promise.reject(null), "task-1", "null rejection");
    await new Promise((r) => setTimeout(r, 10));
    expect(mockWarn).toHaveBeenCalledWith({ err: null }, "null rejection");
  });

  it("handles non-Error rejection (undefined)", async () => {
    safeFire(Promise.reject(undefined), "task-1", "undefined rejection");
    await new Promise((r) => setTimeout(r, 10));
    expect(mockWarn).toHaveBeenCalledWith({ err: undefined }, "undefined rejection");
  });

  it("does not interfere with multiple simultaneous promises", async () => {
    safeFire(Promise.reject(new Error("err1")), "task-1", "msg1");
    safeFire(Promise.reject(new Error("err2")), "task-2", "msg2");
    safeFire(Promise.resolve("ok"), "task-3", "msg3");

    await new Promise((r) => setTimeout(r, 20));
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  it("handles promise that rejects after delay", async () => {
    const delayed = new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 5));
    safeFire(delayed, "task-1", "delayed fail");
    await new Promise((r) => setTimeout(r, 20));
    expect(mockWarn).toHaveBeenCalledWith({ err: expect.any(Error) }, "delayed fail");
  });

  it("does not throw when called with empty taskId and message", async () => {
    safeFire(Promise.reject(new Error("x")), "", "");
    await new Promise((r) => setTimeout(r, 10));
    expect(mockWarn).toHaveBeenCalledWith({ err: expect.any(Error) }, "");
  });
});
