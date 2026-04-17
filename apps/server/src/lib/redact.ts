const SENSITIVE_SUFFIXES = /(?:_|^)(?:api[_-]?key|secret|token|password|credential|bearer|private[_-]?key|signing[_-]?(?:key|secret))$/i;
const SENSITIVE_EXACT = /^(?:authorization|auth|token|secret|password|bearer|apikey|api_key)$/i;
const SENSITIVE_VALUE_PATTERN = /^(?:sk-|ghp_|gho_|github_pat_|xox[bpas]-|glpat-|AKIA|eyJ)[^\s]{10,}/;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_EXACT.test(key) || SENSITIVE_SUFFIXES.test(key);
}

export function redactSensitive(obj: unknown, depth = 0): unknown {
  if (obj === null || obj === undefined) return obj;
  if (depth > 10) return "[REDACTED:depth]";
  if (typeof obj === "string") {
    return SENSITIVE_VALUE_PATTERN.test(obj) ? "[REDACTED]" : obj;
  }
  if (Array.isArray(obj)) return obj.map((v) => redactSensitive(v, depth + 1));
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = isSensitiveKey(k) ? "[REDACTED]" : redactSensitive(v, depth + 1);
    }
    return result;
  }
  return obj;
}
