# Stage 4a — Retire Legacy Engine — Completion Handoff

Date: 2026-04-24
Branch: main

## Milestone results

Executed as four commits (plan's 9 batches collapsed — the dependency graph showed machine/agent/edge/actions are fully entangled, so batches A-F were replaced by one atomic commit):

| Step | SHA | Subject |
|---|---|---|
| Atomic (batches A, B, C, E, F) | `3638e2b` | delete machine + agent(legacy) + edge + routes + tests + integration + audit + regression + scripts + orphan lib/services/sse |
| Batch D | `6ee923f` | delete Gemini + Codex executors |
| Batch G | `4f4ee5b` | delete legacy web pages, minimal root |
| Batch H | *(this commit)* | docs update — CLAUDE.md + roadmap + design + handoff |

## Deletion summary

- Legacy XState workflow engine deleted: `apps/server/src/machine/` (~40 files)
- Legacy Claude agent stack deleted: `apps/server/src/agent/` (all modules)
- Gemini + Codex executors deleted (moved from frozen → retired)
- Edge Runner deleted: `apps/server/src/edge/` (21 files)
- Legacy routes deleted: 15 route modules + tests + middleware + actions layer
- Legacy integration / audit / regression test suites deleted
- Legacy scripts layer + dependent orphan helpers under `services/` and `lib/` deleted
- Legacy Next.js pages deleted + root replaced with minimal landing page
- Nav simplified to drop dead links

Total: 315 files deleted, ~66.5k production + test LOC.

## Not in scope (deferred)

- Converter `kernel-next/converter/` retained — Stage 4b
- Builtin YAMLs (`builtin-pipelines/{smoke-test,tech-research-collector,tech-research-writer,pipeline-generator}/`) retained
- Execution Record sidecar → Stage 6
- New kernel-next-native Web dashboard → future milestone
- Orphan `apps/web/src/lib/*.ts` utilities + `apps/web/e2e/tests/` legacy specs + `messages/*/stream.json` + `public/help/` — small web cleanup follow-up
- Config schema `apps/server/src/lib/config/*.ts` still carries `gemini_executable` / `codex_executable` fields — also needs cleaning

## Test deltas

| Phase | Tests passed | Delta |
|---|---|---|
| Baseline (pre) | 4246 | — |
| After atomic commit | 1633 | -2613 |
| After Batch D | 1586 | -47 |
| After Batch G | 1586 (server unchanged; web tsc only) | 0 |
| After Batch H (expected) | 1586 | 0 |

Drop of -2660 tests reflects deletion of ~200+ legacy test files alongside their targets.

## Invariants preserved

- `server tsc --noEmit` → 0 errors at every batch
- `server vitest run` → 0 failures at every batch
- `web tsc --noEmit` → 0 errors after Batch G
- kernel-next test suite counts unchanged (kernel-next/* tests untouched)

## Key commits (for git archaeology)

- `0951ab4` — pre-milestone HEAD (baseline snapshot)
- `3638e2b` — atomic legacy deletion
- `6ee923f` — Gemini + Codex
- `4f4ee5b` — legacy web pages
- *(this commit)* — docs update + this handoff

## Follow-ups

- **Stage 4b**: migrate builtin YAMLs to native IR + delete converter
- **Stage 6**: Execution Record sidecar into kernel-next
- **Web cleanup (minor)**: prune `apps/web/src/lib/`, `apps/web/e2e/tests/`, config schema stale fields
- **Future**: kernel-next-native Web dashboard
