// Pure pipeline validation logic — shared between server (persist) and web (editor)

export interface ValidationIssue {
  severity: "error" | "warning" | "info";
  stageIndex?: number;
  field?: string;
  message: string;
}

type WriteDeclaration = string | { key: string; strategy?: "replace" | "append" | "merge" };

interface StageRuntime {
  engine?: string;
  system_prompt?: string;
  writes?: WriteDeclaration[];
  reads?: Record<string, string>;
  on_reject_to?: string;
  on_approve_to?: string;
  retry?: { max_retries?: number; max_attempts?: number; back_to?: string };
  exclusive_write_group?: string;
  compensation?: { strategy: "git_reset" | "git_stash" | "none" };
  [key: string]: unknown;
}

function writeKey(w: WriteDeclaration): string {
  return typeof w === "string" ? w : w.key;
}

function writeStrategy(w: WriteDeclaration): string {
  return typeof w === "string" ? "replace" : (w.strategy ?? "replace");
}

interface StageConfig {
  name: string;
  type: "agent" | "script" | "human_confirm" | "condition" | "pipeline" | "foreach";
  runtime?: StageRuntime;
  outputs?: Record<string, { type: string; fields?: { key: string }[]; hidden?: boolean }>;
  [key: string]: unknown;
}

interface ParallelGroupEntry {
  parallel: {
    name: string;
    stages: StageConfig[];
  };
}

type StageEntry = StageConfig | ParallelGroupEntry;

function isParallelGroup(entry: StageEntry): entry is ParallelGroupEntry {
  return "parallel" in entry;
}

/**
 * Validate pipeline logical consistency (reads/writes data flow, routing targets, parallel rules).
 * This does NOT validate schema structure — use Zod schema validation for that.
 *
 * @param stages - Pipeline stage entries (from parsed YAML)
 * @param promptKeys - Optional set of available prompt filenames (without .md extension, kebab-case).
 *                     When provided, validates that agent stages reference existing prompts.
 *                     Omit when prompts are generated alongside the pipeline (e.g., persist flow).
 * @param knownMcps - Optional set of registered MCP names. When provided, validates that
 *                    stage mcps references exist in the registry.
 */
