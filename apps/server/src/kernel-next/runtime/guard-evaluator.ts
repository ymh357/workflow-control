// Wire guard expression evaluator (design doc §6.2).
//
// A wire guard is a user-authored expression evaluated at runtime against
// the source port's value. The design example:
//
//   wire: { from: { stage: 'analysis', port: 'result' },
//           to:   { stage: 'deep_dive', port: 'input' },
//           guard: 'value.complexity > 8' }
//
// Semantics:
//   - `value` is the only bound variable; it is the source port's value.
//   - Expressions evaluate in a plain Function scope — no `this`, no
//     access to the enclosing module (aside from globalThis, which the
//     AI author is trusted not to abuse; this is a single-user local
//     engine, not a sandbox for hostile code).
//   - Truthiness is JavaScript-standard: `0`, `""`, `null`, `undefined`,
//     `false`, `NaN` are false; everything else is true.
//   - Any exception during evaluation is treated as false, and the
//     diagnostic is captured via the optional `onError` hook. The wire
//     still "does not deliver" — it's equivalent to a false guard.
//
// Tradeoff: `new Function()` executes arbitrary JS. This project is
// single-user local (CLAUDE.md) and the AI is the pipeline author;
// treating guards as untrusted user input would demand a DSL, which
// was rejected in the interview for being over-engineered (see answer
// options in A3 scoping). The doc-level contract is that guards are
// simple boolean expressions on the port value.

export interface GuardEvalContext {
  wireFrom: { stage: string; port: string };
  wireTo: { stage: string; port: string };
}

export interface GuardEvalOptions {
  onError?: (err: unknown, ctx: GuardEvalContext) => void;
}

// F8 / Reviewer concern C6 — guard expressions flow through
// `submit_pipeline` from external MCP callers and ultimately run in
// `new Function()`. Single-user local engine makes a full sandbox
// overkill (CLAUDE.md), but the cost of a deny-list regex is almost
// zero and catches the obvious escape hatches so that a malformed
// IR (AI hallucination, copy-paste from a tutorial) doesn't escalate
// to code execution beyond port-value inspection.
//
// Matched as a word-boundary regex against the raw expression. If the
// AI genuinely wants `value.processingTime > 100`, that still works —
// `process` by itself would have to be a standalone identifier or
// property access to trip the deny-list. Legitimate guards are simple
// boolean predicates on `value`; none of these tokens belong in one.
const DENIED_IDENTIFIERS = [
  "require",
  "import",
  "process",
  "globalThis",
  "global",
  "eval",
  "Function",
  // Prototype-chain escape hatches — also denied when reached via
  // property access (e.g. value.constructor.prototype). Bare
  // identifiers `constructor` / `__proto__` as port field names are
  // unusual but technically possible; authors should rename those
  // fields rather than work around the deny-list.
  "constructor",
  "prototype",
  "__proto__",
];
// Word-boundary match anywhere — applies to both standalone identifiers
// (`require(...)`) AND property access (`value.constructor`). A port
// whose field name literally IS one of these tokens would be rejected;
// that trade-off is acceptable given the names are reserved by the JS
// runtime and collide with attack vectors.
const DENY_PATTERN = new RegExp(`\\b(${DENIED_IDENTIFIERS.join("|")})\\b`);

export class GuardDeniedError extends Error {
  constructor(public readonly token: string, public readonly expr: string) {
    super(`guard expression contains denied identifier '${token}': ${expr}`);
    this.name = "GuardDeniedError";
  }
}

/**
 * Evaluate a wire guard expression against a port value.
 *
 * Returns true on a truthy result, false otherwise (including on any
 * evaluation exception). Caller decides what "false" means — usually:
 * the wire does not deliver.
 *
 * Expressions containing any of DENIED_IDENTIFIERS as a standalone
 * token are rejected BEFORE compilation; onError is invoked with a
 * GuardDeniedError so NO_ACTIVE_WIRE diagnostics can classify the
 * failure as policy-driven rather than as a runtime exception.
 */
export function evaluateGuard(
  expr: string,
  value: unknown,
  ctx: GuardEvalContext,
  options: GuardEvalOptions = {},
): boolean {
  const denied = DENY_PATTERN.exec(expr);
  if (denied) {
    options.onError?.(new GuardDeniedError(denied[1]!, expr), ctx);
    return false;
  }
  try {
    // `new Function('value', 'return (...)')` compiles once per call;
    // acceptable for the sub-1000 wires/run regime. If hot-path arises,
    // cache compiled fns by expression string — not doing that now to
    // keep the eval engine stateless.
    const fn = new Function("value", `return (${expr});`) as (v: unknown) => unknown;
    const result = fn(value);
    return Boolean(result);
  } catch (err) {
    options.onError?.(err, ctx);
    return false;
  }
}
