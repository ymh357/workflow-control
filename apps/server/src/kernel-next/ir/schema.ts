// Zod schemas for kernel-next IR.
// See docs/kernel-next-terminal-design.md §3.2 / §5.2.
//
// This module is the single source of truth for IR runtime validation.
// submit_pipeline / validate_pipeline / propose_pipeline_change all parse
// through here before touching SQLite or codegen.
//
// Terminal-design shape:
//   - StageIR is a discriminated union keyed by `type`: agent | script | gate.
//     Each variant has a type-specific `config`.
//   - agent and script stages may declare `fanout` (per-element instantiation).
//   - gate stages cannot fanout.
//   - WireIR may carry an optional `guard` expression (runtime condition).

import { z } from "zod";

// Stage/port names must not collide with TS/JS reserved words: codegen
// emits `export namespace <name>` and reserved words produce TS1128/2819
// which the type validator can't map back to a wire.
const TS_RESERVED = new Set([
  "any", "as", "boolean", "break", "case", "catch", "class", "const",
  "constructor", "continue", "debugger", "declare", "default", "delete",
  "do", "else", "enum", "export", "extends", "false", "finally", "for",
  "from", "function", "get", "if", "implements", "import", "in",
  "instanceof", "interface", "let", "module", "namespace", "never", "new",
  "null", "number", "of", "package", "private", "protected", "public",
  "readonly", "require", "return", "set", "static", "string", "super",
  "switch", "symbol", "this", "throw", "true", "try", "type", "typeof",
  "undefined", "unknown", "var", "void", "while", "with", "yield",
]);

const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "must be a valid JS identifier")
  .refine((s) => !TS_RESERVED.has(s), {
    message: "must not be a TS/JS reserved word",
  });

export const PortIRSchema = z.object({
  name: identifier,
  type: z.string().min(1),       // TS type source; deep check deferred to tsc
  zod: z.string().optional(),    // optional zod expression for runtime shape
  // Human-readable semantic description of what this port carries,
  // what values it accepts, and whether it is optional. Consumed by
  // external callers (main Claude) driving a pipeline over MCP: they
  // read externalInputs + their descriptions to know what to ask the
  // user. Persisted through canonicalisation so it's part of
  // version_hash (changing port semantics = new version).
  description: z.string().optional(),
  // 2026-04-28 (Bug 7): for top-level externalInputs[] only. When true,
  // startPipelineRun seeds null when the caller omits the key instead of
  // raising SEED_VALUES_MISSING_KEY. Pre-Bug-7 IRs default to false
  // (current behaviour: every externalInput is required). Stage-internal
  // input/output ports ignore this flag — it's a seed-validation policy,
  // not a wire/contract one.
  optional: z.boolean().optional(),
});

// --- Fanout / gate supporting shapes ---

export const FanoutSpecSchema = z.object({
  input: identifier,                       // input port name to iterate
  // P5.1 — per-stage parallelism cap. Protects against Anthropic rate
  // limits + unbounded cost when an array has many elements. Runner
  // defaults to 3 when unspecified; 20 is an arbitrary hard ceiling
  // (mirrors RetrySpec's pattern of "typo guard, not policy").
  concurrency: z.number().int().positive().max(20).optional(),
  // P4 (2026-04-29) — per-element retry on transient executor error. A
  // single Anthropic API blip should not nuke an entire fanout run
  // (observed in 0G dogfood: 5/6 evidenceGather children succeeded but
  // one transient `api_error` failed the whole stage and the pipeline
  // halted before findingsAuthoring could even start). When set,
  // runner reschedules a failed element up to `elementRetries` times
  // (re-executes the executor in-place, opens a new
  // stage_attempt(kind='fanout_element') each retry, preserves
  // fanout_element_idx). Default 0 (no retries) — the existing
  // first-error behaviour.
  elementRetries: z.number().int().nonnegative().max(5).optional(),
});

// Answer option for a gate. `value` is the exact string the runner
// will route on (must match a key in GateRouting.routes).
// `description` is the human-readable explanation of what this answer
// means — shown to the user when the caller (main Claude) relays the
// gate question. P3.7: promoted from bare string[] so gates with
// multiple reject-class or branch-class answers can be presented in
// natural language without the caller having to hand-translate the
// raw routing keys.
export const GateAnswerOptionSchema = z.object({
  value: z.string().min(1),
  description: z.string().optional(),
});

