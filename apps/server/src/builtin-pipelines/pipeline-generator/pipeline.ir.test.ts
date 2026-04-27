import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("pipeline-generator IR", () => {
  const irPath = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "pipeline.ir.json");
  const ir = JSON.parse(readFileSync(irPath, "utf8")) as {
    stages: Array<{
      name: string;
      inputs?: Array<{ name: string; type: string }>;
      outputs?: Array<{ name: string; type: string }>;
    }>;
  };

  const expectedType =
    "Array<{ entryId: string; name: string; command: string; args: string[]; env?: Record<string, string>; envKeys: string[]; reason: string }>";

  it("analyzing.outputs.recommendedMcps has structured type", () => {
    const stage = ir.stages.find((s) => s.name === "analyzing");
    const port = stage?.outputs?.find((p) => p.name === "recommendedMcps");
    expect(port?.type).toBe(expectedType);
  });

  it("genSkeleton.inputs.recommendedMcps has structured type", () => {
    const stage = ir.stages.find((s) => s.name === "genSkeleton");
    const port = stage?.inputs?.find((p) => p.name === "recommendedMcps");
    expect(port?.type).toBe(expectedType);
  });

  it("all 4 recommendedMcps ports across the pipeline share the same type", () => {
    const ports: Array<{ stage: string; type: string }> = [];
    for (const stage of ir.stages) {
      for (const p of [...(stage.inputs ?? []), ...(stage.outputs ?? [])]) {
        if (p.name === "recommendedMcps") ports.push({ stage: stage.name, type: p.type });
      }
    }
    expect(ports.length).toBe(4);
    const distinctTypes = new Set(ports.map((p) => p.type));
    expect(distinctTypes.size).toBe(1);
    expect([...distinctTypes][0]).toBe(expectedType);
  });

  it("store_schema['analyzing.recommendedMcps'].type matches the port type", () => {
    const irFull = JSON.parse(readFileSync(irPath, "utf8")) as {
      store_schema?: Record<string, { type: string }>;
    };
    const entry = irFull.store_schema?.["analyzing.recommendedMcps"];
    expect(entry).toBeDefined();
    expect(entry?.type).toBe(expectedType);
  });
});
