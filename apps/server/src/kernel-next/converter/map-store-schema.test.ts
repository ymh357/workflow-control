import { describe, it, expect } from "vitest";
import { mapStoreSchemaToPorts } from "./map-store-schema.js";

describe("mapStoreSchemaToPorts", () => {
  it("maps each declared field to a kernel-next port with matching type", () => {
    const legacy = {
      stages: [{ name: "greet" }, { name: "echoBack" }],
      store_schema: {
        greeting: {
          produced_by: "greet",
          fields: {
            subject: { type: "string" },
            note: { type: "string" },
          },
        },
      },
    };
    const r = mapStoreSchemaToPorts(legacy);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stageOutputs.get("greet")).toEqual([
        { name: "subject", type: "string" },
        { name: "note", type: "string" },
      ]);
      expect(r.entryDirectory.get("greeting")!.producerStage).toBe("greet");
      expect(r.entryDirectory.get("greeting")!.fields).toHaveLength(2);
      expect(r.warnings).toEqual([]);
    }
  });

  it("downgrades markdown to string with a warning", () => {
    const legacy = {
      stages: [{ name: "greet" }],
      store_schema: {
        greeting: { produced_by: "greet", fields: { body: { type: "markdown" } } },
      },
    };
    const r = mapStoreSchemaToPorts(legacy);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stageOutputs.get("greet")![0]!.type).toBe("string");
      expect(r.warnings.some((w) => w.code === "LEGACY_TYPE_DOWNGRADED")).toBe(true);
    }
  });

  it("maps string[] / number / boolean verbatim (no warning)", () => {
    const legacy = {
      stages: [{ name: "s" }],
      store_schema: {
        e: { produced_by: "s", fields: {
          arr: { type: "string[]" }, num: { type: "number" }, b: { type: "boolean" },
        } },
      },
    };
    const r = mapStoreSchemaToPorts(legacy);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const outs = r.stageOutputs.get("s")!;
      expect(outs.find((p) => p.name === "arr")!.type).toBe("string[]");
      expect(outs.find((p) => p.name === "num")!.type).toBe("number");
      expect(outs.find((p) => p.name === "b")!.type).toBe("boolean");
      expect(r.warnings).toEqual([]);
    }
  });

  it("downgrades object to Record<string, unknown> with a warning", () => {
    const legacy = {
      stages: [{ name: "s" }],
      store_schema: {
        e: { produced_by: "s", fields: { obj: { type: "object" } } },
      },
    };
    const r = mapStoreSchemaToPorts(legacy);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stageOutputs.get("s")![0]!.type).toBe("Record<string, unknown>");
      expect(r.warnings.some((w) => w.code === "LEGACY_TYPE_DOWNGRADED")).toBe(true);
    }
  });

  it("downgrades object[] similarly", () => {
    const legacy = {
      stages: [{ name: "s" }],
      store_schema: {
        e: { produced_by: "s", fields: { obj: { type: "object[]" } } },
      },
    };
    const r = mapStoreSchemaToPorts(legacy);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stageOutputs.get("s")![0]!.type).toBe("Record<string, unknown>[]");
  });

  it("fails with UNSUPPORTED_FIELD_TYPE for unknown type", () => {
    const legacy = {
      stages: [{ name: "s" }],
      store_schema: {
        e: { produced_by: "s", fields: { x: { type: "weird" } } },
      },
    };
    const r = mapStoreSchemaToPorts(legacy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("UNSUPPORTED_FIELD_TYPE");
  });

  it("fails with STORE_ENTRY_PRODUCER_MISSING when produced_by is not a declared stage", () => {
    const legacy = {
      stages: [{ name: "s" }],
      store_schema: {
        e: { produced_by: "ghost", fields: { x: { type: "string" } } },
      },
    };
    const r = mapStoreSchemaToPorts(legacy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("STORE_ENTRY_PRODUCER_MISSING");
  });
});