export const GateQuestionSchema = z.object({
  text: z.string().min(1),
  options: z.array(GateAnswerOptionSchema).optional(),
});

// Script retry spec: when a script stage fails (executor returns
// status=error), the runner reruns `backToStage` and every stage
// downstream of it, up to `maxRetries` times. The upper bound is
// arbitrary but intentional — prevents typos like `max_retries:
// 99999` from hiding runaway costs. pipeline-generator uses 1.
export const RetrySpecSchema = z.object({
  maxRetries: z.number().int().min(1).max(10),
  backToStage: identifier,
});

// Sub-agent definition — maps to Claude Agent SDK's AgentDefinition
// (description/prompt/tools/model/maxTurns). legacy YAML's
// runtime.agents[<name>] is extracted into this shape by the converter
// (Slice D / Task D2). disallowedTools/skills/mcpServers are not
// captured in this milestone; pipeline-generator's prompt-writer uses
// only the five fields below.
// SubAgent name is passed verbatim to the Claude Agent SDK's
// AgentDefinition.name; it does not participate in TS codegen
// (no `export namespace`), so the JS-identifier constraint used
// elsewhere in the IR does not apply. Accept kebab-case and other
// common shapes while keeping a sanity length bound.
export const SubAgentDefSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/, "must start with a letter or underscore; letters, digits, underscore, dash only"),
  description: z.string().min(1),
  prompt: z.string().min(1),
  tools: z.array(z.string()).optional(),
  model: z.enum(["sonnet", "opus", "haiku", "inherit"]).optional(),
  maxTurns: z.number().int().positive().optional(),
});

export const McpServerDeclSchema = z.object({
  name: z.string().min(1).max(64)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/, "must start with letter or underscore; letters, digits, underscore, dash only")
    .refine((n) => !/^__.+__$/.test(n), "names matching __*__ are reserved (would shadow kernel MCP)"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  envKeys: z.array(z.string()).default([]),
});
export type McpServerDecl = z.infer<typeof McpServerDeclSchema>;

export const GateRoutingSchema = z.object({
  // Routes: answer value → target stage name(s). Single stage stays a
  // string; multiple stages (used when a human gate gates a parallel
  // block whose stages all need simultaneous authorization) use an
  // array. Canonical form preserves the input shape so existing
  // fixture hashes stay byte-identical; array values are additionally
  // sorted in canonical form to make permutations hash-equivalent.
  routes: z.record(
    z.string().min(1),
    z.union([identifier, z.array(identifier).min(1)]),
  ),
});

// --- Stage variants (discriminated union on `type`) ---

const StageCommon = {
  name: identifier,
  inputs: z.array(PortIRSchema).default([]),
  outputs: z.array(PortIRSchema).default([]),
};

export const AgentStageSchema = z.object({
  ...StageCommon,
  type: z.literal("agent"),
  config: z.object({
    promptRef: z.string().min(1),         // resolved by userland prompt assembler
    subAgents: z.array(SubAgentDefSchema).optional(),
    mcpServers: z.array(McpServerDeclSchema)
      .optional()
      .refine(
        (arr) => !arr || new Set(arr.map((m) => m.name)).size === arr.length,
        "duplicate mcpServer name within a stage",
      ),
    // 2026-04-26 cross-segment resume pivot. When set, names a wire-upstream
    // agent stage in a different segment whose persisted SDK session this
    // stage will resume. Default (omitted) → no cross-segment resume.
    // Validator (structural.ts) enforces: target exists, is wire-reachable,
    // is in a different segment.
    cross_segment_resume_from: z.string().min(1).optional(),
  }),
  fanout: FanoutSpecSchema.optional(),
});

// D'-1 / D'-3 — ScriptStage has two variants:
//
//   1. `source: "registry"` (or omitted for backward-compat) — references
//      a moduleId registered in the kernel's builtin-script registry.
//      The IR never carries the implementation; submit-time validation
//      checks moduleId ∈ BUILTIN_SCRIPT_IDS.
//
//   2. `source: "inline"` (D'-3) — carries the TypeScript source of the
//      ScriptModule directly. The runtime compiles + imports it at
//      task-start. Submit-time validation: import whitelist, tsc, and
//      a contract test using `sampleInputs`.
//
// The discriminant is `config.source`. Zod preprocess defaults legacy
// shape (no `source`, has `moduleId`) to `source: "registry"`.
const ScriptConfigRegistrySchema = z.object({
  source: z.literal("registry"),
  moduleId: z.string().min(1),
  retry: RetrySpecSchema.optional(),
});

