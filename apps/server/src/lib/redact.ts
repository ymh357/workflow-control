const SENSITIVE_SUFFIXES = /(?:_|^)(?:api[_-]?key|secret|token|password|credential|bearer|private[_-]?key|signing[_-]?(?:key|secret))$/i;
const SENSITIVE_EXACT = /^(?:authorization|auth|token|secret|password|bearer|apikey|api_key|client_secret_id|client_secret|webhook_url|aws_session_token|aws_secret_access_key)$/i;
// B6.#24 (2026-04-30 review): expanded value-pattern catalogue — the
// pre-fix regex only caught OpenAI / GitHub / Slack / GitLab / AWS
// access-key prefixes. Added Stripe live/test keys, Google API keys,
// Azure SAS, Twilio auth tokens, generic OAuth bearer tokens (long
// hex / base64), JWT access tokens (eyJ already covered), Anthropic
// API keys (sk-ant-).
const SENSITIVE_VALUE_PATTERN = /^(?:sk-|sk-ant-|ghp_|gho_|ghs_|ghu_|github_pat_|xox[bpas]-|glpat-|AKIA|ASIA|eyJ|AIza|sk_live_|sk_test_|pk_live_|pk_test_|rk_live_|rk_test_|whsec_|SK[A-Za-z0-9]{32}|AC[A-Za-z0-9]{32})[^\s]{10,}/;

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

// B6.#23 (2026-04-30 review): the json-extractor and similar parsers
// log a "preview" of the failing input on parse error. Raw agent
// output may contain provider tokens (Anthropic API keys, GitHub
// PATs from a tool-call response, etc.). redactStringPreview scans
// the buffer for known token shapes and replaces them inline,
// preserving non-sensitive context for debugging.
//
// This is best-effort — it does not catch every possible secret, but
// covers the common families captured by SENSITIVE_VALUE_PATTERN
// expressed as in-text matches rather than full-string matches.
const SENSITIVE_TOKEN_INTEXT = new RegExp(
  "(?:" +
    "sk-ant-[A-Za-z0-9_-]{20,}" + // Anthropic
    "|sk-[A-Za-z0-9]{20,}" + // OpenAI
    "|gh[opsu]_[A-Za-z0-9]{20,}" + // GitHub classic / OAuth / server / user
    "|github_pat_[A-Za-z0-9_]{20,}" + // GitHub fine-grained
    "|xox[bpas]-[A-Za-z0-9-]{20,}" + // Slack
    "|glpat-[A-Za-z0-9_-]{20,}" + // GitLab
    "|AKIA[A-Z0-9]{16}" + // AWS access key
    "|ASIA[A-Z0-9]{16}" + // AWS session
    "|eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}" + // JWT
    "|AIza[A-Za-z0-9_-]{30,}" + // Google API
    "|sk_live_[A-Za-z0-9]{20,}|sk_test_[A-Za-z0-9]{20,}" + // Stripe secret
    "|pk_live_[A-Za-z0-9]{20,}|pk_test_[A-Za-z0-9]{20,}" + // Stripe publishable
    "|rk_live_[A-Za-z0-9]{20,}|rk_test_[A-Za-z0-9]{20,}" + // Stripe restricted
    "|whsec_[A-Za-z0-9]{20,}" + // Stripe webhook
    "|SK[A-Za-z0-9]{32}|AC[A-Za-z0-9]{32}" + // Twilio
  ")",
  "g",
);

export function redactStringPreview(text: string): string {
  return text.replace(SENSITIVE_TOKEN_INTEXT, "[REDACTED]");
}
