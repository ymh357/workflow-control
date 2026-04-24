// Pipeline-domain MCP tools: the authoring + launch surface.
// submit_pipeline persists an IR + prompts; validate_pipeline runs the
// full validator without persisting; run_pipeline starts a task against
// a previously-submitted version; describe_pipeline returns the pipeline
// schema (stages, ports, wires) for a task or version so external
// agents can learn the shape before calling read_port / answer_gate.

import { z } from "zod";
import { kernelNextBroadcaster } from "../../sse/singleton.js";
import { startPipelineRun } from "../../runtime/start-pipeline-run.js";
import { getPipelineIR } from "../../ir/sql.js";
import type { PipelineIR, StageIR, PortIR } from "../../ir/schema.js";
import type { ToolDef, ToolsDeps } from "../tool-types.js";
import { jsonResponse, errorResponse } from "../tool-helpers.js";

export function buildPipelineTools(deps: ToolsDeps): ToolDef[] {
  const { db, kernel, tscPath } = deps;

  return [
    {
      name: "submit_pipeline",
      description:
        "Submit a pipeline IR for validation + persistence. Returns the " +
        "version hash on success, or structured diagnostics on failure. " +
        "AgentStage prompts must be supplied via the 'prompts' map " +
        "(promptRef -> content).",
      inputSchema: {
        ir: z.unknown().describe("PipelineIR object (see kernel-next docs)"),
        parentHash: z.string().optional(),
        prompts: z
          .record(z.string(), z.string())
          .optional()
          .describe("Map of promptRef to prompt content; required if the IR contains AgentStage entries"),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          const prompts =
            args.prompts && typeof args.prompts === "object"
              ? (args.prompts as Record<string, string>)
              : undefined;
          const result = kernel.submit(args.ir, {
            parentHash: typeof args.parentHash === "string" ? args.parentHash : undefined,
            prompts,
          });
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "run_pipeline",
      description:
        "Start a new task running a previously-submitted pipeline. " +
        "Specify `name` (resolves to latest versionHash) or `versionHash` " +
        "(exact). Returns the taskId — poll get_task_status to observe.",
      inputSchema: {
        name: z.string().optional().describe("Pipeline name; resolves to latest versionHash"),
        versionHash: z.string().optional().describe("Exact pipeline versionHash; overrides name when both supplied"),
        seedValues: z.record(z.string(), z.unknown()).optional().describe("Per-port external input values"),
        policy: z.unknown().optional().describe("ExecutionPolicy (see terminal-design §5.3)"),
        model: z.string().optional(),
        maxTurns: z.number().int().positive().optional(),
        maxBudgetUsd: z.number().positive().optional(),
        taskId: z.string().optional(),
        checkpointConfig: z
          .object({
            enabled: z.boolean().optional(),
            workdir: z.string().optional(),
            maxDiffBytes: z.number().int().positive().optional(),
            timeouts: z
              .object({
                revParseMs: z.number().int().positive().optional(),
                snapshotMs: z.number().int().positive().optional(),
                diffMs: z.number().int().positive().optional(),
              })
              .optional(),
          })
          .optional()
          .describe("Per-task checkpoint config; omit to use defaults (enabled=true, workdir=process.cwd())"),
        envValues: z
          .record(z.string(), z.string())
          .optional()
          .describe("Environment variable values injected into stage.config.mcpServers at runtime. Stored per-task, deleted on task termination."),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          const result = await startPipelineRun({
            db,
            broadcaster: kernelNextBroadcaster,
            name: typeof args.name === "string" ? args.name : undefined,
            versionHash: typeof args.versionHash === "string" ? args.versionHash : undefined,
            seedValues:
              args.seedValues && typeof args.seedValues === "object"
                ? (args.seedValues as Record<string, unknown>)
                : undefined,
            policy: args.policy as never,
            model: typeof args.model === "string" ? args.model : undefined,
            maxTurns: typeof args.maxTurns === "number" ? args.maxTurns : undefined,
            maxBudgetUsd: typeof args.maxBudgetUsd === "number" ? args.maxBudgetUsd : undefined,
            taskId: typeof args.taskId === "string" ? args.taskId : undefined,
            checkpointConfig:
              args.checkpointConfig && typeof args.checkpointConfig === "object"
                ? (args.checkpointConfig as import("../../runtime/checkpoint/checkpoint.js").CheckpointConfig)
                : undefined,
            envValues:
              args.envValues && typeof args.envValues === "object" && args.envValues !== null
                ? (args.envValues as Record<string, string>)
                : undefined,
            tscPath,
          });
          if (result.ok === true) {
            return jsonResponse({
              ok: true,
              taskId: result.taskId,
              versionHash: result.versionHash,
            });
          }
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(result),
            }],
            isError: true,
          };
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "describe_pipeline",
      description:
        "Return the pipeline schema (stages, ports, wires, externalInputs) " +
        "for a task or a specific pipeline version. Supply EITHER taskId " +
        "(resolved to the version the task is currently running on) OR " +
        "versionHash (exact). Ports carry their declared type and (when " +
        "authored) description — external agents should call this BEFORE " +
        "read_port to discover the exact port names they can read. " +
        "Useful when the caller knows the high-level shape from design " +
        "prose but not the precise (stage, port) identifiers.",
      inputSchema: {
        taskId: z.string().optional().describe(
          "Resolve to the version the task is running on (latest stage_attempt).",
        ),
        versionHash: z.string().optional().describe(
          "Exact pipeline versionHash. Overrides taskId when both supplied.",
        ),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          const taskId = typeof args.taskId === "string" ? args.taskId : undefined;
          const explicitVh = typeof args.versionHash === "string" ? args.versionHash : undefined;
          if (!taskId && !explicitVh) {
            return errorResponse(
              "describe_pipeline: supply taskId or versionHash",
              { code: "MISSING_ARG" },
            );
          }
          let vh = explicitVh;
          if (!vh && taskId) {
            const row = db.prepare(
              `SELECT version_hash FROM stage_attempts
                WHERE task_id = ?
                ORDER BY started_at DESC LIMIT 1`,
            ).get(taskId) as { version_hash: string } | undefined;
            if (!row) {
              return errorResponse(
                `task '${taskId}' has no stage_attempts (unknown task or no run yet)`,
                { code: "TASK_NOT_FOUND", taskId },
              );
            }
            vh = row.version_hash;
          }
          const ir = getPipelineIR(db, vh!);
          if (!ir) {
            return errorResponse(
              `pipeline version '${vh}' not found`,
              { code: "VERSION_NOT_FOUND", versionHash: vh },
            );
          }
          return jsonResponse({
            ok: true,
            versionHash: vh,
            pipeline: describePipelineIR(ir),
          });
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "validate_pipeline",
      description:
        "Run the full validation pipeline (zod + structural + DAG + tsc) on " +
        "an IR without persisting. Returns ok + diagnostics[].",
      inputSchema: {
        ir: z.unknown(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          return jsonResponse(kernel.validate(args.ir));
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}

// describePipelineIR flattens a PipelineIR into a schema-only view.
// Ports drop `zod` (compiled form not useful to callers) but retain
// name / type / description. Gate stages gain a synthetic
// `__gate_feedback__` output entry so external agents know they can
// read it via read_port — the runner emits that port at answer time
// without declaring it in IR.outputs.
interface DescribedPort {
  name: string;
  type: string;
  description?: string;
}
interface DescribedStage {
  name: string;
  type: "agent" | "script" | "gate";
  inputs: DescribedPort[];
  outputs: DescribedPort[];
  fanout?: { input: string };
  config?: Record<string, unknown>;
}
interface DescribedWire {
  from: { source: "stage" | "external"; stage?: string; port: string };
  to: { stage: string; port: string };
  guard?: string;
}

function portToDescribed(p: PortIR): DescribedPort {
  const out: DescribedPort = { name: p.name, type: p.type };
  if (p.description !== undefined) out.description = p.description;
  return out;
}

function stageToDescribed(s: StageIR): DescribedStage {
  const out: DescribedStage = {
    name: s.name,
    type: s.type,
    inputs: s.inputs.map(portToDescribed),
    outputs: s.outputs.map(portToDescribed),
  };
  if (s.type !== "gate" && s.fanout?.input) {
    out.fanout = { input: s.fanout.input };
  }
  if (s.type === "gate") {
    // Synthesize the builtin __gate_feedback__ output so external
    // callers know they can observe reviewer comments.
    out.outputs = [
      ...out.outputs,
      {
        name: "__gate_feedback__",
        type: "string",
        description:
          "Builtin output: carries the free-text comment the reviewer " +
          "supplied when calling answer_gate (empty string when no " +
          "comment was given). Populated at gate answer time.",
      },
    ];
    out.config = {
      question: s.config.question,
      routing: s.config.routing,
    };
  } else if (s.type === "agent") {
    out.config = {
      promptRef: s.config.promptRef,
      mcpServers: s.config.mcpServers,
    };
  } else if (s.type === "script") {
    if (s.config.source === "registry") {
      out.config = { source: "registry", moduleId: s.config.moduleId };
    } else {
      // Do not echo the full inline TS source — external callers don't
      // need to re-see it to call read_port / answer_gate, and it can
      // be large. Surface only the variant + a byte count.
      out.config = {
        source: "inline",
        moduleSourceBytes: Buffer.byteLength(s.config.moduleSource, "utf8"),
      };
    }
  }
  return out;
}

export function describePipelineIR(ir: PipelineIR): {
  name: string;
  externalInputs: DescribedPort[];
  stages: DescribedStage[];
  wires: DescribedWire[];
  entry?: string;
} {
  return {
    name: ir.name,
    externalInputs: (ir.externalInputs ?? []).map(portToDescribed),
    stages: ir.stages.map(stageToDescribed),
    wires: ir.wires.map((w) => {
      const wire: DescribedWire =
        w.from.source === "external"
          ? {
              from: { source: "external", port: w.from.port },
              to: { stage: w.to.stage, port: w.to.port },
            }
          : {
              from: {
                source: "stage",
                stage: (w.from as { stage: string }).stage,
                port: w.from.port,
              },
              to: { stage: w.to.stage, port: w.to.port },
            };
      if (w.guard !== undefined) wire.guard = w.guard;
      return wire;
    }),
    entry: ir.entry,
  };
}
