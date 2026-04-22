# Stage 4b — Retire Converter — Completion Handoff

Date: 2026-04-24
Branch: main

## Milestone results

Four sequential commits:

| Task | SHA | Subject |
|---|---|---|
| 1 | `713fbb0` | generate pipeline.ir.json for 4 builtins (converter still present) |
| 2 | `bde1374` | swap loader to JSON, delete YAML files |
| 3 | `09162bb` | delete converter + YAML tests, move topo-downstream |
| 4 | `a99b534` | cleanup: delete web3-research-writer + docs |

## Deletions

- `apps/server/src/kernel-next/converter/` (~2.2k LOC + 20 test files)
- 4x `apps/server/src/builtin-pipelines/<name>/pipeline.yaml`
- `apps/server/src/kernel-next/runtime/load-legacy-pipeline.ts` + test
- `apps/server/src/kernel-next/runtime/pg-inspect.test.ts`
- `apps/server/src/kernel-next/runtime/pipeline-generator-run.test.ts`
- `apps/server/src/builtin-pipelines/web3-research-writer/`
- `apps/server/src/lib/builtin-pipelines.test.ts` (orphan — guarded `pipeline.yaml` presence; no YAML remains after Task 2)
- `apps/server/src/scripts/migrate-yaml-to-ir.ts` (one-shot)

## Creations / Renames

- `apps/server/src/kernel-next/runtime/load-builtin-pipeline.ts` + test
- `BuiltinPipelineLoadError` class (was `LegacyPipelineLoadError`)
- `seedBuiltinPipelineByName` helper (was `seedLegacyPipelineByName`)
- 4x `apps/server/src/builtin-pipelines/<name>/pipeline.ir.json`
- `apps/server/src/kernel-next/runtime/topo-downstream.ts` (moved from converter/)

## Round-trip invariant

All four builtins' versionHashes match pre-migration values (from
`/tmp/pre-migration-hashes.txt`, verified after migration):

| Pipeline | versionHash |
|---|---|
| smoke-test | `9986a97e0fd5e38c4f472a6030d0e0e19be00f44f047877915a7d17569c47d99` |
| tech-research-collector | `5dcea7362ffd31339cf75036176ce2a780ab455a767e29d01690707cacb8fd51` |
| tech-research-writer | `576d685e0e7fd65ce84d5e14d51a7980a6fc35f8a4d6a5a3cbab3d2f65ca8150` |
| pipeline-generator | `f5dbdf18ca90a0664537fb417505b7b9a1ee548dad3012ab28f7cbc117553206` |

## Test deltas

| Phase | Tests passed | Delta |
|---|---|---|
| Baseline (post Stage 4a) | 1586 | — |
| Task 1 | 1586 | 0 (script is not a test) |
| Task 2 | 1564 | fell briefly due to Task 3's fix being bundled — 9 failing tests in converter/ got cured in Task 3 |
| Task 3 | 1503 | large drop from converter/ + YAML-dependent tests deletion |
| Task 4 | 1499 | −4 (orphan `builtin-pipelines.test.ts` deleted; its 4 cases depended on the last remaining `pipeline.yaml` under `web3-research-writer/`) |

## kernel-next invariants preserved

- Server `tsc --noEmit` 0 errors at every task
- Server `vitest run` 0 failures at every task (1499 passed / 1 skipped post Stage 4b)
- Web `tsc --noEmit` 0 errors (no web changes in this milestone)
- kernel-next routes + MCP tools behavior unchanged
- All 4 builtin pipelines still seed into `pipeline_versions` at server startup with same versionHashes

## Follow-ups

- Stage 5: B-series hot-update productionization
- Stage 6: Execution Record sidecar
- Stage 7: Registry sharing + Phase 5 打磨
- (Minor) apps/web/src/lib/ orphan cleanup, apps/web/e2e/tests/ legacy specs, config schema gemini_executable/codex_executable stale fields
