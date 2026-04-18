import { describe, it, expect } from "vitest";
import {
  canonicalize,
  canonicalJson,
  canonicalHash,
} from "./canonical.js";

describe("canonicalize", () => {
  it("passes through null, undefined, and primitives", () => {
    expect(canonicalize(null)).toBeNull();
    expect(canonicalize(undefined)).toBeUndefined();
    expect(canonicalize(42)).toBe(42);
    expect(canonicalize("x")).toBe("x");
    expect(canonicalize(true)).toBe(true);
  });

  it("sorts object keys recursively", () => {
    const input = { b: 1, a: { y: 2, x: 1 } };
    const result = canonicalize(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "b"]);
    expect(Object.keys(result.a as Record<string, unknown>)).toEqual([
      "x",
      "y",
    ]);
  });

  it("preserves array order (semantic)", () => {
    const input = { stages: [{ name: "a" }, { name: "b" }] };
    const result = canonicalize(input) as Record<string, unknown>;
    expect((result.stages as Array<{ name: string }>)[0]!.name).toBe("a");
    expect((result.stages as Array<{ name: string }>)[1]!.name).toBe("b");
  });

  it("sorts keys inside array elements", () => {
    const input = { items: [{ z: 1, a: 2 }] };
    const result = canonicalize(input) as {
      items: Array<Record<string, unknown>>;
    };
    expect(Object.keys(result.items[0]!)).toEqual(["a", "z"]);
  });
});

describe("canonicalJson", () => {
  it("produces the same string regardless of input key order", () => {
    const a = { a: 1, b: 2, c: { e: 3, d: 4 } };
    const b = { c: { d: 4, e: 3 }, b: 2, a: 1 };
    expect(canonicalJson(a)).toEqual(canonicalJson(b));
  });

  it("produces different strings for different values", () => {
    expect(canonicalJson({ a: 1 })).not.toEqual(canonicalJson({ a: 2 }));
  });

  it("distinguishes {} from []", () => {
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
  });
});

describe("canonicalHash", () => {
  it("returns a 64-char hex SHA-256", () => {
    const h = canonicalHash({ name: "p", stages: [] });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores YAML key order (same hash for reordered sources)", () => {
    const a = `
name: test
stages:
  - name: s1
    type: agent
`;
    const b = `
stages:
  - type: agent
    name: s1
name: test
`;
    expect(canonicalHash(a)).toEqual(canonicalHash(b));
  });

  it("ignores YAML whitespace and comments", () => {
    const a = `
name: test
stages:
  - name: s1
    type: agent
`;
    const b = `
# leading comment
name:       test

stages:
  -  name:    s1
     type:   agent     # inline comment
`;
    expect(canonicalHash(a)).toEqual(canonicalHash(b));
  });

  it("picks up value changes", () => {
    const a = `
name: test
stages:
  - name: s1
    type: agent
`;
    const b = `
name: test
stages:
  - name: s1
    type: script
`;
    expect(canonicalHash(a)).not.toEqual(canonicalHash(b));
  });

  it("picks up array-order changes (stages run in order — that's semantic)", () => {
    const a = `
name: p
stages:
  - name: s1
    type: agent
  - name: s2
    type: agent
`;
    const b = `
name: p
stages:
  - name: s2
    type: agent
  - name: s1
    type: agent
`;
    expect(canonicalHash(a)).not.toEqual(canonicalHash(b));
  });

  it("accepts a pre-parsed object", () => {
    const obj = { name: "p", stages: [] };
    expect(canonicalHash(obj)).toEqual(canonicalHash(obj));
  });

  it("is deterministic across calls (no randomness)", () => {
    const obj = { a: 1, b: [2, 3, { c: "x" }] };
    const first = canonicalHash(obj);
    const second = canonicalHash(obj);
    expect(first).toEqual(second);
  });

  it("hashes null and empty values without throwing", () => {
    expect(() => canonicalHash(null)).not.toThrow();
    expect(() => canonicalHash({})).not.toThrow();
    expect(() => canonicalHash("")).not.toThrow();
  });
});
