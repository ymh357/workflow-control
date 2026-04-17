const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|secret|token|password|credential|auth|bearer|private[_-]?key|signing)/i;
const SENSITIVE_VALUE_PATTERN = /(?:^(?:sk-|ghp_|gho_|github_pat_|xox[bpas]-|glpat-|AKIA|eyJ)[^\s]{10,})/;

export function redactSensitive(obj: unknown, depth = 0): unknown {
  if (depth > 5 || obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    return SENSITIVE_VALUE_PATTERN.test(obj) ? "[REDACTED]" : obj;
  }
  if (Array.isArray(obj)) return obj.map((v) => redactSensitive(v, depth + 1));
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = SENSITIVE_KEY_PATTERN.test(k) ? "[REDACTED]" : redactSensitive(v, depth + 1);
    }
    return result;
  }
  return obj;
}
