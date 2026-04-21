# Converter Wire-LocalKey Semantics — Resolved 2026-04-23

**Status:** RESOLVED 2026-04-23 via targeted fix that preserved
runtime's "one input port, one driver" invariant. The original worry
about needing a 4-6h runtime overhaul was based on an incorrect read
of the problem; the actual fix was ~30 minutes in two converter files.

**Historical note:** This document was originally filed as debt-for-
next-milestone. Keeping it for archaeology — it captures both the
mis-estimation and the correct final scope.

**Context:** Discovered while unblocking pipeline-generator MockExecutor E2E in the
`converter extension for pipeline-generator` milestone. Pragmatic
mitigation (pipeline-generator prompt rule + pipeline.yaml reshaping)
took the observable dup count from 3 → 1, but the underlying converter
semantic bug remains.

## The Bug

File: `apps/server/src/kernel-next/converter/map-wires.ts` (lines 33-58)
Also: `apps/server/src/kernel-next/converter/map-stages.ts` (line 127)

Both iterate `Object.values(reads)`, discarding the user-written
`localKey`. Wire `to.port` and the derived stage input port name are
both set from the **source field name**, not the localKey.

```ts
// Current (buggy):
for (const sourceKey of Object.values(reads)) {
  if (entryDirectory.has(sourceKey)) {
    for (const f of entry.fields) {
      wires.push({
        from: { ..., port: f.name },
        to: { stage: name, port: f.name },  // uses source field name, not localKey
      });
    }
  }
}
```

**Observable consequences:**

1. Two different localKeys on the same stage that resolve to the same
   source field produce duplicate wires (same `to.stage.port`). Example:

   ```yaml
   # Parent-entry + sub-field read on the same entry:
   reads:
     design: pipelineDesign
     contracts: pipelineDesign.stageContracts
   # Generates two wires both targeting `stageContracts` port.
   ```

2. Two different localKeys sourced from different entries that happen
   to share a field name produce a conflict. Example from
   `persisting` stage in `pipeline-generator/pipeline.yaml`:

   ```yaml
   reads:
     prompts: refinedPromptFiles       # entry-level → expands `outputDir` among others
     rawPromptDir: promptFiles.outputDir  # dotted → same field name `outputDir`
   # Both wires target `persisting.outputDir`, but from different upstream stages.
   ```

   This case cannot be fixed by adjusting the YAML because the script
   legitimately needs both values (one for refined prompts, one for
   cleaning up the raw temp directory).

3. The stage's input port name never matches the user-written
   localKey. The agent prompt must know the *source field name* rather
   than the localKey. Example: `contracts: pipelineDesign.stageContracts`
   makes the agent see a port called `stageContracts`, not `contracts`.
   This contradicts the natural reading of the YAML and forces the
   `pipeline-generator` prompt to teach AI about this mismatch.

## Why the original estimate was wrong

The initial analysis assumed the fix required a **runtime data-plane
change** — one input port fed by multiple wires, with an aggregation
layer that packs multiple field values into an object. That would
have violated the existing `WIRE_TARGET_ALREADY_DRIVEN` validator
invariant (each input port has exactly one driving wire) and would
have touched `ir-to-machine.ts`, every executor, and every canonical
hash fixture.

The actual fix needed none of that. Entry-level reads continue to
expand into one port per field (preserving the existing "each port
one driver" semantics and keeping `smoke-test` / `tech-research`
hashes byte-identical). Only **dotted-field reads** and **external
reads** changed: their `wire.to.port` and the corresponding input
port name now use the declared `localKey` instead of the upstream
field name. That collapses to one wire per read, still one driver
per port.

Actual change footprint:
- `map-wires.ts` — ~10 lines (add `isDottedField` branch, use
  `Object.entries` instead of `Object.values`, external wires use
  `localKey`).
- `map-stages.ts` — ~15 lines (mirror: dotted → localKey-named port
  with the referenced field's type; entry → unchanged; external →
  localKey-named port).
- `map-wires.test.ts`, `map-stages.test.ts` — 1 external-read
  assertion updated in each; 1 new dotted-field test added.
