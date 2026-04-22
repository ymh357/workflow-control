import { describe, it, expect } from "vitest";
import { validateStoreSchema } from "./store-schema.js";
import type { PipelineIR } from "../ir/schema.js";

function makeIR(overrides: Partial<PipelineIR> = {}): PipelineIR {
  return {
    name: "t",
    stages: [
      {
        name: "producer",
        type: "agent",
        inputs: [],
        outputs: [
          { name: "report", type: "string" },
          { name: "count", type: "number" },
        ],
        config: { promptRef: "p" },
      },
    ],
    wires: [],
    ...overrides,
  };
}

describe("validateStoreSchema", () => {
  it("passes when store_schema is absent (backward compatibility)", () => {
    const result = validateStoreSchema(makeIR());
    expect(result.ok).toBe(true);
  });

  it("passes when store_schema is empty object", () => {
    const ir = makeIR();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ir as any).store_schema = {};
    const result = validateStoreSchema(ir);
    expect(result.ok).toBe(true);
  });

  it("passes when every entry produced_by references an existing (stage, port)", () => {
    const ir = makeIR();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ir as any).store_schema = {
      artifactPath: {
        type: "string",
        produced_by: { stage: "producer", port: "report" },
      },
      attemptCount: {
        type: "number",
        produced_by: { stage: "producer", port: "count" },
      },
    };
    const result = validateStoreSchema(ir);
    expect(result.ok).toBe(true);
  });

  it("rejects entry referencing a missing stage", () => {
    const ir = makeIR();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ir as any).store_schema = {
      artifactPath: {
        type: "string",
        produced_by: { stage: "ghost", port: "x" },
      },
    };
    const result = validateStoreSchema(ir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("STORE_SCHEMA_STAGE_MISSING");
  });

  it("rejects entry referencing an existing stage but missing output port", () => {
    const ir = makeIR();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ir as any).store_schema = {
      artifactPath: {
        type: "string",
        produced_by: { stage: "producer", port: "nope" },
      },
    };
    const result = validateStoreSchema(ir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("STORE_SCHEMA_PORT_MISSING");
  });

  it("rejects entry referencing an input port (store_schema must point at outputs)", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        {
          name: "producer", type: "agent",
          inputs: [{ name: "seed", type: "string" }],
          outputs: [{ name: "report", type: "string" }],
          config: { promptRef: "p" },
        },
      ],
      wires: [],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ir as any).store_schema = {
      seedVal: {
        type: "string",
        produced_by: { stage: "producer", port: "seed" },
      },
    };
    const result = validateStoreSchema(ir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("STORE_SCHEMA_PORT_MISSING");
  });

  it("rejects entry whose declared type disagrees with the referenced port's type", () => {
    const ir = makeIR();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ir as any).store_schema = {
      artifactPath: {
        type: "number",
        produced_by: { stage: "producer", port: "report" },
      },
    };
    const result = validateStoreSchema(ir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("STORE_SCHEMA_TYPE_MISMATCH");
  });

  it("allows whitespace differences in types (trimmed equality)", () => {
    const ir = makeIR();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ir as any).store_schema = {
      artifactPath: {
        type: "  string  ",
        produced_by: { stage: "producer", port: "report" },
      },
    };
    const result = validateStoreSchema(ir);
    expect(result.ok).toBe(true);
  });

  it("collects multiple issues in a single run (does not short-circuit)", () => {
    const ir = makeIR();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ir as any).store_schema = {
      ghostStage: {
        type: "string",
        produced_by: { stage: "ghost", port: "anything" },
      },
      wrongType: {
        type: "number",
        produced_by: { stage: "producer", port: "report" },
      },
      ghostPort: {
        type: "string",
        produced_by: { stage: "producer", port: "nope" },
      },
    };
    const result = validateStoreSchema(ir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("STORE_SCHEMA_STAGE_MISSING");
    expect(codes).toContain("STORE_SCHEMA_TYPE_MISMATCH");
    expect(codes).toContain("STORE_SCHEMA_PORT_MISSING");
  });

  it("includes key + stage + port in diagnostic context", () => {
    const ir = makeIR();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ir as any).store_schema = {
      artifactPath: {
        type: "string",
        produced_by: { stage: "ghost", port: "x" },
      },
    };
    const result = validateStoreSchema(ir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const d = result.diagnostics[0]!;
    expect(d.context).toMatchObject({ key: "artifactPath", stage: "ghost", port: "x" });
  });
});
