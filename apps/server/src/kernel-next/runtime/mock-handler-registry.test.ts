import { describe, it, expect } from "vitest";
import { MOCK_HANDLER_REGISTRY } from "./mock-handler-registry.js";

describe("MOCK_HANDLER_REGISTRY", () => {
  it("has diamond with 4 handlers", () => {
    const entry = MOCK_HANDLER_REGISTRY["diamond"];
    expect(entry).toBeDefined();
    expect(Object.keys(entry!.handlers).sort()).toEqual(["A", "B", "C", "D"]);
    expect(entry!.ir.stages.length).toBeGreaterThan(0);
  });

  it("has diamond-slow", () => {
    expect(MOCK_HANDLER_REGISTRY["diamond-slow"]).toBeDefined();
  });

  it("has diamond-real with empty handler map (uses real executor)", () => {
    const entry = MOCK_HANDLER_REGISTRY["diamond-real"];
    expect(entry).toBeDefined();
    expect(Object.keys(entry!.handlers)).toEqual([]);
  });

  it("does not contain legacy YAML builtins (they live in pipeline_versions)", () => {
    expect(MOCK_HANDLER_REGISTRY["pipeline-generator"]).toBeUndefined();
    expect(MOCK_HANDLER_REGISTRY["smoke-test"]).toBeUndefined();
    expect(MOCK_HANDLER_REGISTRY["tech-research-collector"]).toBeUndefined();
    expect(MOCK_HANDLER_REGISTRY["tech-research-writer"]).toBeUndefined();
  });
});
