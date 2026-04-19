# kernel-next Phase 2 P1 Findings

**Date**: 2026-04-19
**Scope**: Replace mock-executor with real Claude Agent SDK; measure schema
compliance on the canonical diamond pipeline (A → {B, C} → D).
**Model**: `claude-haiku-4-5` (via local Claude CLI auth, ~/.claude)
**Pipeline**: `generator-mock.diamondIR()` — 4 stages, 4 wires, fan-out/fan-in.
**Budget**: hard ceiling `maxBudgetUsd=0.2` per stage; measured total <$2
across all experiments.

## TL;DR

- **json_schema path** (agent returns a final JSON object): naive appearance
  of 100% compliance was observation failure. After adding semantic checks,
  true compliance was **60% ± 20%** on Haiku. Retrying up to 2× did not
  increase compliance — same 60%, at 2.3× cost. The failure mode was
  **systematic**: Haiku packaged the whole output envelope into a string
  field (`final = '{"final":"..."}'`), not random noise, so resampling
  reproduced the bug.

- **tool-call path** (agent calls `mcp__kernel_next__write_port` once per
  declared output port, no outputFormat): **10/10 compliance, 0 retries,
  30% faster** than the json_schema path. Every `D.final` value was a
  clean plain string. This is the recommended output contract for
  kernel-next going forward.

- Root cause insight: `outputFormat: json_schema` puts two cognitively
  separable tasks on the model — *produce the port value* and *wrap it in
  the declared envelope*. Haiku routinely conflated them. MCP tool calls
  move the envelope out of the model's job description entirely; the SDK
  owns the tool-call structure, the model only provides the `value`
  argument.

## Experiment matrix

All 10-run stress tests, Haiku 4.5, identical diamond pipeline. Compliance
= `finalState === "completed" ∧ D.final is a clean string`.

| Version | Output path                              | Retries | Compliant | First-try pass | Mean duration | Total attempts |
| ------- | ---------------------------------------- | ------- | --------- | -------------- | ------------- | -------------- |
| v1      | json_schema, no semantic guard           | 0       | 10/10 *   | 10/10 *        | 54 s          | 40             |
| v2      | json_schema, + nested-JSON guard         | 0       | 4/10      | 4/10           | 53 s          | 40             |
| v3      | json_schema, stronger prompt + guard     | 0       | 6/10      | 6/10           | 55 s          | 40             |
| v5      | v3 + `maxRetries=2` (silent retry)       | 2       | 6/10      | 2/10 †         | 72 s          | 53             |
| **v6**  | **tool-only: forced `write_port` calls** | **0**   | **10/10** | **10/10**      | **39 s**      | **40**         |

\* v1 was observation failure: the nested-JSON packaging bug existed but
was invisible without a semantic check (see §"Finding #1").

† v5's low first-try pass rate is noise from small n=10; what the retry
path actually delivers is a 4-out-of-6 save rate on first-try failures,
adding up to the same 60% final compliance as v3 no-retry.

## Finding #1 — `outputFormat: json_schema` alone is not a schema contract

On string-typed ports, Haiku consistently did one of two things:

1. **Envelope-swallowing**: `D.final = '{"final":"b:B saw 42 | c:C saw 42"}'`.
   The agent's final JSON had the correct top-level key `final` as required
   by the schema, but its value was the *entire intended output object*
   re-encoded as a string.

2. **Upstream bleed-through**: in one run, `C.z = '{"z":"C saw 42"}'`. The
   same bug one stage up, then propagated through D without further
   corruption — so D saw `c = '{"z":"C saw 42"}'` and faithfully concatenated
   it, producing `final = '... | c:{"z":"C saw 42"}'`.

The JSON-schema validator on the SDK side only checks the outer object
shape (`{ "final": <string> }`). A string-that-looks-like-JSON *is* a
string, so validation passes. Only a semantic check
(`detectNestedJson`: value trims to `{...}`/`[...]` and re-parses as an
object/array ⇒ reject) catches this.

**Implication**: if a real pipeline ever relies on
`outputFormat: json_schema` as its compliance contract without a semantic
post-check, its observed "compliance rate" is a lie. The nested-JSON bug
silently corrupts downstream ports.

## Finding #2 — Retrying systematic model errors doesn't help

v5 enabled `maxRetries=2` (so up to 3 attempts per stage). Silent failure
mechanism: intermediate-attempt DB rows stay `status='error'` but do NOT
dispatch `STAGE_FAILED`; the machine remains in `executing` and the
executor issues a fresh `startAttempt` with bumped `attempt_idx`.

Outcomes across the 10 runs:

- 2 runs: D succeeded on first try (D:1).
- 4 runs: D failed first, succeeded on retry (D:2 or D:3). **Retry earned these.**
- 4 runs: D failed **all three** attempts with the identical
  "nested JSON" error. Haiku's bias is stable across independent samples
  for the same prompt.

Net: same 60% compliance as v3 no-retry, but at 2.3× attempt cost and 31%
longer mean duration. Retry is worth doing for random sampling noise;
it cannot fix a model's systematic understanding gap.

Retry as an infra feature still matters (transient API errors, budget
retries, non-model failures), but default `maxRetries=0` is correct for
the happy path.

## Finding #3 — Tool-call output inverts the contract

v6 rewired the output path:

