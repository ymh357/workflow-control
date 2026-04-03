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

describe("safeFire", () => {
  it("does nothing on resolved promise", async () => {
    safeFire(Promise.resolve("ok"), "task-1", "test msg");
    // Allow microtask to flush
    await new Promise((r) => setTimeout(r, 10));
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("logs warning on rejected promise", async () => {
    const err = new Error("boom");
    safeFire(Promise.reject(err), "task-2", "fire failed");
    await new Promise((r) => setTimeout(r, 10));
    expect(mockWarn).toHaveBeenCalledWith({ err }, "fire failed");
  });
});