export function validatePipelineLogic(
  stages: StageEntry[],
  promptKeys?: Set<string>,
  knownMcps?: Set<string>,
  injectedStoreKeys?: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allWrites = new Map<string, number>();
  const writeOriginStage = new Map<string, string>(); // write key → stage name that wrote it

  // Pre-populate writes with externally injected store keys (e.g., from parent foreach reads)
  if (injectedStoreKeys) {
    for (const key of injectedStoreKeys) {
      allWrites.set(key, -1);
      writeOriginStage.set(key, "__injected__");
    }
  }
  const allStageNames = new Set<string>();

  // Build stage-by-name map for cross-referencing (includes parallel group children)
  const stageByName = new Map<string, StageConfig>();
  for (const entry of stages) {
    if (isParallelGroup(entry)) {
      for (const s of entry.parallel.stages) stageByName.set(s.name, s);
    } else {
      stageByName.set((entry as StageConfig).name, entry as StageConfig);
    }
  }

  // Collect all names
  for (const entry of stages) {
    if (isParallelGroup(entry)) {
      allStageNames.add(entry.parallel.name);
      for (const s of entry.parallel.stages) allStageNames.add(s.name);
    } else {
      allStageNames.add(entry.name);
    }
  }

  const promptKeysNormalized = promptKeys
    ? new Set([...promptKeys].map(normalizePromptKey))
    : undefined;

  for (let i = 0; i < stages.length; i++) {
    const entry = stages[i];

    if (isParallelGroup(entry)) {
      const group = entry.parallel;

      if (group.stages.length < 2) {
        issues.push({
          severity: "error",
          stageIndex: i,
          message: `Parallel group "${group.name}" must have at least 2 stages`,
        });
      }

      for (const s of group.stages) {
        if (s.type === "human_confirm") {
          issues.push({
            severity: "error",
            stageIndex: i,
            message: `Parallel group "${group.name}": human_confirm stages not allowed inside parallel groups`,
          });
        }
      }

      // Writes overlap within group (unless both sides use append/merge)
      const groupWrites = new Map<string, { stage: string; strategy: string }>();
      for (const s of group.stages) {
        const rawWrites = (s.runtime as Record<string, any> | undefined)?.writes as WriteDeclaration[] | undefined;
        for (const w of rawWrites ?? []) {
          const k = writeKey(w);
          const strategy = writeStrategy(w);
          const existing = groupWrites.get(k);
          if (existing) {
            if (existing.strategy === "replace" || strategy === "replace") {
              issues.push({
                severity: "error",
                stageIndex: i,
                field: "runtime.writes",
                message: `Parallel group "${group.name}": write key "${k}" overlaps between "${existing.stage}" and "${s.name}". Use strategy "append" or "merge" on both stages to allow shared writes.`,
              });
            }
          }
          groupWrites.set(k, { stage: s.name, strategy });
        }
      }

      // Child retry.back_to must stay within group
      const childNameSet = new Set(group.stages.map((s) => s.name));
      for (const s of group.stages) {
        const backTo = (s.runtime as Record<string, any>)?.retry?.back_to as string | undefined;
        if (backTo && !childNameSet.has(backTo)) {
          issues.push({
            severity: "error",
            stageIndex: i,
            message: `Parallel group "${group.name}": "${s.name}" retry.back_to "${backTo}" is outside the parallel group`,
          });
        }
      }

      // Child reads must not reference sibling writes
      const siblingWrites = new Set<string>();
      for (const s of group.stages) {
        for (const w of s.runtime?.writes ?? []) siblingWrites.add(writeKey(w));
      }
      for (const s of group.stages) {
        if (s.runtime?.reads) {
          const ownWriteKeys = new Set((s.runtime?.writes ?? []).map(writeKey));
          for (const [, sourcePath] of Object.entries(s.runtime.reads)) {
            const rootKey = (sourcePath as string).split(".")[0];
            if (siblingWrites.has(rootKey) && !ownWriteKeys.has(rootKey)) {
              issues.push({
                severity: "error",
                stageIndex: i,
                message: `Parallel group "${group.name}": "${s.name}" reads "${rootKey}" which is written by a sibling stage`,
              });
            }
          }
        }
      }

      // Validate individual child stages
      for (const s of group.stages) {
        validateStage(s, i, allWrites, allStageNames, promptKeysNormalized, knownMcps, issues, stageByName, writeOriginStage);
      }

      // Track group writes
      for (const s of group.stages) {
        for (const w of s.runtime?.writes ?? []) {
          allWrites.set(writeKey(w), i);
          writeOriginStage.set(writeKey(w), s.name);
        }
      }

      continue;
    }

    // Regular stage
    const stage = entry as StageConfig;

    // Foreach item_var is self-referencing: the stage itself injects it for its own reads.
    // Register before validateStage so reads check can find it.
    if (stage.type === "foreach") {
      const rt = stage.runtime as Record<string, unknown> | undefined;
      const itemVar = rt?.item_var as string | undefined;
      if (itemVar) {
        allWrites.set(itemVar, i);
        writeOriginStage.set(itemVar, stage.name);
      }
    }

    validateStage(stage, i, allWrites, allStageNames, promptKeysNormalized, knownMcps, issues, stageByName, writeOriginStage);

    if (stage.runtime?.writes) {
      for (const w of stage.runtime.writes) {
        allWrites.set(writeKey(w), i);
        writeOriginStage.set(writeKey(w), stage.name);
      }
    }

    // Foreach collect_to is an implicit write
    if (stage.type === "foreach") {
      const rt = stage.runtime as Record<string, unknown> | undefined;
      const collectTo = rt?.collect_to as string | undefined;
      if (collectTo) {
        const key = collectTo.startsWith("store.") ? collectTo.slice(6) : collectTo;
        allWrites.set(key, i);
        writeOriginStage.set(key, stage.name);
      }
    }

    // Pipeline call writes are already in runtime.writes — no extra handling needed
  }

  return issues;
}