- No `outputFormat` sent to `query()`.
- System prompt forbids returning output in text. `write_port` is the
  only legitimate sink. One call per declared output port. Per-port
  examples are inlined, grounded in the actual `(taskId, attemptId,
  stage, port)` tuple for this attempt.
- `write_port` MCP tool accepts a live `writePortDispatcher` so tool
  calls fire `PORT_WRITTEN` directly into the XState runner — no
  executor-side transcription step.
- Executor validates by querying `port_values` for this attempt:
  every declared output port must have a row.

Result: **10/10 clean runs, 0 retries needed.** The nested-JSON bug
disappears because Haiku no longer has to construct the outer envelope
— the MCP wire format does that. The model is only responsible for the
`value` argument.

Bonus effects:
- 30% faster (39 s vs 55 s). No "generate final JSON object" token cost.
- Lineage is natively correct: `port_values.attempt_id` equals the
  attemptId the agent passed, not an executor-synthesized one.
- Every output event is an observable tool call, not an invisible
  transcription step.

## Architectural consequence

kernel-next's "Typed Port + Wires" contract pairs naturally with
**tool-based output, not return-value output**. The runtime treats
agents as actors emitting events (writePort), not as functions returning
JSON objects. This matches the agentic programming model the SDK is
built on and sidesteps a whole class of structured-output failures.

The `outputFormat: json_schema` option is still useful for *declarative
shape guarantee* — but not sufficient as a contract when port values
are strings (because a string "envelope" can smuggle more structure).

### Recommended default for kernel-next

- **RealStageExecutor output path**: tool-call only. `write_port` is
  the single sink. `outputFormat` is not set.
- **Semantic guard retained**: `detectNestedJson` still runs on every
  string-typed port write, as a defense for pipelines that evolve or
  for models that misbehave in new ways.
- **Retry default**: `maxRetries=0`. Opt-in per-executor for flows where
  transient failures are expected.
- **MCP tool `write_port`**: accepts an optional `writePortDispatcher`;
  live-runner callers pass the machine-bound dispatcher, external
  authoring callers get the inert default.

## What changed (this session)

Files modified in `apps/server/src/kernel-next/`:

- `runtime/real-executor.ts` — main rewrite. Factory signature takes a
  `dispatcher`, removed `outputFormat`, system prompt rewritten for
  mandatory tool calls with grounded examples, compliance validation
  reads `port_values` for the attempt instead of parsing a final JSON
  string. `maxRetries` option with silent-fail retry loop.
- `runtime/port-runtime.ts` — added `getDispatcher()` and
  `readWritesForAttempt()`. `finishAttempt` now takes
  `{ silent?: boolean }` to support retry loops without prematurely
  failing the machine.
- `runtime/runner.ts` — `RunnerOptions.executor?` injection, default
  falls back to `new MockStageExecutor({ handlers })`. `RunResult.stageErrors`
  collects per-stage executor failures (distinct from drain errors).
  Final-state judgment fixed to consider only the *latest* attempt per
  stage, not any historical error row (pre-retry bug that misjudged
  retried-to-success runs as failed).
- `runtime/mock-executor.ts` — added `MockStageExecutor` class wrapper
  around the existing function; class and function coexist for test
  backward-compat.
- `runtime/executor.ts` — new file, shared `StageExecutor` interface and
  related types.
- `mcp/server.ts` — added 7th tool `write_port` (attempt-scoped,
  validates against IR's declared outputs); `KernelMcpOptions` gains
  optional `writePortDispatcher` for live-runner integration.
- `mcp/server.test.ts` — updated "6 tools" assertion to 7.
- `generator-mock/mini-generator.ts` — diamond prompts rewritten to
  remove JSON-envelope templates and forbid nested-JSON values.
- `demo/diamond-real.ts` — new file: stress harness + `runOnce`
  function, CLI `--runs --retries --model --out`, falls back to CLI
  auth when `ANTHROPIC_API_KEY` is missing.
- `demo/diamond-real.test.ts` — new file: single smoke test that
  `skipIf(!RUN_REAL_SDK || !ANTHROPIC_API_KEY)`.

## Report artifacts

- `/tmp/kernel-next-stress-v3.json` — 10-run, json_schema, no retry
- `/tmp/kernel-next-stress-v5.json` — 10-run, json_schema + retry=2
- `/tmp/kernel-next-stress-v6.json` — 10-run, tool-call only (final design)
- `/tmp/kernel-next-tool-smoke.json` — 1-run smoke before v6

## Leftovers for future sessions

- **Semantic guard stress-test in tool-call mode**: v6's 10/10 didn't
  trigger `detectNestedJson`. Need an adversarial pipeline (e.g. a stage
  that asks for a string summary of JSON content) to verify the guard
  doesn't false-positive when the model legitimately embeds JSON in prose.
- **Sonnet / Opus baseline**: v6 passed with Haiku. A Sonnet baseline
  would confirm the tool-call design is robust across the model tier
  (expected: even higher compliance, irrelevant differences in duration).
- **Retry policy semantics**: the current silent-retry only respects a
  count. Real systems want *error-class-based* retry policies (retry
  transient/schema; don't retry fatal/auth/budget).
- **`mock-executor.ts`'s top-level `executeStage` function** is kept
  around for test compat but the retry loop lives only in
  RealStageExecutor. Mock path does not support retries — fine for
  current tests, something to unify later if retry becomes a
  cross-cutting concern.
