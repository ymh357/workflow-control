import { describe, it, expect } from "vitest";
import { stableHash } from "./stable-hash.js";

describe("stableHash", () => {
  it("produces deterministic hashes for primitives", () => {
    expect(stableHash("hello")).toBe(stableHash("hello"));
    expect(stableHash(42)).toBe(stableHash(42));
    expect(stableHash(true)).toBe(stableHash(true));
    expect(stableHash(null)).toBe(stableHash(null));

    // Different primitives produce different hashes
    const hashes = [
      stableHash("hello"),
      stableHash(42),
      stableHash(true),
      stableHash(null),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("handles undefined without throwing", () => {
    expect(() => stableHash(undefined)).not.toThrow();
    expect(stableHash(undefined)).toMatch(/^[0-9a-f]{16}$/);
    expect(stableHash(undefined)).not.toBe(stableHash(null));
  });

  it("produces the same hash regardless of key order", () => {
    const a = { a: 1, b: 2 };
    const b = { b: 2, a: 1 };
    expect(stableHash(a)).toBe(stableHash(b));
  });

  it("produces the same hash for nested objects with different key orders", () => {
    const a = { outer: { x: 1, y: 2 }, z: { m: "a", n: "b" } };
    const b = { z: { n: "b", m: "a" }, outer: { y: 2, x: 1 } };
    expect(stableHash(a)).toBe(stableHash(b));
  });

  it("produces different hashes when array order differs", () => {
    expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
  });

  it("handles circular references without throwing", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => stableHash(obj)).not.toThrow();
    expect(typeof stableHash(obj)).toBe("string");
  });

  it("produces different hashes for different Dates and same hash for identical Dates", () => {
    const d1 = new Date("2024-01-01T00:00:00Z");
    const d2 = new Date("2024-06-15T12:00:00Z");
    const d3 = new Date("2024-01-01T00:00:00Z");

    expect(stableHash(d1)).toBe(stableHash(d3));
    expect(stableHash(d1)).not.toBe(stableHash(d2));
  });

  it("produces different hashes for different RegExp values", () => {
    const r1 = /abc/gi;
    const r2 = /xyz/;
    const r3 = /abc/gi;

    expect(stableHash(r1)).toBe(stableHash(r3));
    expect(stableHash(r1)).not.toBe(stableHash(r2));
  });

  it("returns a 16-character hex string", () => {
    const hash = stableHash({ foo: "bar" });
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces different hashes for empty object and empty array", () => {
    expect(stableHash({})).not.toBe(stableHash([]));
  });
});
