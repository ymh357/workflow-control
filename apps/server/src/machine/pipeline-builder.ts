import { Parser } from "expr-eval";
import type { TaskStatus } from "../types/index.js";
import type { PipelineConfig, PipelineStageEntry, PipelineStageConfig } from "../lib/config-loader.js";
import { isParallelGroup } from "../lib/config-loader.js";
import { taskLogger } from "../lib/logger.js";
import type { StateNode } from "./state-builders.js";
import { buildParallelGroupState, buildSingleSessionParallelState } from "./state-builders.js";
import { getStageBuilder } from "./stage-registry.js";
import { deriveStageWrites, deriveStageOutputs } from "../lib/config/store-schema.js";

const exprParser = new Parser();

// --- Helpers ---

function getEntryName(entry: PipelineStageEntry): string {
  return isParallelGroup(entry) ? entry.parallel.name : entry.name;
}

function collectAllNames(entries: PipelineStageEntry[]): string[] {
  const names: string[] = [];
  for (const e of entries) {
    if (isParallelGroup(e)) {
      names.push(e.parallel.name);
      for (const s of e.parallel.stages) names.push(s.name);
    } else {
      names.push(e.name);
    }
  }
  return names;
}

function transformDagToParallelGroups(pipeline: PipelineConfig): PipelineConfig {
  const hasDepends = pipeline.stages.some(
    e => !isParallelGroup(e) && (e as PipelineStageConfig).depends_on?.length
  );
  if (!hasDepends) return pipeline;

  if (pipeline.stages.some(e => isParallelGroup(e))) {
    throw new Error("Pipeline cannot use both depends_on and parallel_group. They are mutually exclusive.");
  }
  const stages = pipeline.stages as PipelineStageConfig[];
  const depMap = new Map<string, Set<string>>();
  for (const s of stages) {
    depMap.set(s.name, new Set(s.depends_on ?? []));
  }

  // Topological sort into levels
  const levels: PipelineStageConfig[][] = [];
  const placed = new Set<string>();

  while (placed.size < stages.length) {
    const level: PipelineStageConfig[] = [];
    for (const s of stages) {
      if (placed.has(s.name)) continue;
      const deps = depMap.get(s.name) ?? new Set();
      if ([...deps].every(d => placed.has(d))) {
        level.push(s);
      }
    }
    if (level.length === 0) break; // cycle (caught by validator)
    for (const s of level) placed.add(s.name);
    levels.push(level);
  }

  // Convert levels to pipeline entries
  const newStages: PipelineStageEntry[] = [];
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    if (level.length === 1) {
      newStages.push(level[0]);
    } else {
      newStages.push({
        parallel: {
          name: `__dag_group_${i}`,
          stages: level,
        },
      });
    }
  }

  return { ...pipeline, stages: newStages };
}

const PASS_THROUGH_TYPES = new Set(["condition", "pipeline", "foreach"]);

function findPrevAgentTarget(entries: PipelineStageEntry[], currentIndex: number): string | null {
  for (let j = currentIndex - 1; j >= 0; j--) {
    const entry = entries[j];
    if (isParallelGroup(entry)) {
      return entry.parallel.name;
    }
    const stageType = (entry as PipelineStageConfig).type;
    if (stageType === "agent" || stageType === "script") {
      return (entry as PipelineStageConfig).name;
    }
    // condition/pipeline/foreach are pass-through — skip them when looking for prevAgent
  }
  return null;
}

// --- Pipeline state generation ---

