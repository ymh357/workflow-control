// startPipelineRun — single entry function for starting a task on any
// submitted pipeline. Callers: MCP run_pipeline tool, HTTP route,
// pg-entry's start_pipeline_generator.
//
// Responsibilities:
//   1. Resolve {name, versionHash} → a single versionHash whose IR is in
//      pipeline_versions.
//   2. Build executor: RealStageExecutor with DbPromptResolver(versionHash),
//      mcpServerFactory threading the monorepo tscPath.
//   3. Consult MOCK_HANDLER_REGISTRY for diamond-family handler overrides.
//   4. Fire runPipeline in background (fire-and-forget).
//   5. Return { taskId, versionHash }.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import type { PipelineIR } from "../ir/schema.js";
import {
  getLatestVersionHashByName,
  getPipelineIR,
} from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { createKernelMcp } from "../mcp/server.js";
import { runPipeline } from "./runner.js";
import { RealStageExecutor } from "./real-executor.js";
import { DbPromptResolver } from "./db-prompt-resolver.js";
import { MOCK_HANDLER_REGISTRY } from "./mock-handler-registry.js";
import type { StageHandlerMap } from "./mock-executor.js";
import type { KernelNextBroadcaster } from "../sse/broadcaster.js";
import { logger } from "../../lib/logger.js";

export interface StartPipelineRunInput {
  db: DatabaseSync;
  broadcaster: KernelNextBroadcaster;
  name?: string;
  versionHash?: string;
  taskId?: string;
  seedValues?: Record<string, unknown>;
  policy?: ExecutionPolicyShape;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  tscPath?: string;
  timeoutMs?: number;
}

// Minimal ExecutionPolicy shape — only policy.default is consumed by
// the current RealStageExecutor. perStage is accepted but ignored for
// now; future milestone wires it through.
export interface ExecutionPolicyShape {
  default?: {
    budget?: { maxTurns?: number; maxCostUsd?: number; timeoutSeconds?: number };
    promptAssembly?: { model?: string };
    retry?: unknown;
    permission?: unknown;
  };
  perStage?: Record<string, unknown>;
}

export type StartPipelineRunResult =
  | { ok: true; taskId: string; versionHash: string }
  | {
      ok: false;
      code:
        | "MISSING_INPUT"
        | "UNKNOWN_PIPELINE"
        | "UNKNOWN_VERSION_HASH"
        | "AMBIGUOUS_INPUT";
      message: string;
      context?: Record<string, unknown>;
    };

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TURNS = 30;
const DEFAULT_MAX_BUDGET_USD = 2;

// Build a prompts map covering every AgentStage promptRef in the IR so
// that KernelService.submit() accepts the IR when auto-seeding a
// mock-registry pipeline. The content value is a non-empty placeholder
// — the mock registry supplies synthetic handlers that bypass the
// real prompt-assembly path, so this never reaches an LLM.
function buildMockSeedPrompts(ir: PipelineIR): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of ir.stages) {
    if (s.type === "agent" && s.config.promptRef) {
      out[s.config.promptRef] = s.config.promptRef;
    }
  }
  return out;
}