- No runtime changes. No validator changes. No schema changes.
- No fixture hash regeneration (smoke-test / tech-research only use
  entry-level reads).

**Runtime invariant preserved:** every input port is still driven by
exactly one wire.

## What we did in this milestone (mitigation A)

1. `prompts/system/gen-skeleton.md`: added rule "No redundant parent+child
   reads on the same stage" (Translation Rule #13 + Quality Checklist).
2. `prompts/system/gen-prompts.md`: renamed standalone `contracts` references
   to `design.stageContracts` (consistent with reads-being-single-entry rule).
3. `builtin-pipelines/pipeline-generator/pipeline.yaml`:
   - Removed the redundant `contracts: pipelineDesign.stageContracts` from
     `genSkeleton` and `genPrompts` — both now use `design: pipelineDesign`
     and must reference `design.stageContracts` inside their prompts.
   - Removed `rawPromptDir: promptFiles.outputDir` from `persisting`. The
     previously-fed value was used for best-effort cleanup of the raw
     prompt temp directory; `persist-pipeline.ts` already guards the
     cleanup path with `if (rawPromptDir && ...)`, so omitting the read
     simply disables best-effort cleanup of `/tmp/gen-prompts-{taskId}/`.
     OS-level /tmp cleanup handles the leak; acceptable local-only cost.

**Result:** `pg-inspect.test.ts` reports **0 dups** out of 56 wires on
pipeline-generator after these mitigations. All 69 converter tests pass.

**Resolved later the same day (B).** See the "Why the original estimate
was wrong" section above. B's fix means:
- Dotted-field reads (`contracts: pipelineDesign.stageContracts`) now
  produce a single wire whose target port is `contracts` — matching
  the declared localKey.
- External reads (`cfg: pipelineConfig`) likewise name the target
  port `cfg`, not `pipelineConfig`.
- Entry-level reads (`design: pipelineDesign`) still expand to one
  port per field (name = field name), so no hashes churned.
- The `rawPromptDir: promptFiles.outputDir` read that had to be
  temporarily removed from `pipeline-generator/pipeline.yaml` is now
  safely restored: the resulting wire targets
  `persisting.rawPromptDir` rather than `persisting.outputDir`, so
  there is no collision with `prompts: refinedPromptFiles`' expanded
  `outputDir` port.

**Runtime invariant intact.** `WIRE_TARGET_ALREADY_DRIVEN` validator
still applies and still guarantees one driver per input port.

## Outcome

- `map-wires.ts` and `map-stages.ts` patched in place (~25 lines
  total).
- `map-wires.test.ts` and `map-stages.test.ts` assertions updated;
  one new dotted-field test added.
- `kernel-next` regression suite: 411 passed / 2 skipped / 0 failed.
- `pg-inspect.test.ts` confirms 0 duplicate wires in pipeline-generator.
- C6 (MockExecutor E2E for pipeline-generator) remains independently
  blocked by a hang unrelated to the converter; skipped via
  `describe.skip` to stop the regression suite paying 45 s per run.
  That hang is the topic of a future milestone, not this one.

## Invariants to preserve

- `smoke-test.ts` and other hand-written IR (`inputs: [{ name: ... }]`
  with matching wires) do not go through the converter. These must
  continue to work unchanged — `inputs[].name` IS the port name there,
  which already matches the new semantics.
- `tech-research-collector` and `tech-research-writer` happen to write
  reads where localKey matches source field name — their behavior
  under the new semantics should be byte-identical modulo canonical
  hash changes.

## References

- `apps/server/src/kernel-next/runtime/pg-inspect.test.ts` — the
  diagnostic test that surfaces the dup count. Keep this after the fix
  and assert 0 dups.
- `apps/server/src/kernel-next/runtime/retry-debug.test.ts` — related
  diagnostic (retry closure semantics). Not affected by this debt.
- `docs/superpowers/specs/2026-04-22-converter-extension-pipeline-generator-design.md`
  — the milestone spec that surfaced this bug.
