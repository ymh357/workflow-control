import { describe, it, expect, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { extractJSON } from "./json-extractor.js";

describe("extractJSON", () => {
  it("parses direct JSON object", () => {
    const result = extractJSON('{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });

  it("parses direct JSON array", () => {
    const result = extractJSON('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  it("extracts JSON from markdown code fence", () => {
    const text = "Here is the result:\n```json\n{\"a\": 1}\n```\nDone.";
    expect(extractJSON(text)).toEqual({ a: 1 });
  });

  it("extracts JSON from code fence without json label", () => {
    const text = "Result:\n```\n{\"b\": 2}\n```";
    expect(extractJSON(text)).toEqual({ b: 2 });
  });

  it("picks last code block when multiple exist", () => {
    const text = '```json\n{"first": true}\n```\nsome text\n```json\n{"second": true}\n```';
    expect(extractJSON(text)).toEqual({ second: true });
  });

  it("falls back to earlier code block if last is malformed", () => {
    const text = '```json\n{"good": true}\n```\n```json\nnot json at all\n```';
    expect(extractJSON(text)).toEqual({ good: true });
  });

  it("extracts JSON embedded in surrounding text via balanced brace extraction", () => {
    const text = 'The answer is {"nested": {"deep": true}} and that is all.';
    expect(extractJSON(text)).toEqual({ nested: { deep: true } });
  });

  it("picks the largest balanced JSON block when multiple exist", () => {
    const text = 'small {"a":1} big {"a":1,"b":2,"c":3}';
    expect(extractJSON(text)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("handles nested objects correctly", () => {
    const obj = { level1: { level2: { level3: "deep" } } };
    const text = `Here: ${JSON.stringify(obj)} done`;
    expect(extractJSON(text)).toEqual(obj);
  });

  it("handles escaped characters in strings", () => {
    const text = '{"msg": "say \\"hello\\"", "path": "C:\\\\Users"}';
    expect(extractJSON(text)).toEqual({ msg: 'say "hello"', path: "C:\\Users" });
  });

  it("handles braces inside strings during balanced extraction", () => {
    const text = 'result: {"data": "value with { and } inside"} end';
    expect(extractJSON(text)).toEqual({ data: "value with { and } inside" });
  });

  it("throws on invalid JSON with no extractable content", () => {
    expect(() => extractJSON("no json here")).toThrow("Failed to extract JSON");
  });

  it("throws on empty input", () => {
    expect(() => extractJSON("")).toThrow("Failed to extract JSON");
  });

  it("throws when only primitive values found", () => {
    expect(() => extractJSON("42")).toThrow("Failed to extract JSON");
  });

  it("throws when balanced braces contain invalid JSON", () => {
    expect(() => extractJSON("look {not: valid json} here")).toThrow("Failed to extract JSON");
  });

  it("extracts complex real-world agent output", () => {
    const text = `I've analyzed the codebase. Here is my plan:

\`\`\`json
{
  "stages": ["design", "implement", "test"],
  "estimated_hours": 4
}
\`\`\`

Let me know if you'd like changes.`;
    expect(extractJSON(text)).toEqual({
      stages: ["design", "implement", "test"],
      estimated_hours: 4,
    });
  });

  it("handles backslash escape sequences in balanced brace extraction", () => {
    const text = 'result: {"key": "value with \\"escaped\\" quotes", "path": "C:\\\\Users\\\\test"} done';
    const result = extractJSON(text);
    expect(result).toEqual({ key: 'value with "escaped" quotes', path: "C:\\Users\\test" });
  });

  it("skips unbalanced opening brace and continues searching", () => {
    const text = 'broken { but then {"valid": true} here';
    expect(extractJSON(text)).toEqual({ valid: true });
  });

  it("throws for a single unbalanced brace with no valid JSON", () => {
    expect(() => extractJSON("just { and nothing else")).toThrow("Failed to extract JSON");
  });

  it("extracts deeply nested JSON via balanced extraction", () => {
    const deep = { a: { b: { c: { d: { e: "deep" } } } } };
    const text = `prefix ${JSON.stringify(deep)} suffix`;
    expect(extractJSON(text)).toEqual(deep);
  });
});
