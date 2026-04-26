import { describe, it, expect } from "vitest";
import { parseObjectType } from "./parse-ts-object-type";

describe("parseObjectType", () => {
  it("recognizes top-level primitives", () => {
    expect(parseObjectType("string")).toEqual({ kind: "primitive", type: "string" });
    expect(parseObjectType("number")).toEqual({ kind: "primitive", type: "number" });
    expect(parseObjectType("boolean")).toEqual({ kind: "primitive", type: "boolean" });
  });

  it("recognizes primitive arrays", () => {
    expect(parseObjectType("string[]")).toEqual({ kind: "primitive-array", element: "string" });
    expect(parseObjectType("number[]")).toEqual({ kind: "primitive-array", element: "number" });
  });

  it("parses a flat object", () => {
    const r = parseObjectType("{ name: string; age: number }");
    expect(r.kind).toBe("object");
    if (r.kind !== "object") throw new Error();
    expect(r.fields).toEqual([
      { name: "name", type: { kind: "string", optional: false } },
      { name: "age", type: { kind: "number", optional: false } },
    ]);
  });

  it("supports comma separator and optional fields", () => {
    const r = parseObjectType("{ id: string, label?: string, count?: number }");
    expect(r.kind).toBe("object");
    if (r.kind !== "object") throw new Error();
    expect(r.fields[0]!.type).toEqual({ kind: "string", optional: false });
    expect(r.fields[1]!.type).toEqual({ kind: "string", optional: true });
    expect(r.fields[2]!.type).toEqual({ kind: "number", optional: true });
  });

  it("handles primitive arrays inside objects", () => {
    const r = parseObjectType("{ tags: string[]; scores: number[] }");
    expect(r.kind).toBe("object");
    if (r.kind !== "object") throw new Error();
    expect(r.fields[0]!.type).toEqual({ kind: "string-array", optional: false });
    expect(r.fields[1]!.type).toEqual({ kind: "number-array", optional: false });
  });

  it("handles one level of nesting", () => {
    const r = parseObjectType("{ user: { name: string; age: number }; active: boolean }");
    expect(r.kind).toBe("object");
    if (r.kind !== "object") throw new Error();
    expect(r.fields[0]!.name).toBe("user");
    expect(r.fields[0]!.type.kind).toBe("object");
    if (r.fields[0]!.type.kind !== "object") throw new Error();
    expect(r.fields[0]!.type.fields).toEqual([
      { name: "name", type: { kind: "string", optional: false } },
      { name: "age", type: { kind: "number", optional: false } },
    ]);
  });

  it("falls through to raw for union types and other unsupported shapes", () => {
    expect(parseObjectType("string | number").kind).toBe("raw");
    expect(parseObjectType("Array<string>").kind).toBe("raw");
    expect(parseObjectType("Record<string, unknown>").kind).toBe("raw");
    expect(parseObjectType("MyImportedType").kind).toBe("raw");
  });

  it("returns raw on unbalanced braces", () => {
    expect(parseObjectType("{ name: string").kind).toBe("raw");
    expect(parseObjectType("{ a: { b: string }").kind).toBe("raw");
  });

  it("returns empty fields for {}", () => {
    const r = parseObjectType("{}");
    expect(r.kind).toBe("object");
    if (r.kind !== "object") throw new Error();
    expect(r.fields).toEqual([]);
  });
});
