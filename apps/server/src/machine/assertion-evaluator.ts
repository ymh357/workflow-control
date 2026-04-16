export interface AssertionResult {
  key: string;
  assertion: string;
  passed: boolean;
}

/**
 * Evaluate declarative assertions against a store value.
 * Uses Function constructor (not eval) with a sandboxed scope containing only `value` and `Object`.
 * Returns an array of failed assertions (empty = all passed).
 */
export function evaluateAssertions(
  key: string,
  value: unknown,
  assertions: string[],
): AssertionResult[] {
  if (!assertions || assertions.length === 0) return [];

  const failures: AssertionResult[] = [];

  for (const assertion of assertions) {
    let passed = false;
    try {
      // Sandbox: only expose `value` and `Object` to the expression
      const fn = new Function("value", "Object", `"use strict"; return !!(${assertion});`);
      passed = fn(value, Object);
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
