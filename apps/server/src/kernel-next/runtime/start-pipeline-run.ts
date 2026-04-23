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
import type { CheckpointConfig } from "./checkpoint/checkpoint.js";
import { allocateWorktree } from "./worktree/allocator.js";
import { slugifyPipelineName } from "./name-slug.js";

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
  // Stage 5B — resume an existing taskId mid-pipeline on a new
  // versionHash. Runner hydrates finalizedStages + portValues from
  // stage_attempts / port_values rows belonging to taskId (status='success'
  // only) and skips external input seeding. The stage named by
  // resumeFrom plus its wire-reachable descendants (currently superseded)
  // are re-invoked; upstream stages stay finalized.
  resumeFrom?: string;
  // Phase 4.5 Step 1 — forwarded to runPipeline. Optional; when omitted,
  // runner applies defaults (enabled: true, workdir: process.cwd(), etc.).
  // When `worktreeSourceRepo` is set below, this field is overridden by
  // the allocated worktree (caller-provided checkpointConfig only wins
  // when worktreeSourceRepo is omitted).
  checkpointConfig?: CheckpointConfig;
  // Phase 5C — worktree ownership contract. When set, the task gets an
  // isolated git worktree branched off of `baseBranch` (default HEAD)
  // under `<worktreeRoot>/<taskId>/`. Checkpoint capture + future B9
  // git-reset operations all happen inside that directory.
  //
  // When omitted: no worktree is allocated; checkpointConfig falls
  // back to whatever the caller provided (or runner defaults).
  worktreeSourceRepo?: string;
  /** Root directory for per-task worktrees. Defaults to `{data_dir}/worktrees`. */
  worktreeRoot?: string;
  /** Branch ref to start the worktree from. Defaults to source repo HEAD. */
  baseBranch?: string;
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

    // P6-5: slug fallback. Callers may pass the slug form (e.g.
    // "pr-description-generator") even though the IR-declared
    // pipeline_name is the display name ("PR Description Generator").
    // Scan every pipeline_name in the DB and match by slugify
    // equivalence. O(N) in number of versions — negligible at the
    // fleet sizes this product targets.
    if (!hash) {
      const slugInput = slugifyPipelineName(name);
      if (slugInput.length > 0) {
        const rows = input.db
          .prepare(
            `SELECT version_hash, pipeline_name
             FROM pipeline_versions
             ORDER BY created_at DESC`,
          )
          .all() as Array<{ version_hash: string; pipeline_name: string }>;
        for (const r of rows) {
          if (slugifyPipelineName(r.pipeline_name) === slugInput) {
            hash = r.version_hash;
            break;
          }
        }
      }
    }

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

  // P6-6: synthesize taskId with the slug form of the pipeline name so
  // it's URL-safe and readable in logs. An explicit caller-supplied
  // taskId is passed through verbatim — tests and migration flows rely
  // on that escape hatch.
  const taskId = input.taskId
    ?? `${slugifyPipelineName(nameForRegistry) || "task"}-${Date.now()}-${randomUUID().slice(0, 8)}`;

  // --- Worktree allocation (Phase 5C) -------------------------------
  //
  // Opt-in: only when caller specified worktreeSourceRepo. allocate is
  // idempotent per taskId — migration-driven resume calls pass the
  // same taskId and the allocator returns the existing row without
  // re-creating the directory.
  let resolvedCheckpointConfig = input.checkpointConfig;
  if (input.worktreeSourceRepo) {
    const worktreeRoot = input.worktreeRoot
      ?? `${process.env.DATA_DIR || "/tmp/workflow-control-data"}/worktrees`;
    try {
      const alloc = await allocateWorktree(db, taskId, {
        repo: input.worktreeSourceRepo,
        worktreeRoot,
        baseBranch: input.baseBranch,
      });
      if (alloc.status === "active" && alloc.workdir) {
        // Merge caller-supplied checkpointConfig (excluding workdir)
        // with the allocated directory so captureBefore / captureAfter
        // run against the task's owned workdir.
        resolvedCheckpointConfig = {
          ...(input.checkpointConfig ?? {}),
          workdir: alloc.workdir,
          enabled: input.checkpointConfig?.enabled ?? true,
        };
      } else {
        // Allocation unavailable — explicitly disable checkpoint to
        // avoid capturing against process.cwd() (would record server
        // changes, not agent changes — see checkpoint.ts default doc).
        resolvedCheckpointConfig = {
          ...(input.checkpointConfig ?? {}),
          enabled: false,
        };
      }
    } catch (err) {
      logger.warn(
        { taskId, err: (err as Error).message },
        "[startPipelineRun] worktree allocation threw; running without checkpoint",
      );
      resolvedCheckpointConfig = {
        ...(input.checkpointConfig ?? {}),
        enabled: false,
      };
    }
  }

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
    resumeFrom: input.resumeFrom,
    checkpointConfig: resolvedCheckpointConfig,
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