const ScriptConfigInlineSchema = z.object({
  source: z.literal("inline"),
  // TypeScript source text. Must `export default` a value conforming to
  // ScriptModule (enforced at submit via compile-inline-script). Bounded
  // at 64KB to keep IR rows manageable; scripts larger than this are a
  // smell — factor into multiple stages.
  moduleSource: z.string().min(1).max(64 * 1024),
  // Per-input-port sample values used for the submit-time contract test
  // (Layer 3). Keys must equal the stage's declared input port names.
  // At run time this value is NOT consulted — the real wire delivery
  // provides inputs; sampleInputs only exists for pre-run validation.
  sampleInputs: z.record(z.string(), z.unknown()),
  retry: RetrySpecSchema.optional(),
});

export const ScriptStageSchema = z.object({
  ...StageCommon,
  type: z.literal("script"),
  config: z.discriminatedUnion("source", [
    ScriptConfigRegistrySchema,
    ScriptConfigInlineSchema,
  ]),
  fanout: FanoutSpecSchema.optional(),
});

/**
 * Normalise a legacy ScriptStage `config` (no `source`, has `moduleId`)
 * into the `source: "registry"` variant so the discriminated union
 * parse succeeds. Applied as a top-level preprocess on StageIRSchema
 * below, NOT on ScriptStageSchema directly — ScriptStageSchema must
 * remain a ZodObject so z.discriminatedUnion("type", [...]) accepts it.
 */
function normalizeLegacyScriptConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const stage = raw as { config?: unknown; type?: unknown };
  if (stage.type !== "script") return raw;
  const cfg = stage.config;
  if (cfg && typeof cfg === "object" && !("source" in cfg) && "moduleId" in cfg) {
    return { ...stage, config: { source: "registry", ...(cfg as Record<string, unknown>) } };
  }
  return raw;
}

export const GateStageSchema = z.object({
  ...StageCommon,
  type: z.literal("gate"),
  config: z.object({
    question: GateQuestionSchema,
    routing: GateRoutingSchema,
    // P5.2 (D6) — opt-in gate deadline. When set, a periodic sweeper
    // (gate-timeout-sweeper) cancels the owning task once created_at +
    // timeout_minutes*60_000 has elapsed without an answer. Omitted →
    // gate never times out. Upper bound (7 days) is a typo guard, not
    // policy — mirrors RetrySpec's pattern.
    timeout_minutes: z.number().int().positive().max(10080).optional(),
  }),
  // Gates cannot fanout: the schema simply does not declare a `fanout`
  // field, so TS narrowing prevents it at compile time. Runtime IR (loaded
  // from JSON that may have bypassed the type system) is additionally
  // checked by validator/structural.ts (GATE_FANOUT_FORBIDDEN).
});

const StageIRStrictSchema = z.discriminatedUnion("type", [
  AgentStageSchema,
  ScriptStageSchema,
  GateStageSchema,
]);

/**
 * StageIR parser that normalises legacy ScriptStage `config`
 * (no `source`, has `moduleId`) to `source: "registry"` before the
 * discriminated-union parse. Inferred type equals the strict schema's
 * output — the preprocess only touches input shape.
 */
export const StageIRSchema = z.preprocess(
  normalizeLegacyScriptConfig,
  StageIRStrictSchema,
) as unknown as typeof StageIRStrictSchema;

const WireSourceSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("stage"),
    stage: identifier,
    port: identifier,
  }),
  z.object({
    source: z.literal("external"),
    port: identifier,
  }),
]);

// Backward-compat preprocess: a legacy `from` lacking `source` is
// treated as `source: "stage"`. Keeps the discriminated union clean
// without forcing every existing IR fixture to be rewritten.
function normalizeWireFrom(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const wire = raw as { from?: unknown };
  const from = wire.from;
  if (from && typeof from === "object" && !("source" in from)) {
    return { ...wire, from: { source: "stage", ...(from as Record<string, unknown>) } };
  }
  return raw;
}

export const WireIRSchema = z.preprocess(
  normalizeWireFrom,
  z.object({
    from: WireSourceSchema,
    to: z.object({ stage: identifier, port: identifier }),
    guard: z.string().min(1).optional(),   // §6.2 runtime expression
  }),
);

