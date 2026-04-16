import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  Options as SdkOptions,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { StageTokenUsage } from "@workflow-control/shared";
import { AsyncQueue } from "./async-queue.js";
import { sseManager } from "../sse/manager.js";
import { taskLogger } from "../lib/logger.js";
import { persistSessionId } from "./session-persister.js";
import type { SSEMessage } from "../types/index.js";
import type { AgentRuntimeConfig } from "../lib/config-loader.js";
import type { WorkflowContext } from "../machine/types.js";
import { buildMcpServers } from "../lib/mcp-config.js";
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
    mcpServices: string[];
    permissionMode: string;
    maxTurns: number;
    maxBudgetUsd: number;
    thinking: SdkOptions["thinking"];
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
  private stageTurnCount = 0;
  private knownStoreKeys = new Set<string>();
  private prevModel: string | undefined;
  private prevPermissionMode: string | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
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
    const needsNewQuery =
      this.query === null || (this.queryClosed && this.sessionId);

    if (needsNewQuery) {
      await this.createQuery(params);
    } else if (!isRetry) {
      await this.switchStageConfig(params);
    }

    // Build the user message for this stage
    const promptText = isRetry
      ? params.resumeInfo!.feedback
      : this.buildStagePrompt(params, isFirstStage && !this.queryClosed);

    this.inputQueue!.enqueue(buildUserMessage(promptText));

    return this.consumeUntilResult(params);
  }

  close(): void {
    this.clearIdleTimer();
    if (this.query) {
      try {
        this.query.close();
      } catch {
        /* already closed */
      }
      this.query = null;
      this.queryIterator = null;
    }
    if (this.inputQueue) {
      this.inputQueue.finish();
      this.inputQueue = null;
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

    const options: SdkOptions = {
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: appendPrompt,
      },
      pathToClaudeCodeExecutable: this.config.claudePath,
      settingSources: [],
      thinking: params.stageConfig.thinking,
      includePartialMessages: true,
      maxTurns: 500,
      maxBudgetUsd: 50,
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
    };

    // MCP servers
    const mcpServers = buildMcpServers(params.stageConfig.mcpServices);
    if (Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers as SdkOptions["mcpServers"];
    }

    // Interactive mode: AskUserQuestion interceptor
    if (params.interactive) {
      options.canUseTool = createAskUserQuestionInterceptor(
        params.taskId,
      ) as unknown as SdkOptions["canUseTool"];
    }

    // Idle timeout recovery: resume existing session
    if (this.queryClosed && this.sessionId) {
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

    this.prevModel = params.stageConfig.model;
    this.prevPermissionMode = params.stageConfig.permissionMode;
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

    // Update MCP servers if service list changed
    const mcpServers = buildMcpServers(params.stageConfig.mcpServices);
    await this.query.setMcpServers(
      mcpServers as Parameters<Query["setMcpServers"]>[0],
    );
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
    let resultText = "";
    const startTime = Date.now();
    const redFlagAccumulator = new RedFlagAccumulator();

    // Emit stage_change SSE
    sseManager.pushMessage(
      params.taskId,
      createSSEMessage(params.taskId, "stage_change", {
        stage: params.stageName,
      }),
    );

    while (true) {
      const { value: message, done } = await this.queryIterator.next();
      if (done) {
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
            this.cumulativeInputTokens = usage.input_tokens ?? 0;
            this.cumulativeOutputTokens = usage.output_tokens ?? 0;
            this.cumulativeCacheReadTokens =
              usage.cache_read_input_tokens ?? 0;
            tokenUsage = {
              inputTokens,
              outputTokens,
              cacheReadTokens,
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

      // Soft turn limit
      if (
        this.stageTurnCount > 0 &&
        this.stageTurnCount >= params.stageConfig.maxTurns
      ) {
        this.inputQueue!.enqueue(
          buildUserMessage(
            "You have exceeded the turn limit for this stage. Stop working and output your current progress as the required JSON immediately.",
          ),
        );
        this.stageTurnCount = -999; // prevent re-sending
      }
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
      const services: string[] = stage.stageConfig?.mcpServices ?? [];
      for (const svc of services) allMcpServices.add(svc);
    }
    for (const svc of params.stageConfig.mcpServices) allMcpServices.add(svc);

    const mergedParams: ExecuteStageParams = {
      ...params,
      stageName: group.name,
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
      this.close();
    }, this.config.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}
