# Prompt: Add refinePrompts Stage to Pipeline Generator

## Goal

Add a `refinePrompts` stage to the pipeline-generator pipeline. After genSkeleton + genPrompts produce the initial YAML and prompt files, refinePrompts reads the target codebase (if available) and enhances every prompt with project-specific knowledge — real file paths, component names, hook signatures, directory structure, etc.

This makes every generated pipeline's prompts production-quality out of the box, without manual tuning.

## Current pipeline-generator flow

```
analyzing → awaitingConfirm → generating (parallel: genSkeleton + genPrompts) → persisting
```

## New flow

```
analyzing → awaitingConfirm → generating (parallel: genSkeleton + genPrompts) → refinePrompts → persisting
```

## What to change

### 1. Pipeline YAML (`apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml`)

Add a new stage between `generating` and `persisting`:

```yaml
  - name: refinePrompts
    type: agent
    thinking:
      type: enabled
    effort: high
    max_budget_usd: 4
    max_turns: 50
    runtime:
      engine: llm
      system_prompt: refine-prompts
      disallowed_tools:
        - Edit
        - Write
      reads:
        promptFiles: promptFiles
        pipelineYaml: pipelineYaml.pipeline
        pipelineDesign: pipelineDesign
      writes:
        - refinedPromptFiles
    outputs:
      refinedPromptFiles:
        type: object
        label: Refined Prompts
        fields:
          - key: files
            type: object
            description: Object mapping prompt names to enhanced content strings
          - key: globalConstraints
            type: markdown
            description: Enhanced global constraints content
```

Key design decisions:
- `disallowed_tools: [Edit, Write]` — can Read/Grep/Glob the target codebase but cannot modify it
- Reads the original `promptFiles` from genPrompts and outputs `refinedPromptFiles` with the same shape
- If no target codebase is found, outputs `promptFiles` unchanged (passthrough)

Update `persisting` stage's reads to consume `refinedPromptFiles` instead of `promptFiles`:

```yaml
  - name: persisting
    runtime:
      reads:
        pipeline: pipelineYaml.pipeline
        subPipelines: pipelineYaml.sub_pipelines
        prompts: refinedPromptFiles    # was: promptFiles
        pipelineId: pipelineDesign.pipelineId
        pipelineName: pipelineDesign.pipelineName
```

### 2. New prompt: `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/refine-prompts.md`

Write a system prompt that instructs the agent to:

#### Context available
- `promptFiles.files` — object mapping prompt names (kebab-case) to their content strings
- `promptFiles.globalConstraints` — global constraints markdown
- `pipelineYaml` — the full pipeline config object (stages, reads, writes, outputs)
- `pipelineDesign.stageDesign` — the original stage-by-stage design spec

#### Workflow

**Step 1 — Locate the target codebase**
Extract `repoName` from `pipelineDesign` or the task description (available in tier-1 context). Use Glob to find the repo under common paths (`~/`, repos_base configured in settings, or the worktree path if present in context). If no target codebase can be found, output `promptFiles` unchanged and note "no target codebase found — prompts not refined" in a `_refinementNote` field.

**Step 2 — Scan the target codebase**
Using Read, Grep, Glob on the target codebase:
- Map the directory structure (top-level dirs, key files)
- Identify the package.json dependencies and framework versions
- Find key type definitions, hook signatures, component names
- Locate config files (tailwind.config, next.config, tsconfig)

**Step 3 — Enhance each prompt**
For each prompt file in `promptFiles.files`:
1. Read the pipeline stage config from `pipelineYaml` to understand what this stage does (reads, writes, outputs, permission_mode, mcps)
2. Identify generic references in the prompt that can be made specific:
   - "components/ui/" → actual path if different (e.g. "shared/components/ui/")
   - "existing hooks" → actual hook names (e.g. "`useRouterAuth`, `useBrokerOperations`, `useFineTuning`")
   - "wallet library" → actual library with version (e.g. "RainbowKit 2.2.8 + wagmi 2.16.0")
   - "state management" → actual pattern (e.g. "28 custom hooks with useReducer-based ChatState")
   - "contract interactions" → actual contract names + key methods
3. Add a "## Project-Specific Context" section to the prompt with discovered facts that the agent will need
4. Verify workflow steps reference real paths and real file names from the codebase
5. Do NOT change the prompt structure (role, workflow steps, error handling, output fields) — only add specificity

**Step 4 — Enhance global constraints**
Add project-specific constraints discovered from the codebase:
- Actual dependency versions that must be preserved or upgraded
- Actual directory conventions
- Known quirks (e.g. "output: 'export' means no server-side features currently")

**Step 5 — Output**
Produce `refinedPromptFiles` with the same shape as `promptFiles`:
- `files`: object mapping prompt names to enhanced content
- `globalConstraints`: enhanced global constraints string

#### Quality standards
- Every enhancement must cite the source file it came from (e.g. "from package.json: next@15.4.8")
- Do not invent information — only add what was directly observed in the codebase
- If a prompt references a concept that doesn't exist in the codebase, add a warning comment in the prompt
- Preserve 100% of the original prompt content — only ADD specificity, never remove or restructure

#### Error handling
- Target codebase not found: passthrough promptFiles unchanged
- A specific file referenced in stageDesign doesn't exist: add a comment noting this in the prompt
- Codebase is too large to fully scan within budget: focus on package.json, tsconfig, top-level directory structure, and files directly referenced in stageDesign

### 3. Sync to config directory

After modifying the builtin pipeline YAML and adding the new prompt:
- Copy the updated `pipeline.yaml` to `apps/server/config/pipelines/pipeline-generator/pipeline.yaml`
- Copy the new prompt to `apps/server/config/pipelines/pipeline-generator/prompts/system/refine-prompts.md`

### 4. Adjust analyzing stage output

Add a `targetRepoName` field to `pipelineDesign` outputs so refinePrompts knows where to look:

In `pipeline.yaml` analyzing stage outputs, add:
```yaml
          - key: targetRepoName
            type: string
            description: Repository name extracted from task description (empty if not specified)
```

In `analysis.md` prompt, add instruction to extract repoName from the task description if mentioned.

## Key constraints

- **Backward compatible**: if refinePrompts can't find a codebase, it passes through unchanged — pipeline-generator still works for abstract/design-only tasks
- **Read-only**: refinePrompts never writes to the target codebase
- **Additive only**: never removes content from prompts, only adds project-specific context
- **Same output shape**: `refinedPromptFiles` has identical structure to `promptFiles` so persisting needs minimal change (just the reads key name)

## Verification

1. `cd apps/server && npx tsc --noEmit` — zero new errors
2. `cd apps/server && npx vitest run` — all tests pass
3. Run pipeline-generator with a task that mentions a real repo → verify prompts contain project-specific details
4. Run pipeline-generator with a task that has no repo → verify prompts are unchanged (passthrough)
