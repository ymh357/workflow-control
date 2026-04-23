# Persist Pipeline to kernel-next

Your sole responsibility: submit the generated IR and prompts to kernel-next by calling the `submit_pipeline` MCP tool, then emit four output ports recording the result.

**You MUST call `submit_pipeline`. Do not guess a versionHash. Do not write "ERROR" or fabricated strings. The only path to success is calling the tool.**

## Available inputs

- `ir` — the main pipeline's PipelineIR JSON (from skeletonResult.ir)
- `subIrs` — array of sub-pipeline PipelineIRs (may be empty)
- `prompts` — Record<string, string> of promptRef → content for the main pipeline
- `subPrompts` — array of Record<string, string>, index-aligned with subIrs
- `pipelineName` / `pipelineId` — from pipelineDesign (fallbacks if `ir.name` is missing)
- Other fields from pipelineDesign flow into your inputs — **ignore them**. You do not echo inputs as outputs.

## Output ports (exactly four)

Emit these via `mcp____kernel_next____write_port` — one call per port:

1. `versionHash: string` — main pipeline's versionHash returned from `submit_pipeline`
2. `subVersionHashes: string[]` — sub-pipeline versionHashes in index order (empty array when subIrs is empty)
3. `pipelineId: string` — kebab-case slug of `ir.name`
4. `pipelineName: string` — `ir.name`

**Do not write any other port.** In particular do NOT echo `pipelineDesign`, `stageContracts`, `stageDesign`, `summary`, `useCases`, `ir`, `prompts`, or any other upstream value — they are your **inputs**, not your outputs.

## Workflow

### Step 1: Submit each sub-pipeline (if any)

For each `subIrs[i]` in order:

Call the tool `mcp____kernel_next____submit_pipeline` with input:

```json
{
  "ir": <subIrs[i] verbatim>,
  "prompts": <subPrompts[i] verbatim>
}
```

Expected tool_result shapes:

- Success: `{ "ok": true, "versionHash": "abc123...", "tsSource": "..." }` — record `versionHash` into your local `subVersionHashes` accumulator.
- Failure: `{ "ok": false, "diagnostics": [{code, message, context}, ...] }` — see diagnostic handling below.

### Step 2: Verify sub-pipeline name references

Scan every value in `prompts` (the main IR's prompts) for literal substrings of the form `run_pipeline(name="X")` or `run_pipeline(name='X')`. For each match, verify `X` equals one of `subIrs[i].name`. Any mismatch → this is a genSkeleton/genPrompts naming bug; you cannot fix it in persisting. Write error ports and stop (see Failure handling below).

If `subIrs` is empty or no prompt mentions `run_pipeline(`, this step is a no-op.

### Step 3: Submit the main pipeline

Call `mcp____kernel_next____submit_pipeline` with input:

```json
{
  "ir": <the "ir" input verbatim>,
  "prompts": <the "prompts" input verbatim>
}
```

Record the returned `versionHash` as `mainVersionHash`.

### Step 4: Compute pipelineId / pipelineName

- `pipelineName` = `ir.name` (fall back to the `pipelineName` input if `ir.name` is empty)
- `pipelineId` = kebab-case, lowercase, ASCII letters + digits + `-` only (replace spaces, underscores, and non-ASCII with `-`; collapse runs of `-`; trim leading/trailing `-`)

### Step 5: Write the four output ports

Four separate `mcp____kernel_next____write_port` calls:

```json
{ "port": "versionHash", "value": "<mainVersionHash>" }
```
```json
{ "port": "subVersionHashes", "value": [...] }
```
```json
{ "port": "pipelineId", "value": "<pipelineId>" }
```
```json
{ "port": "pipelineName", "value": "<pipelineName>" }
```

The `stage` field on `write_port` is filled in automatically from your executing stage context; omit it unless the tool rejects the call.

After all four ports are written, you are done.

## Diagnostic handling

When `submit_pipeline` returns `{ ok: false, diagnostics: [...] }`, inspect each diagnostic's `code`:

**Retryable (syntax-level)** — try ONE fix then resubmit. Maximum 2 attempts per pipeline (main or sub).

- `PROMPT_REF_MISSING` → a prompt for an AgentStage is not in your `prompts` map. Add an entry with key = the missing promptRef and a minimal body (e.g. `"# <stageName>\n\nTODO: flesh out this prompt."`). Resubmit.
- `PROMPT_REF_UNUSED` → a prompt key is not referenced by any AgentStage. Remove that entry from the prompts map. (Keys starting with `system/` or equal to `global-constraints` are whitelisted — safe to keep; if this diagnostic fires on one of those, kernel is mis-validating and you should escalate, not remove.)
- `PROMPT_CONTENT_EMPTY` → a prompt is whitespace-only. Replace with meaningful content (at least a heading).
- `WIRE_TARGET_PORT_MISSING` / `WIRE_SOURCE_PORT_MISSING` → port names drifted between the wire and the stage declaration. Adjust port names in the IR's stages or wires array so they match.
- `ZOD_PARSE_ERROR` on a port type → the type string is malformed. Replace with a simple valid TS type literal (`"string"`, `"number"`, `"string[]"`, `"{ field: string }"`).

**Non-retryable (semantic)** — do NOT attempt to fix. Write error ports and fail.

- `DAG_HAS_CYCLE`, `GATE_ROUTING_TARGET_MISSING`, `GATE_TARGET_SHARED`, `ENTRY_STAGE_MISSING`, `DUPLICATE_STAGE_NAME`, `DUPLICATE_PORT_NAME`, `WIRE_TYPE_MISMATCH`, `GATE_FANOUT_FORBIDDEN`, `FANOUT_INPUT_MISSING`, `NO_ACTIVE_WIRE`.

## Failure handling

If you decide to fail the stage (non-retryable diagnostic, two failed retries, or naming mismatch):

- Still write the four output ports so the stage completes cleanly, but set values that clearly indicate failure:

```json
{ "port": "versionHash", "value": "FAILED" }
```
```json
{ "port": "subVersionHashes", "value": [] }
```
```json
{ "port": "pipelineId", "value": "FAILED" }
```
```json
{ "port": "pipelineName", "value": "FAILED" }
```

- Then produce a final text message summarizing: which submit failed, which diagnostics blocked, and why you could not fix them.

**Never** write a fabricated versionHash. **Never** skip the `submit_pipeline` call and pretend it succeeded. If the tool is genuinely unavailable (you don't see it in your tool list), say so in text and fail.

## Rules recap

- Call `submit_pipeline` for every IR. There is no shortcut.
- Only write the four declared output ports. Do not echo upstream inputs.
- Idempotency: if `submit_pipeline` returns ok with a versionHash that matches a prior submit, that's expected — reuse the hash.
- No filesystem writes. Kernel owns persistence.
