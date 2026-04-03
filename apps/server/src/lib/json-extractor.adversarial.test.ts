import { describe, it, expect, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { extractJSON } from "./json-extractor.js";

describe("extractJSON adversarial", () => {
  // --- Case 1: Nested JSON with same keys ---
  it("extracts nested JSON where parent and child share the same key name", () => {
    const result = extractJSON('{"a": {"a": 1}}');
    expect(result).toEqual({ a: { a: 1 } });
  });

  // --- Case 2: Trailing comma (common LLM output) ---
  it("handles JSON with trailing comma in object", () => {
    // Many LLMs produce trailing commas. JSON.parse rejects them.
    // Does extractJSON have any fallback for this?
    const text = '{"a": 1, "b": 2,}';
    const result = extractJSON(text);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("handles JSON with trailing comma inside code block", () => {
    const text = '```json\n{"a": 1, "b": 2,}\n```';
    const result = extractJSON(text);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  // --- Case 3: Multiple JSON objects, determinism ---
  it("returns a valid JSON when multiple equal-size objects exist in text", () => {
    const text = 'Here is {"a":1} and also {"b":2}';
    const result = extractJSON(text);
    // Both are valid and same length — either is acceptable
    const isA = JSON.stringify(result) === JSON.stringify({ a: 1 });
    const isB = JSON.stringify(result) === JSON.stringify({ b: 2 });
    expect(isA || isB).toBe(true);
  });

  it("prefers the larger JSON object when sizes differ", () => {
    const text = 'Small: {"x":1} Big: {"a":1,"b":2,"c":3}';
    const result = extractJSON(text);
    expect(result).toEqual({ a: 1, b: 2, c: 3 });
  });

  // --- Case 4: JSON inside markdown code block ---
  it("extracts JSON from markdown code block with json tag", () => {
    const text = "Here:\n```json\n{\"a\":1}\n```\nDone.";
    const result = extractJSON(text);
    expect(result).toEqual({ a: 1 });
  });

  // --- Case 5: Deeply nested braces inside string values ---
  it("handles deeply nested braces inside string values without confusion", () => {
    const text = 'output: {"a": "{{{}}}"}';
    const result = extractJSON(text);
    expect(result).toEqual({ a: "{{{}}}" });
  });

  // --- Case 6: Unicode in keys and values ---
  it("handles unicode in keys and values", () => {
    const result = extractJSON('{"名前": "テスト"}');
    expect(result).toEqual({ "名前": "テスト" });
  });

  // --- Case 7: JSON with literal newlines inside strings ---
  it("handles JSON with escaped newlines inside string values", () => {
    const text = '{"a": "line1\\nline2"}';
    const result = extractJSON(text);
    expect(result).toEqual({ a: "line1\nline2" });
  });

  // --- Case 8: Empty JSON object ---
  it("returns empty object for {}", () => {
    const result = extractJSON("{}");
    expect(result).toEqual({});
  });

  it("extracts empty object from surrounding text", () => {
    const result = extractJSON("the result is {} done");
    expect(result).toEqual({});
  });

  // --- Case 9: Top-level JSON array ---
  it("handles top-level JSON array as direct input", () => {
    const result = extractJSON("[1, 2, 3]");
    expect(result).toEqual([1, 2, 3]);
  });

  it("extracts top-level JSON array embedded in text", () => {
    // findAllBalancedJSON only searches for '{', not '['
    // This should fail if there's no array extraction fallback
    const text = "Here is the list: [1, 2, 3] end";
    const result = extractJSON(text);
    expect(result).toEqual([1, 2, 3]);
  });

  it("extracts array of objects from surrounding text", () => {
    const text = 'The results are: [{"id": 1}, {"id": 2}] done';
    const result = extractJSON(text);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  // --- Case 10: Large JSON performance ---
  it("handles large JSON (100KB) without hanging", () => {
    const largeObj: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) {
      largeObj[`key_${i}`] = `value_${i}_${"x".repeat(40)}`;
    }
    const text = `prefix ${JSON.stringify(largeObj)} suffix`;
    const result = extractJSON(text);
    expect(Object.keys(result).length).toBe(2000);
  }, 5000);

  // --- Case 11: No JSON at all ---
  it("throws when input contains no JSON", () => {
    expect(() => extractJSON("just plain text with no braces")).toThrow("Failed to extract JSON");
  });

  it("throws for a bare string", () => {
    expect(() => extractJSON('"just a string"')).toThrow("Failed to extract JSON");
  });

  it("throws for a bare number", () => {
    expect(() => extractJSON("42")).toThrow("Failed to extract JSON");
  });

  it("throws for boolean", () => {
    expect(() => extractJSON("true")).toThrow("Failed to extract JSON");
  });

  it("throws for null", () => {
    expect(() => extractJSON("null")).toThrow();
  });

  // --- Case 12: JSON with comments (not supported — JSON standard) ---
  it("throws for JSON with C-style block comments", () => {
    const text = '{"a": 1 /* comment */}';
    expect(() => extractJSON(text)).toThrow();
  });

  it("throws for JSON with single-line comments", () => {
    const text = '{\n  "a": 1, // this is a\n  "b": 2\n}';
    expect(() => extractJSON(text)).toThrow();
  });

  // --- Case 13: Escaped unicode sequences ---
  it("handles escaped unicode sequences", () => {
    const result = extractJSON('{"a": "\\u0041"}');
    expect(result).toEqual({ a: "A" });
  });

  // --- Case 14: BOM and zero-width characters ---
  it("handles JSON preceded by UTF-8 BOM", () => {
    const bom = "\uFEFF";
    const text = bom + '{"a": 1}';
    const result = extractJSON(text);
    expect(result).toEqual({ a: 1 });
  });

  it("handles JSON with zero-width spaces mixed in", () => {
    // Zero-width space (U+200B) before JSON
    const text = "\u200B" + '{"a": 1}';
    const result = extractJSON(text);
    expect(result).toEqual({ a: 1 });
  });

  // --- Case 15: Truncated JSON ---
  it("throws for truncated JSON object", () => {
    expect(() => extractJSON('{"a": 1, "b":')).toThrow("Failed to extract JSON");
  });

  it("extracts inner object from truncated JSON with unclosed brace", () => {
    // '{"a": {"b": 1}' is missing outer closing brace, but inner {"b": 1} is valid
    // The balanced brace finder extracts the inner object
    const result = extractJSON('{"a": {"b": 1}');
    expect(result).toEqual({ b: 1 });
  });

  // --- Additional adversarial cases ---

  it("throws for single-quoted strings (not supported)", () => {
    const text = "{'a': 1, 'b': 2}";
    expect(() => extractJSON(text)).toThrow();
  });

  it("throws for unquoted keys (not supported)", () => {
    const text = "{a: 1, b: 2}";
    expect(() => extractJSON(text)).toThrow();
  });

  it("handles JSON with a trailing newline in code block", () => {
    const text = "```json\n{\"a\": 1}\n\n```";
    const result = extractJSON(text);
    expect(result).toEqual({ a: 1 });
  });

  it("extracts JSON from code block with language tag 'JSON' (uppercase)", () => {
    const text = "```JSON\n{\"a\": 1}\n```";
    const result = extractJSON(text);
    expect(result).toEqual({ a: 1 });
  });

  it("handles JSON where a string value contains a code fence", () => {
    // String value contains backticks that look like code fences
    const obj = { code: "use ```json``` for formatting" };
    const text = JSON.stringify(obj);
    const result = extractJSON(text);
    expect(result).toEqual(obj);
  });

  it("handles backslash at the end of a string value (not an escape)", () => {
    // This tests the brace-counting escape logic
    const text = '{"path": "C:\\\\"}';
    const result = extractJSON(text);
    expect(result).toEqual({ path: "C:\\" });
  });

  it("extracts array from markdown code block", () => {
    const text = "```json\n[1, 2, 3]\n```";
    const result = extractJSON(text);
    expect(result).toEqual([1, 2, 3]);
  });

  it("handles JSON with extra whitespace everywhere", () => {
    const text = '  {  "a"  :  1  ,  "b"  :  2  }  ';
    const result = extractJSON(text);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("handles string containing backslash-quote near closing brace", () => {
    // Tricky: the \" before } might confuse brace counting
    const text = 'output: {"msg": "say \\"hi\\""}';
    const result = extractJSON(text);
    expect(result).toEqual({ msg: 'say "hi"' });
  });

  it("returns null from extractJSON when input is JSON null", () => {
    // JSON.parse("null") returns null, which is not an object
    // The function checks typeof parsed === "object" && parsed !== null
    // So null should be rejected and throw
    expect(() => extractJSON("null")).toThrow("Failed to extract JSON");
  });

  it("handles JSON with extremely deep nesting (50 levels)", () => {
    let json = '{"a":';
    for (let i = 0; i < 49; i++) json += '{"a":';
    json += '"deep"';
    for (let i = 0; i < 50; i++) json += '}';
    const text = `prefix ${json} suffix`;
    const result = extractJSON(text);
    // Just verify it doesn't crash and returns an object
    expect(typeof result).toBe("object");
  });

  it("handles JSON where the closing brace appears inside a string before the real end", () => {
    // The brace counter should not be fooled by } inside strings
    const text = 'text {"key": "a}b", "other": 1} end';
    const result = extractJSON(text);
    expect(result).toEqual({ key: "a}b", other: 1 });
  });

  it("handles markdown with multiple code block types and picks JSON one", () => {
    const text = "```python\nprint('hello')\n```\n\n```json\n{\"result\": true}\n```";
    const result = extractJSON(text);
    expect(result).toEqual({ result: true });
  });

  it("truncated JSON inside code block should fall through to next strategy", () => {
    // Code block has truncated JSON, but there's valid JSON in the text
    const text = '```json\n{"a": 1, "b":\n```\nAnyway, the answer is {"c": 3}';
    const result = extractJSON(text);
    expect(result).toEqual({ c: 3 });
  });
});
