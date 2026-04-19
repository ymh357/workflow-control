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

/**
 * Evaluate a wire guard expression against a port value.
 *
 * Returns true on a truthy result, false otherwise (including on any
 * evaluation exception). Caller decides what "false" means — usually:
 * the wire does not deliver.
 */
export function evaluateGuard(
  expr: string,
  value: unknown,
  ctx: GuardEvalContext,
  options: GuardEvalOptions = {},
): boolean {
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
