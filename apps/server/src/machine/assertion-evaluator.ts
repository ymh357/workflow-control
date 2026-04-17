import { Parser } from "expr-eval";

export interface AssertionResult {
  key: string;
  assertion: string;
  passed: boolean;
}

const parser = new Parser();

/**
 * Sanitize a value for safe use in expr-eval expressions.
 * Strips functions, preserves primitives, arrays, and plain objects.
 */
function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "function") return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeValue(v);
      if (sanitized !== undefined) safe[k] = sanitized;
    }
    return safe;
  }
  return undefined;
}

/**
 * Evaluate declarative assertions against a store value.
 * Uses expr-eval Parser for safe sandboxed expression evaluation —
 * no access to globals, process, require, etc.
 * Returns an array of failed assertions (empty = all passed).
 */
export function evaluateAssertions(
  key: string,
  value: unknown,
  assertions: string[],
): AssertionResult[] {
  if (!assertions || assertions.length === 0) return [];

  const failures: AssertionResult[] = [];
  const safeValue = sanitizeValue(value);

  for (const assertion of assertions) {
    let passed = false;
    try {
      const expr = parser.parse(assertion);
      passed = !!expr.evaluate({
        value: safeValue,
        keys: (obj: unknown) => (typeof obj === "object" && obj !== null ? Object.keys(obj) : []),
        len: (obj: unknown) => (Array.isArray(obj) ? obj.length : typeof obj === "string" ? obj.length : 0),
        includes: (haystack: unknown, needle: unknown) => {
          if (typeof haystack === "string") return haystack.includes(String(needle));
          if (Array.isArray(haystack)) return haystack.includes(needle);
          return false;
        },
        not: (v: unknown) => !v,
      } as Record<string, any>);
    } catch {
      passed = false;
    }
    if (!passed) {
      failures.push({ key, assertion, passed: false });
    }
  }

  return failures;
}

/**
 * Format assertion failures into a human-readable feedback string for retry.
 */
export function formatAssertionFeedback(failures: AssertionResult[]): string {
  const lines = failures.map(
    (f) => `- Key "${f.key}": assertion FAILED: \`${f.assertion}\``,
  );
  return (
    "Your output did not pass the following quality assertions:\n" +
    lines.join("\n") +
    "\n\nFix these issues and output the corrected JSON."
  );
}
