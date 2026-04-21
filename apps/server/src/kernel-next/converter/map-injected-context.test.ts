import { describe, it, expect } from "vitest";
import { mapInjectedContext } from "./map-injected-context.js";

describe("mapInjectedContext", () => {
  it("maps each entry to an externalInput port with type 'unknown'", () => {
    const r = mapInjectedContext({ injected_context: ["pipelineConfig", "projectContext"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.externalInputs).toEqual([
        { name: "pipelineConfig", type: "unknown" },
        { name: "projectContext", type: "unknown" },
      ]);
      expect(r.warnings).toHaveLength(2);
      expect(r.warnings[0]!.code).toBe("INJECTED_CONTEXT_UNTYPED");
    }
  });

  it("returns empty externalInputs when injected_context is absent", () => {
    const r = mapInjectedContext({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.externalInputs).toEqual([]);
      expect(r.externalKeys.size).toBe(0);
    }
  });

  it("fails with INJECTED_CONTEXT_NAME_INVALID for non-identifier names", () => {
    const r = mapInjectedContext({ injected_context: ["project-context"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("INJECTED_CONTEXT_NAME_INVALID");
  });

  it("fails with INJECTED_CONTEXT_NAME_INVALID for the reserved sentinel", () => {
    const r = mapInjectedContext({ injected_context: ["__external__"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("INJECTED_CONTEXT_NAME_INVALID");
  });

  it("fails with DUPLICATE_EXTERNAL_INPUT_NAME when an entry appears twice", () => {
    const r = mapInjectedContext({ injected_context: ["x", "x"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("DUPLICATE_EXTERNAL_INPUT_NAME");
  });

  it("fails with EXTERNAL_INPUT_COLLIDES_WITH_STAGE when entry equals a store_schema key", () => {
    const r = mapInjectedContext({
      injected_context: ["greeting"],
      store_schema: { greeting: { produced_by: "s", fields: { a: { type: "string" } } } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("EXTERNAL_INPUT_COLLIDES_WITH_STAGE");
  });

  // Tests for the structured external_inputs{} dict path.

  it("valid typed dict input produces PortIR with correct name and type, no EXTERNAL_INPUT_TYPE_UNKNOWN warning", () => {
    const r = mapInjectedContext({
      external_inputs: { foo: { type: "string", description: "x", required: true } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.externalInputs).toEqual([{ name: "foo", type: "string" }]);
      const typeWarnings = r.warnings.filter((w) => w.code === "EXTERNAL_INPUT_TYPE_UNKNOWN");
      expect(typeWarnings).toHaveLength(0);
    }
  });

  it("unknown type in dict format falls back to 'unknown' and emits EXTERNAL_INPUT_TYPE_UNKNOWN warning", () => {
    const r = mapInjectedContext({
      external_inputs: { bar: { type: "weird-type" } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.externalInputs).toEqual([{ name: "bar", type: "unknown" }]);
      const typeWarnings = r.warnings.filter((w) => w.code === "EXTERNAL_INPUT_TYPE_UNKNOWN");
      expect(typeWarnings).toHaveLength(1);
      expect(typeWarnings[0]!.context).toMatchObject({ entry: "bar", declaredType: "weird-type" });
    }
  });

  it("duplicate name across injected_context and external_inputs emits DUPLICATE_EXTERNAL_INPUT_NAME", () => {
    const r = mapInjectedContext({
      injected_context: ["foo"],
      external_inputs: { foo: { type: "string" } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics[0]!.code).toBe("DUPLICATE_EXTERNAL_INPUT_NAME");
      expect(r.diagnostics[0]!.context).toMatchObject({ entry: "foo" });
    }
  });
});