export async function startPipelineRun(
  input: StartPipelineRunInput,
): Promise<StartPipelineRunResult> {
  // --- Resolve versionHash ---
  if (!input.name && !input.versionHash) {
    return {
      ok: false,
      code: "MISSING_INPUT",
      message: "one of `name` or `versionHash` is required",
    };
  }

  let versionHash: string;
  let ir: PipelineIR;

  if (input.versionHash) {
    const found = getPipelineIR(input.db, input.versionHash);
    if (!found) {
      return {
        ok: false,
        code: "UNKNOWN_VERSION_HASH",
        message: `no pipeline version found for hash '${input.versionHash}'`,
        context: { versionHash: input.versionHash },
      };
    }
    if (input.name && found.name !== input.name) {
      return {
        ok: false,
        code: "AMBIGUOUS_INPUT",
        message: `versionHash '${input.versionHash}' belongs to pipeline '${found.name}', not '${input.name}'`,
        context: { versionHash: input.versionHash, expectedName: input.name, actualName: found.name },
      };
    }
    versionHash = input.versionHash;
    ir = found;
  } else {
    // name-only path
    const name = input.name!;
    let hash = getLatestVersionHashByName(input.db, name);

    // Mock-registry fallback: if the name is a mock entry and no DB row
    // exists yet, seed the IR and retry lookup. This makes diamond*
    // pipelines runnable without a dedicated bootstrap step.
    if (!hash && MOCK_HANDLER_REGISTRY[name]) {
      const entry = MOCK_HANDLER_REGISTRY[name]!;
      const svc = new KernelService(input.db, { skipTypeCheck: true });
      const seedRes = svc.submit(entry.ir, { prompts: buildMockSeedPrompts(entry.ir) });
      if (!seedRes.ok) {
        return {
          ok: false,
          code: "UNKNOWN_PIPELINE",
          message: `could not seed mock pipeline '${name}': ${seedRes.diagnostics.map((d) => d.code).join(",")}`,
          context: { name },
        };
      }
      hash = seedRes.versionHash;
    }

    if (!hash) {
      return {
        ok: false,
        code: "UNKNOWN_PIPELINE",
        message: `no pipeline registered under name '${name}'`,
        context: { name },
      };
    }
    const found = getPipelineIR(input.db, hash);
    if (!found) {
      return {
        ok: false,
        code: "UNKNOWN_VERSION_HASH",
        message: `resolved versionHash '${hash}' for name '${name}' but ir_json is missing`,
        context: { name, versionHash: hash },
      };
    }
    versionHash = hash;
    ir = found;
  }

  // --- Determine handlers from registry (if any) ---
  const nameForRegistry = input.name ?? ir.name;
  const mockEntry = MOCK_HANDLER_REGISTRY[nameForRegistry];
  const handlers: StageHandlerMap = mockEntry ? mockEntry.handlers : {};

  // --- Merge policy ---
  const model = input.model
    ?? input.policy?.default?.promptAssembly?.model
    ?? DEFAULT_MODEL;
  const maxTurns = input.maxTurns
    ?? input.policy?.default?.budget?.maxTurns
    ?? DEFAULT_MAX_TURNS;
  const maxBudgetUsd = input.maxBudgetUsd
    ?? input.policy?.default?.budget?.maxCostUsd
    ?? DEFAULT_MAX_BUDGET_USD;

  // --- Build executor ---
  //
  // runner.ts picks `opts.executor ?? new MockStageExecutor({handlers})`.
  // When a mock-registry entry carries synthetic handlers, omit the
  // executor so the runner falls back to MockStageExecutor — otherwise
  // the handlers are dead code. Mock entries with EMPTY handlers
  // (e.g. diamond-real) still need RealStageExecutor. AI-submitted and
  // legacy-YAML pipelines always go through RealStageExecutor.
  const db = input.db;
  const tscPath = input.tscPath;
  const useMockHandlers = mockEntry !== undefined && Object.keys(mockEntry.handlers).length > 0;
  const executor = useMockHandlers
    ? undefined
    : new RealStageExecutor({
        mcpServerFactory: (_dispatcher, portRuntime) =>
          createKernelMcp(db, {
            surface: "combined",
            portRuntime,
            tscPath,
          }),
        promptResolver: new DbPromptResolver(db, versionHash),
        model,
        maxTurns,
        maxBudgetUsd,
      });

  const taskId = input.taskId
    ?? `${nameForRegistry}-${Date.now()}-${randomUUID().slice(0, 8)}`;

  // --- Fire runPipeline in background ---
  //
  // runPipeline throws synchronously on setup errors (e.g.
  // SEED_VALUES_MISSING_KEY) before any SSE event is published. Translate
  // such a throw into a synthetic run_final=failed so SSE subscribers see
  // a terminal event instead of a silent dangling task.
  void runPipeline({
    db,
    ir,
    taskId,
    versionHash,
    handlers,
    executor,
    seedValues: input.seedValues,
    broadcaster: input.broadcaster,
  }, input.timeoutMs).catch((err: unknown) => {
    logger.error(
      { taskId, versionHash, err },
      "[startPipelineRun] background runPipeline rejected",
    );
    try {
      input.broadcaster.publish({
        type: "run_final",
        taskId,
        timestamp: new Date().toISOString(),
        data: {
          finalState: "failed",
          stageErrors: [
            {
              stage: "",
              message: (err as Error).message ?? String(err),
            },
          ],
        },
      });
    } catch (publishErr) {
      logger.error(
        { taskId, err: publishErr },
        "[startPipelineRun] failed to publish synthetic run_final",
      );
    }
  });

  return { ok: true, taskId, versionHash };
}