// A3 (Phase 4.5 Tier 3): a pipeline-level data dictionary. Each key
// names a semantic store slot; `produced_by` points at the concrete
// output port that carries it. `type` is a free-form TS type string —
// it must textually match the referenced port's `type` (trimmed). Deep
// structural equivalence is deferred to tsc by the same convention the
// rest of the IR uses for type strings.
export const StoreSchemaEntrySchema = z.object({
  type: z.string().min(1),
  description: z.string().optional(),
  produced_by: z.object({
    stage: identifier,
    port: identifier,
  }),
});

export const StoreSchemaSchema = z.record(z.string().min(1), StoreSchemaEntrySchema);

export const PipelineIRSchema = z.object({
  name: z.string().min(1).max(128),
  stages: z.array(StageIRSchema).min(1),
  wires: z.array(WireIRSchema).default([]),
  entry: identifier.optional(),
  externalInputs: z.array(PortIRSchema).default([]),
  store_schema: StoreSchemaSchema.optional(),
  // Single-session mode: when "single", consecutive agent stages share
  // one SDK conversation (per spec 2026-04-25-single-session-mode-design).
  // Default "multi" preserves pre-2026-04-25 behavior.
  session_mode: z.enum(["multi", "single"]).default("multi"),
});

export type PortIR = z.infer<typeof PortIRSchema>;
export type FanoutSpec = z.infer<typeof FanoutSpecSchema>;
export type GateQuestion = z.infer<typeof GateQuestionSchema>;
export type GateRouting = z.infer<typeof GateRoutingSchema>;
export type SubAgentDef = z.infer<typeof SubAgentDefSchema>;
export type AgentStage = z.infer<typeof AgentStageSchema>;
export type ScriptStage = z.infer<typeof ScriptStageSchema>;
export type GateStage = z.infer<typeof GateStageSchema>;
export type StageIR = z.infer<typeof StageIRSchema>;

// WireSource: strict discriminated union (after zod preprocess). Callers
// that have just parsed an IR through WireIRSchema see this shape.
export type WireSource = z.infer<typeof WireSourceSchema>;

// WireIR type: legacy-compatible at the TypeScript level. The runtime
// schema (WireIRSchema) always preprocesses missing `source` to "stage",
// so the normalized shape at runtime is WireSource. At the type level we
// accept the legacy `{stage, port}` literal (source optional) so existing
// IR fixtures compile without modification; callers that need to branch
// on `source` must use a type guard / discriminant check. See Task 1.2.
export type WireIR = {
  from:
    | { source?: "stage"; stage: string; port: string }
    | { source: "external"; port: string };
  to: { stage: string; port: string };
  guard?: string;
};

// PipelineIR type: externalInputs and session_mode are typed as optional
// to keep legacy fixtures compiling. At runtime PipelineIRSchema defaults
// them (externalInputs to [], session_mode to "multi"), so consumers
// observing a parsed IR will always see concrete values.
export type StoreSchemaEntry = z.infer<typeof StoreSchemaEntrySchema>;
export type StoreSchema = z.infer<typeof StoreSchemaSchema>;

export type PipelineIR = Omit<z.infer<typeof PipelineIRSchema>, "externalInputs" | "wires" | "session_mode"> & {
  externalInputs?: PortIR[];
  wires: WireIR[];
  session_mode?: "multi" | "single";
};

// IRPatch — see docs/kernel-next-terminal-design.md §10.
// configPatch is typed as `unknown` at the Zod layer because the valid shape
// depends on the target stage's `type`; validator+downstream code applies
// variant-specific rules. Concrete shape is enforced in patch application.
export const IRPatchOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_stage"), stage: StageIRSchema }),
  z.object({ op: z.literal("remove_stage"), stageName: identifier }),
  z.object({ op: z.literal("add_wire"), wire: WireIRSchema }),
  z.object({ op: z.literal("remove_wire"), wire: WireIRSchema }),
  z.object({
    op: z.literal("update_port_type"),
    stage: identifier,
    port: identifier,
    direction: z.enum(["in", "out"]),
    newType: z.string().min(1),
  }),
  z.object({
    op: z.literal("update_stage_config"),
    stage: identifier,
    configPatch: z.record(z.string(), z.unknown()),
  }),
  // Bug 8a (2026-04-28 dogfood): pipeline-modifier needs to add a new
  // externalInput when its modification adds a stage that consumes one.
  // Without these ops, the agent invents an op name, zod rejects, and the
  // modifier silently submits ops:[] with verdict "safe", masking the
  // failure. Mirror add_stage / remove_stage shape.
  z.object({ op: z.literal("add_external_input"), port: PortIRSchema }),
  z.object({ op: z.literal("remove_external_input"), name: identifier }),
]);

