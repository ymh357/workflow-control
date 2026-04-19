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
});

// --- Fanout / gate supporting shapes ---

export const FanoutSpecSchema = z.object({
  input: identifier,                       // input port name to iterate
});

export const GateQuestionSchema = z.object({
  text: z.string().min(1),
  options: z.array(z.string().min(1)).optional(),
});

export const GateRoutingSchema = z.object({
  // answer value → target stage name (special key '_default' for fallback).
  routes: z.record(z.string().min(1), identifier),
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
  }),
  fanout: FanoutSpecSchema.optional(),
});

export const ScriptStageSchema = z.object({
  ...StageCommon,
  type: z.literal("script"),
  config: z.object({
    moduleId: z.string().min(1),          // userland-provided module identifier
  }),
  fanout: FanoutSpecSchema.optional(),
});

export const GateStageSchema = z.object({
  ...StageCommon,
  type: z.literal("gate"),
  config: z.object({
    question: GateQuestionSchema,
    routing: GateRoutingSchema,
  }),
  // Gates cannot fanout: the schema simply does not declare a `fanout`
  // field, so TS narrowing prevents it at compile time. Runtime IR (loaded
  // from JSON that may have bypassed the type system) is additionally
  // checked by validator/structural.ts (GATE_FANOUT_FORBIDDEN).
});

export const StageIRSchema = z.discriminatedUnion("type", [
  AgentStageSchema,
  ScriptStageSchema,
  GateStageSchema,
]);

export const WireIRSchema = z.object({
  from: z.object({ stage: identifier, port: identifier }),
  to:   z.object({ stage: identifier, port: identifier }),
  guard: z.string().min(1).optional(),     // §6.2 runtime expression
});

export const PipelineIRSchema = z.object({
  name: z.string().min(1).max(128),
  stages: z.array(StageIRSchema).min(1),
  wires: z.array(WireIRSchema).default([]),
  entry: identifier.optional(),
});

export type PortIR = z.infer<typeof PortIRSchema>;
export type FanoutSpec = z.infer<typeof FanoutSpecSchema>;
export type GateQuestion = z.infer<typeof GateQuestionSchema>;
export type GateRouting = z.infer<typeof GateRoutingSchema>;
export type AgentStage = z.infer<typeof AgentStageSchema>;
export type ScriptStage = z.infer<typeof ScriptStageSchema>;
export type GateStage = z.infer<typeof GateStageSchema>;
export type StageIR = z.infer<typeof StageIRSchema>;
export type WireIR = z.infer<typeof WireIRSchema>;
export type PipelineIR = z.infer<typeof PipelineIRSchema>;

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
]);

export const IRPatchSchema = z.object({
  ops: z.array(IRPatchOpSchema).min(1),
});

export type IRPatchOp = z.infer<typeof IRPatchOpSchema>;
export type IRPatch = z.infer<typeof IRPatchSchema>;

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
    "FANOUT_INPUT_MISSING",
  ]),
  message: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export type ValidationResult =
  | { ok: true }
  | { ok: false; diagnostics: Diagnostic[] };
