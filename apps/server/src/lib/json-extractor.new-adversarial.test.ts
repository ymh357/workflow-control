import { describe, it, expect, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { extractJSON } from "./json-extractor.js";

describe("extractJSON — stripTrailingCommas bug and additional edge cases", () => {
  // ========================================================================
  // BUG: stripTrailingCommas corrupts string values containing ,} or ,]
  // The regex /,\s*([\]}])/g does not respect JSON string boundaries.
  // It only fires when the first JSON.parse fails (i.e., actual trailing commas exist).
  // ========================================================================

  describe("stripTrailingCommas string corruption bug", () => {
    it("corrupts string value containing ',}' when trailing comma is present", () => {
      // Input has a trailing comma (invalid JSON) AND a string containing ",}"
      // stripTrailingCommas will turn "a,}" into "a}" inside the string
      const input = '{"msg": "a,}", "x": 1,}';
      const result = extractJSON(input);
      // BUG: the comma in "a,}" gets stripped, resulting in { msg: "a}", x: 1 }
      // Correct behavior would preserve "a,}" in the string value
      expect(result).toHaveProperty("x", 1);
      // After fix: string-aware stripTrailingCommas preserves commas inside strings
      expect((result as Record<string, unknown>).msg).toBe("a,}");
    });

    it("preserves string value containing ',]' when trailing comma is present", () => {
      const input = '{"data": "items: [a,]", "extra": true,}';
      const result = extractJSON(input);
      expect(result).toHaveProperty("extra", true);
      // After fix: comma inside string is preserved
      expect((result as Record<string, unknown>).data).toBe("items: [a,]");
    });

    it("correctly strips trailing comma when no problematic strings exist", () => {
      // No string values contain ,} or ,] — should work fine
      const input = '{"a": 1, "b": 2,}';
      const result = extractJSON(input);
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it("does NOT corrupt valid JSON with ',}' in string (first parse succeeds)", () => {
      // Valid JSON — no trailing comma, so JSON.parse succeeds on first try
      // stripTrailingCommas is never called
      const input = '{"msg": "a,}"}';
      const result = extractJSON(input);
      expect(result).toEqual({ msg: "a,}" });
    });

    it("does NOT corrupt valid JSON with ',]' in string (first parse succeeds)", () => {
      const input = '{"arr": "x,]"}';
      const result = extractJSON(input);
      expect(result).toEqual({ arr: "x,]" });
    });

    it("preserves multiple string values each containing ',}' when trailing comma exists", () => {
      const input = '{"a": "x,}", "b": "y,}", "c": 1,}';
      const result = extractJSON(input);
      // After fix: commas inside strings preserved
      expect((result as Record<string, unknown>).a).toBe("x,}");
      expect((result as Record<string, unknown>).b).toBe("y,}");
      expect((result as Record<string, unknown>).c).toBe(1);
    });

    it("preserves string with ',}' in code block with trailing comma", () => {
      const input = '```json\n{"msg": "a,}", "x": 1,}\n```';
      const result = extractJSON(input);
      // After fix: string-aware stripping preserves comma inside string
      expect((result as Record<string, unknown>).msg).toBe("a,}");
    });
  });

  // ========================================================================
  // findAllBalanced with [ / ] (array extraction)
  // ========================================================================

  describe("findAllBalanced with arrays", () => {
    it("extracts nested arrays", () => {
      const text = "result: [[1,2],[3,4]] end";
      const result = extractJSON(text);
      expect(result).toEqual([[1, 2], [3, 4]]);
    });

    it("extracts array containing objects", () => {
      const text = 'data: [{"a":1},{"b":2}] done';
      const result = extractJSON(text);
      expect(result).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it("extracts array from text that also contains unmatched { chars", () => {
      // The { before "not json" is not balanced, but the array is
      const text = "some text { broken [1, 2, 3] end";
      const result = extractJSON(text);
      expect(result).toEqual([1, 2, 3]);
    });

    it("handles ] inside strings during balanced [ extraction", () => {
      const text = 'list: [{"name": "a]b"}, {"name": "c"}] end';
      const result = extractJSON(text);
      expect(result).toEqual([{ name: "a]b" }, { name: "c" }]);
    });
  });

  // ========================================================================
  // Additional edge cases not covered by existing tests
  // ========================================================================

  describe("edge cases", () => {
    it("handles very large string (1MB) without hanging", () => {
      // Build a ~1MB JSON string
      const bigValue = "x".repeat(1_000_000);
      const json = JSON.stringify({ big: bigValue });
      const text = `prefix ${json} suffix`;
      const result = extractJSON(text);
      expect((result as Record<string, unknown>).big).toBe(bigValue);
    }, 10_000);

    it("throws for code block with only whitespace", () => {
      const text = "```json\n   \n```";
      expect(() => extractJSON(text)).toThrow("Failed to extract JSON");
    });

    it("extracts valid JSON from middle code block when first and last are invalid", () => {
      const text = [
        "```json\nnot valid\n```",
        "```json\n{\"middle\": true}\n```",
        "```json\nalso broken\n```",
      ].join("\n\n");
      // extractJSON iterates code blocks from last to first, so it tries
      // the last (broken), then middle (valid), and returns it
      const result = extractJSON(text);
      expect(result).toEqual({ middle: true });
    });

    it("throws for text with [ but no matching ]", () => {
      expect(() => extractJSON("open bracket [ but never closed")).toThrow(
        "Failed to extract JSON",
      );
    });

    it("throws for text with { but no matching }", () => {
      expect(() => extractJSON("open brace { but never closed")).toThrow(
        "Failed to extract JSON",
      );
    });

    it("handles trailing comma in nested array", () => {
      const input = '{"arr": [1, 2, 3,],}';
      const result = extractJSON(input);
      expect(result).toEqual({ arr: [1, 2, 3] });
    });

    it("handles trailing comma in nested object", () => {
      const input = '{"outer": {"inner": 1,},}';
      const result = extractJSON(input);
      expect(result).toEqual({ outer: { inner: 1 } });
    });
  });
});