export function buildPipelineStates(pipeline: PipelineConfig): Record<string, StateNode> {
  // transformDagToParallelGroups may return `pipeline` itself when no DAG
  // transform is needed, so work off a shallow copy to avoid mutating the
  // caller's pipeline object below (store_schema derivation, execution_mode
  // inheritance, etc.).
  const transformed = { ...transformDagToParallelGroups(pipeline) };

  // Validate session_mode constraints
  if (pipeline.session_mode === "single") {
    if (pipeline.engine && pipeline.engine !== "claude") {
      throw new Error(`Pipeline validation failed:\nsession_mode: 'single' requires engine: 'claude' (or omitted). Got: '${pipeline.engine}'`);
    }
  }

  // When store_schema is present, auto-populate runtime.writes and stage.outputs
  // from the schema. This is a one-time derivation at build time — runtime code
  // continues to read runtime.writes and stage.outputs as before.
  //
  // IMPORTANT: stage objects can be shared across snapshots (YAML cache, persisted
  // pipeline embedded in context.config). We MUST NOT mutate the caller's objects.
  // Clone runtime and the stage entry before assigning derived fields.
  if (pipeline.store_schema) {
    const clonedStages: PipelineStageEntry[] = [];
    for (const entry of transformed.stages) {
      if (isParallelGroup(entry)) {
        const clonedChildren = entry.parallel.stages.map((stage) => {
          const derivedWrites = deriveStageWrites(pipeline.store_schema!, stage.name);
          const derivedOutputs = deriveStageOutputs(pipeline.store_schema!, stage.name);
          const rt = stage.runtime as any;
          const needWrites = derivedWrites.length > 0 && rt && (!rt.writes || rt.writes.length === 0);
          const needOutputs = derivedOutputs && !stage.outputs;
          if (!needWrites && !needOutputs) return stage;
          const nextRuntime = needWrites ? { ...rt, writes: derivedWrites } : rt;
          return {
            ...stage,
            ...(needWrites ? { runtime: nextRuntime } : {}),
            ...(needOutputs ? { outputs: derivedOutputs } : {}),
          } as PipelineStageConfig;
        });
        clonedStages.push({ parallel: { ...entry.parallel, stages: clonedChildren } });
      } else {
        const stage = entry as PipelineStageConfig;
        const derivedWrites = deriveStageWrites(pipeline.store_schema, stage.name);
        const derivedOutputs = deriveStageOutputs(pipeline.store_schema, stage.name);
        const rt = stage.runtime as any;
        const needWrites = derivedWrites.length > 0 && rt && (!rt.writes || rt.writes.length === 0);
        const needOutputs = derivedOutputs && !stage.outputs;
        if (!needWrites && !needOutputs) {
          clonedStages.push(stage);
        } else {
          const nextRuntime = needWrites ? { ...rt, writes: derivedWrites } : rt;
          clonedStages.push({
            ...stage,
            ...(needWrites ? { runtime: nextRuntime } : {}),
            ...(needOutputs ? { outputs: derivedOutputs } : {}),
          } as PipelineStageConfig);
        }
      }
    }
    transformed.stages = clonedStages;
  }

  const states: Record<string, StateNode> = {};
  const errors: string[] = [];

  // Global writes-key tracking: warn when multiple stages write the same key
  // with "replace" strategy. Within-group conflicts are caught separately as errors.
  const globalWrites = new Map<string, string[]>();
  for (const entry of transformed.stages) {
    const stagesInEntry = isParallelGroup(entry) ? entry.parallel.stages : [entry as PipelineStageConfig];
    for (const s of stagesInEntry) {
      const writes = (s.runtime as Record<string, any> | undefined)?.writes as Array<string | { key: string; strategy?: string }> | undefined;
      for (const w of writes ?? []) {
        const key = typeof w === "string" ? w : w.key;
        const strategy = typeof w === "string" ? "replace" : (w.strategy ?? "replace");
        if (strategy !== "replace") continue;
        const existing = globalWrites.get(key) ?? [];
        existing.push(s.name);
        globalWrites.set(key, existing);
      }
    }
  }
  for (const [key, stages] of globalWrites) {
    if (stages.length > 1) {
      const log = taskLogger("pipeline-builder");
      log.warn({ key, stages }, `Multiple stages write key "${key}" with replace strategy: ${stages.join(", ")}. Later stages will overwrite earlier values.`);
    }
  }

  const validTargets = new Set(collectAllNames(transformed.stages));
  validTargets.add("completed");
  validTargets.add("error");
  validTargets.add("blocked");

  // Build child→group mapping for reject routing into parallel groups
  const childToGroup = new Map<string, string>();
  for (const e of transformed.stages) {
    if (isParallelGroup(e)) {
      for (const s of e.parallel.stages) {
        childToGroup.set(s.name, e.parallel.name);
      }
    }
  }

  // Pre-compute condition branch convergence points.
  // For each condition stage, all branch targets that are downstream stages in the
  // linear sequence should converge to a single "join" point — the first stage after
  // all branch targets. This prevents branches from falling through to sibling branches.
  //
  // Only targets that appear in the contiguous block immediately after the condition
  // participate in convergence. Back-jumps (targets before the condition) and jumps
  // to built-in states (completed/error/blocked) are excluded.
  // If a target already has an override from a prior condition, we do not overwrite it.
  //
  // Explicit convergence: if the condition runtime has a `converge_to` field, ALL
  // downstream branch targets are overridden to that stage. This is useful when
  // one branch is an "optional prefix" and should flow into the default branch
  // target after completion (e.g., competitorBenchmark → outputPlanning).
  const conditionNextOverrides = new Map<string, string>();
  for (let i = 0; i < transformed.stages.length; i++) {
    const entry = transformed.stages[i];
    if (isParallelGroup(entry)) continue;
    const stage = entry as PipelineStageConfig;
    if (stage.type !== "condition" && stage.type !== "llm_decision") continue;

    const condRuntime = stage.runtime as Record<string, any> | undefined;

    // Extract branch targets: condition uses branches[].to, llm_decision uses choices[].goto
    let branchTargetNames: string[];
    if (stage.type === "condition") {
      const branches = condRuntime?.branches as Array<{ to: string }> | undefined;
      if (!branches) continue;
      branchTargetNames = branches.map((b) => b.to);
    } else {
      const choices = condRuntime?.choices as Array<{ goto: string }> | undefined;
      if (!choices) continue;
      branchTargetNames = choices.map((c) => c.goto);
    }

    const builtInStates = new Set(["completed", "error", "blocked"]);
    const explicitConvergeTo = condRuntime?.converge_to as string | undefined;

    // Collect branch targets that are downstream stages (after the branching stage, not built-in)
    const allBranchTargets = new Set(branchTargetNames.filter((t) => t && !builtInStates.has(t)));
    if (allBranchTargets.size === 0) continue;

    // Only consider targets that appear in the contiguous sequence after the condition
    const downstreamTargets = new Set<string>();
    for (let j = i + 1; j < transformed.stages.length; j++) {
      const name = getEntryName(transformed.stages[j]);
      if (allBranchTargets.has(name)) {
        downstreamTargets.add(name);
      } else {
        break; // stop at first non-target — contiguous block ended
      }
    }
    if (downstreamTargets.size === 0) continue;

    // Determine the convergence target
    let joinTarget: string;
    if (explicitConvergeTo) {
      // Explicit convergence: pipeline author specified where branches should join
      joinTarget = explicitConvergeTo;
    } else {
      // Auto convergence: first stage after the contiguous block of branch targets
      joinTarget = "completed";
      for (let j = i + 1; j < transformed.stages.length; j++) {
        const name = getEntryName(transformed.stages[j]);
        if (!downstreamTargets.has(name)) {
          joinTarget = name;
          break;
        }
      }
    }

    // Override nextTarget for each downstream branch target stage (skip if already overridden).
    // When using explicit converge_to, the converge_to target itself is excluded from
    // overrides — it should keep its natural linear next.
    for (const target of downstreamTargets) {
      if (explicitConvergeTo && target === explicitConvergeTo) continue;
      if (!conditionNextOverrides.has(target)) {
        conditionNextOverrides.set(target, joinTarget);
      }
    }
  }

  for (let i = 0; i < transformed.stages.length; i++) {
    // `entry` is reassigned below when parallel-group children need cloning to
    // inherit default_execution_mode without mutating the caller's pipeline.
    let entry = transformed.stages[i];
    const linearNext = i < transformed.stages.length - 1
      ? getEntryName(transformed.stages[i + 1])
      : "completed";
    const nextStateName = conditionNextOverrides.get(getEntryName(entry)) ?? linearNext;
    const prevAgentState = findPrevAgentTarget(transformed.stages, i) ?? "error";

    if (isParallelGroup(entry)) {
      // Validate: no nested parallel, at least 2 stages, no human_confirm inside
      for (const s of entry.parallel.stages) {
        if (s.type === "human_confirm") {
          errors.push(`Parallel group "${entry.parallel.name}": human_confirm stages are not allowed inside parallel groups`);
        }
      }

      // Inherit pipeline-level default_execution_mode for child stages.
      // Clone the parallel entry + children to avoid mutating the caller's
      // pipeline object (which may be shared with persistence / snapshots).
      if (transformed.default_execution_mode) {
        const mutatedChildren = entry.parallel.stages.map((s) => {
          if (!s.execution_mode && s.type === "agent") {
            return { ...s, execution_mode: transformed.default_execution_mode };
          }
          return s;
        });
        // Replace in place within our already-cloned transformed.stages array.
        const clonedEntry = { parallel: { ...entry.parallel, stages: mutatedChildren } };
        transformed.stages = transformed.stages.map((e, idx) => (idx === i ? clonedEntry : e));
        // Rebind entry for subsequent use below
        entry = clonedEntry;
      }

      // Validate: no overlapping writes keys within group
      const groupWrites = new Map<string, { stage: string; strategy: string }>();
      for (const s of entry.parallel.stages) {
        const writes = (s.runtime as Record<string, any> | undefined)?.writes as Array<string | { key: string; strategy?: string }> | undefined;
        for (const w of writes ?? []) {
          const key = typeof w === "string" ? w : w.key;
          const strategy = typeof w === "string" ? "replace" : (w.strategy ?? "replace");
          const existing = groupWrites.get(key);
          if (existing) {
            if (existing.strategy === "append" && strategy === "append") continue;
            errors.push(`Parallel group "${entry.parallel.name}": write key "${key}" overlaps between "${existing.stage}" and "${s.name}"`);
          }
          groupWrites.set(key, { stage: s.name, strategy });
        }
      }

      // Validate child stage references and builders
      const childNames = new Set(entry.parallel.stages.map(s => s.name));
      for (const s of entry.parallel.stages) {
        const runtime = s.runtime as Record<string, any> | undefined;
        if (runtime?.retry?.back_to) {
          if (pipeline.session_mode === "single") {
            // Single-session groups execute all children in one conversation; there's
            // no way to rewind to a specific child without restarting the whole group.
            errors.push(
              `Stage "${s.name}" in parallel group "${entry.parallel.name}": retry.back_to is not supported in session_mode: "single" (group executes as one session).`,
            );
          } else if (!validTargets.has(runtime.retry.back_to)) {
            errors.push(`Stage "${s.name}" in parallel group "${entry.parallel.name}": retry.back_to references non-existent state "${runtime.retry.back_to}"`);
          } else if (!childNames.has(runtime.retry.back_to)) {
            // XState parallel regions cannot transition to states outside the group —
            // all regions must complete before the group can exit.
            errors.push(`Stage "${s.name}" in parallel group "${entry.parallel.name}": retry.back_to "${runtime.retry.back_to}" is outside the parallel group. Only sibling stages within the same group are valid back_to targets.`);
          }
        }
        if (s.execution_mode && s.execution_mode !== "auto" && s.type !== "agent") {
          errors.push(`Stage "${s.name}" in parallel group "${entry.parallel.name}" has execution_mode "${s.execution_mode}" but is type "${s.type}". Only agent stages support edge execution.`);
        }
        // Validate builder exists for each child stage
        const childBuilder = getStageBuilder(s);
        if (!childBuilder) {
          errors.push(`Stage "${s.name}" in parallel group "${entry.parallel.name}": no builder found for type "${s.type}" (engine: ${runtime?.engine ?? "none"})`);
        }
      }

      if (pipeline.session_mode === "single") {
        states[entry.parallel.name] = buildSingleSessionParallelState(
          entry.parallel, nextStateName, prevAgentState
        );
        taskLogger("pipeline").info({ group: entry.parallel.name, next: nextStateName, mode: "single-session" }, "Single-session parallel group built");
      } else {
        states[entry.parallel.name] = buildParallelGroupState(
          entry.parallel, nextStateName, prevAgentState
        );
        taskLogger("pipeline").info({ group: entry.parallel.name, children: entry.parallel.stages.map(s => s.name), next: nextStateName }, "Parallel group built");
      }
    } else {
      const stage = { ...entry as PipelineStageConfig };

      // Inherit pipeline-level default_execution_mode if stage doesn't specify one
      if (!stage.execution_mode && transformed.default_execution_mode && stage.type === "agent") {
        stage.execution_mode = transformed.default_execution_mode;
      }
      const stateName = stage.name;

      // Find previous agent/script stage for feedback loops
      let prevAgentStateForGate: string | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const prev = transformed.stages[j];
        if (isParallelGroup(prev)) {
          prevAgentStateForGate = prev.parallel.name;
          break;
        }
        const prevType = (prev as PipelineStageConfig).type;
        if (prevType === "agent" || prevType === "script") {
          prevAgentStateForGate = (prev as PipelineStageConfig).name;
          break;
        }
        // condition/pipeline/foreach are pass-through — skip them
      }
      // Validate: human_confirm gate needs a previous agent/script stage for feedback routing
      if (stage.type === "human_confirm" && !prevAgentStateForGate) {
        errors.push(`Stage "${stage.name}": human_confirm gate cannot be the first stage — no previous agent/script stage for feedback routing`);
      }

      // Validate condition branches
      if (stage.type === "condition") {
        const condRuntime = stage.runtime as Record<string, any> | undefined;
        const branches = condRuntime?.branches as Array<{ when?: string; default?: true; to: string }> | undefined;
        if (branches) {
          const defaultBranches = branches.filter((b) => b.default);
          if (defaultBranches.length !== 1) {
            errors.push(`Stage "${stage.name}": condition must have exactly 1 default branch (found ${defaultBranches.length})`);
          }
          const nonDefaultBranches = branches.filter((b) => !b.default);
          if (nonDefaultBranches.length === 0) {
            errors.push(`Stage "${stage.name}": condition must have at least 1 non-default branch`);
          }
          for (const branch of branches) {
            if (branch.to && !validTargets.has(branch.to)) {
              errors.push(`Stage "${stage.name}": condition branch.to "${branch.to}" references non-existent state`);
            }
            if (branch.when) {
              try {
                exprParser.parse(branch.when);
              } catch (err) {
                errors.push(`Stage "${stage.name}": invalid when expression "${branch.when}": ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
          if (condRuntime?.converge_to && !validTargets.has(condRuntime.converge_to)) {
            errors.push(`Stage "${stage.name}": converge_to "${condRuntime.converge_to}" references non-existent state`);
          }
        }
      }

      if (stage.type === "llm_decision") {
        const decisionRuntime = stage.runtime as Record<string, any> | undefined;
        const choices = decisionRuntime?.choices as Array<{ id: string; goto: string }> | undefined;
        if (choices) {
          for (const choice of choices) {
            if (choice.goto && !validTargets.has(choice.goto)) {
              errors.push(`Stage "${stage.name}": llm_decision choice "${choice.id}" goto "${choice.goto}" references non-existent state`);
            }
          }
        }
      }

      // Validate pipeline_name existence is deferred to runtime (config loader may not know all pipelines)
      // But we validate that pipeline/foreach stages have the required fields
      if (stage.type === "pipeline") {
        const pipelineRuntime = stage.runtime as Record<string, any> | undefined;
        if (!pipelineRuntime?.pipeline_name && pipelineRuntime?.pipeline_source !== "store") {
          errors.push(`Stage "${stage.name}": pipeline stage must have runtime.pipeline_name (or pipeline_source: "store" with pipeline_key)`);
        }
        if (pipelineRuntime?.pipeline_source === "store" && !pipelineRuntime?.pipeline_key) {
          errors.push(`Stage "${stage.name}": pipeline_source "store" requires pipeline_key`);
        }
      }

      if (stage.type === "foreach") {
        const foreachRuntime = stage.runtime as Record<string, any> | undefined;
        if (!foreachRuntime?.pipeline_name) {
          errors.push(`Stage "${stage.name}": foreach stage must have runtime.pipeline_name`);
        }
        if (!foreachRuntime?.items) {
          errors.push(`Stage "${stage.name}": foreach stage must have runtime.items`);
        }
        if (!foreachRuntime?.item_var) {
          errors.push(`Stage "${stage.name}": foreach stage must have runtime.item_var`);
        }
      }

      // Warn: gate after parallel group without on_reject_to means all children re-run on reject
      if (stage.type === "human_confirm" && prevAgentStateForGate) {
        const prevEntry = i > 0 ? transformed.stages[i - 1] : undefined;
        const gateRuntime = stage.runtime as Record<string, any> | undefined;
        if (prevEntry && isParallelGroup(prevEntry) && !gateRuntime?.on_reject_to) {
          taskLogger("pipeline").warn(
            { gate: stage.name, group: (prevEntry as any).parallel.name },
            "Gate after parallel group has no on_reject_to — reject/feedback will re-run ALL children. Set on_reject_to to a child stage for selective re-run.",
          );
        }
      }

      if (!prevAgentStateForGate) prevAgentStateForGate = "error";

      // Collect validation errors
      const runtime = stage.runtime as Record<string, any> | undefined;
      if (runtime?.on_approve_to && !validTargets.has(runtime.on_approve_to)) {
        errors.push(`Stage "${stage.name}": on_approve_to references non-existent state "${runtime.on_approve_to}"`);
      }
      if (runtime?.on_reject_to && !validTargets.has(runtime.on_reject_to)) {
        errors.push(`Stage "${stage.name}": on_reject_to references non-existent state "${runtime.on_reject_to}"`);
      }
      if (runtime?.retry?.back_to && !validTargets.has(runtime.retry.back_to)) {
        errors.push(`Stage "${stage.name}": retry.back_to references non-existent state "${runtime.retry.back_to}"`);
      }

      // Validate: execution_mode "edge" is only allowed on agent stages
      if (stage.execution_mode && stage.execution_mode !== "auto" && stage.type !== "agent") {
        errors.push(`Stage "${stage.name}" has execution_mode "${stage.execution_mode}" but is type "${stage.type}". Only agent stages support edge execution.`);
      }

      const builder = getStageBuilder(stage);
      if (builder) {
        states[stateName] = builder(nextStateName, prevAgentStateForGate, stage, { childToGroup, sessionMode: pipeline.session_mode });
        taskLogger("pipeline").info({ stage: stage.name, type: stage.type, next: nextStateName }, "State built");
      } else {
        errors.push(`Stage "${stage.name}": no builder found for type "${stage.type}" (engine: ${runtime?.engine ?? "none"})`);
      }
    }
  }

  // Detect back_to cycles (A->B->A) — only for flat stages
  const backToEdges = new Map<string, string>();
  for (const entry of transformed.stages) {
    if (isParallelGroup(entry)) {
      for (const s of entry.parallel.stages) {
        const rt = s.runtime as Record<string, any> | undefined;
        if (rt?.retry?.back_to) backToEdges.set(s.name, rt.retry.back_to);
      }
    } else {
      const rt = (entry as PipelineStageConfig).runtime as Record<string, any> | undefined;
      if (rt?.retry?.back_to) backToEdges.set((entry as PipelineStageConfig).name, rt.retry.back_to);
    }
  }
  for (const [src, dst] of backToEdges) {
    let cursor = dst;
    const visited = new Set([src]);
    while (cursor && backToEdges.has(cursor)) {
      if (visited.has(cursor)) {
        errors.push(`Cycle detected in back_to routing: ${[...visited, cursor].join(" -> ")}`);
        break;
      }
      visited.add(cursor);
      cursor = backToEdges.get(cursor)!;
    }
  }

  if (errors.length) {
    throw new Error(`Pipeline validation failed:\n${errors.join("\n")}`);
  }

  return states;
}

// --- Lifecycle helpers ---

export function derivePipelineLists(pipeline: PipelineConfig): { retryable: TaskStatus[]; resumable: TaskStatus[] } {
  const retryable: TaskStatus[] = [];
  const resumable: TaskStatus[] = [];

  for (const entry of pipeline.stages) {
    if (isParallelGroup(entry)) {
      retryable.push(entry.parallel.name);
      resumable.push(entry.parallel.name);
      for (const s of entry.parallel.stages) {
        if (s.type === "agent" || s.type === "script") {
          retryable.push(s.name);
          resumable.push(s.name);
        }
      }
    } else {
      const stage = entry as PipelineStageConfig;
      if (stage.type === "agent" || stage.type === "script") {
        retryable.push(stage.name);
        resumable.push(stage.name);
      } else if (stage.type === "human_confirm") {
        resumable.push(stage.name);
      } else if (stage.type === "pipeline" || stage.type === "foreach") {
        retryable.push(stage.name);
        resumable.push(stage.name);
      }
      // condition and llm_decision stages are not retryable/resumable (branching stages)
    }
  }

  return { retryable, resumable };
}
