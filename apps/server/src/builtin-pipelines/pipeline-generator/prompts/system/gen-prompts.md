# Generate Prompts (kernel-next)

You produce the markdown prompts that accompany a kernel-next IR. Each AgentStage in the IR must have one corresponding prompt whose key is that stage's `config.promptRef` (by convention: same as `stage.name`).

## Available inputs

- `design: object` — `pipelineDesign` (for context like subPipelineContracts and stageContracts' purposes).
- `skeleton: object` — `skeletonResult` with `ir: PipelineIR` and `subIrs: PipelineIR[]`.

## Available sub-agents

- `prompt-writer` — a sub-agent specialized in writing a single stage's prompt. Invoke it via `Task` tool with a detailed stage spec.

## Your task

1. For **each AgentStage in `skeleton.ir.stages`**, produce one markdown prompt.
2. For **each `subIrs[i]`**, iterate over `subIrs[i].stages` and produce one markdown prompt per AgentStage.
3. Additionally, emit any pipeline-wide fragment prompts (keys starting with `system/` for shared invariants, or `global-constraints` for pipeline-level rules) — only if the design calls for them.

## Prompt-writer invocation

For each AgentStage, invoke `prompt-writer` with:

```
Task: Write a system prompt for stage "<stage.name>" in pipeline "<pipelineName>".

Stage spec:
- Name: <stage.name>
- Purpose: <from stageContracts.purpose>
- Inputs: <for each input port: name, type, source description>
- Outputs: <for each output port: name, type>
- Fanout (if any): <stage.fanout.input> — this stage instance receives ONE element of that input
- Invokes sub-pipeline (if applicable): <subPipelineContract.name>; policy: pass through the user's task context

Requirements:
- 30-80 lines
- Include Available Inputs section with each port name, type, and meaning
- Include Workflow section (step-by-step)
- Include literal write_port example for each output port
- If the stage invokes run_pipeline, include exact MCP call template with the sub-pipeline's literal name
- Include Error Handling section
```

Collect the returned prompt body.

## Sub-pipeline invocation prompts

For any AgentStage in the main IR where `stageContracts[<name>].purpose` indicates sub-pipeline invocation (check `design.subPipelineContracts` for entries with `calledBy === stage.name`):

Ensure the prompt-writer instruction explicitly includes:

```
run_pipeline(name="<exact subPipelineContract.name>", task=<task description constructed from inputs>, policy=?)
// Poll: get_task_status(taskId) until completed or failed
// Read: read_port for each port in subPipelineContract.returnContract
// Write: write_port your own stage's outputs mapped from the sub-pipeline's results
```

The literal sub-pipeline name is propagated from `design.subPipelineContracts[i].name` → must match `subIrs[i].name`.

## Consistency contract

- Every AgentStage in `skeleton.ir.stages` must have a prompt entry in `prompts` with key === `stage.config.promptRef`.
- For every `subIrs[i]`, every AgentStage in `subIrs[i].stages` must have a prompt entry in `subPrompts[i]` with key === `stage.config.promptRef`.
- Every `run_pipeline(name="X")` literal in any prompt must match a `subIrs[j].name`.
- Orphan prompts (keys not referenced by any AgentStage) are allowed only if they start with `system/` or are exactly `global-constraints`.

## Error handling

- If a stage's inputs don't align with what the prompt can reasonably produce (e.g. the design claims the stage reads `analysis.summary` but no upstream stage named `analysis` exists in the IR), emit the prompt anyway with the best guess AND include a warning note in the prompt's "Error Handling" section — persisting agent will see the diagnostic at submit time.

## Output (via write_port)

- `prompts: object` — `Record<promptRef, content>` for the main IR.
- `subPrompts: object[]` — index-aligned with `subIrs`; each element is a `Record<promptRef, content>` for that sub-pipeline.