export const IRPatchSchema = z.object({
  // ops may be empty: a prompts-only change is a legitimate proposal
  // (pipelineVersionHash folds prompts into the hash). The "is this
  // actually a change?" guard lives at propose() and raises
  // NO_OP_PROPOSAL when proposedHash === currentVersion.
  ops: z.array(IRPatchOpSchema).min(0),
});

// IRPatchOp/IRPatch types use the relaxed WireIR at the add_wire/remove_wire
// sites so existing patch fixtures (legacy `from: { stage, port }` literal)
// continue to typecheck. Runtime validation goes through IRPatchOpSchema
// which enforces the discriminated union via WireIRSchema's preprocess.
type _InferredIRPatchOp = z.infer<typeof IRPatchOpSchema>;
export type IRPatchOp =
  | Exclude<_InferredIRPatchOp, { op: "add_wire" } | { op: "remove_wire" }>
  | { op: "add_wire"; wire: WireIR }
  | { op: "remove_wire"; wire: WireIR };
export type IRPatch = { ops: IRPatchOp[] };

// Diagnostic — returned by validator and tsc-based type checker.
export const DiagnosticSchema = z.object({
  code: z.enum([
    "ZOD_PARSE_ERROR",
    "DUPLICATE_STAGE_NAME",
    "DUPLICATE_PORT_NAME",
    "WIRE_SOURCE_PORT_MISSING",
    "WIRE_TARGET_PORT_MISSING",
    "WIRE_SOURCE_DIRECTION_WRONG",
    "WIRE_TARGET_DIRECTION_WRONG",
    "WIRE_TARGET_ALREADY_DRIVEN",
    "DAG_HAS_CYCLE",
    "ENTRY_STAGE_MISSING",
    "WIRE_TYPE_MISMATCH",             // reserved for M2 tsc diagnostics
    "PATCH_APPLY_ERROR",
    "PROPOSAL_NOT_FOUND",             // P2.1 approve/reject
    "PROPOSAL_ALREADY_RESOLVED",
    // A0 additions — stage-type / gate / fanout constraints
    "GATE_FANOUT_FORBIDDEN",
    "GATE_ROUTING_TARGET_MISSING",
    "GATE_TARGET_SHARED",
    "FANOUT_INPUT_MISSING",
    // A1.2 additions — gate lifecycle
    "GATE_NOT_FOUND",
    "GATE_ALREADY_ANSWERED",
    "GATE_ANSWER_INVALID",
    // A3.1 addition — wire guard runtime failure
    "NO_ACTIVE_WIRE",
    // A8 / F5 — hot-update migration lifecycle
    "MIGRATION_IN_PROGRESS",
    "MIGRATION_FAILED",
    // 2026-04-20 — externalInputs schema extension
    "WIRE_EXTERNAL_SOURCE_PORT_MISSING",
    "DUPLICATE_EXTERNAL_INPUT_NAME",
    "EXTERNAL_INPUT_COLLIDES_WITH_STAGE",
    "RESERVED_STAGE_NAME",
    // 2026-04-24 — prompts-in-SQLite submit extension
    "PROMPT_REF_MISSING",
    "PROMPT_REF_UNUSED",
    "PROMPT_CONTENT_EMPTY",
    // Stage 5A — propose-pipeline lifecycle
    "CONFLICT",
    "VERSION_NOT_IN_HISTORY",
    "REGISTRY_PIPELINE_NOT_FOUND",
    // Stage 5B — migration execution
    "MIGRATION_INTERRUPT_TIMEOUT",
    "MIGRATION_RESUME_FAILED",
    "ROLLBACK_EMPTY_DIFF",
    // Phase 4.5 Tier 3 — A3 store_schema drift
    "STORE_SCHEMA_STAGE_MISSING",
    "STORE_SCHEMA_PORT_MISSING",
    "STORE_SCHEMA_TYPE_MISMATCH",
    // Phase 6 P6-8 — pipeline-generator agent stripped I/O schema
    // before calling submit_pipeline. Without a dataflow the submitted
    // pipeline is a no-op but schema-legal. Reject.
    "EMPTY_DATAFLOW",
    // Phase 6 propose-UI — IRPatchSchema now accepts ops:[] (for
    // prompts-only proposals). The "nothing actually changed" guard
    // lives at propose() and raises this when
    // proposedHash === currentVersion (empty patch + no/identical
    // prompts, or non-empty but idempotent patch).
    "NO_OP_PROPOSAL",
    // Phase 4 P4.1 (D8) — retry_task MCP tool diagnostics.
    "TASK_NOT_FOUND",
    "NO_FAILED_STAGE",
    "UNKNOWN_STAGE",
    // Phase 4 P4.3 (D4) — cancel_task MCP tool diagnostics.
    "TASK_ALREADY_TERMINAL",
    // D'-1 — script stage moduleId resolution at submit time.
    // Emitted when a ScriptStage.config.moduleId is not registered in
    // the kernel's builtin script registry (see builtin-scripts/index.ts).
    // AI-generated pipelines in D'-1 can only reference builtin modules;
    // D'-3 will add inline-source scripts as a second ScriptStage config
    // variant and this diagnostic will continue to apply to the moduleId
    // branch.
    "SCRIPT_MODULE_NOT_REGISTERED",
    // D'-3 — inline script safety layers (submit-time Layer 1+2+3).
    "SCRIPT_COMPILE_ERROR",                 // Layer 1 — tsc failed
    "SCRIPT_IMPORT_NOT_WHITELISTED",        // Layer 2 — off-whitelist import
    "SCRIPT_DYNAMIC_IMPORT_FORBIDDEN",      // Layer 2 — dynamic import() / require()
    "SCRIPT_SAMPLE_INPUT_MISSING",          // Layer 3 — no sample for declared input port
    "SCRIPT_SAMPLE_INPUT_UNEXPECTED",       // Layer 3 — sample key ∉ declared inputs
    "SCRIPT_IMPORT_ERROR",                  // Layer 3 — emitted JS failed to import
    "SCRIPT_CONTRACT_THROW",                // Layer 3 — script threw on sampleInputs
    "SCRIPT_CONTRACT_BAD_RETURN",           // Layer 3 — run() returned non-object
    "SCRIPT_CONTRACT_MISSING_OUTPUT",       // Layer 3 — declared output port missing in return
    // 2026-04-26 cross-segment resume pivot — emitted by validator/structural.ts
    "CROSS_SEGMENT_TARGET_NOT_FOUND",          // target stage doesn't exist
    "CROSS_SEGMENT_TARGET_NOT_AGENT",          // target exists but is not an agent stage
    "CROSS_SEGMENT_TARGET_NOT_REACHABLE",      // target exists but not wire-upstream
    "CROSS_SEGMENT_TARGET_SAME_SEGMENT",       // target is in the same segment as the consumer
    "CROSS_SEGMENT_RESUME_FROM_REQUIRES_SINGLE", // field set on a multi-mode pipeline
    // 2026-04-26 F17 secret-gate
    "NO_PENDING_SECRET_GATE",
    "SECRET_KEY_NOT_REQUIRED",
    // 2026-04-26 mcp-catalog subsystem (Phase 1)
    "CATALOG_ENTRY_NOT_FOUND",
    "CATALOG_ENTRY_ID_CONFLICT",
    "CATALOG_INVALID_ENTRY",
    "CATALOG_BUILTIN_NOT_WRITABLE",
    "CATALOG_LLM_OVERLAY_UNAVAILABLE",
    // 2026-04-27 mcp-catalog Phase 2 — inventory + provisioning
    "MCP_PROVISION_ENVKEY_MISSING",
    "MCP_PROVISION_PACKAGE_NOT_FOUND",
    "MCP_PROVISION_HEALTHCHECK_TIMEOUT",
    "MCP_INVENTORY_DECRYPT_FAILED",
    // 2026-04-27 pipeline-modifier builtin
    "MODIFIER_TARGET_UNKNOWN",
    "MODIFIER_SELF_MODIFY_REJECTED",
  ]),
  message: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export type ValidationResult =
  | { ok: true }
  | { ok: false; diagnostics: Diagnostic[] };
