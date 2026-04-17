import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  Options as SdkOptions,
  HookInput,
  HookJSONOutput,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { StageTokenUsage } from "@workflow-control/shared";
import { AsyncQueue, QueueAbortedError } from "./async-queue.js";
import { sseManager } from "../sse/manager.js";
import { taskLogger } from "../lib/logger.js";
import { persistSessionId } from "./session-persister.js";
import type { SSEMessage } from "../types/index.js";
import type { AgentRuntimeConfig } from "../lib/config-loader.js";
import type { WorkflowContext } from "../machine/types.js";
import { buildMcpServers } from "../lib/mcp-config.js";
import { createStoreReaderMcp } from "../lib/store-reader-mcp.js";
import { buildChildEnv } from "../lib/child-env.js";
import {
  createAskUserQuestionInterceptor,
  createPathRestrictionHook,
} from "./executor-hooks.js";
import { loadSystemSettings } from "../lib/config-loader.js";
import {
  buildSystemAppendPrompt,
  buildStaticPromptPrefix,
} from "./prompt-builder.js";
import { RedFlagAccumulator } from "./red-flag-detector.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionManagerConfig {
  taskId: string;
  claudePath: string;
  idleTimeoutMs: number;
  cwd: string;
}

export interface ExecuteStageParams {
  taskId: string;
  stageName: string;
  tier1Context: string;
  stagePrompt: string;
  stageConfig: {
    model?: string;
    effort?: SdkOptions["effort"];
    mcpServices: string[];
    permissionMode: string;
    maxTurns: number;
    maxBudgetUsd: number;
    thinking: SdkOptions["thinking"];
    stageTimeoutSec?: number;
  };
  resumeInfo?: { feedback: string };
  worktreePath: string;
  interactive: boolean;
  runtime: AgentRuntimeConfig;
  context: WorkflowContext;
  parallelGroup?: { name: string; stages: any[] };
}

interface AgentResult {
  resultText: string;
  sessionId: string | undefined;
  costUsd: number;
  durationMs: number;
  tokenUsage: StageTokenUsage | undefined;
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSSEMessage(
  taskId: string,
  type: SSEMessage["type"],
  data: unknown,
): SSEMessage {
  return { type, taskId, timestamp: new Date().toISOString(), data };
}

export function buildUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: "",
  };
}

const MAX_RESULT_TEXT = 5 * 1024 * 1024;

