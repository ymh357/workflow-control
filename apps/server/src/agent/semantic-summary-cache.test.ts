import { describe, it, expect, beforeEach } from "vitest";
import {
  getCachedSummary,
  setCachedSummary,
  clearTaskSummaries,
} from "./semantic-summary-cache";

describe("semantic-summary-cache", () => {
  const TASK_A = "test-task-a";
  const TASK_B = "test-task-b";

  beforeEach(() => {
    clearTaskSummaries(TASK_A);
    clearTaskSummaries(TASK_B);
  });

  it("get returns undefined for missing key", () => {
    expect(getCachedSummary(TASK_A, "nonexistent")).toBeUndefined();
  });

  it("set then get returns the value", () => {
    setCachedSummary(TASK_A, "key1", "summary-value");
    expect(getCachedSummary(TASK_A, "key1")).toBe("summary-value");
  });

  it("different taskId:storeKey combinations are independent", () => {
    setCachedSummary(TASK_A, "key1", "value-a-1");
    setCachedSummary(TASK_A, "key2", "value-a-2");
    setCachedSummary(TASK_B, "key1", "value-b-1");

    expect(getCachedSummary(TASK_A, "key1")).toBe("value-a-1");
    expect(getCachedSummary(TASK_A, "key2")).toBe("value-a-2");
    expect(getCachedSummary(TASK_B, "key1")).toBe("value-b-1");
  });

  it("clearTaskSummaries removes only entries for that task", () => {
    setCachedSummary(TASK_A, "key1", "value-a-1");
    setCachedSummary(TASK_A, "key2", "value-a-2");
    setCachedSummary(TASK_B, "key1", "value-b-1");

    clearTaskSummaries(TASK_A);

    expect(getCachedSummary(TASK_A, "key1")).toBeUndefined();
    expect(getCachedSummary(TASK_A, "key2")).toBeUndefined();
  });

  it("clearTaskSummaries leaves other tasks entries intact", () => {
    setCachedSummary(TASK_A, "key1", "value-a-1");
    setCachedSummary(TASK_B, "key1", "value-b-1");

    clearTaskSummaries(TASK_A);

    expect(getCachedSummary(TASK_B, "key1")).toBe("value-b-1");
  });

  it("overwrite: set same key twice, get returns latest", () => {
    setCachedSummary(TASK_A, "key1", "first");
    setCachedSummary(TASK_A, "key1", "second");

    expect(getCachedSummary(TASK_A, "key1")).toBe("second");
  });
});
