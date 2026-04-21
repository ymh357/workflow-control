# Persist Pipeline to kernel-next

You receive the IR skeleton (`skeleton`), prompt bundle (`promptBundle`), and full design (`design`). Your job: submit sub-pipelines and the main pipeline to kernel-next via `submit_pipeline` MCP, and produce `persistResult`.

## Available inputs

- `skeleton: object` — `{ ir: PipelineIR, subIrs: PipelineIR[] }`.
- `promptBundle: object` — `{ prompts: Record<string,string>, subPrompts: Record<string,string>[] }` (index-aligned with `subIrs`).
- `design: object` — full `pipelineDesign` (for `pipelineName` / `pipelineId` fallbacks).

## Available tools

- `submit_pipeline` MCP — submits an IR+prompts bundle, returns `{ ok: true, versionHash, ... }` or `{ ok: false, diagnostics: [...] }`.
- `write_port` MCP — emit output ports.

## Workflow

1. **Submit sub-pipelines first.** For each `subIrs[i]` in order:
   - Call `submit_pipeline(ir=subIrs[i], prompts=promptBundle.subPrompts[i])`.
   - On success: record the returned `versionHash` into a local `subVersionHashes[i]` accumulator.
   - On diagnostics:
     - If diagnostics are syntax-level (`PROMPT_REF_MISSING`, `PROMPT_REF_UNUSED`, `WIRE_TARGET_PORT_MISSING`, `WIRE_SOURCE_PORT_MISSING`, Zod parse errors on port types): attempt ONE fix by adjusting the sub-IR / sub-prompts and resubmitting. Cap: 2 attempts per sub-pipeline.
     - If diagnostics indicate semantic errors (missing stage the design required, cycles, unroutable gates): abandon fix attempts, throw via `write_port error: "<reason>"` on a terminal error port **OR** call a tool that causes the agent to fail the stage. Do not silently proceed.
   - After 2 failed attempts on a sub-pipeline: throw. Task fails.

2. **Verify main IR's run_pipeline references.** Scan `promptBundle.prompts` for every occurrence of `run_pipeline(name="X")`. For each match, verify `X` appears in your accumulated `subVersionHashes` map (via the sub-IR's `name` field). Mismatch → throw. This catches genSkeleton / genPrompts naming drift.

3. **Submit the main pipeline.** Call `submit_pipeline(ir=skeleton.ir, prompts=promptBundle.prompts)`.
   - On success: record the returned `versionHash` as `mainVersionHash`.
   - On diagnostics: same policy as step 1 — 2 attempts max; syntax-fix only; semantic errors abandon.

4. **Derive `pipelineId` and `pipelineName`:**
   - `pipelineName = skeleton.ir.name` (or `design.pipelineName` if absent — rare).
   - `pipelineId = slugify(pipelineName)` — kebab-case, lowercase, ASCII only.

5. **Emit `persistResult`** via `write_port`:

```
write_port({
  port: "persistResult",
  value: {
    versionHash: "<mainVersionHash>",
    subVersionHashes: [...subVersionHashes],
    pipelineId: "<pipelineId>",
    pipelineName: "<pipelineName>"
  }
})
```

## Rules

- **Atomic intent.** Either all submits succeed and you emit `persistResult`, or you fail the stage. Do not emit a partial `persistResult`.
- **Syntax fix scope.** You may rewrite port names, prompt references, and prompt content. You may NOT add or remove stages, change stage types, or alter gate routing. Those are semantic decisions belonging to analyzing / genSkeleton.
- **No filesystem writes.** Do not attempt to write any files. All persistence goes through `submit_pipeline`.

## Error handling

- `submit_pipeline` unavailable (MCP tool missing) → throw with an explanatory message. This is a kernel bug; do not work around.
- Disk IO errors, network errors → retry once, then throw.
- `versionHash` collision (re-submit of existing identical pipeline): returned `versionHash` still comes back ok; that's expected (submit is idempotent for identical content). Use the returned hash directly.

## Output (via write_port)

- `persistResult: object` with fields `versionHash`, `subVersionHashes`, `pipelineId`, `pipelineName`.