function mcpServiceKey(services: string[]): string {
  return [...services].sort().join(",");
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private query: Query | null = null;
  private queryIterator: AsyncIterator<SDKMessage> | null = null;
  private inputQueue: AsyncQueue<SDKUserMessage> | null = null;
  private sessionId: string | undefined;
  private queryClosed = false;
  private cumulativeCostUsd = 0;
  private cumulativeInputTokens = 0;
  private cumulativeOutputTokens = 0;
  private cumulativeCacheReadTokens = 0;
  private cumulativeCacheCreationTokens = 0;
  private stageTurnCount = 0;
  private turnLimitNotified = false;
  private prevModel: string | undefined;
  private prevPermissionMode: string | undefined;
  private prevMcpKey: string | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  // Hard-kill deadline (milliseconds since epoch) after which close() aborts the query
  // regardless of what the agent is doing. Set by stage timeout after a grace period.
  private hardKillDeadline: number | undefined;
  // Reason the current query was closed. Lets consumeUntilResult distinguish
  // "SDK iterator ended because WE closed it" (intentional — report as abort)
  // from "SDK iterator ended unexpectedly" (agent crashed — report as bug).
  private closeReason: "idle" | "explicit" | "hardTimeout" | null = null;
  private readonly config: SessionManagerConfig;
  private readonly log;

  constructor(config: SessionManagerConfig) {
    this.config = config;
    this.log = taskLogger(config.taskId, "session-mgr");
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async executeStage(params: ExecuteStageParams): Promise<AgentResult> {
    if (params.parallelGroup) {
      return this.executeParallelGroup(params);
    }

    const isFirstStage = this.query === null && !this.queryClosed;
    const isRetry = !!params.resumeInfo?.feedback;

    if (this.query === null) {
      await this.createQuery(params);
    } else if (!isRetry) {
      await this.switchStageConfig(params);
    }

    // Build the user message for this stage
    const promptText = isRetry
      ? params.resumeInfo!.feedback
      : this.buildStagePrompt(params, isFirstStage);

    this.inputQueue!.enqueue(buildUserMessage(promptText));

    return this.consumeUntilResult(params);
  }

  /**
   * Close the session gracefully. Pending consume-loop iterators unwind with
   * a specific "aborted" error rather than the ambiguous "query ended
   * unexpectedly" path. Callers that want idle-recovery semantics should
   * still rely on the `queryClosed && sessionId` branch in createQuery.
   *
   * @param reason informs the consume loop how to phrase the error. `idle`
   *   and `explicit` both unwind cleanly; `hardTimeout` is set by the stage
   *   timeout path before calling close().
   */
  close(reason: "idle" | "explicit" | "hardTimeout" = "explicit"): void {
    this.clearIdleTimer();
    this.hardKillDeadline = undefined;
    // Record intent BEFORE closing so the consume loop's done-branch can
    // distinguish intentional shutdown from SDK crash.
    this.closeReason = reason;

    // Abort the input queue so any producer waiting on a full buffer unwinds.
    if (this.inputQueue) {
      try {
        this.inputQueue.abort("session closed");
      } catch {
        /* best-effort */
      }
      this.inputQueue = null;
    }
    // Close SDK query — its asyncIterator will resolve with done:true on the
    // next microtask, which consumeUntilResult catches via closeReason.
    if (this.query) {
      try {
        this.query.close();
      } catch {
        /* already closed */
      }
      this.query = null;
      this.queryIterator = null;
    }
    this.queryClosed = true;
  }

  // -----------------------------------------------------------------------
  // Query creation
  // -----------------------------------------------------------------------

  private async createQuery(params: ExecuteStageParams): Promise<void> {
    this.clearIdleTimer();

    this.inputQueue = new AsyncQueue<SDKUserMessage>();

    const appendPrompt = await this.buildSystemAppend(params);

    // Build hooks: path restriction (always) from sandbox config
    const settings = loadSystemSettings();
    const sandboxFs = (params.context.config?.sandbox ?? settings.sandbox)?.filesystem;
    const pathHook = createPathRestrictionHook(
      sandboxFs?.allow_write,
      sandboxFs?.deny_write,
    );
    const hooks: Record<string, Array<{ hooks: Array<(input: HookInput, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<HookJSONOutput>> }>> = {
      PreToolUse: [{ hooks: [pathHook] }],
    };

    // Build MCP servers with store-reader
    const mcpServers: Record<string, unknown> = buildMcpServers(params.stageConfig.mcpServices, "claude");
    if (params.context.store && Object.keys(params.context.store).length > 0) {
      mcpServers["__store__"] = createStoreReaderMcp(
        params.context.store,
        params.context.scratchPad ?? [],
        params.stageName,
      );
    } else if (params.context.scratchPad && params.context.scratchPad.length > 0) {
      mcpServers["__store__"] = createStoreReaderMcp(
        {},
        params.context.scratchPad,
        params.stageName,
      );
    }

    const options: SdkOptions = {
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: appendPrompt,
      },
      pathToClaudeCodeExecutable: this.config.claudePath,
      settingSources: [],
      thinking: params.stageConfig.thinking,
      ...(params.stageConfig.effort ? { effort: params.stageConfig.effort } : {}),
      includePartialMessages: true,
      // Hard ceiling at SDK level: 3x the per-stage limit as safety net for multi-stage sessions.
      // Per-stage soft limits are enforced in consumeUntilResult via turn counting + timeout.
      maxTurns: params.stageConfig.maxTurns * 3,
      maxBudgetUsd: params.stageConfig.maxBudgetUsd * 3,
      permissionMode: params.stageConfig
        .permissionMode as SdkOptions["permissionMode"],
      ...(params.stageConfig.permissionMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      disallowedTools: [
        "ToolSearch",
        "mcp__claude_ai_*",
        ...(params.runtime?.disallowed_tools ?? []),
      ],
      ...(params.stageConfig.model
        ? { model: params.stageConfig.model }
        : {}),
      ...(params.worktreePath ? { cwd: params.worktreePath } : {}),
      env: {
        ...buildChildEnv({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
        CLAUDECODE: "",
        CI: "true",
      },
      hooks,
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers: mcpServers as SdkOptions["mcpServers"] } : {}),
    };

    // Interactive mode: AskUserQuestion interceptor
    if (params.interactive) {
      options.canUseTool = createAskUserQuestionInterceptor(
        params.taskId,
      ) as unknown as SdkOptions["canUseTool"];
    }

    // Idle timeout recovery: resume existing session.
    // When recovering, we keep prevModel/prevPermissionMode/prevMcpKey from the
    // previous query so the next switchStageConfig call can still detect real
    // config differences. Overwriting them with the current stage's config
    // (which was built from the LAST stage's config) would mask transitions.
    const isIdleRecover = this.queryClosed && !!this.sessionId;
    if (isIdleRecover) {
      options.resume = this.sessionId;
      this.log.info(
        { sessionId: this.sessionId },
        "Resuming session after idle timeout",
      );
    }

    this.query = sdkQuery({
      prompt: this.inputQueue as AsyncIterable<SDKUserMessage>,
      options,
    });
    this.queryIterator = null;
    this.queryClosed = false;
    // Fresh query — wipe any intent from the previous close so a subsequent
    // SDK-side unexpected exit isn't misreported as "aborted".
    this.closeReason = null;

    // Only refresh prev* on a fresh session (first stage or cold start).
    // On idle-recover we inherit the last-known config so subsequent
    // switchStageConfig correctly detects transitions.
    if (!isIdleRecover) {
      this.prevModel = params.stageConfig.model;
      this.prevPermissionMode = params.stageConfig.permissionMode;
      this.prevMcpKey = mcpServiceKey(params.stageConfig.mcpServices);
    }
  }

  // -----------------------------------------------------------------------
  // Stage config switching
  // -----------------------------------------------------------------------

  private async switchStageConfig(params: ExecuteStageParams): Promise<void> {
    if (!this.query) return;

    if (
      params.stageConfig.model &&
      params.stageConfig.model !== this.prevModel
    ) {
      this.log.info(
        { from: this.prevModel, to: params.stageConfig.model },
        "Switching model between stages",
      );
      await this.query.setModel(params.stageConfig.model);
      this.prevModel = params.stageConfig.model;
    }

    if (params.stageConfig.permissionMode !== this.prevPermissionMode) {
      this.log.info(
        {
          from: this.prevPermissionMode,
          to: params.stageConfig.permissionMode,
        },
        "Switching permission mode between stages",
      );
      await this.query.setPermissionMode(
        params.stageConfig
          .permissionMode as Parameters<Query["setPermissionMode"]>[0],
      );
      this.prevPermissionMode = params.stageConfig.permissionMode;
    }

    // Update MCP servers if service list changed — always re-include __store__
    const newMcpKey = mcpServiceKey(params.stageConfig.mcpServices);
    if (newMcpKey !== this.prevMcpKey) {
      this.log.info(
        { from: this.prevMcpKey, to: newMcpKey },
        "Switching MCP servers between stages",
      );
      const mcpServers: Record<string, unknown> = buildMcpServers(params.stageConfig.mcpServices, "claude");
      // Re-attach __store__ MCP so it persists across MCP service changes
      if (params.context.store && Object.keys(params.context.store).length > 0) {
        mcpServers["__store__"] = createStoreReaderMcp(
          params.context.store,
          params.context.scratchPad ?? [],
          params.stageName,
        );
      } else if (params.context.scratchPad && params.context.scratchPad.length > 0) {
        mcpServers["__store__"] = createStoreReaderMcp(
          {},
          params.context.scratchPad,
          params.stageName,
        );
      }
      await this.query.setMcpServers(
        mcpServers as Parameters<Query["setMcpServers"]>[0],
      );
      this.prevMcpKey = newMcpKey;
    }
  }

  // -----------------------------------------------------------------------
  // Prompt building
  // -----------------------------------------------------------------------

  private buildStagePrompt(
    params: ExecuteStageParams,
    isFirst: boolean,
  ): string {
    if (isFirst) {
      // Full prompt: Tier 1 context + stage instruction
      const parts: string[] = [];
      if (params.tier1Context) parts.push(params.tier1Context);
      if (params.stagePrompt) parts.push(params.stagePrompt);
      return parts.join("\n\n---\n\n");
    }

    // Incremental prompt: just the stage instruction
    return params.stagePrompt;
  }

  // -----------------------------------------------------------------------
  // consumeUntilResult — THE CRITICAL METHOD
  // -----------------------------------------------------------------------

  private async consumeUntilResult(
    params: ExecuteStageParams,
  ): Promise<AgentResult> {
    if (!this.queryIterator) {
      this.queryIterator = this.query![Symbol.asyncIterator]();
    }

    this.stageTurnCount = 0;
    this.turnLimitNotified = false;
    let resultText = "";
    const startTime = Date.now();
    const redFlagAccumulator = new RedFlagAccumulator();

    // Per-stage timeout. Two-phase: soft (inject URGENT message, give agent
    // HARD_KILL_GRACE_MS to wrap up) then hard (interrupt SDK query + abort
    // input queue to unwind the consume loop unconditionally).
    const stageTimeoutSec = params.stageConfig.stageTimeoutSec ?? 1800;
    const HARD_KILL_GRACE_MS = 60_000;
    let stageTimedOut = false;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    const stageTimer = setTimeout(() => {
      stageTimedOut = true;
      this.log.error(
        { timeoutSec: stageTimeoutSec, stage: params.stageName },
        "Stage soft timeout reached — injecting URGENT stop message",
      );
      // Soft stop: let the agent wrap up if it's still responsive.
      this.inputQueue?.tryEnqueue(
        buildUserMessage(
          "URGENT: Stage execution timeout reached. Stop ALL work immediately and output your current progress as the required JSON NOW.",
        ),
      );
      // Arm hard kill — unconditional interrupt after grace window.
      this.hardKillDeadline = Date.now() + HARD_KILL_GRACE_MS;
      hardKillTimer = setTimeout(() => {
        this.log.error(
          { stage: params.stageName, graceMs: HARD_KILL_GRACE_MS },
          "Stage hard timeout — interrupting SDK query and closing session",
        );
        // Best-effort interrupt so any current tool call is signalled to
        // cancel; then close() with hardTimeout reason so consumeUntilResult
        // surfaces the correct error when the SDK iterator wraps up.
        try {
          this.query?.interrupt();
        } catch {
          /* best-effort */
        }
        this.close("hardTimeout");
      }, HARD_KILL_GRACE_MS);
    }, stageTimeoutSec * 1000);

    // Emit stage_change SSE
    sseManager.pushMessage(
      params.taskId,
      createSSEMessage(params.taskId, "stage_change", {
        stage: params.stageName,
      }),
    );

    // `queryIterator` is captured into a local so close() setting the field
    // to null doesn't affect this loop — we detect shutdown via closeReason.
    const localIterator = this.queryIterator;

    try {
      while (true) {
        let message: SDKMessage;
        let done: boolean | undefined;
        try {
          const result = await localIterator.next();
          message = result.value as SDKMessage;
          done = result.done;
        } catch (err) {
          // AsyncQueue propagated an abort; usually this path is inert (the
          // inputQueue isn't being iterated here) but keep the branch for
          // robustness — an SDK-side iterator throwing during shutdown lands
          // here too.
          if (err instanceof QueueAbortedError) {
            if (this.closeReason === "hardTimeout" || stageTimedOut) {
              throw new Error(
                `Stage "${params.stageName}" exceeded timeout (${stageTimeoutSec}s) and was hard-killed`,
              );
            }
            throw new Error(
              `Stage "${params.stageName}" aborted: session closed during execution`,
            );
          }
          throw err;
        }
        if (done) {
          // Intentional shutdown — surface a specific error so the caller
          // knows this wasn't an agent crash.
          if (this.closeReason === "hardTimeout" || stageTimedOut) {
            throw new Error(
              `Stage "${params.stageName}" exceeded timeout (${stageTimeoutSec}s) and was hard-killed`,
            );
          }
          if (this.closeReason === "idle" || this.closeReason === "explicit") {
            throw new Error(
              `Stage "${params.stageName}" aborted: session closed during execution`,
            );
          }
          throw new Error(
            `Single-session query ended unexpectedly during stage "${params.stageName}"`,
          );
        }

        this.clearIdleTimer();

        const msg = message as Record<string, unknown>;

        // Capture session ID
        if (msg.session_id && !this.sessionId) {
          this.sessionId = msg.session_id as string;
          await persistSessionId(
            params.taskId,
            params.stageName,
            this.sessionId,
          );
        }

        switch ((message as any).type) {
          case "assistant": {
            const content = (msg.message as any)?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text" && block.text) {
                  sseManager.pushMessage(
                    params.taskId,
                    createSSEMessage(params.taskId, "agent_text", {
                      text: block.text,
                    }),
                  );
                  if (resultText.length < MAX_RESULT_TEXT) {
                    resultText += block.text;
                  }
                  const newFlags = redFlagAccumulator.append(block.text);
                  if (newFlags.length > 0) {
                    sseManager.pushMessage(
                      params.taskId,
                      createSSEMessage(params.taskId, "agent_red_flag", {
                        flags: newFlags.map((f) => ({
                          category: f.category,
                          description: f.description,
                          matched: f.matchedText,
                        })),
                      }),
                    );
                  }
                }
                if (block.type === "thinking" && (block as any).thinking) {
                  sseManager.pushMessage(
                    params.taskId,
                    createSSEMessage(params.taskId, "agent_thinking", {
                      text: (block as any).thinking as string,
                    }),
                  );
                }
                if (block.type === "tool_use") {
                  sseManager.pushMessage(
                    params.taskId,
                    createSSEMessage(params.taskId, "agent_tool_use", {
                      toolName: block.name,
                      input: block.input as Record<string, unknown>,
                    }),
                  );
                  this.stageTurnCount++;
                  sseManager.pushMessage(
                    params.taskId,
                    createSSEMessage(params.taskId, "agent_progress", {
                      toolCallCount: this.stageTurnCount,
                      phase: "working",
                    }),
                  );
                }
              }
            }
            break;
          }

          case "result": {
            // Differential cost
            const totalCost = (msg.total_cost_usd as number) ?? 0;
            const stageCost = totalCost - this.cumulativeCostUsd;
            this.cumulativeCostUsd = totalCost;

            // Differential token usage
            const usage = msg.usage as Record<string, number> | undefined;
            let tokenUsage: StageTokenUsage | undefined;
            if (usage) {
              const inputTokens =
                (usage.input_tokens ?? 0) - this.cumulativeInputTokens;
              const outputTokens =
                (usage.output_tokens ?? 0) - this.cumulativeOutputTokens;
              const cacheReadTokens =
                (usage.cache_read_input_tokens ?? 0) -
                this.cumulativeCacheReadTokens;
              const cacheCreationTokens =
                (usage.cache_creation_input_tokens ?? 0) -
                this.cumulativeCacheCreationTokens;
              this.cumulativeInputTokens = usage.input_tokens ?? 0;
              this.cumulativeOutputTokens = usage.output_tokens ?? 0;
              this.cumulativeCacheReadTokens =
                usage.cache_read_input_tokens ?? 0;
              this.cumulativeCacheCreationTokens =
                usage.cache_creation_input_tokens ?? 0;
              tokenUsage = {
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheCreationTokens: cacheCreationTokens || undefined,
                totalTokens: inputTokens + outputTokens,
              };
            }

            // Handle result text
            const subtype = msg.subtype as string | undefined;
            if (subtype === "success") {
              if (msg.structured_output) {
                resultText = JSON.stringify(msg.structured_output);
              } else if (msg.result) {
                resultText = msg.result as string;
              }
            } else if (subtype && subtype.startsWith("error_")) {
              throw new Error(
                String(
                  msg.error_message ?? msg.result ?? "Agent error",
                ),
              );
            }

            // Update session ID from result if present
            if (msg.session_id) {
              this.sessionId = msg.session_id as string;
            }

            // Start idle timer
            this.startIdleTimer();

            this.log.info(
              {
                stage: params.stageName,
                costUsd: stageCost.toFixed(4),
                durationMs: Date.now() - startTime,
                sessionId: this.sessionId,
                timedOut: stageTimedOut,
              },
              "Stage result received",
            );

            return {
              resultText,
              sessionId: this.sessionId,
              costUsd: stageCost,
              durationMs: Date.now() - startTime,
              tokenUsage,
              cwd: params.worktreePath,
            };
          }

          case "system":
            break;

          default:
            break;
        }

        // Soft turn limit — notify once per stage
        if (
          !this.turnLimitNotified &&
          this.stageTurnCount >= params.stageConfig.maxTurns
        ) {
          // Queue may be closed if close() raced with us — tryEnqueue avoids throw
          this.inputQueue?.tryEnqueue(
            buildUserMessage(
              "You have exceeded the turn limit for this stage. Stop working and output your current progress as the required JSON immediately.",
            ),
          );
          this.turnLimitNotified = true;
        }
      }
    } finally {
      clearTimeout(stageTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      this.hardKillDeadline = undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Parallel group execution
  // -----------------------------------------------------------------------

  private async executeParallelGroup(
    params: ExecuteStageParams,
  ): Promise<AgentResult> {
    const group = params.parallelGroup!;

    // Build union of MCP services from all stages
    const allMcpServices = new Set<string>();
    for (const stage of group.stages) {
      const mcps: string[] = (stage as any).mcps ?? [];
      for (const svc of mcps) allMcpServices.add(svc);
    }
    for (const svc of params.stageConfig.mcpServices) allMcpServices.add(svc);

    // Build dispatch prompt that instructs the agent to run child stages via Agent tool
    const childDescriptions = group.stages.map((stage: any) => {
      const runtime = stage.runtime as AgentRuntimeConfig | undefined;
      const writes = (runtime?.writes ?? []).map((w: any) => typeof w === "string" ? w : w.key);
      return `### ${stage.name}\n**Prompt:** ${runtime?.system_prompt ?? "(no prompt)"}\n**Required output keys:** ${writes.join(", ") || "(none)"}`;
    }).join("\n\n");

    const dispatchPrompt = [
      `You are now executing parallel group "${group.name}".`,
      `This group contains ${group.stages.length} independent stages that should be dispatched in parallel using the Agent tool.`,
      "",
      "## Child Stages",
      "",
      childDescriptions,
      "",
      "## Instructions",
      "1. Launch ALL child stages simultaneously using the Agent tool (one Agent call per stage)",
      "2. Each agent should complete its assigned task and output a JSON object with its required output keys",
      "3. After all agents complete, combine their outputs into a single JSON object and output it",
      "4. The final output MUST contain ALL required output keys from ALL child stages",
    ].join("\n");

    const mergedParams: ExecuteStageParams = {
      ...params,
      stageName: group.name,
      stagePrompt: dispatchPrompt,
      stageConfig: {
        ...params.stageConfig,
        mcpServices: [...allMcpServices],
      },
    };

    return this.executeStage({
      ...mergedParams,
      parallelGroup: undefined,
    });
  }

  // -----------------------------------------------------------------------
  // System prompt
  // -----------------------------------------------------------------------

  private async buildSystemAppend(
    params: ExecuteStageParams,
  ): Promise<string> {
    const privateConfig = params.context.config;
    const { prompt: stageAppend, fragmentIds } =
      await buildSystemAppendPrompt({
        taskId: params.taskId,
        stageName: params.stageName,
        runtime: params.runtime,
        privateConfig,
        stageConfig: {
          engine: "claude",
          mcpServices: params.stageConfig.mcpServices,
        },
      });

    const staticPrefix = buildStaticPromptPrefix(
      privateConfig,
      "claude",
      fragmentIds,
    );

    return [staticPrefix, stageAppend].filter(Boolean).join("\n\n");
  }

  // -----------------------------------------------------------------------
  // Idle timer
  // -----------------------------------------------------------------------

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.log.warn(
        { idleTimeoutMs: this.config.idleTimeoutMs },
        "Idle timeout reached, closing query",
      );
      this.close("idle");
    }, this.config.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}