function validateStage(
  stage: StageConfig,
  entryIndex: number,
  allWrites: Map<string, number>,
  stageNames: Set<string>,
  promptKeysNormalized: Set<string> | undefined,
  knownMcps: Set<string> | undefined,
  issues: ValidationIssue[],
  stageByName?: Map<string, StageConfig>,
  writeOriginStage?: Map<string, string>,
): void {
  const runtime = stage.runtime;

  // Agent: check prompt exists (only when promptKeys provided)
  if (stage.type === "agent" && promptKeysNormalized) {
    const promptRef = runtime?.system_prompt || stage.name;
    const normalized = normalizePromptKey(promptRef);
    if (!promptKeysNormalized.has(normalized)) {
      issues.push({
        severity: "error",
        stageIndex: entryIndex,
        field: "system_prompt",
        message: `Missing prompt "${promptRef}" for stage "${stage.name}"`,
      });
    }
  }

  // Check MCP references exist in registry (warning, not error — pipelines may reference MCPs not yet installed)
  if (knownMcps) {
    const stageMcps = (stage as Record<string, unknown>).mcps as string[] | undefined;
    if (stageMcps) {
      for (const mcp of stageMcps) {
        if (!knownMcps.has(mcp)) {
          issues.push({
            severity: "warning",
            stageIndex: entryIndex,
            field: "mcps",
            message: `Stage "${stage.name}" references MCP "${mcp}" which is not registered`,
          });
        }
      }
    }
  }

  // Check reads reference valid upstream writes
  if (runtime?.reads) {
    for (const [alias, sourcePath] of Object.entries(runtime.reads)) {
      // Strip "store." prefix if present (YAML convention uses store.xxx for consistency with condition expressions)
      const normalizedPath = (sourcePath as string).startsWith("store.") ? (sourcePath as string).slice(6) : (sourcePath as string);
      const rootKey = normalizedPath.split(".")[0];
      if (!allWrites.has(rootKey)) {
        issues.push({
          severity: "error",
          stageIndex: entryIndex,
          field: "reads",
          message: `"${stage.name}" reads "${sourcePath}" (as "${alias}") but no prior stage writes "${rootKey}"`,
        });
      }
    }
  }

  // Check writes duplicates (against non-sibling stages)
  if (runtime?.writes) {
    for (const w of runtime.writes) {
      const k = writeKey(w);
      if (allWrites.has(k)) {
        // Skip warning if both stages declare the same exclusive_write_group
        const prevStageName = writeOriginStage?.get(k);
        const prevEntry = prevStageName ? stageByName?.get(prevStageName) : undefined;
        const prevGroup = prevEntry?.runtime?.exclusive_write_group;
        const curGroup = runtime.exclusive_write_group;
        if (curGroup && prevGroup && curGroup === prevGroup) {
          continue;
        }
        const prevEntryIndex = allWrites.get(k)!;
        issues.push({
          severity: "warning",
          stageIndex: entryIndex,
          field: "writes",
          message: `"${k}" in "${stage.name}" also written by entry ${prevEntryIndex + 1}`,
        });
      }
    }
  }

  // Check routing targets exist
  if (runtime?.on_reject_to && runtime.on_reject_to !== "error" && !stageNames.has(runtime.on_reject_to)) {
    issues.push({
      severity: "error",
      stageIndex: entryIndex,
      field: "on_reject_to",
      message: `on_reject_to "${runtime.on_reject_to}" does not match any stage`,
    });
  }
  if (runtime?.on_approve_to && !stageNames.has(runtime.on_approve_to)) {
    issues.push({
      severity: "error",
      stageIndex: entryIndex,
      field: "on_approve_to",
      message: `on_approve_to "${runtime.on_approve_to}" does not match any stage`,
    });
  }
  if (runtime?.retry?.back_to && !stageNames.has(runtime.retry.back_to)) {
    issues.push({
      severity: "error",
      stageIndex: entryIndex,
      field: "retry",
      message: `retry.back_to "${runtime.retry.back_to}" does not match any stage`,
    });
  }

  // Compensation: validate strategy value and stage type
  if (runtime?.compensation) {
    const strategy = runtime.compensation.strategy;
    if (!strategy || !["git_reset", "git_stash", "none"].includes(strategy)) {
      issues.push({
        severity: "error",
        stageIndex: entryIndex,
        field: "runtime.compensation.strategy",
        message: `Invalid compensation strategy "${strategy}". Must be "git_reset", "git_stash", or "none".`,
      });
    }
    if (stage.type !== "agent" && stage.type !== "script") {
      issues.push({
        severity: "warning",
        stageIndex: entryIndex,
        field: "runtime.compensation",
        message: `Compensation is only meaningful for agent/script stages, not "${stage.type}".`,
      });
    }
  }

  // Condition: validate branches
  if (stage.type === "condition") {
    const branches = (runtime as Record<string, unknown>)?.branches as Array<{ when?: string; default?: boolean; to?: string }> | undefined;
    if (!branches || !Array.isArray(branches)) {
      issues.push({ severity: "error", stageIndex: entryIndex, field: "branches", message: `Condition "${stage.name}" must have a branches array` });
    } else {
      const defaults = branches.filter((b) => b.default);
      const nonDefaults = branches.filter((b) => !b.default);
      if (defaults.length !== 1) {
        issues.push({ severity: "error", stageIndex: entryIndex, field: "branches", message: `Condition "${stage.name}" must have exactly 1 default branch (found ${defaults.length})` });
      }
      if (nonDefaults.length === 0) {
        issues.push({ severity: "error", stageIndex: entryIndex, field: "branches", message: `Condition "${stage.name}" must have at least 1 non-default branch` });
      }
      for (const b of branches) {
        if (b.to && !stageNames.has(b.to) && !["completed", "error", "blocked"].includes(b.to)) {
          issues.push({ severity: "error", stageIndex: entryIndex, field: "branches", message: `Condition "${stage.name}" branch.to "${b.to}" does not match any stage` });
        }
      }
    }
  }

  // Pipeline call: validate required fields
  if (stage.type === "pipeline") {
    const pipelineName = (runtime as Record<string, unknown>)?.pipeline_name as string | undefined;
    if (!pipelineName) {
      issues.push({ severity: "error", stageIndex: entryIndex, field: "pipeline_name", message: `Pipeline stage "${stage.name}" must have runtime.pipeline_name` });
    }
  }

  // Foreach: validate required fields
  if (stage.type === "foreach") {
    const rt = runtime as Record<string, unknown> | undefined;
    if (!rt?.pipeline_name) {
      issues.push({ severity: "error", stageIndex: entryIndex, field: "pipeline_name", message: `Foreach stage "${stage.name}" must have runtime.pipeline_name` });
    }
    if (!rt?.items) {
      issues.push({ severity: "error", stageIndex: entryIndex, field: "items", message: `Foreach stage "${stage.name}" must have runtime.items` });
    }
    if (!rt?.item_var) {
      issues.push({ severity: "error", stageIndex: entryIndex, field: "item_var", message: `Foreach stage "${stage.name}" must have runtime.item_var` });
    }
    // Warn if item_var is not explicitly listed in reads (auto-injected at runtime but explicit declaration improves readability)
    if (rt?.item_var && rt?.reads) {
      const reads = rt.reads as Record<string, string>;
      const itemVar = rt.item_var as string;
      if (!Object.keys(reads).includes(itemVar) && !Object.values(reads).includes(itemVar)) {
        issues.push({
          severity: "warning",
          stageIndex: entryIndex,
          field: "item_var",
          message: `Foreach stage "${stage.name}": item_var "${itemVar}" is not explicitly listed in reads. It will be auto-injected at runtime, but explicit declaration improves readability and edge agent visibility.`,
        });
      }
    }
  }

  // Check output schema field key duplicates
  if (stage.outputs) {
    for (const [storeKey, schema] of Object.entries(stage.outputs)) {
      if (schema.fields) {
        const fieldKeys = new Set<string>();
        for (const field of schema.fields) {
          if (fieldKeys.has(field.key)) {
            issues.push({
              severity: "warning",
              stageIndex: entryIndex,
              field: "outputs",
              message: `Duplicate field key "${field.key}" in output "${storeKey}" of "${stage.name}"`,
            });
          }
          fieldKeys.add(field.key);
        }
      }
    }
  }

  // Check writes/outputs consistency for agent and script stages
  if ((stage.type === "agent" || stage.type === "script") && runtime?.writes && runtime.writes.length > 0) {
    const outputKeys = stage.outputs ? new Set(Object.keys(stage.outputs)) : new Set<string>();
    const declaredWriteKeys = new Set(runtime.writes.map(writeKey));
    for (const w of runtime.writes) {
      const k = writeKey(w);
      if (!outputKeys.has(k)) {
        issues.push({
          severity: "warning",
          stageIndex: entryIndex,
          field: "outputs",
          message: `"${stage.name}" writes "${k}" but has no matching outputs entry`,
        });
      }
    }
    for (const k of outputKeys) {
      if (!declaredWriteKeys.has(k)) {
        issues.push({
          severity: "warning",
          stageIndex: entryIndex,
          field: "writes",
          message: `"${stage.name}" has outputs key "${k}" but does not include it in writes`,
        });
      }
    }
  }
}

function normalizePromptKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/\.md$/, "");
}

export function getValidationErrors(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === "error");
}

/**
 * Heuristic validation of prompt content against pipeline stage configuration.
 * Checks for permission mode / disallowed tool mismatches.
 * Returns warnings only — these are best-effort checks, not definitive.
 *
 * @param stages - Pipeline stage entries (from parsed YAML)
 * @param promptContents - Map of system_prompt name (kebab-case, no .md) to file content
 */
export function validatePromptAlignment(
  stages: StageEntry[],
  promptContents: Map<string, string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const flatStages: Array<{ stage: StageConfig; entryIndex: number }> = [];
  for (let i = 0; i < stages.length; i++) {
    const entry = stages[i];
    if (isParallelGroup(entry)) {
      for (const s of entry.parallel.stages) {
        flatStages.push({ stage: s, entryIndex: i });
      }
    } else {
      flatStages.push({ stage: entry as StageConfig, entryIndex: i });
    }
  }

  for (const { stage, entryIndex } of flatStages) {
    if (stage.type !== "agent") continue;
    const runtime = stage.runtime as StageRuntime | undefined;

    const promptName = runtime?.system_prompt || stage.name;
    const normalizedName = normalizePromptKey(promptName);
    const content = promptContents.get(normalizedName);
    if (!content) continue;

    // Check 1: plan mode stages should not instruct tool usage
    const permissionMode = (stage as Record<string, unknown>).permission_mode as string | undefined;
    if (permissionMode === "plan") {
      const toolPatterns = [
        /\bRead\s+(?:the\s+)?file/i,
        /\bSearch\s+(?:for|the)\b/i,
        /\bget_store_value\b/,
        /\bGrep\b/,
        /\bGlob\b/,
        /\bBash\b/,
      ];
      for (const pat of toolPatterns) {
        if (pat.test(content)) {
          issues.push({
            severity: "warning",
            stageIndex: entryIndex,
            field: "system_prompt",
            message: `"${stage.name}" has permission_mode:plan but prompt contains tool-like instruction (matched: ${pat.source})`,
          });
          break;
        }
      }
    }

    // Check 2: disallowed tools referenced in prompt
    const disallowed = runtime?.disallowed_tools as string[] | undefined;
    if (disallowed) {
      for (const tool of disallowed) {
        // Match the tool name as a word boundary to avoid false positives
        const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pat = new RegExp(`\\b${escaped}\\b`);
        if (pat.test(content)) {
          issues.push({
            severity: "warning",
            stageIndex: entryIndex,
            field: "system_prompt",
            message: `"${stage.name}" disallows tool "${tool}" but prompt references it`,
          });
        }
      }
    }
  }

  return issues;
}
